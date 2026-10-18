import { describe, expect, it } from 'vitest'
import { applySemanticIntake, applySemanticCompensation, semanticCandidateFactKey } from '../src/semanticIntake.js'
import { applyUserDomainCommand } from '../src/domainCommands.js'
import { latestScheduleOccurrence } from '../src/scheduleNodes.js'
import { createSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'
import { opportunity } from '../e2e/fixtures/todayWorkspace.js'
import type { SemanticIntakeObservation, SemanticIntakeReceipt } from '../src/model.js'

const NOW = new Date('2026-09-21T12:40:00Z')
const temporal = { shape: 'availability_window' as const, precision: 'datetime' as const, timezone: 'Asia/Shanghai',
  startAt: '2026-09-23T18:00:00+08:00', endAt: '2026-09-23T20:00:00+08:00', latestStartAt: '2026-09-23T18:20:00+08:00',
  resolutionBasis: 'source_explicit' as const }
function seed() {
  const s = createSnapshot({ opportunities: [opportunity('job', 'Example Co', 'Product Manager')],
    processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [] })
  return applyUserDomainCommand(s, { commandId: 'original-fixed-event', kind: 'record_process_event', opportunityId: 'job',
    eventType: 'written_test_invite', occurredAt: '2026-09-21T12:00:00Z', temporal: { shape: 'fixed_range', precision: 'datetime',
      timezone: temporal.timezone, startAt: temporal.startAt, resolutionBasis: 'source_explicit' } }, new Date('2026-09-21T12:00:00Z')).snapshot
}
function current(s: PJSDASSnapshot) { return latestScheduleOccurrence(s.data.scheduleNodes!, s.data.scheduleNodes![0]!.occurrenceId)! }
function notice(s: PJSDASSnapshot, id = 'first-window-notice', latestStartAt = temporal.latestStartAt, sourceId = 'source-one', assertedAt = '2026-09-21T12:28:00Z'): SemanticIntakeObservation {
  return { contractVersion: 1, inputId: id, source: { kind: 'mcp', sourceId, sourceRecordId: id, sourceVersion: 'v1',
    observedAt: assertedAt, assertedAt, timezone: temporal.timezone }, statementMode: 'assertion', candidates: [{
    id: 'window-reschedule', kind: 'occurrence_rescheduled', target: { occurrenceId: current(s).occurrenceId },
    temporal: { ...temporal, latestStartAt }, objectConfidence: 'high', eventConfidence: 'high', temporalConfidence: 'high',
    evidenceRefs: [id], sourceVersionRefs: ['v1'] }] }
}
function apply(s: PJSDASSnapshot, o: SemanticIntakeObservation) { return applySemanticIntake(s, o, { authorized: true, workspaceRevision: 'txn:1', now: NOW }) }
function legacyReceipt(receipt: SemanticIntakeReceipt) {
  const strip = (key: string) => key.replace(/\|latestStartAt:[^|]+$/, '')
  if (receipt.factKeys) receipt.factKeys = receipt.factKeys.map(strip)
  if (receipt.mutatedFactKeys) receipt.mutatedFactKeys = receipt.mutatedFactKeys.map(strip)
  if (receipt.factMutationObjects) receipt.factMutationObjects = Object.fromEntries(Object.entries(receipt.factMutationObjects).map(([key, refs]) => [strip(key), refs]))
}

describe('latest-start fact identity and replay', () => {
  it('distinguishes only-latest changes while normalizing equivalent instants', () => {
    const s = seed(), a = notice(s), b = notice(s, 'second-window-notice', '2026-09-23T18:40:00+08:00'), same = notice(s, 'same-window-notice', '2026-09-23T10:20:00Z')
    expect(semanticCandidateFactKey(s, a.candidates[0]!)).not.toBe(semanticCandidateFactKey(s, b.candidates[0]!))
    expect(semanticCandidateFactKey(s, a.candidates[0]!)).toBe(semanticCandidateFactKey(s, same.candidates[0]!))
  })

  it('applies a cross-source latest correction to the same occurrence without rewriting historical facts or receipts', () => {
    const s = seed(), first = apply(s, notice(s)), old = structuredClone(first.snapshot)
    const next = apply(first.snapshot, notice(first.snapshot, 'later-window-notice', '2026-09-23T18:40:00+08:00', 'source-two', '2026-09-21T12:29:00Z'))
    expect(next.status).toBe('APPLIED')
    expect(current(next.snapshot)).toMatchObject({ occurrenceId: current(old).occurrenceId, version: 3,
      temporal: { ...temporal, latestStartAt: '2026-09-23T18:40:00+08:00' } })
    expect(next.snapshot.data.scheduleNodes?.find(n => n.id === current(old).id)?.temporal).toEqual(current(old).temporal)
    expect(next.snapshot.data.semanticReceipts?.find(r => r.id === first.receipt!.id)).toEqual(first.receipt)
    expect(next.snapshot.data.processEvents).toHaveLength(old.data.processEvents.length)
    expect(next.snapshot.data.actions).toHaveLength(old.data.actions.length)
    expect(first.snapshot).toEqual(old)
  })

  it('does not mutate the business state on exact replay or an equivalent cross-source fact', () => {
    const s = seed(), input = notice(s), first = apply(s, input)
    const replay = apply(first.snapshot, input)
    expect(replay.status).toBe('ALREADY_APPLIED'); expect(replay.changed).toBe(false)
    expect(replay.snapshot).toEqual(first.snapshot)
    const duplicate = apply(first.snapshot, notice(first.snapshot, 'copied-window-notice', '2026-09-23T10:20:00Z', 'source-two'))
    expect(duplicate.snapshot.data.scheduleNodes).toEqual(first.snapshot.data.scheduleNodes)
    expect(duplicate.receipt?.mutatedFactKeys ?? []).toEqual([])
  })

  it('preserves legacy same-notice replay and admits a cross-source duplicate only with the exact current receipt node proof', () => {
    const s = seed(), input = notice(s), first = apply(s, input), legacy = structuredClone(first.snapshot)
    legacy.data.semanticReceipts!.forEach(legacyReceipt)
    const oldReceipts = structuredClone(legacy.data.semanticReceipts)
    expect(apply(legacy, input).status).toBe('ALREADY_APPLIED')
    const duplicate = apply(legacy, notice(legacy, 'legacy-copy-notice', temporal.latestStartAt, 'source-two'))
    expect(duplicate.snapshot.data.scheduleNodes).toEqual(legacy.data.scheduleNodes)
    expect(duplicate.snapshot.data.semanticReceipts?.slice(0, oldReceipts!.length)).toEqual(oldReceipts)
    const correction = apply(legacy, notice(legacy, 'legacy-new-value', '2026-09-23T18:40:00+08:00', 'source-two', '2026-09-21T12:29:00Z'))
    expect(current(correction.snapshot).temporal.latestStartAt).toBe('2026-09-23T18:40:00+08:00')
    expect(correction.snapshot.data.semanticReceipts?.slice(0, oldReceipts!.length)).toEqual(oldReceipts)
  })

  it('does not let a late old source or cancelled occurrence recover an old latest-start constraint', () => {
    const s = seed(), first = apply(s, notice(s)), newer = apply(first.snapshot, notice(first.snapshot,
      'newest-window-notice', '2026-09-23T18:40:00+08:00', 'source-two', '2026-09-21T12:30:00Z'))
    const late = apply(newer.snapshot, notice(newer.snapshot, 'late-old-window', temporal.latestStartAt, 'source-three', '2026-09-21T12:29:00Z'))
    expect(late.status).toBe('DECISION_REQUIRED')
    expect(current(late.snapshot).temporal.latestStartAt).toBe('2026-09-23T18:40:00+08:00')
    expect(late.snapshot.data.scheduleNodes).toEqual(newer.snapshot.data.scheduleNodes)
    const cancelled = applyUserDomainCommand(newer.snapshot, { commandId: 'cancel-window-occurrence', kind: 'cancel_occurrence', occurrenceId: current(newer.snapshot).occurrenceId }, NOW)
    const after = apply(cancelled.snapshot, notice(cancelled.snapshot, 'after-cancel-window', '2026-09-23T18:50:00+08:00', 'source-four', NOW.toISOString()))
    expect(current(after.snapshot).state).toBe('cancelled')
    expect(after.snapshot.data.scheduleNodes).toEqual(cancelled.snapshot.data.scheduleNodes)
  })

  it('keeps absent-field keys byte compatible and never makes all legacy/new latest keys equivalent', () => {
    const s = seed(), input = notice(s), candidate = input.candidates[0]!
    if (candidate.kind !== 'occurrence_rescheduled') throw new Error('fixture')
    delete candidate.temporal.latestStartAt
    const key = semanticCandidateFactKey(s, candidate)
    expect(key).toBe(`occurrence_rescheduled|occurrence:${current(s).occurrenceId}|["availability_window","datetime","2026-09-23T10:00:00.000Z","2026-09-23T12:00:00.000Z","",""]`)
  })

  it('distinguishes latest-start in process-event keys and preserves equivalent legacy duplicates', () => {
    const s = seed(), base = notice(s)
    const event = (latestStartAt: string): SemanticIntakeObservation => ({ ...base, inputId: `new-window-${latestStartAt}`,
      source: { ...base.source, sourceRecordId: `new-window-${latestStartAt}` }, candidates: [{ id: 'new-written-window', kind: 'process_event',
        target: { opportunityId: 'job' }, eventType: 'written_test_invite', objectConfidence: 'high', eventConfidence: 'high',
        temporalConfidence: 'high', temporal: { ...temporal, latestStartAt }, evidenceRefs: ['synthetic-window'], sourceVersionRefs: [] }] })
    const input = event(temporal.latestStartAt), other = event('2026-09-23T18:40:00+08:00')
    expect(semanticCandidateFactKey(s, input.candidates[0]!)).not.toBe(semanticCandidateFactKey(s, other.candidates[0]!))
    const first = apply(s, input), legacy = structuredClone(first.snapshot)
    legacy.data.semanticReceipts!.forEach(legacyReceipt)
    const copy = { ...input, inputId: 'legacy-event-copy', source: { ...input.source, sourceId: 'source-two', sourceRecordId: 'legacy-event-copy' } }
    const duplicate = apply(legacy, copy)
    expect(duplicate.snapshot.data.processEvents).toEqual(legacy.data.processEvents)
    expect(duplicate.receipt?.mutatedFactKeys ?? []).toEqual([])
  })

  it.each(['missing_current_ref', 'invalidated_receipt'] as const)('never treats %s as legacy duplicate proof', damage => {
    const s = seed(), first = apply(s, notice(s)), legacy = structuredClone(first.snapshot)
    legacy.data.semanticReceipts!.forEach(legacyReceipt)
    const receipt = legacy.data.semanticReceipts![0]!, key = receipt.factKeys![0]!
    if (damage === 'missing_current_ref') receipt.factMutationObjects![key] = receipt.factMutationObjects![key]!.filter(ref => ref.type !== 'schedule_node' || ref.id !== current(legacy).id)
    else receipt.factInvalidations = [{ factKey: key, invalidatedAt: NOW.toISOString(), invalidatedByReceiptId: 'synthetic-invalidation' }]
    const candidate = notice(legacy, `unproved-${damage}`, temporal.latestStartAt, 'source-two', NOW.toISOString())
    const result = apply(legacy, candidate)
    expect(result.compensation?.payload.domainCompensations).toHaveLength(1)
    expect(current(result.snapshot).version).toBe(3)
    expect(result.snapshot.data.semanticReceipts?.find(r => r.id === receipt.id)).toEqual(receipt)
  })

  it('replays the same record under a new input ID and never revives it after cancellation', () => {
    const s = seed(), input = notice(s), first = apply(s, input)
    const renamed = { ...input, inputId: 'new-wrapper-same-record' }
    expect(apply(first.snapshot, renamed).status).toBe('ALREADY_APPLIED')
    const cancelled = applyUserDomainCommand(first.snapshot, { commandId: 'cancel-before-replay', kind: 'cancel_occurrence', occurrenceId: current(first.snapshot).occurrenceId }, NOW).snapshot
    const replay = apply(cancelled, renamed)
    expect(replay.status).toBe('ALREADY_APPLIED'); expect(replay.changed).toBe(false)
    expect(current(replay.snapshot).state).toBe('cancelled')
  })

  it('does not follow a legacy receipt historical node to claim a newer current latest-start fact', () => {
    const s = seed(), first = apply(s, notice(s)), legacy = structuredClone(first.snapshot)
    legacy.data.semanticReceipts!.forEach(legacyReceipt)
    const changed = applyUserDomainCommand(legacy, { commandId: 'independent-latest-change', kind: 'reschedule_occurrence',
      occurrenceId: current(legacy).occurrenceId, temporal: { ...temporal, latestStartAt: '2026-09-23T18:40:00+08:00' } }, NOW).snapshot
    const oldNotice = apply(changed, notice(changed, 'old-proof-new-notice', temporal.latestStartAt, 'source-three', '2026-09-21T12:29:00Z'))
    expect(oldNotice.status).toBe('DECISION_REQUIRED')
    expect(oldNotice.snapshot.data.scheduleNodes).toEqual(changed.data.scheduleNodes)
  })

  it('retains legacy Undo dependencies and refuses value-unknown legacy recovery without rewriting history', () => {
    const s = seed(), input = notice(s), first = apply(s, input), legacy = structuredClone(first.snapshot)
    legacy.data.semanticReceipts!.forEach(legacyReceipt)
    const duplicateInput = notice(legacy, 'legacy-dependent-copy', temporal.latestStartAt, 'source-two')
    const duplicate = apply(legacy, duplicateInput)
    expect(duplicate.receipt?.factKeys).toContain(legacy.data.semanticReceipts![0]!.factKeys![0])
    const undone = applySemanticCompensation(duplicate.snapshot, first.compensation!, new Date('2026-09-21T12:45:00Z'))
    expect(current(undone).temporal.latestStartAt).toBeUndefined()
    expect(undone.data.semanticReceipts?.find(r => r.id === duplicate.receipt!.id)?.factInvalidations?.length).toBeGreaterThan(0)
    const replay = apply(undone, input)
    expect(replay.status).toBe('NO_WRITE'); expect(replay.changed).toBe(false)
    expect(replay.summary).toContain('latest-start')
    expect(replay.snapshot).toEqual(undone)
  })

  it('applies an explicit latest-start removal instead of borrowing an older absent-field receipt', () => {
    const s = seed(), without = notice(s)
    if (without.candidates[0]!.kind !== 'occurrence_rescheduled') throw new Error('fixture')
    delete without.candidates[0]!.temporal.latestStartAt
    const first = apply(s, without)
    const added = apply(first.snapshot, notice(first.snapshot, 'add-explicit-latest', temporal.latestStartAt, 'source-two', '2026-09-21T12:29:00Z'))
    const remove = notice(added.snapshot, 'remove-explicit-latest', temporal.latestStartAt, 'source-three', '2026-09-21T12:30:00Z')
    if (remove.candidates[0]!.kind !== 'occurrence_rescheduled') throw new Error('fixture')
    delete remove.candidates[0]!.temporal.latestStartAt
    const removed = apply(added.snapshot, remove)
    expect(removed.status).toBe('APPLIED')
    expect(current(removed.snapshot).version).toBe(4)
    expect(current(removed.snapshot).temporal.latestStartAt).toBeUndefined()
    expect(removed.compensation?.payload.domainCompensations).toHaveLength(1)
    expect(removed.snapshot.data.scheduleNodes?.find(n => n.id === current(added.snapshot).id)?.temporal.latestStartAt).toBe(temporal.latestStartAt)
  })

  it('reports unresolved legacy latest recovery even when another independent fact is restored', () => {
    const s = seed(), input = notice(s)
    input.candidates.push({ id: 'independent-manual', kind: 'manual_action', title: 'Review synthetic portfolio notes',
      objectConfidence: 'high', eventConfidence: 'high', evidenceRefs: [], sourceVersionRefs: [] })
    const first = apply(s, input), legacy = structuredClone(first.snapshot)
    legacy.data.semanticReceipts!.forEach(legacyReceipt)
    const undone = applySemanticCompensation(legacy, first.compensation!, new Date('2026-09-21T12:45:00Z'))
    const replay = apply(undone, input)
    expect(replay.status).toBe('APPLIED')
    expect(replay.snapshot.data.actions.some(a => a.title === 'Review synthetic portfolio notes')).toBe(true)
    expect(current(replay.snapshot).temporal.latestStartAt).toBeUndefined()
    expect(replay.compensation?.payload.domainCompensations).toHaveLength(1)
    expect(replay.coverageDebtCount).toBe(1)
    expect(replay.summary).toContain('latest-start')
    expect(replay.receipt?.summary).toContain('latest-start')
    const again = apply(replay.snapshot, input)
    expect(again.status).toBe('NO_WRITE'); expect(again.changed).toBe(false)
    expect(again.coverageDebtCount).toBe(1)
    expect(again.summary).toContain('latest-start')
    expect(again.snapshot.data.actions.filter(a => a.title === 'Review synthetic portfolio notes')).toHaveLength(1)
    expect(again.snapshot).toEqual(replay.snapshot)
  })
})
