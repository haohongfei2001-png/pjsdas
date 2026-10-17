import { unknownDeadlineWorkspace } from './fixtures/unknownDeadlineWorkspace.js'
import { describe, expect, it, vi } from 'vitest'
import { createAuthoritativeCommandExecutor } from '../gateway/authoritativeCommands.js'
import { createTransactionalWorkspaceStore } from '../gateway/transactionalWorkspaceStore.js'
import { assertDiscoveryProfileManagementGrant, type DiscoveryProfileManagementGrant } from '../gateway/discoveryProfileManagementAccess.js'
import { createDiscoveryProfileManagementTools } from '../gateway/discoveryProfileManagementTools.js'
import { getDiscoveryProfileManagementRead } from '../src/discoveryProfileManagement.js'
import { upgradeSnapshotToLatest, type PJSDASSnapshot } from '../src/snapshot.js'
const owner = '00000000-0000-4000-8000-000000000001', client = '00000000-0000-4000-8000-000000000002', grantId = '00000000-0000-4000-8000-000000000003'
const principal = { kind: 'delegated_mcp' as const, userId: owner, clientId: client }
const grant: DiscoveryProfileManagementGrant = { id: grantId, revision: 1, userId: owner, clientId: client, consentVersion: 5, capability: 'workspace.discovery-profile.manage', grantedAt: '2026-10-01T00:00:00Z' }
function fixture(): PJSDASSnapshot { return upgradeSnapshotToLatest({ schema: 'pjsdas-local-snapshot', version: 4, exportedAt: '2026-10-02T00:00:00Z', data: { opportunities: [{ id: 'opp-a', company: 'Synthetic', role: 'Engineer', processStage: 'screening', currentStageLabel: 'User application', roleType: 'core', early: false, opportunityValue: 70, fitScore: 80, importedAt: '2026-10-01T00:00:00Z' }], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], scheduleNodes: [], timeline: [] } }) }
async function command(snapshot = fixture()) { const read = await getDiscoveryProfileManagementRead(snapshot); return { commandId: 'synthetic-v5-command', baseRevision: 0, command: { type: 'discovery_profile_management', value: { kind: 'patch_discovery_profile', expectedFingerprint: read.fingerprint, patch: { searchGoal: 'Explicit preference' } } } } }
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
describe('v5 grant discrimination and atomic kernel', () => {
  it.each([undefined, { ...grant, consentVersion: 2, capability: 'workspace.manage' }, { ...grant, consentVersion: 3, capability: 'workspace.opportunity.manage' }, { ...grant, consentVersion: 4, capability: 'workspace.planning.manage' }, { ...grant, consentVersion: 5, capability: 'workspace.manage' }, { ...grant, userId: client }, { ...grant, clientId: owner }, { ...grant, revokedAt: '2026-10-02T00:00:00Z' }, { ...grant, revision: 0 }, { ...grant, grantedAt: '2999-01-01T00:00:00Z' }])('rejects absent/foreign/v2/revoked grants %#', candidate => { expect(() => assertDiscoveryProfileManagementGrant(principal, candidate as DiscoveryProfileManagementGrant)).toThrow(/authorization/) })
  it('does not treat first-party sessions as delegated planning consent', () => {
    expect(() => assertDiscoveryProfileManagementGrant({ ...principal, kind: 'first_party' } as any, grant)).toThrow(/authorization/)
  })
  it('default-denies v5 before database access even with a valid v2 resolver', async () => {
    const f = storeFixture(); const executor = createAuthoritativeCommandExecutor({ ...f.options, resolveBusinessManagementGrant: async () => ({ ...grant, consentVersion: 2, capability: 'workspace.manage' }) })
    await expect(executor.execute(principal, await command())).rejects.toThrow(/version-5/)
    expect(f.fetchImpl).not.toHaveBeenCalled()
  })
  it('commits and replays once with a distinct RPC, exact proof and retained compensation', async () => {
    const f = storeFixture(); const executor = createAuthoritativeCommandExecutor({ ...f.options, resolveDiscoveryProfileManagementGrant: async () => grant }); const input = await command()
    expect((await executor.execute(principal, input)).outcome).toBe('COMMITTED')
    expect((await executor.execute(principal, input)).outcome).toBe('ALREADY_APPLIED')
    expect(f.posts).toHaveLength(1)
    expect(f.posts[0]).toMatchObject({ path: '/rest/v1/rpc/pjsdas_commit_discovery_profile_workspace_v1', body: { target_grant_id: grantId, target_grant_revision: 1, target_user_id: owner, target_client_id: client, target_operation: 'discovery_profile_management' } })
    expect(f.records[0].compensation.operation).toBe('discovery_profile_management_restore')
    await expect(executor.execute(principal, { ...input, command: { ...input.command, value: { ...input.command.value, patch: { searchGoal: 'Different preference' } } } })).rejects.toThrow(/reused/)
  })
  it('preserves raw legacy dates and cancelled nodes through gateway commit and restore', async () => {
    const initial = unknownDeadlineWorkspace(1)
    initial.data.actions[0].dueAt = '2026-08-27T15:59:59Z'
    initial.data.actions[0].timingMode = 'deadline'
    const protectedData = (snapshot: PJSDASSnapshot) => Object.fromEntries(Object.entries(snapshot.data).filter(([key]) => !['discoveryProfile', 'timeline'].includes(key)))
    const f = storeFixture(initial)
    const fetchImpl: typeof fetch = async (input, init) => {
      if (init?.method === 'POST') expect(protectedData(JSON.parse(String(init.body)).target_snapshot)).toEqual(protectedData(initial))
      return f.fetchImpl(input, init)
    }
    const executor = createAuthoritativeCommandExecutor({ ...f.options, fetchImpl, resolveDiscoveryProfileManagementGrant: async () => grant })
    const applied = await executor.execute(principal, await command(initial))
    expect(applied.outcome).toBe('COMMITTED')
    expect(protectedData(f.snapshot())).toEqual(protectedData(initial))
    const restored = await executor.undo(principal, { commandId: 'raw-planning-restore', targetCommandId: 'synthetic-v5-command', expectedCompensationFingerprint: applied.result!.compensationFingerprint })
    expect(restored.outcome).toBe('COMMITTED')
    expect(protectedData(f.snapshot())).toEqual(protectedData(initial))
  })
  it.each(['revoke', 'revision', 'replacement'] as const)('refuses %s between admission and commit', async change => {
    const f = storeFixture(); let reads = 0
    const executor = createAuthoritativeCommandExecutor({ ...f.options, resolveDiscoveryProfileManagementGrant: async () => ++reads === 1 ? grant : change === 'revoke' ? undefined : { ...grant, ...(change === 'revision' ? { revision: 2 } : { id: '00000000-0000-4000-8000-000000000004' }) } })
    await expect(executor.execute(principal, await command())).rejects.toThrow(/authorization|changed/); expect(f.posts).toEqual([])
  })
  it('binds the immutable admission proof across CAS retries', async () => {
    const f = storeFixture(); let currentGrant = { ...grant }; let posts = 0
    const fetchImpl: typeof fetch = async (input, init) => {
      if (init?.method === 'POST') { posts++; currentGrant.revision = 2; return Response.json([{ outcome: 'CONFLICT', workspace_id: 'fixture-workspace', revision: 1, snapshot: fixture() }]) }
      return f.fetchImpl(input, init)
    }
    const executor = createAuthoritativeCommandExecutor({ ...f.options, fetchImpl, resolveDiscoveryProfileManagementGrant: async () => currentGrant })
    await expect(executor.execute(principal, await command())).rejects.toThrow(/changed/); expect(posts).toBe(1)
  })
  it('requires exact owner-ledger compensation proof for restore and uses the same grant lock', async () => {
    const f = storeFixture(); const executor = createAuthoritativeCommandExecutor({ ...f.options, resolveDiscoveryProfileManagementGrant: async () => grant })
    const applied = await executor.execute(principal, await command()); const undo = { commandId: 'synthetic-v5-restore', targetCommandId: 'synthetic-v5-command', expectedCompensationFingerprint: applied.result!.compensationFingerprint }
    await expect(executor.undo(principal, { ...undo, expectedCompensationFingerprint: 'f'.repeat(64) })).rejects.toThrow(/fingerprint/)
    expect((await executor.undo(principal, undo)).outcome).toBe('COMMITTED')
    expect(f.posts[1].path).toBe('/rest/v1/rpc/pjsdas_commit_discovery_profile_workspace_v1'); expect(f.snapshot().data.discoveryProfile).toBeUndefined()
    expect((await executor.undo(principal, undo)).outcome).toBe('ALREADY_APPLIED')
    expect(f.posts).toHaveLength(2)
  })
  it('withholds undo replay after a v5 grant is revoked', async () => {
    const f = storeFixture(); let current: DiscoveryProfileManagementGrant | undefined = grant
    const executor = createAuthoritativeCommandExecutor({ ...f.options, resolveDiscoveryProfileManagementGrant: async () => current })
    const applied = await executor.execute(principal, await command()); const undo = { commandId: 'synthetic-v5-restore', targetCommandId: 'synthetic-v5-command', expectedCompensationFingerprint: applied.result!.compensationFingerprint }
    await executor.undo(principal, undo); current = undefined
    await expect(executor.undo(principal, undo)).rejects.toThrow(/authorization/); expect(f.posts).toHaveLength(2)
  })
  it('refuses mismatched v2/v5 RPC proof and never falls back after SQL denial', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ code: '42501' }, { status: 403 }))
    const store = createTransactionalWorkspaceStore({ supabaseUrl: 'https://example.invalid', serviceRoleKey: 'fixture-only', fetchImpl })
    const commit = { userId: owner, clientId: client, principalKind: 'delegated_mcp' as const, commandId: 'synthetic-command', operation: 'discovery_profile_management', payloadHash: 'hash', expectedRevision: 0, snapshot: fixture(), schemaVersion: 4, receiptContext: {}, managementAuthorization: { grantId, grantRevision: 1 } }
    await expect(store.commitAuthoritativeForUser(commit)).rejects.toThrow(/version/); expect(fetchImpl).not.toHaveBeenCalled()
    await expect(store.commitAuthoritativeForUser({ ...commit, managementAuthorization: { ...commit.managementAuthorization, consentVersion: 5 } })).rejects.toThrow(/before commit/); expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String(fetchImpl.mock.calls[0][0])).toContain('pjsdas_commit_discovery_profile_workspace_v1')
  })
})


describe('source-only raw discovery-profile tool adapter', () => {
  function tools(read: any, resolveGrant: () => Promise<DiscoveryProfileManagementGrant | undefined>) {
    const fetchImpl: typeof fetch=async (input,init)=>{
      expect(init?.method??'GET').toBe('GET')
      expect(new URL(String(input)).searchParams.get('user_id')).toBe(`eq.${owner}`)
      const row=await read();return Response.json(row?[{id:'fixture',user_id:row.userId,revision:row.revision,schema_version:row.snapshot.version,snapshot:row.snapshot}]:[])
    }
    return createDiscoveryProfileManagementTools({ principal, storeOptions:{supabaseUrl:'https://example.invalid',serviceRoleKey:'fixture-only',fetchImpl}, resolveGrant })
  }
  it('denies before raw workspace read and returns bounded profile only', async () => {
    const read = vi.fn(async () => ({snapshot:fixture(),userId:owner,revision:7}))
    expect((await tools(read,async()=>undefined).invoke('get_discovery_profile_management',{})).isError).toBe(true)
    expect(read).not.toHaveBeenCalled()
    const result=await tools(read,async()=>grant).invoke('get_discovery_profile_management',{})
    expect(result.structuredContent).toMatchObject({consentVersion:5,workspaceVersion:'txn:7',data:{raw:null,configured:false}})
    expect(JSON.stringify(result)).not.toContain('Engineer')
  })
  it.each(['foreign-workspace','revoke','replacement'] as const)('withholds raw read on %s',async change=>{
    let current: DiscoveryProfileManagementGrant | undefined = grant
    const read=async()=>{if(change==='revoke')current=undefined;if(change==='replacement')current={...grant,revision:2};return {snapshot:fixture(),userId:change==='foreign-workspace'?client:owner,revision:1}}
    const result=await tools(read,async()=>current).invoke('get_discovery_profile_management',{})
    expect(result.isError).toBe(true);expect(JSON.stringify(result)).not.toContain('Engineer')
  })
  it('rejects legacy missing collections rather than returning a misleading fingerprint',async()=>{
    const s=fixture();s.version=1;delete s.data.reminderIntents
    const result=await tools(async()=>({snapshot:s,userId:owner,revision:0}),async()=>grant).invoke('get_discovery_profile_management',{})
    expect(result.structuredContent).toMatchObject({code:'INVALID_CONFIGURATION'})
  })
  it('executes, restores and replays through the exact bound store without releasing snapshots or compensation',async()=>{
    const f=storeFixture();const adapter=createDiscoveryProfileManagementTools({principal,storeOptions:f.options,resolveGrant:async()=>grant})
    const input=await command();const executed=await adapter.invoke('execute_discovery_profile_management',{commandId:input.commandId,baseRevision:0,change:input.command.value})
    expect(executed.structuredContent).toMatchObject({outcome:'COMMITTED',workspaceVersion:'txn:1'})
    expect(f.posts[0].body).toMatchObject({target_grant_id:grantId,target_grant_revision:1})
    expect(JSON.stringify(executed)).not.toContain('Engineer');expect(JSON.stringify(executed)).not.toContain('discovery_profile_management_restore')
    const undo={commandId:'adapter-profile-restore',targetCommandId:input.commandId,expectedCompensationFingerprint:(executed.structuredContent as any).result.compensationFingerprint}
    expect((await adapter.invoke('restore_discovery_profile_management',undo)).structuredContent).toMatchObject({outcome:'COMMITTED'})
    expect((await adapter.invoke('restore_discovery_profile_management',undo)).structuredContent).toMatchObject({outcome:'ALREADY_APPLIED'})
    expect(f.posts).toHaveLength(2);expect(f.snapshot().data.discoveryProfile).toBeUndefined()
  })
  it.each(['revoke','revision','replacement'] as const)('binds first tool admission even when %s happens before executor admission',async change=>{
    const f=storeFixture();let reads=0
    const resolveGrant=async()=>++reads===1?grant:change==='revoke'?undefined:{...grant,...(change==='revision'?{revision:2}:{id:'00000000-0000-4000-8000-000000000004'})}
    const adapter=createDiscoveryProfileManagementTools({principal,storeOptions:f.options,resolveGrant});const input=await command()
    const result=await adapter.invoke('execute_discovery_profile_management',{commandId:input.commandId,baseRevision:0,change:input.command.value})
    expect(result.structuredContent).toMatchObject({code:'AUTH_FORBIDDEN'});expect(f.fetchImpl).not.toHaveBeenCalled()
  })
  it('binds restore lookup and undo to first tool admission and refuses another command family',async()=>{
    const f=storeFixture();const input=await command();const executor=createAuthoritativeCommandExecutor({...f.options,resolveDiscoveryProfileManagementGrant:async()=>grant})
    const applied=await executor.execute(principal,input);let reads=0
    const adapter=createDiscoveryProfileManagementTools({principal,storeOptions:f.options,resolveGrant:async()=>++reads===1?grant:{...grant,revision:2}})
    const result=await adapter.invoke('restore_discovery_profile_management',{commandId:'stale-adapter-restore',targetCommandId:input.commandId,expectedCompensationFingerprint:applied.result!.compensationFingerprint})
    expect(result.structuredContent).toMatchObject({code:'AUTH_FORBIDDEN'});expect(f.posts).toHaveLength(1)
    f.records[0].operation='planning_management'
    const other=createDiscoveryProfileManagementTools({principal,storeOptions:f.options,resolveGrant:async()=>grant})
    const rejected=await other.invoke('restore_discovery_profile_management',{commandId:'other-family-restore',targetCommandId:input.commandId,expectedCompensationFingerprint:applied.result!.compensationFingerprint})
    expect(rejected.structuredContent).toMatchObject({code:'AUTH_FORBIDDEN'});expect(f.posts).toHaveLength(1)
  })
})
