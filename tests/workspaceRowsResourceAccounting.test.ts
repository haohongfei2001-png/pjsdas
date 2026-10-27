import { describe, expect, it } from 'vitest'
import {
  assertResourceLedger, createResourceLedger, inspectResourceInventory, resourceTotals,
  restoreResourceLedger, transitionResourceLedger,
  type ResourceAction, type ResourceAdmission, type ResourceBinding, type ResourceConfiguration,
  type ResourceLedger, type ResourceInventoryEntry,
} from '../gateway/workspaceRowsResourceAccounting.js'

// Small arithmetic fixtures, deliberately NOT proposed product limits or TTLs.
const H = 'a'.repeat(64), J = 'b'.repeat(64)
const config: ResourceConfiguration = { enabled: true, limits: { commandBytes: 100, ownerBytes: 150, globalBytes: 200 } }
const binding = (stageId = 'stage-a', userId = 'owner-a', commandId = stageId): ResourceBinding => ({
  stageId, userId, commandId, workspaceId: `workspace-${userId}`, expectedEpoch: 'original-epoch', expectedRevision: 4,
  family: 'first_party_abandon', operation: 'abandon_opportunity', principal: 'first_party_web', authority: {},
  payloadHash: H, manifestSha256: J, preparedSha256: H,
})
const admission = (b = binding(), reservedBytes = 80): ResourceAdmission => ({ binding: b, reservedBytes, expiresAt: 90, deadlineAt: 80 })
const apply = (s: ResourceLedger, a: ResourceAction, now = 10) => transitionResourceLedger(s, s.revision, a, now).state
const initial = (configuration = config) => apply(createResourceLedger(configuration), { type: 'inventory', observedRevision: 0, complete: true, entries: [] })
const admitted = (b = binding(), bytes = 80) => apply(initial(), { type: 'admit', admission: admission(b, bytes) })
const append = (b = binding(), allocationId = 'document:metadata', offset = 0, bytes = 10, sha256 = H): ResourceAction => ({
  type: 'append', binding: b, allocationId, kind: 'document-fragments', offset, bytes, sha256,
})
const confirmed = (s: ResourceLedger, b = binding(), allocationId = 'document:metadata', offset = 0, bytes = 10, sha256 = H) =>
  apply(s, { type: 'confirm-append', binding: b, allocationId, offset, bytes, sha256 })
function resolve(s: ResourceLedger, b = binding(), committed = false) {
  return apply(s, { type: 'resolve', binding: b, reservationRevision: s.reservations.find(r => r.binding.stageId === b.stageId)!.revision,
    evidence: committed ? { outcome: 'committed', fenceId: 'terminal-fence', resultingRevision: 5, auditRetention: 'original-receipt-projection-compensation-retained' }
      : { outcome: 'not-committed', fenceId: 'terminal-fence' } })
}
function reclaim(s: ResourceLedger, b = binding()) {
  s = apply(s, { type: 'begin-reclaim', binding: b, reclaimId: 'cleanup', writerFenceId: 'writers-joined', reservationRevision: s.reservations.find(r => r.binding.stageId === b.stageId)!.revision })
  for (const a of s.reservations.find(r => r.binding.stageId === b.stageId)!.allocations) {
    s = apply(s, { type: 'confirm-removed', binding: b, reclaimId: 'cleanup', allocationId: a.allocationId })
  }
  return apply(s, { type: 'release', binding: b, reclaimId: 'cleanup' })
}
const inventory = (s: ResourceLedger): ResourceInventoryEntry[] => s.reservations.flatMap(r => r.allocations.filter(a => !a.removed)
  .flatMap(a => a.chunks.map(c => ({ stageId: r.binding.stageId, allocationId: a.allocationId, offset: c.offset, bytes: c.bytes, sha256: c.sha256 }))))
function expectRejectedUnchanged(s: ResourceLedger, a: ResourceAction, code: string, now = 10) {
  const before = JSON.stringify(s)
  expect(() => apply(s, a, now)).toThrow(code)
  expect(JSON.stringify(s)).toBe(before)
}

describe('default-off resource accounting specification', () => {
  it('has no numeric defaults, no implicit admission, and no mutation while disabled', () => {
    const s = createResourceLedger()
    expect(s.configuration).toEqual({})
    const result = transitionResourceLedger(s, 0, { type: 'admit', admission: admission() }, 10)
    expect(result).toEqual({ state: s, disposition: 'disabled' })
    expect(() => createResourceLedger({ enabled: true } as ResourceConfiguration)).toThrow('EXPLICIT_RESOURCE_LIMITS_REQUIRED')
    for (const value of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => createResourceLedger({ enabled: true, limits: { commandBytes: value, ownerBytes: 10, globalBytes: 10 } })).toThrow()
    }
  })
  it('requires an explicit complete fenced inventory before initial admission and after restore', () => {
    const s = createResourceLedger(config)
    expectRejectedUnchanged(s, { type: 'admit', admission: admission() }, 'RESOURCE_RECONCILIATION_REQUIRED')
    const live = apply(admitted(), append()), restored = restoreResourceLedger(JSON.parse(JSON.stringify(live)))
    expect(restored.inventoryVerified).toBe(false)
    expect(resourceTotals(restored)).toEqual(resourceTotals(live))
    expectRejectedUnchanged(restored, append(binding(), 'second'), 'RESOURCE_RECONCILIATION_REQUIRED')
    const reconciled = apply(restored, { type: 'inventory', observedRevision: restored.revision, complete: true, entries: [] })
    expect(reconciled.inventoryVerified).toBe(true) // precharged write may never have reached disk
    expect(resourceTotals(reconciled).global.occupiedUpperBoundBytes).toBe(10)
  })
  it('freezes and detaches caller-owned configuration, identities and snapshots', () => {
    const c = structuredClone(config), a = admission()
    const s = apply(initial(c), { type: 'admit', admission: a })
    a.binding.authority.unsafe = true; a.reservedBytes = 999
    if (c.enabled) c.limits.globalBytes = 999
    expect(s.reservations[0].reservedBytes).toBe(80)
    expect(s.reservations[0].binding.authority).toEqual({})
    expect(Object.isFrozen(s.reservations[0].binding.authority)).toBe(true)
    expect(s.configuration).toEqual(config)
  })
  it('enforces command, owner and global aggregate admission, with no partial failed mutation', () => {
    expectRejectedUnchanged(initial(), { type: 'admit', admission: admission(binding(), 101) }, 'COMMAND_LIMIT_EXCEEDED')
    const s = admitted()
    expectRejectedUnchanged(s, { type: 'admit', admission: admission(binding('b'), 80) }, 'OWNER_LIMIT_EXCEEDED')
    const two = apply(s, { type: 'admit', admission: admission(binding('b', 'owner-b'), 80) })
    expectRejectedUnchanged(two, { type: 'admit', admission: admission(binding('c', 'owner-c'), 41) }, 'GLOBAL_LIMIT_EXCEEDED')
    const exact = apply(two, { type: 'admit', admission: admission(binding('c', 'owner-c'), 40) })
    expect(resourceTotals(exact).global.heldBytes).toBe(200)
    expect(resourceTotals(exact).owners.map(o => o.usage.heldBytes)).toEqual([80, 80, 40])
  })
  it('accepts explicit zero capacity as a deny-all policy without inventing a minimum', () => {
    const s = initial({ enabled: true, limits: { commandBytes: 0, ownerBytes: 0, globalBytes: 0 } })
    expectRejectedUnchanged(s, { type: 'admit', admission: admission(binding(), 1) }, 'GLOBAL_LIMIT_EXCEEDED')
  })
  it('pins reservation and original command identity, including authority, generation and absolute deadlines', () => {
    const s = admitted(), a = admission()
    expect(transitionResourceLedger(s, s.revision, { type: 'admit', admission: a }, 100).state).toBe(s)
    for (const changed of [ { ...a, deadlineAt: 81 }, { ...a, expiresAt: 91 }, { ...a, reservedBytes: 79 },
      ...['userId', 'workspaceId', 'expectedEpoch', 'commandId', 'family', 'operation', 'principal'].map(k => ({ ...a, binding: { ...a.binding, [k]: 'changed' } })),
      { ...a, binding: { ...a.binding, expectedRevision: 5 } }, { ...a, binding: { ...a.binding, authority: { grantId: 'changed' } } },
      { ...a, binding: { ...a.binding, manifestSha256: H } }, { ...a, binding: { ...a.binding, preparedSha256: J } },
      { ...a, binding: { ...a.binding, payloadHash: J } } ]) {
      expectRejectedUnchanged(s, { type: 'admit', admission: changed }, 'RESERVATION_IDENTITY_REUSED')
    }
    expectRejectedUnchanged(s, { type: 'admit', admission: admission({ ...binding('replacement'), commandId: binding().commandId, expectedEpoch: 'new-epoch' }) }, 'COMMAND_ID_REUSED')
    const anotherOwner = apply(s, { type: 'admit', admission: admission(binding('second', 'owner-b', binding().commandId)) })
    expect(anotherOwner.reservations).toHaveLength(2)
  })
  it('precharges every representation and concurrent spool allocation before bytes, counting capacity once', () => {
    let s = admitted()
    for (const [id, kind] of [['compressed', 'intent-encoded'], ['decoded:process-a', 'intent-decoded'], ['decoded:process-b', 'intent-decoded'],
      ['document:compensation', 'document-fragments'], ['effects:wire', 'effect-wire'], ['effects:jsonb', 'effect-jsonb'], ['spool:process-a', 'audit-spool']] as const) {
      s = apply(s, { ...append(binding(), id), kind } as ResourceAction)
    }
    expect(resourceTotals(s).global).toEqual({ heldBytes: 80, occupiedUpperBoundBytes: 70, confirmedPresentBytes: 0 })
    s = confirmed(s, binding(), 'compressed')
    expect(resourceTotals(s).global.confirmedPresentBytes).toBe(10)
    expectRejectedUnchanged(s, append(binding(), 'too-large', 0, 11), 'RESERVATION_EXCEEDED')
    s = apply(s, append(binding(), 'fits', 0, 10))
    expect(resourceTotals(s).global).toEqual({ heldBytes: 80, occupiedUpperBoundBytes: 80, confirmedPresentBytes: 10 })
  })
  it('deduplicates append and confirmation but rejects changed chunks, overlap, gap and kind reuse', () => {
    let s = apply(admitted(), append())
    expect(apply(s, append())).toBe(s)
    s = confirmed(s)
    expect(confirmed(s)).toBe(s)
    expect(apply(s, append())).toBe(s)
    for (const a of [append(binding(), 'document:metadata', 0, 9), append(binding(), 'document:metadata', 0, 10, J)]) {
      expectRejectedUnchanged(s, a, 'APPEND_IDENTITY_REUSED')
    }
    for (const offset of [1, 9, 11]) expectRejectedUnchanged(s, append(binding(), 'document:metadata', offset), 'APPEND_GAP_OR_OVERLAP')
    expectRejectedUnchanged(s, { ...append(), kind: 'audit-spool' } as ResourceAction, 'ALLOCATION_IDENTITY_REUSED')
    expectRejectedUnchanged(s, { ...append(binding(), 'original-audit'), kind: 'original-receipt' } as unknown as ResourceAction, 'INVALID_APPEND')
    s = apply(s, append(binding(), 'document:metadata', 10))
    expect(resourceTotals(s).global.occupiedUpperBoundBytes).toBe(20)
  })
  it('rejects foreign owner/authority/generation mutations even when stageId matches', () => {
    const s = apply(admitted(), append())
    for (const changed of [{ ...binding(), userId: 'other' }, { ...binding(), expectedEpoch: 'other' }, { ...binding(), authority: { grantId: 'regrant' } }]) {
      for (const a of [append(changed), { type: 'stop', binding: changed, reason: 'cancelled' } as ResourceAction,
        { type: 'begin-reclaim', binding: changed, reclaimId: 'x', writerFenceId: 'writers-joined', reservationRevision: s.reservations[0].revision } as ResourceAction]) {
        expectRejectedUnchanged(s, a, 'RESOURCE_BINDING_MISMATCH')
      }
    }
  })
  it('does not revive an expired reservation or grant a new deadline on any retry', () => {
    const s = admitted()
    expectRejectedUnchanged(s, append(), 'RESOURCE_WRITES_CLOSED', 80)
    expectRejectedUnchanged(s, { type: 'begin-finalize', binding: binding(), attemptId: 'original' }, 'RESOURCE_WRITES_CLOSED', 80)
    expectRejectedUnchanged(s, { type: 'stop', binding: binding(), reason: 'expired' }, 'NOT_EXPIRED', 79)
    const stopped = apply(s, { type: 'stop', binding: binding(), reason: 'expired' }, 80)
    expect(stopped.reservations[0].phase).toBe('stopped')
    expect(resourceTotals(stopped).global.heldBytes).toBe(80)
    expectRejectedUnchanged(stopped, { type: 'begin-reclaim', binding: binding(), reclaimId: 'x', writerFenceId: 'writers-joined', reservationRevision: stopped.reservations[0].revision }, 'ORIGINAL_OUTCOME_UNRESOLVED')
    expect(apply(stopped, { type: 'admit', admission: admission() }, 100)).toBe(stopped)
  })
  it.each(['cancelled', 'expired', 'process-crash'] as const)('keeps %s before/after dispatch pinned until authoritative resolution', reason => {
    const s = confirmed(apply(admitted(), append()))
    const stopped = apply(s, { type: 'stop', binding: binding(), reason }, 80)
    expect(stopped.reservations[0].phase).toBe('stopped')
    const dispatched = apply(s, { type: 'begin-finalize', binding: binding(), attemptId: 'original' })
    const unknown = apply(dispatched, { type: 'stop', binding: binding(), reason }, 80)
    expect(unknown.reservations[0].phase).toBe('unknown')
    for (const pinned of [stopped, unknown]) {
      expect(resourceTotals(pinned).global).toEqual(resourceTotals(s).global)
      expectRejectedUnchanged(pinned, { type: 'begin-reclaim', binding: binding(), reclaimId: 'unsafe', writerFenceId: 'writers-joined', reservationRevision: pinned.reservations[0].revision }, 'ORIGINAL_OUTCOME_UNRESOLVED')
      expectRejectedUnchanged(pinned, { type: 'release', binding: binding(), reclaimId: 'unsafe' }, 'RECLAIM_FENCE_REQUIRED')
      expectRejectedUnchanged(pinned, append(binding(), 'new'), 'RESOURCE_WRITES_CLOSED')
    }
  })
  it('pins a lost finalizer reply, replays its original attempt, never starts a replacement', () => {
    const a: ResourceAction = { type: 'begin-finalize', binding: binding(), attemptId: 'original' }
    const dispatched = apply(admitted(), a)
    expect(apply(dispatched, a)).toBe(dispatched)
    const unknown = apply(dispatched, { type: 'mark-unknown', binding: binding(), attemptId: 'original' })
    expect(apply(unknown, a)).toBe(unknown)
    expectRejectedUnchanged(unknown, { ...a, attemptId: 'replacement' }, 'FINALIZE_ATTEMPT_REUSED')
    expect(resolve(unknown, binding(), true).reservations[0].phase).toBe('committed')
  })
  it('rejects stale resolution and conflicting replay, requiring retained full original audit for commit', () => {
    const s = apply(admitted(), append())
    expectRejectedUnchanged(s, { type: 'resolve', binding: binding(), reservationRevision: s.reservations[0].revision - 1,
      evidence: { outcome: 'not-committed', fenceId: 'fence' } }, 'STALE_RESOLUTION_EVIDENCE')
    expectRejectedUnchanged(s, { type: 'resolve', binding: binding(), reservationRevision: s.reservations[0].revision,
      evidence: { outcome: 'committed', fenceId: 'fence', resultingRevision: 5 } } as ResourceAction, 'ORIGINAL_AUDIT_RETENTION_REQUIRED')
    const committed = resolve(s, binding(), true), evidence = committed.reservations[0].resolution!
    expect(apply(committed, { type: 'resolve', binding: binding(), reservationRevision: 0, evidence })).toBe(committed)
    expectRejectedUnchanged(committed, { type: 'resolve', binding: binding(), reservationRevision: committed.reservations[0].revision,
      evidence: { outcome: 'not-committed', fenceId: 'fence' } }, 'OUTCOME_EVIDENCE_CHANGED')
  })
  it.each([false, true])('uses deletion-intent then physical absence acknowledgements then idempotent release (committed=%s)', committed => {
    let s = confirmed(apply(admitted(), append()))
    s = resolve(s, binding(), committed)
    s = apply(s, { type: 'begin-reclaim', binding: binding(), reclaimId: 'cleanup', writerFenceId: 'writers-joined', reservationRevision: s.reservations[0].revision })
    expect(resourceTotals(s).global).toEqual({ heldBytes: 80, occupiedUpperBoundBytes: 10, confirmedPresentBytes: 10 })
    expectRejectedUnchanged(s, { type: 'release', binding: binding(), reclaimId: 'cleanup' }, 'PHYSICAL_REMOVAL_NOT_CONFIRMED')
    expectRejectedUnchanged(s, { type: 'confirm-removed', binding: binding(), reclaimId: 'other', allocationId: 'document:metadata' }, 'RECLAIM_FENCE_REQUIRED')
    s = apply(s, { type: 'confirm-removed', binding: binding(), reclaimId: 'cleanup', allocationId: 'document:metadata' })
    expect(resourceTotals(s).global).toEqual({ heldBytes: 80, occupiedUpperBoundBytes: 0, confirmedPresentBytes: 0 })
    const released = apply(s, { type: 'release', binding: binding(), reclaimId: 'cleanup' })
    expect(resourceTotals(released).global.heldBytes).toBe(0)
    expect(apply(released, { type: 'release', binding: binding(), reclaimId: 'cleanup' })).toBe(released)
    expect(apply(released, { type: 'admit', admission: admission() })).toBe(released)
    expectRejectedUnchanged(released, append(), 'RESOURCE_WRITES_CLOSED')
    expect(released.reservations[0].binding).toEqual(binding()) // permanent tombstone, no TTL invented
  })
  it('finds orphan, mismatched, missing confirmed and incomplete inventory without deleting or releasing', () => {
    const s = confirmed(apply(admitted(), append())), entries = inventory(s)
    const cases: [ResourceInventoryEntry[], boolean, string][] = [
      [[...entries, { ...entries[0], allocationId: 'untracked' }], true, 'orphan'],
      [[{ ...entries[0], sha256: J }], true, 'mismatch'], [[], true, 'missing-confirmed'], [entries, false, 'incomplete-inventory'],
    ]
    for (const [observed, complete, code] of cases) {
      const result = transitionResourceLedger(s, s.revision, { type: 'inventory', observedRevision: s.revision, entries: observed, complete }, 10)
      expect(result.inventoryIssues?.some(i => i.code === code)).toBe(true)
      expect(result.state.inventoryVerified).toBe(false)
      expect(resourceTotals(result.state)).toEqual(resourceTotals(s))
      expectRejectedUnchanged(result.state, append(binding(), 'new'), 'RESOURCE_RECONCILIATION_REQUIRED')
    }
    expect(inspectResourceInventory(s, entries, true)).toEqual([])
    expect(() => inspectResourceInventory(s, [...entries, ...entries], true)).toThrow('DUPLICATE_INVENTORY_ENTRY')
  })
  it('survives each cleanup crash cut while preserving occupied upper bound until absence is acknowledged', () => {
    const live = confirmed(apply(admitted(), append())), resolved = resolve(live), planned = apply(resolved, { type: 'begin-reclaim', binding: binding(), reclaimId: 'cleanup', writerFenceId: 'writers-joined', reservationRevision: resolved.reservations[0].revision })
    for (const cut of [live, resolved, planned]) {
      const restarted = restoreResourceLedger(JSON.parse(JSON.stringify(cut)))
      expect(resourceTotals(restarted)).toEqual(resourceTotals(cut))
      expect(restarted.inventoryVerified).toBe(false)
    }
    // Deletion may have happened but its DB acknowledgement was lost. Repeating
    // the same fenced absence acknowledgement works; an inventory alone does not.
    const afterDelete = apply(restoreResourceLedger(planned), { type: 'inventory', observedRevision: planned.revision + 1, complete: true, entries: [] })
    expect(afterDelete.inventoryVerified).toBe(false)
    expect(resourceTotals(afterDelete).global.heldBytes).toBe(80)
    const done = reclaim(afterDelete)
    expect(resourceTotals(done).global.heldBytes).toBe(0)
    expect(apply(done, { type: 'inventory', observedRevision: done.revision, complete: true, entries: [] }).inventoryVerified).toBe(true)
    expect(inspectResourceInventory(done, inventory(live), true)[0].code).toBe('orphan')
  })
  it('fails closed on corrupt restored counters, identities, offsets, phases and non-JSON authority', () => {
    const s = confirmed(apply(admitted(), append()))
    for (const mutate of [
      (v: ResourceLedger) => { v.reservations[0].reservedBytes = 1 },
      (v: ResourceLedger) => { v.reservations[0].allocations[0].chunks[0].offset = 1 },
      (v: ResourceLedger) => { v.reservations[0].allocations[0].removed = true },
      (v: ResourceLedger) => { v.reservations[0].phase = 'released' },
      (v: ResourceLedger) => { v.reservations[0].phase = 'unknown' },
      (v: ResourceLedger) => { v.reservations.push(structuredClone(v.reservations[0])) },
      (v: ResourceLedger) => { v.reservations[0].binding.authority.invalid = undefined },
    ]) { const bad = structuredClone(s); mutate(bad); expect(() => restoreResourceLedger(bad)).toThrow() }
  })

  it('requires a separate fresh physical writer fence and never reuses stale inventory evidence', () => {
    const live = apply(admitted(), append()), resolved = resolve(live)
    const begin: ResourceAction = { type: 'begin-reclaim', binding: binding(), reclaimId: 'cleanup', writerFenceId: 'physical-fence', reservationRevision: resolved.reservations[0].revision }
    expectRejectedUnchanged(resolved, { ...begin, writerFenceId: '' }, 'WRITER_FENCE_REQUIRED')
    expectRejectedUnchanged(resolved, { ...begin, reservationRevision: 0 }, 'STALE_WRITER_FENCE')
    const planned = apply(resolved, begin)
    expect(apply(planned, begin)).toBe(planned)
    expectRejectedUnchanged(planned, { ...begin, writerFenceId: 'replacement-fence' }, 'RECLAIM_ID_REUSED')
    const staleScan: ResourceAction = { type: 'inventory', observedRevision: live.revision, complete: true, entries: inventory(live) }
    expectRejectedUnchanged(resolved, staleScan, 'STALE_INVENTORY_EVIDENCE')
    const restarted = restoreResourceLedger(live)
    expectRejectedUnchanged(restarted, { type: 'begin-finalize', binding: binding(), attemptId: 'attempt' }, 'RESOURCE_RECONCILIATION_REQUIRED')
    const tampered = structuredClone(live); tampered.configuration = { enabled: false }
    expect(() => restoreResourceLedger(tampered)).toThrow('DISABLED_LEDGER_HAS_RESERVATIONS')
  })
  it('uses exact safe integers and refuses capacity sums that overflow JSON integer precision', () => {
    const limits = { commandBytes: Number.MAX_SAFE_INTEGER, ownerBytes: Number.MAX_SAFE_INTEGER, globalBytes: Number.MAX_SAFE_INTEGER }
    let s = initial({ enabled: true, limits })
    s = apply(s, { type: 'admit', admission: admission(binding(), Number.MAX_SAFE_INTEGER) })
    expectRejectedUnchanged(s, { type: 'admit', admission: admission(binding('b', 'owner-b'), 1) }, 'BYTE_COUNTER_OVERFLOW')
    for (const bytes of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => apply(s, append(binding(), 'x', 0, bytes))).toThrow()
  })
})

describe('serial model concurrency and differential accounting (not a DB concurrency proof)', () => {
  it('rejects a lost CAS and re-evaluates same-owner/global racing admissions under current totals', () => {
    const s = initial(), a = { type: 'admit', admission: admission() } as const
    const first = transitionResourceLedger(s, s.revision, a, 10).state
    expect(() => transitionResourceLedger(first, s.revision, a, 10)).toThrow('STALE_LEDGER_REVISION')
    for (const order of [[binding('a'), binding('b')], [binding('b'), binding('a')]]) {
      const winner = apply(initial(), { type: 'admit', admission: admission(order[0]) })
      expectRejectedUnchanged(winner, { type: 'admit', admission: admission(order[1]) }, 'OWNER_LIMIT_EXCEEDED')
    }
    // Two independently calculated successors of the same snapshot are NOT
    // mergeable. Only one revision-CAS may be persisted by the real adapter.
    const left = apply(s, a), right = apply(s, { type: 'admit', admission: admission(binding('other')) })
    expect(left.revision).toBe(right.revision)
    expect(() => transitionResourceLedger(left, s.revision, { type: 'admit', admission: right.reservations[0] }, 10)).toThrow('STALE_LEDGER_REVISION')
  })
  it('enumerates cancel/dispatch and cleanup/append orderings without an unsafe free-byte state', () => {
    const s = apply(admitted(), append()), b = binding()
    const cancel: ResourceAction = { type: 'stop', binding: b, reason: 'cancelled' }
    const dispatch: ResourceAction = { type: 'begin-finalize', binding: b, attemptId: 'original' }
    expectRejectedUnchanged(apply(s, cancel), dispatch, 'RESOURCE_WRITES_CLOSED')
    const unknown = apply(apply(s, dispatch), cancel)
    expect(unknown.reservations[0].phase).toBe('unknown')
    expect(resourceTotals(unknown).global.heldBytes).toBe(80)
    const cleanup = reclaim(resolve(unknown, b, true))
    expectRejectedUnchanged(cleanup, append(b, 'late'), 'RESOURCE_WRITES_CLOSED')
    expectRejectedUnchanged(resolve(s), append(b, 'late'), 'RESOURCE_WRITES_CLOSED')
  })
  it('differentially checks seeded mixed action traces against an independent flattened BigInt sum', () => {
    let seed = 0x647b3bbe
    const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
    let s = initial({ enabled: true, limits: { commandBytes: 100, ownerBytes: 300, globalBytes: 900 } })
    for (let i = 0; i < 12; i++) {
      const b = binding(`stage-${i}`, `owner-${i % 4}`)
      try { s = apply(s, { type: 'admit', admission: admission(b, 50 + rand() % 41) }) } catch { /* capacity denial */ }
    }
    for (let step = 0; step < 600; step++) {
      const r = s.reservations[rand() % s.reservations.length], b = r.binding, a = r.allocations[0]
      const operations: ResourceAction[] = [
        append(b, 'buffer', a?.chunks.reduce((n, c) => n + c.bytes, 0) ?? 0, 1 + rand() % 12),
        append(b, 'buffer', 0, a?.chunks[0].bytes ?? 5, a?.chunks[0].sha256 ?? H),
        { type: 'stop', binding: b, reason: 'cancelled' },
        { type: 'begin-finalize', binding: b, attemptId: 'attempt' },
        { type: 'resolve', binding: b, reservationRevision: r.revision, evidence: { outcome: 'not-committed', fenceId: 'fence' } },
        { type: 'begin-reclaim', binding: b, reclaimId: 'cleanup', writerFenceId: 'writers-joined', reservationRevision: s.reservations.find(r => r.binding.stageId === b.stageId)!.revision },
        { type: 'confirm-removed', binding: b, reclaimId: 'cleanup', allocationId: 'buffer' },
        { type: 'release', binding: b, reclaimId: 'cleanup' },
      ]
      const before = JSON.stringify(s)
      try { s = apply(s, operations[rand() % operations.length]) } catch { expect(JSON.stringify(s)).toBe(before) }
      assertResourceLedger(s)
      const total = resourceTotals(s)
      for (const [records, actual] of [[s.reservations, total.global], ...total.owners.map(o => [s.reservations.filter(r => r.binding.userId === o.userId), o.usage]),
        ...total.commands.map(c => [s.reservations.filter(r => r.binding.userId === c.userId && r.binding.commandId === c.commandId), c.usage])] as const) {
        let held = 0n, occupied = 0n, present = 0n
        for (const r of records as ResourceLedger['reservations']) {
          held += BigInt(r.currentHeldBytes)
          expect(BigInt(r.currentHeldBytes) + BigInt(r.releasedBytes)).toBe(BigInt(r.reservedBytes))
          for (const a of r.allocations) if (!a.removed) for (const c of a.chunks) { occupied += BigInt(c.bytes); if (c.status === 'present') present += BigInt(c.bytes) }
        }
        expect(actual).toEqual({ heldBytes: Number(held), occupiedUpperBoundBytes: Number(occupied), confirmedPresentBytes: Number(present) })
        expect(present <= occupied && occupied <= held).toBe(true)
      }
    }
  })
})
