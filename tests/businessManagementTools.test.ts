import type { AuthoritativeCommandExecution } from '../gateway/authoritativeCommands.js'
import { describe, expect, it, vi } from 'vitest'
import { createBusinessManagementTools, executeBusinessManagementSchema } from '../gateway/businessManagementTools.js'
import type { BusinessManagementGrant } from '../gateway/businessManagementAccess.js'
import type { PJSDASSnapshot } from '../src/snapshot.js'
const principal = { kind: 'delegated_mcp' as const, userId: 'synthetic-owner', clientId: 'synthetic-client' }
const grant: BusinessManagementGrant = { id: '00000000-0000-4000-8000-000000000001', revision: 1, ...{ userId: principal.userId, clientId: principal.clientId }, consentVersion: 2, capability: 'workspace.manage', grantedAt: '2026-10-01T00:00:00Z' }
const snapshot: PJSDASSnapshot = { schema: 'pjsdas-local-snapshot', version: 4, exportedAt: grant.grantedAt, data: { opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [] } }
const change = { operations: [{ kind: 'create_prep', value: { title: 'Synthetic preparation', estimatedMinutes: 30 } }] }
const args = { commandId: 'synthetic-command-1', baseRevision: 4, change }
function fixture(currentGrant: BusinessManagementGrant | undefined = grant) {
 const read = vi.fn(async () => ({ snapshot, context: { now: new Date(), timezone: 'UTC', workspaceVersion: 'txn:4', workspaceOwnerUserId: principal.userId } }))
 const execute = vi.fn(async (): Promise<AuthoritativeCommandExecution> => ({ outcome: 'COMMITTED' as const, revision: 5, snapshot, receipt: { compensation: 'must-not-leak' }, result: { status: 'APPLIED' } }))
 const undo = vi.fn(execute)
 const lookup = vi.fn(async () => ({ found: true, operation: 'business_management', revision: 5, snapshot: undefined }))
 const createExecutor = vi.fn(() => ({ execute, undo, lookup }))
 const resolveGrant = vi.fn(async () => currentGrant)
 const tools = createBusinessManagementTools({ principal, source: { read }, createExecutor, resolveGrant })
 return { tools, read, execute, undo, lookup, resolveGrant, createExecutor }
}
describe('owner management MCP adapter', () => {
 it('returns missing consent without accessing workspace', async () => {
  const f = fixture(); f.resolveGrant.mockResolvedValue(undefined)
  expect((await f.tools.invoke('get_business_management', {})).structuredContent).toMatchObject({ authorized: false })
  expect(f.read).not.toHaveBeenCalled()
 })
 it('reads only server-scoped current workspace and bounded entity query', async () => {
  const f = fixture(); expect((await f.tools.invoke('get_business_management', { query: { type: 'prep', limit: 1 } })).structuredContent).toMatchObject({ authorized: true, workspaceVersion: 'txn:4', data: { items: [] } })
 })
 it('rejects a mismatched source owner', async () => {
  const f = fixture(); f.read.mockResolvedValue({ snapshot, context: { now: new Date(), timezone: 'UTC', workspaceVersion: 'txn:4', workspaceOwnerUserId: 'foreign' } })
  expect((await f.tools.invoke('get_business_management', {})).isError).toBe(true)
 })
 it.each(['userId', 'clientId'] as const)('refuses foreign %s before execution', async key => {
  const f = fixture({ ...grant, [key]: 'foreign' }); expect((await f.tools.invoke('execute_business_management', args)).isError).toBe(true); expect(f.execute).not.toHaveBeenCalled()
 })
 it.each(['revoked', 'revision', 'replacement'] as const)('refuses %s during an awaited read before returning data', async change => {
  const mutable = { ...grant }; const f = fixture(mutable)
  f.read.mockImplementation(async () => {
   if (change === 'revoked') mutable.revokedAt = '2026-10-02T00:00:00Z'
   else if (change === 'revision') mutable.revision++
   else mutable.id = '00000000-0000-4000-8000-000000000099'
   return { snapshot, context: { now: new Date(), timezone: 'UTC', workspaceVersion: 'txn:4', workspaceOwnerUserId: principal.userId } }
  })
  const response = await f.tools.invoke('get_business_management', { query: { type: 'prep' } })
  expect(response.isError).toBe(true); expect(response.structuredContent).toMatchObject({ code: 'AUTH_FORBIDDEN' }); expect(response.structuredContent).not.toHaveProperty('data'); expect(response.structuredContent).not.toHaveProperty('authorized', true)
 })
 it('binds immutable admission and forwards only typed business commands', async () => {
  const f = fixture(); const response = await f.tools.invoke('execute_business_management', args)
  expect(f.execute).toHaveBeenCalledWith(principal, { commandId: args.commandId, baseRevision: 4, command: { type: 'business_management', value: change } })
  expect(Object.isFrozen(f.createExecutor.mock.calls[0][0])).toBe(true)
  expect(response.structuredContent).toMatchObject({ outcome: 'COMMITTED', commandId: args.commandId, workspaceVersion: 'txn:5' })
  expect(JSON.stringify(response)).not.toContain('must-not-leak'); expect(response.structuredContent).not.toHaveProperty('snapshot')
 })
 it.each([{...args,userId:'foreign'}, {...args,change:{operations:[{kind:'purge_prep',id:'x'}]}}, {...args,commandId:'x'.repeat(161)}])('strictly rejects expanded payload %#', async input => {
  const f = fixture(); expect(executeBusinessManagementSchema.safeParse(input).success).toBe(false); expect((await f.tools.invoke('execute_business_management', input)).isError).toBe(true); expect(f.execute).not.toHaveBeenCalled()
 })
 it('restricts undo lookup to own principal and management family', async () => {
  const f = fixture(); f.lookup.mockResolvedValue({ found:true, operation:'domain', revision:5, snapshot:undefined })
  expect((await f.tools.invoke('undo_business_management', { commandId: 'synthetic-undo', targetCommandId: args.commandId })).isError).toBe(true)
  expect(f.lookup).toHaveBeenCalledWith(principal,args.commandId,true); expect(f.undo).not.toHaveBeenCalled()
 })
 it.each(['ALREADY_APPLIED', 'CONFLICT', 'NO_WRITE'] as const)('withholds %s result after a concurrent regrant', async outcome => {
  const mutable = { ...grant }; const f = fixture(mutable)
  let release!: () => void; let started!: () => void
  const begun = new Promise<void>(resolve => { started = resolve })
  f.execute.mockImplementation(async () => { started(); await new Promise<void>(resolve => { release = resolve }); return { outcome, revision: 4, snapshot, conflict: { kind: 'OBJECT_CONFLICT', message: 'private conflict', objects: [] } } })
  const pending = f.tools.invoke('execute_business_management', args)
  await begun; mutable.revision++; release()
  const response = await pending
  expect(response.isError).toBe(true); expect(response.structuredContent).not.toHaveProperty('conflict'); expect(JSON.stringify(response)).toContain('not rolled back')
 })
 it.each(['revoked', 'replacement'] as const)('withholds idempotent undo response after %s while waiting', async change => {
  const mutable = { ...grant }; const f = fixture(mutable)
  let release!: () => void; let started!: () => void
  const begun = new Promise<void>(resolve => { started = resolve })
  f.undo.mockImplementation(async () => { started(); await new Promise<void>(resolve => { release = resolve }); return { outcome: 'ALREADY_APPLIED', revision: 4, snapshot } })
  const pending = f.tools.invoke('undo_business_management', { commandId: 'synthetic-undo', targetCommandId: args.commandId })
  await begun
  if (change === 'revoked') mutable.revokedAt = '2026-10-02T00:00:00Z'
  else mutable.id = '00000000-0000-4000-8000-000000000099'
  release(); const response = await pending
  expect(response.isError).toBe(true); expect(response.structuredContent).not.toHaveProperty('outcome')
 })
 it('does not hide a confirmed atomic commit after later revocation', async () => {
  const mutable = { ...grant }; const f = fixture(mutable)
  f.execute.mockImplementation(async () => { mutable.revokedAt = '2026-10-02T00:00:00Z'; return { outcome: 'COMMITTED', revision: 5, snapshot } })
  expect((await f.tools.invoke('execute_business_management', args)).structuredContent).toMatchObject({ outcome: 'COMMITTED', workspaceVersion: 'txn:5' })
 })
 it('delegates valid undo and sanitizes unexpected failures', async () => {
  const f=fixture(); await f.tools.invoke('undo_business_management',{commandId:'synthetic-undo',targetCommandId:args.commandId});expect(f.undo).toHaveBeenCalled()
  f.execute.mockRejectedValue(new Error('private-backend-detail')); const response=await f.tools.invoke('execute_business_management',args)
  expect(response.isError).toBe(true); expect(JSON.stringify(response)).not.toContain('private-backend-detail')
 })
})

describe('actual MCP registration and dispatch', () => {
 it('keeps management absent by default and advertises all three only with an adapter', async () => {
  const { createMcpHandler } = await import('@modelcontextprotocol/server')
  const { createPjsdasMcpServer } = await import('../gateway/serverFactory.js')
  const f = fixture()
  const request = (method:string, params:Record<string,unknown>={}) => new Request('https://example.invalid/api/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','MCP-Protocol-Version':'2026-07-28','Mcp-Method':method,...(method==='tools/call'?{'Mcp-Name':String(params.name)}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'synthetic',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}})})
  const payload = async (response:Response) => { const text=await response.text();return JSON.parse(text.startsWith('event:')?text.split('\n').find(line=>line.startsWith('data:'))!.slice(5):text) }
  const disabled=createMcpHandler(()=>createPjsdasMcpServer({read:f.read}))
  const baseline=await payload(await disabled.fetch(request('tools/list')))
  expect(baseline.result.tools.map((tool:{name:string})=>tool.name)).not.toContain('execute_business_management')
  const enabled=createMcpHandler(()=>createPjsdasMcpServer({read:f.read},{businessManagement:f.tools}))
  const list=await payload(await enabled.fetch(request('tools/list')))
  for(const name of ['get_business_management','execute_business_management','undo_business_management']) expect(list.result.tools.find((tool:{name:string})=>tool.name===name).inputSchema.type).toBe('object')
  const invoked=await payload(await enabled.fetch(request('tools/call',{name:'execute_business_management',arguments:args})))
  expect(invoked.result.structuredContent).toMatchObject({outcome:'COMMITTED',commandId:args.commandId})
  expect(f.execute).toHaveBeenCalledTimes(1)
 })
})
