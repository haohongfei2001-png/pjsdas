import { unknownDeadlineWorkspace } from './fixtures/unknownDeadlineWorkspace.js'
import { describe, expect, it, vi } from 'vitest'
import { createAuthoritativeCommandExecutor } from '../gateway/authoritativeCommands.js'
import { createTransactionalWorkspaceStore } from '../gateway/transactionalWorkspaceStore.js'
import { assertPlanningManagementGrant, type PlanningManagementGrant } from '../gateway/planningManagementAccess.js'
import { createPlanningManagementTools } from '../gateway/planningManagementTools.js'
import { getPlanningManagementRead } from '../src/planningManagement.js'
import { upgradeSnapshotToLatest, type PJSDASSnapshot } from '../src/snapshot.js'
const owner = '00000000-0000-4000-8000-000000000001', client = '00000000-0000-4000-8000-000000000002', grantId = '00000000-0000-4000-8000-000000000003'
const principal = { kind: 'delegated_mcp' as const, userId: owner, clientId: client }
const grant: PlanningManagementGrant = { id: grantId, revision: 1, userId: owner, clientId: client, consentVersion: 4, capability: 'workspace.planning.manage', grantedAt: '2026-10-01T00:00:00Z' }
function fixture(): PJSDASSnapshot { return upgradeSnapshotToLatest({ schema: 'pjsdas-local-snapshot', version: 4, exportedAt: '2026-10-02T00:00:00Z', data: { opportunities: [{ id: 'opp-a', company: 'Synthetic', role: 'Engineer', processStage: 'screening', currentStageLabel: 'User application', roleType: 'core', early: false, opportunityValue: 70, fitScore: 80, importedAt: '2026-10-01T00:00:00Z' }], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], scheduleNodes: [], timeline: [] } }) }
async function command(snapshot = fixture()) { const read = await getPlanningManagementRead(snapshot); return { commandId: 'synthetic-v4-command', baseRevision: 0, command: { type: 'planning_management', value: { operations: [{ kind: 'patch_time_preferences', expectedFingerprint: read.timePreferences.fingerprint, patch: { defaultDailyMinutes: 60 } }] } } } }
function storeFixture(initial = fixture()) {
  let snapshot = structuredClone(initial), revision = 0
  const records: Record<string, any>[] = []
  const posts: any[] = []
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input)); const user = url.searchParams.get('user_id')
    if ((init?.method ?? 'GET') === 'POST') {
      const body = JSON.parse(String(init?.body)); posts.push({ path: url.pathname, body })
      snapshot = body.target_snapshot; revision++
      const receipt = { ...body.target_receipt_context }
      records.push({ command_id: body.target_command_id, operation: body.target_operation, payload_hash: body.target_payload_hash, resulting_revision: revision, receipt, compensation: body.target_compensation, user_id: owner, status: 'COMMITTED' })
      return Response.json([{ outcome: 'COMMITTED', workspace_id: 'fixture-workspace', revision, snapshot, receipt }])
    }
    expect(user).toBe(`eq.${owner}`)
    if (url.pathname.endsWith('pjsdas_workspaces')) return Response.json([{ id: 'fixture-workspace', user_id: owner, snapshot, revision, schema_version: 4 }])
    if (url.pathname.endsWith('pjsdas_command_ledger')) {
      const selector = url.searchParams.get('command_id')
      const after = url.searchParams.get('resulting_revision')
      return Response.json(records.filter(row => (!selector || selector === `eq.${row.command_id}`) && (!after || row.resulting_revision > Number(after.slice(3)))))
    }
    throw new Error(`Unexpected synthetic read ${url.pathname}`)
  })
  return { fetchImpl, posts, records, snapshot: () => snapshot, options: { supabaseUrl: 'https://example.invalid', serviceRoleKey: 'fixture-only', fetchImpl } }
}
describe('v4 grant discrimination and atomic kernel', () => {
  it.each([undefined, { ...grant, consentVersion: 2, capability: 'workspace.manage' }, { ...grant, consentVersion: 3, capability: 'workspace.opportunity.manage' }, { ...grant, consentVersion: 4, capability: 'workspace.manage' }, { ...grant, userId: client }, { ...grant, clientId: owner }, { ...grant, revokedAt: '2026-10-02T00:00:00Z' }, { ...grant, revision: 0 }, { ...grant, grantedAt: '2999-01-01T00:00:00Z' }])('rejects absent/foreign/v2/revoked grants %#', candidate => { expect(() => assertPlanningManagementGrant(principal, candidate as PlanningManagementGrant)).toThrow(/authorization/) })
  it('does not treat first-party sessions as delegated planning consent', () => {
    expect(() => assertPlanningManagementGrant({ ...principal, kind: 'first_party' } as any, grant)).toThrow(/authorization/)
  })
  it('default-denies v4 before database access even with a valid v2 resolver', async () => {
    const f = storeFixture(); const executor = createAuthoritativeCommandExecutor({ ...f.options, resolveBusinessManagementGrant: async () => ({ ...grant, consentVersion: 2, capability: 'workspace.manage' }) })
    await expect(executor.execute(principal, await command())).rejects.toThrow(/version-4/)
    expect(f.fetchImpl).not.toHaveBeenCalled()
  })
  it('commits and replays once with a distinct RPC, exact proof and retained compensation', async () => {
    const f = storeFixture(); const executor = createAuthoritativeCommandExecutor({ ...f.options, resolvePlanningManagementGrant: async () => grant }); const input = await command()
    expect((await executor.execute(principal, input)).outcome).toBe('COMMITTED')
    expect((await executor.execute(principal, input)).outcome).toBe('ALREADY_APPLIED')
    expect(f.posts).toHaveLength(1)
    expect(f.posts[0]).toMatchObject({ path: '/rest/v1/rpc/pjsdas_commit_planning_workspace_v1', body: { target_grant_id: grantId, target_grant_revision: 1, target_user_id: owner, target_client_id: client, target_operation: 'planning_management' } })
    expect(f.records[0].compensation.operation).toBe('planning_management_restore')
    await expect(executor.execute(principal, { ...input, command: { ...input.command, value: { operations: [{ ...input.command.value.operations[0], patch: { defaultDailyMinutes: 90 } }] } } })).rejects.toThrow(/reused/)
  })
  it('preserves raw legacy dates and cancelled nodes through gateway commit and restore', async () => {
    const initial = unknownDeadlineWorkspace(1)
    initial.data.actions[0].dueAt = '2026-08-27T15:59:59Z'
    initial.data.actions[0].timingMode = 'deadline'
    const protectedData = (snapshot: PJSDASSnapshot) => Object.fromEntries(Object.entries(snapshot.data).filter(([key]) => !['decisionRules', 'timePlanning', 'timeline'].includes(key)))
    const f = storeFixture(initial)
    const fetchImpl: typeof fetch = async (input, init) => {
      if (init?.method === 'POST') expect(protectedData(JSON.parse(String(init.body)).target_snapshot)).toEqual(protectedData(initial))
      return f.fetchImpl(input, init)
    }
    const executor = createAuthoritativeCommandExecutor({ ...f.options, fetchImpl, resolvePlanningManagementGrant: async () => grant })
    const applied = await executor.execute(principal, await command(initial))
    expect(applied.outcome).toBe('COMMITTED')
    expect(protectedData(f.snapshot())).toEqual(protectedData(initial))
    const restored = await executor.undo(principal, { commandId: 'raw-planning-restore', targetCommandId: 'synthetic-v4-command', expectedCompensationFingerprint: applied.result!.compensationFingerprint })
    expect(restored.outcome).toBe('COMMITTED')
    expect(protectedData(f.snapshot())).toEqual(protectedData(initial))
  })
  it.each(['revoke', 'revision', 'replacement'] as const)('refuses %s between admission and commit', async change => {
    const f = storeFixture(); let reads = 0
    const executor = createAuthoritativeCommandExecutor({ ...f.options, resolvePlanningManagementGrant: async () => ++reads === 1 ? grant : change === 'revoke' ? undefined : { ...grant, ...(change === 'revision' ? { revision: 2 } : { id: '00000000-0000-4000-8000-000000000004' }) } })
    await expect(executor.execute(principal, await command())).rejects.toThrow(/authorization|changed/); expect(f.posts).toEqual([])
  })
  it('binds the immutable admission proof across CAS retries', async () => {
    const f = storeFixture(); let currentGrant = { ...grant }; let posts = 0
    const fetchImpl: typeof fetch = async (input, init) => {
      if (init?.method === 'POST') { posts++; currentGrant.revision = 2; return Response.json([{ outcome: 'CONFLICT', workspace_id: 'fixture-workspace', revision: 1, snapshot: fixture() }]) }
      return f.fetchImpl(input, init)
    }
    const executor = createAuthoritativeCommandExecutor({ ...f.options, fetchImpl, resolvePlanningManagementGrant: async () => currentGrant })
    await expect(executor.execute(principal, await command())).rejects.toThrow(/changed/); expect(posts).toBe(1)
  })
  it('requires exact owner-ledger compensation proof for restore and uses the same grant lock', async () => {
    const f = storeFixture(); const executor = createAuthoritativeCommandExecutor({ ...f.options, resolvePlanningManagementGrant: async () => grant })
    const applied = await executor.execute(principal, await command()); const undo = { commandId: 'synthetic-v4-restore', targetCommandId: 'synthetic-v4-command', expectedCompensationFingerprint: applied.result!.compensationFingerprint }
    await expect(executor.undo(principal, { ...undo, expectedCompensationFingerprint: 'f'.repeat(64) })).rejects.toThrow(/fingerprint/)
    expect((await executor.undo(principal, undo)).outcome).toBe('COMMITTED')
    expect(f.posts[1].path).toBe('/rest/v1/rpc/pjsdas_commit_planning_workspace_v1'); expect(f.snapshot().data.timePlanning).toBeUndefined()
    expect((await executor.undo(principal, undo)).outcome).toBe('ALREADY_APPLIED')
    expect(f.posts).toHaveLength(2)
  })
  it('withholds undo replay after a v4 grant is revoked', async () => {
    const f = storeFixture(); let current: PlanningManagementGrant | undefined = grant
    const executor = createAuthoritativeCommandExecutor({ ...f.options, resolvePlanningManagementGrant: async () => current })
    const applied = await executor.execute(principal, await command()); const undo = { commandId: 'synthetic-v4-restore', targetCommandId: 'synthetic-v4-command', expectedCompensationFingerprint: applied.result!.compensationFingerprint }
    await executor.undo(principal, undo); current = undefined
    await expect(executor.undo(principal, undo)).rejects.toThrow(/authorization/); expect(f.posts).toHaveLength(2)
  })
  it('refuses mismatched v2/v4 RPC proof and never falls back after SQL denial', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ code: '42501' }, { status: 403 }))
    const store = createTransactionalWorkspaceStore({ supabaseUrl: 'https://example.invalid', serviceRoleKey: 'fixture-only', fetchImpl })
    const commit = { userId: owner, clientId: client, principalKind: 'delegated_mcp' as const, commandId: 'synthetic-command', operation: 'planning_management', payloadHash: 'hash', expectedRevision: 0, snapshot: fixture(), schemaVersion: 4, receiptContext: {}, managementAuthorization: { grantId, grantRevision: 1 } }
    await expect(store.commitAuthoritativeForUser(commit)).rejects.toThrow(/version/); expect(fetchImpl).not.toHaveBeenCalled()
    await expect(store.commitAuthoritativeForUser({ ...commit, managementAuthorization: { ...commit.managementAuthorization, consentVersion: 4 } })).rejects.toThrow(/before commit/); expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String(fetchImpl.mock.calls[0][0])).toContain('pjsdas_commit_planning_workspace_v1')
  })
})

describe('source-only planning tool adapter', () => {
  function tools(read: () => Promise<any>, resolveGrant: () => Promise<PlanningManagementGrant | undefined>) {
    return createPlanningManagementTools({ principal, source: { read }, resolveGrant, createExecutor: () => { throw new Error('No mutation expected') } })
  }
  it('requires a v4 grant before reading workspace data', async () => {
    const read = vi.fn(async () => { throw new Error('No read expected') })
    const result = await tools(read, async () => undefined).invoke('get_planning_management', {})
    expect(result.structuredContent).toMatchObject({ code: 'AUTH_FORBIDDEN' }); expect(read).not.toHaveBeenCalled()
  })
  it.each(['foreign-workspace', 'revoke', 'replacement'] as const)('withholds a read on %s', async change => {
    let active: PlanningManagementGrant | undefined = grant
    const read = async () => { if (change === 'revoke') active = undefined; if (change === 'replacement') active = { ...grant, revision: 2 }; return { snapshot: fixture(), context: { workspaceOwnerUserId: change === 'foreign-workspace' ? client : owner, workspaceVersion: 'txn:0' } } }
    const result = await tools(read, async () => active).invoke('get_planning_management', {})
    expect(result.isError).toBe(true); expect(result.structuredContent).toMatchObject({ code: 'AUTH_FORBIDDEN' }); expect(JSON.stringify(result)).not.toContain('Engineer')
  })
  it('returns exact configuration proofs without ledger contents', async () => {
    const result = await tools(async () => ({ snapshot: fixture(), context: { workspaceOwnerUserId: owner, workspaceVersion: 'txn:0' } }), async () => grant).invoke('get_planning_management', {})
    expect(result.structuredContent).toMatchObject({ consentVersion: 4, capability: 'workspace.planning.manage', data: { timePreferences: { raw: null } } }); expect(JSON.stringify(result)).not.toContain('planning_management_restore')
  })
})
