import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAuthoritativeCommandExecutor } from '../gateway/authoritativeCommands.js'
import type { ApplicationGroup } from '../src/model.js'
import { applicationGroupGoverned } from '../src/applicationGovernance.js'
import * as core from '../src/domainCommands.js'
import { largeAbandonFixture } from './fixtures/workspaceRowsLargeCommand.js'
import { upgradeSnapshotToLatest } from '../src/snapshot.js'
import { applySemanticIntake } from '../src/semanticIntake.js'

const userId = '11111111-1111-4111-8111-111111111111', workspaceId = '22222222-2222-4222-8222-222222222222', epoch = '33333333-3333-4333-8333-333333333333'
afterEach(() => vi.restoreAllMocks())
function harness(count = 20) {
  let snapshot = JSON.parse(JSON.stringify(upgradeSnapshotToLatest(largeAbandonFixture().before))) as ReturnType<typeof upgradeSnapshotToLatest>, revision = 0
  snapshot.data.actions = snapshot.data.actions.slice(0, count)
  const ledger: any[] = []
  const before = () => ({ userId, workspaceId, epoch, revision, snapshot })
  let race: (() => void) | undefined
  const commit = vi.fn(async (_before, input) => {
    if (race) { const change = race; race = undefined; change(); revision++ }
    if (input.expectedRevision !== revision) return { outcome: 'CONFLICT' as const, workspaceId, revision, snapshot, receipt: {} }
    snapshot = JSON.parse(JSON.stringify(input.snapshot)); revision++
    const receipt = { ...input.receiptContext, commandId: input.commandId, operation: input.operation,
      status: 'COMMITTED', revision, undoAvailable: Boolean(input.compensation) }
    ledger.push({ command_id: input.commandId, operation: input.operation, payload_hash: input.payloadHash,
      resulting_revision: revision, status: 'COMMITTED', receipt, compensation: input.compensation ?? null })
    return { outcome: 'COMMITTED' as const, workspaceId, revision, resultingRevision: revision, snapshot, receipt }
  })
  const resumePrepared = vi.fn(async () => undefined as any)
  const executor = createAuthoritativeCommandExecutor({ supabaseUrl: 'https://synthetic.invalid', serviceRoleKey: 'synthetic',
    fetchImpl: vi.fn(async () => Response.json([{ id: workspaceId, user_id: userId, row_candidate_epoch: epoch }])),
    rowLayoutReader: { read: vi.fn(async () => before()), readIdentity: vi.fn(async () => ({ ...before(), schemaVersion: 4 })),
      readHistory: vi.fn(async (_u, _e, q) => ({ ...before(), rows: ledger.filter(row => q.mode === 'command'
        ? row.command_id === q.commandId : q.mode === 'after' ? row.resulting_revision > q.afterRevision : false) })) },
    rowLayoutWriter: { commit, resumePrepared },
  })
  const command = (id = 'stop-one', baseRevision = 0) => ({ commandId: id, baseRevision,
    command: { type: 'domain' as const, value: { commandId: id, kind: 'abandon_opportunity' as const, opportunityId: 'synthetic-opp' } } })
  const govern = (patch: Partial<ApplicationGroup> = { locked: true }) => {
    snapshot.data.opportunities[0]!.applicationGroupId = 'group'
    snapshot.data.applicationGroups = [{ id: 'group', name: 'Synthetic shared group', ...patch } as ApplicationGroup]
    snapshot = JSON.parse(JSON.stringify(upgradeSnapshotToLatest(snapshot)))
  }
  return { executor, command, govern, commit, resumePrepared, ledger, principal: { kind: 'first_party_web' as const, userId },
    snapshot: () => snapshot, revision: () => revision, race: (change: () => void) => { race = change }, advance: () => { revision++ } }
}

describe('stop-following authoritative shared-governance admission', () => {
  it.each([{ locked: true }, { total: 0 }, { remaining: 0 }, { rule: 'one application' }])('uses the semantic governance predicate: %j', async patch => {
    const h = harness(); h.govern(patch)
    expect(applicationGroupGoverned(h.snapshot(), h.snapshot().data.opportunities[0]!)).toBe(true)
    const before = structuredClone(h.snapshot())
    await expect(h.executor.execute(h.principal, h.command())).rejects.toMatchObject({ code: 'SHARED_GOVERNANCE_REQUIRED', retryable: false })
    expect(h.commit).not.toHaveBeenCalled(); expect(h.ledger).toHaveLength(0); expect(h.snapshot()).toEqual(before)
    const at = new Date('2030-01-01T00:00:00Z')
    const semantic = applySemanticIntake(before, { contractVersion: 1, inputId: 'web:shared',
      source: { kind: 'web', sourceId: 'todayaction-web', sourceRecordId: 'shared', observedAt: at.toISOString(), timezone: 'UTC' },
      statementMode: 'current_intent', originalText: '不再跟进', contextRefs: ['synthetic-opp'],
      candidates: [{ id: 'abandon', kind: 'abandon_opportunity', target: { opportunityId: 'synthetic-opp' }, objectConfidence: 'high', eventConfidence: 'high', evidenceRefs: [], sourceVersionRefs: [] }] },
    { authorized: true, workspaceRevision: 'txn:0', now: at })
    expect(semantic.status).toBe('DECISION_REQUIRED')
    expect(semantic.decisionRequests[0]?.reason).toBe('shared_governance')
    expect(semantic.snapshot.data.opportunities[0]?.participationStatus).not.toBe('abandoned')
  })
  it.each(['blank', 'missing', 'unrestricted'])('retains the original ungoverned semantics: %s', async mode => {
    const h = harness(); h.govern(mode === 'blank' ? { rule: '  ' } : {})
    if (mode === 'missing') h.snapshot().data.applicationGroups = []
    expect(applicationGroupGoverned(h.snapshot(), h.snapshot().data.opportunities[0]!)).toBe(false)
    if (mode === 'missing') {
      await expect(h.executor.execute(h.principal, h.command())).rejects.toThrow('引用了不存在的申请组')
      expect(h.commit).not.toHaveBeenCalled()
    } else expect((await h.executor.execute(h.principal, h.command())).outcome).toBe('COMMITTED')
  })
  it.each([20, 2100])('preserves a legal %i-action decision, compensation and exact original replay', async count => {
    const h = harness(count)
    const result = await h.executor.execute(h.principal, h.command())
    expect(result.outcome).toBe('COMMITTED'); expect(result.receipt?.undoAvailable).toBe(true)
    expect(h.ledger[0].compensation.operation).toBe('restore_participation')
    expect(h.snapshot().data.actions.every(action => action.status === 'skipped')).toBe(true)
    h.govern()
    const replay = await h.executor.execute(h.principal, h.command())
    expect(replay.outcome).toBe('ALREADY_APPLIED'); expect(replay.receipt).toEqual(result.receipt)
    expect(h.commit).toHaveBeenCalledTimes(1)
    const changed = h.command(); changed.command.value.opportunityId = 'another'
    await expect(h.executor.execute(h.principal, changed)).rejects.toMatchObject({ code: 'COMMAND_ID_REUSED' })
  })
  it('rechecks new governance after an actual revision/CAS race, before a second commit', async () => {
    const h = harness(); h.race(() => h.govern({ remaining: 0 }))
    await expect(h.executor.execute(h.principal, h.command())).rejects.toMatchObject({ code: 'SHARED_GOVERNANCE_REQUIRED' })
    expect(h.revision()).toBe(1); expect(h.commit).toHaveBeenCalledTimes(1); expect(h.ledger).toHaveLength(0)
    expect(h.snapshot().data.actions.every(action => action.status === 'todo')).toBe(true)
  })
  it('checks latest governance even when an old base has no overlapping intervening ledger scope', async () => {
    const h = harness(); h.advance(); h.govern()
    await expect(h.executor.execute(h.principal, h.command())).rejects.toMatchObject({ code: 'SHARED_GOVERNANCE_REQUIRED' })
    expect(h.commit).not.toHaveBeenCalled()
  })
  it('resumes an already admitted immutable command without new governance/reducer evaluation', async () => {
    const h = harness(2100); h.govern()
    const receipt = { commandId: 'stop-one', operation: 'domain:abandon_opportunity', status: 'COMMITTED' }
    h.resumePrepared.mockResolvedValue({ outcome: 'COMMITTED', workspaceId, revision: 1, snapshot: h.snapshot(), receipt })
    const reducer = vi.spyOn(core, 'applyUserDomainCommand').mockImplementation(() => { throw new Error('CORE_MUST_NOT_RUN') })
    expect((await h.executor.execute(h.principal, h.command())).receipt).toEqual(receipt)
    expect(reducer).not.toHaveBeenCalled(); expect(h.commit).not.toHaveBeenCalled(); expect(h.resumePrepared).toHaveBeenCalledTimes(1)
  })
  it('rejects a first-party confirmation override and scopes the new source guard to first party', async () => {
    const h = harness(); h.govern()
    const extra = { ...h.command(), confirmed: true }
    await expect(h.executor.execute(h.principal, extra)).rejects.toBeDefined()
    expect(h.ledger).toHaveLength(0)
    // This guard intentionally does not broaden or reinterpret delegated authority.
    const source = await import('node:fs')
    expect(source.readFileSync(new URL('../gateway/authoritativeCommands.ts', import.meta.url), 'utf8')).toContain("principal.kind === 'first_party_web' && target && applicationGroupGoverned")
  })
})
