import { describe, expect, it, vi } from 'vitest'
import { createAuthoritativeCommandExecutor } from '../gateway/authoritativeCommands.js'
import { createTransactionalWorkspaceStore } from '../gateway/transactionalWorkspaceStore.js'
import { assertOpportunityManagementGrant, type OpportunityManagementGrant } from '../gateway/opportunityManagementAccess.js'
import { createOpportunityManagementTools } from '../gateway/opportunityManagementTools.js'
import { readOpportunityManagement } from '../src/opportunityManagement.js'
import { upgradeSnapshotToLatest, type PJSDASSnapshot } from '../src/snapshot.js'
const owner = '00000000-0000-4000-8000-000000000001', client = '00000000-0000-4000-8000-000000000002', grantId = '00000000-0000-4000-8000-000000000003'
const principal = { kind: 'delegated_mcp' as const, userId: owner, clientId: client }
const grant: OpportunityManagementGrant = { id: grantId, revision: 1, userId: owner, clientId: client, consentVersion: 3, capability: 'workspace.opportunity.manage', grantedAt: '2026-10-01T00:00:00Z' }
function fixture(): PJSDASSnapshot { return upgradeSnapshotToLatest({ schema: 'pjsdas-local-snapshot', version: 4, exportedAt: '2026-10-02T00:00:00Z', data: { opportunities: [{ id: 'opp-a', company: 'Synthetic', role: 'Engineer', processStage: 'screening', currentStageLabel: 'User application', roleType: 'core', early: false, opportunityValue: 70, fitScore: 80, importedAt: '2026-10-01T00:00:00Z' }], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], scheduleNodes: [], timeline: [] } }) }
async function command(snapshot = fixture()) { const read = await readOpportunityManagement(snapshot, 'opp-a'); return { commandId: 'synthetic-v3-command', baseRevision: 0, command: { type: 'opportunity_management', value: { operations: [{ kind: 'update_opportunity_profile', id: 'opp-a', expectedFingerprint: read.profileFingerprint, patch: { early: true } }] } } } }
function storeFixture(initial = fixture()) {
  let snapshot = initial, revision = 0
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
  return { fetchImpl, posts, records, snapshot: () => snapshot, replace: (next: PJSDASSnapshot) => { snapshot = next; revision++ }, options: { supabaseUrl: 'https://example.invalid', serviceRoleKey: 'fixture-only', fetchImpl } }
}
describe('v3 grant discrimination and atomic kernel', () => {
  it.each([undefined, { ...grant, consentVersion: 2, capability: 'workspace.manage' }, { ...grant, consentVersion: 3, capability: 'workspace.manage' }, { ...grant, userId: client }, { ...grant, clientId: owner }, { ...grant, revokedAt: '2026-10-02T00:00:00Z' }, { ...grant, revision: 0 }, { ...grant, grantedAt: '2999-01-01T00:00:00Z' }])('rejects absent/foreign/v2/revoked grants %#', candidate => { expect(() => assertOpportunityManagementGrant(principal, candidate as OpportunityManagementGrant)).toThrow(/authorization/) })
  it('default-denies v3 before database access even with a valid v2 resolver', async () => {
    const f = storeFixture(); const executor = createAuthoritativeCommandExecutor({ ...f.options, resolveBusinessManagementGrant: async () => ({ ...grant, consentVersion: 2, capability: 'workspace.manage' }) })
    await expect(executor.execute(principal, await command())).rejects.toThrow(/version-3/)
    expect(f.fetchImpl).not.toHaveBeenCalled()
  })
  it('commits and replays once with a distinct RPC, exact proof and retained compensation', async () => {
    const f = storeFixture(); const executor = createAuthoritativeCommandExecutor({ ...f.options, resolveOpportunityManagementGrant: async () => grant }); const input = await command()
    expect((await executor.execute(principal, input)).outcome).toBe('COMMITTED')
    expect((await executor.execute(principal, input)).outcome).toBe('ALREADY_APPLIED')
    expect(f.posts).toHaveLength(1)
    expect(f.posts[0]).toMatchObject({ path: '/rest/v1/rpc/pjsdas_commit_opportunity_workspace_v1', body: { target_grant_id: grantId, target_grant_revision: 1, target_user_id: owner, target_client_id: client, target_operation: 'opportunity_management' } })
    expect(f.records[0].compensation.operation).toBe('opportunity_management_restore')
    await expect(executor.execute(principal, { ...input, command: { ...input.command, value: { operations: [{ ...input.command.value.operations[0], patch: { early: false } }] } } })).rejects.toThrow(/reused/)
  })
  it.each(['revoke', 'revision', 'replacement'] as const)('refuses %s between admission and commit', async change => {
    const f = storeFixture(); let reads = 0
    const executor = createAuthoritativeCommandExecutor({ ...f.options, resolveOpportunityManagementGrant: async () => ++reads === 1 ? grant : change === 'revoke' ? undefined : { ...grant, ...(change === 'revision' ? { revision: 2 } : { id: '00000000-0000-4000-8000-000000000004' }) } })
    await expect(executor.execute(principal, await command())).rejects.toThrow(/authorization|changed/); expect(f.posts).toEqual([])
  })
  it('binds the immutable admission proof across CAS retries', async () => {
    const f = storeFixture(); let currentGrant = { ...grant }; let posts = 0
    const fetchImpl: typeof fetch = async (input, init) => {
      if (init?.method === 'POST') { posts++; currentGrant.revision = 2; return Response.json([{ outcome: 'CONFLICT', workspace_id: 'fixture-workspace', revision: 1, snapshot: fixture() }]) }
      return f.fetchImpl(input, init)
    }
    const executor = createAuthoritativeCommandExecutor({ ...f.options, fetchImpl, resolveOpportunityManagementGrant: async () => currentGrant })
    await expect(executor.execute(principal, await command())).rejects.toThrow(/changed/); expect(posts).toBe(1)
  })
  it('rereads and preserves newer unrelated raw data on a real CAS conflict response', async () => {
    const { unknownDeadlineWorkspace } = await import('./fixtures/unknownDeadlineWorkspace.js')
    const raw = unknownDeadlineWorkspace(2); raw.data.actions[1].dueAt = '2026-08-27T15:59:59Z'; raw.data.actions[1].timingMode = 'deadline'
    const f = storeFixture(raw); let posts = 0
    const fetchImpl: typeof fetch = async (input, init) => {
      if (init?.method === 'POST' && ++posts === 1) {
        const newer = structuredClone(f.snapshot()); newer.data.actions[1].dueAt = '2026-12-31T01:00:00Z'; f.replace(newer)
        return Response.json([{ outcome: 'CONFLICT', workspace_id: 'fixture-workspace', revision: 1, snapshot: newer }])
      }
      return f.fetchImpl(input, init)
    }
    const read = await readOpportunityManagement(raw, 'unknown-0')
    const executor = createAuthoritativeCommandExecutor({ ...f.options, fetchImpl, resolveOpportunityManagementGrant: async () => grant })
    const result = await executor.execute(principal, { commandId: 'raw-cas-preservation', baseRevision: 0, command: { type: 'opportunity_management', value: { operations: [{ kind: 'update_opportunity_profile', id: 'unknown-0', expectedFingerprint: read.profileFingerprint, patch: { early: true } }] } } })
    expect(result.outcome).toBe('COMMITTED'); expect(posts).toBe(2)
    expect(f.snapshot().data.actions[1]).toEqual({ ...raw.data.actions[1], dueAt: '2026-12-31T01:00:00Z' })
    await executor.undo(principal, { commandId: 'raw-cas-preservation-undo', targetCommandId: 'raw-cas-preservation', expectedCompensationFingerprint: result.result!.compensationFingerprint })
    expect(f.snapshot().data.actions[1]).toEqual({ ...raw.data.actions[1], dueAt: '2026-12-31T01:00:00Z' })
  })
  it('requires exact owner-ledger compensation proof for restore and uses the same grant lock', async () => {
    const f = storeFixture(); const executor = createAuthoritativeCommandExecutor({ ...f.options, resolveOpportunityManagementGrant: async () => grant })
    const applied = await executor.execute(principal, await command()); const undo = { commandId: 'synthetic-v3-restore', targetCommandId: 'synthetic-v3-command', expectedCompensationFingerprint: applied.result!.compensationFingerprint }
    await expect(executor.undo(principal, { ...undo, expectedCompensationFingerprint: 'f'.repeat(64) })).rejects.toThrow(/fingerprint/)
    expect((await executor.undo(principal, undo)).outcome).toBe('COMMITTED')
    expect(f.posts[1].path).toBe('/rest/v1/rpc/pjsdas_commit_opportunity_workspace_v1'); expect(f.snapshot().data.opportunities[0].early).toBe(false)
    expect((await executor.undo(principal, undo)).outcome).toBe('ALREADY_APPLIED')
    expect(f.posts).toHaveLength(2)
  })
  it('withholds undo replay after a v3 grant is revoked', async () => {
    const f = storeFixture(); let current: OpportunityManagementGrant | undefined = grant
    const executor = createAuthoritativeCommandExecutor({ ...f.options, resolveOpportunityManagementGrant: async () => current })
    const applied = await executor.execute(principal, await command()); const undo = { commandId: 'synthetic-v3-restore', targetCommandId: 'synthetic-v3-command', expectedCompensationFingerprint: applied.result!.compensationFingerprint }
    await executor.undo(principal, undo); current = undefined
    await expect(executor.undo(principal, undo)).rejects.toThrow(/authorization/); expect(f.posts).toHaveLength(2)
  })
  it('refuses mismatched v2/v3 RPC proof and never falls back after SQL denial', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ code: '42501' }, { status: 403 }))
    const store = createTransactionalWorkspaceStore({ supabaseUrl: 'https://example.invalid', serviceRoleKey: 'fixture-only', fetchImpl })
    const commit = { userId: owner, clientId: client, principalKind: 'delegated_mcp' as const, commandId: 'synthetic-command', operation: 'opportunity_management', payloadHash: 'hash', expectedRevision: 0, snapshot: fixture(), schemaVersion: 4, receiptContext: {}, managementAuthorization: { grantId, grantRevision: 1 } }
    await expect(store.commitAuthoritativeForUser(commit)).rejects.toThrow(/version/); expect(fetchImpl).not.toHaveBeenCalled()
    await expect(store.commitAuthoritativeForUser({ ...commit, managementAuthorization: { ...commit.managementAuthorization, consentVersion: 3 } })).rejects.toThrow(/before commit/); expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String(fetchImpl.mock.calls[0][0])).toContain('pjsdas_commit_opportunity_workspace_v1')
  })
})

describe('source-only opportunity tool adapter', () => {
  function tools(f: ReturnType<typeof storeFixture>, resolveGrant: () => Promise<OpportunityManagementGrant | undefined>, fetchImpl = f.fetchImpl) {
    return createOpportunityManagementTools({ principal, storeOptions: { ...f.options, fetchImpl }, resolveGrant })
  }
  it('requires a v3 grant before reading workspace data', async () => {
    const f = storeFixture()
    const result = await tools(f, async () => undefined).invoke('get_opportunity_management', { opportunityId: 'opp-a' })
    expect(result.structuredContent).toMatchObject({ code: 'AUTH_FORBIDDEN' }); expect(f.fetchImpl).not.toHaveBeenCalled()
  })
  it.each(['foreign-workspace', 'revoke', 'replacement'] as const)('withholds a read on %s', async change => {
    const f = storeFixture(); let active: OpportunityManagementGrant | undefined = grant
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const response = await f.fetchImpl(input, init)
      if (change === 'revoke') active = undefined
      if (change === 'replacement') active = { ...grant, revision: 2 }
      if (change === 'foreign-workspace') return Response.json([{ id: 'foreign', user_id: client, snapshot: fixture(), revision: 0, schema_version: 4 }])
      return response
    })
    const result = await tools(f, async () => active, fetchImpl).invoke('get_opportunity_management', { opportunityId: 'opp-a' })
    expect(result.isError).toBe(true); expect(JSON.stringify(result)).not.toContain('Engineer')
  })
  it('returns a score-free profile with exact raw archive proofs and no ledger contents', async () => {
    const f = storeFixture()
    const raw = f.snapshot().data.opportunities[0]
    raw.detail = { ...raw.detail, privateMetadata: { kept: true } } as any
    const result = await tools(f, async () => grant).invoke('get_opportunity_management', { opportunityId: 'opp-a' })
    const { fitScore: _fit, opportunityValue: _value, ...visible } = raw
    expect(result.structuredContent).toMatchObject({ consentVersion: 3, capability: 'workspace.opportunity.manage', data: { opportunity: visible } }); expect(JSON.stringify(result)).not.toContain('opportunity_management_restore')
    expect((result.structuredContent as any).data.opportunity).not.toHaveProperty('fitScore')
    expect((result.structuredContent as any).data.opportunity).not.toHaveProperty('opportunityValue')
    expect(raw.fitScore).toBe(80)
  })
  it('internally binds adapter admission before executor admission', async () => {
    const f = storeFixture(); let reads = 0
    const adapter = tools(f, async () => ++reads === 1 ? grant : { ...grant, revision: 2 })
    const c = await command()
    const result = await adapter.invoke('execute_opportunity_management', { commandId: c.commandId, baseRevision: 0, change: c.command.value })
    expect(result.structuredContent).toMatchObject({ code: 'AUTH_FORBIDDEN' }); expect(f.fetchImpl).not.toHaveBeenCalled()
  })
})
