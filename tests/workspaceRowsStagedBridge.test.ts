import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceRowsStagedBridge } from '../gateway/workspaceRowsStagedBridge.js'
import { encodeWorkspaceRows, diffReadableWorkspaceRows } from '../gateway/workspaceRowsCodec.js'
import { createSnapshot } from '../src/snapshot.js'
import { createHash } from 'node:crypto'
import { largeAbandonFixture } from './fixtures/workspaceRowsLargeCommand.js'
import { largePlanningFixture } from './fixtures/workspaceRowsLargePlanning.js'

const userId='11111111-1111-4111-8111-111111111111',workspaceId='22222222-2222-4222-8222-222222222222',epoch='33333333-3333-4333-8333-333333333333'
const options={supabaseUrl:'https://synthetic.invalid',serviceRoleKey:'synthetic',readsEnabled:true,writesEnabled:true,rpcTransport:'public-v1' as const}
afterEach(()=>vi.restoreAllMocks())
describe('default-off staged bridge original budget and family boundary',()=>{
 function undo(){const f=largeAbandonFixture(),e=encodeWorkspaceRows(f.result.snapshot);return{
  before:{userId,workspaceId,rowEpoch:epoch,revision:1,schemaVersion:4,snapshot:f.result.snapshot},
  input:{userId,expectedRevision:1,commandId:'synthetic-undo',payloadHash:'a'.repeat(64),operation:'undo_command',principalKind:'first_party_web' as const,snapshot:f.undo,compensation:null,provenance:{undoOf:f.command.commandId}},
  head:{userId,workspaceId,epoch,revision:1,schemaVersion:4,format:'workspace-rows-v1',envelope:e.envelope,manifest:e.manifest},command:f.command.commandId,
 }}
 it('shares the one original ten-second attempt signal across Undo history and never resets it after a wait',async()=>{
  const f=undo(),deadline=new AbortController(),observed:AbortSignal[]=[]
  const timeout=vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>{expect(ms).toBeGreaterThan(0);expect(ms).toBeLessThanOrEqual(10_000);return deadline.signal})
  const fetchImpl=vi.fn<typeof fetch>(async(input,init)=>{
   observed.push(init!.signal as AbortSignal)
   if(String(input).endsWith('read_head'))return Response.json(f.head)
   expect(String(input)).toContain('read_history');deadline.abort(new Error('ORIGINAL_TOTAL_DEADLINE'));throw deadline.signal.reason
  })
  const bridge=createWorkspaceRowsStagedBridge({...options,fetchImpl})
  await expect(bridge.rowLayoutWriter!.commit(f.before,f.input)).rejects.toMatchObject({code:'WORKSPACE_UNAVAILABLE',retryable:true})
  expect(timeout).toHaveBeenCalledTimes(1);expect(fetchImpl).toHaveBeenCalledTimes(2)
  expect(observed).toEqual([deadline.signal,deadline.signal]);expect(observed.every(s=>s.aborted)).toBe(true)
 })
 it('maps a concurrent history fence change to the existing conflict result without beginning upload',async()=>{
  const f=undo(),deadline=new AbortController(),observed:AbortSignal[]=[];let reads=0
  vi.spyOn(AbortSignal,'timeout').mockReturnValue(deadline.signal)
  const fetchImpl=vi.fn<typeof fetch>(async(input,init)=>{
   observed.push(init!.signal as AbortSignal)
   if(String(input).endsWith('read_head'))return Response.json({...f.head,revision:++reads===1?1:2})
   expect(String(input)).toContain('read_history')
   return Response.json({outcome:'HISTORY',userId,workspaceId,epoch,revision:1,rows:[{user_id:userId,workspace_id:workspaceId,command_id:f.command,resulting_revision:1,receipt:{operation:'domain:abandon_opportunity'}}],hasMore:false})
  })
  expect(await createWorkspaceRowsStagedBridge({...options,fetchImpl}).rowLayoutWriter!.commit(f.before,f.input)).toEqual({outcome:'CONFLICT'})
  expect(observed).toEqual([deadline.signal,deadline.signal,deadline.signal]);expect(fetchImpl).toHaveBeenCalledTimes(3)
 })
 it('new audit fragments inside original staged Undo share the original one-shot signal and cannot start upload after expiry',async()=>{
  const f=undo(),deadline=new AbortController(),observed:AbortSignal[]=[]
  const timeout=vi.spyOn(AbortSignal,'timeout').mockReturnValue(deadline.signal)
  const row={user_id:userId,workspace_id:workspaceId,command_id:f.command,resulting_revision:1,receipt:{operation:'domain:abandon_opportunity',unknown:'x'.repeat(2_100_000)}}
  const bytes=Buffer.from(JSON.stringify(row)),document={protocol:'workspace-audit-bytes-v1',userId,workspaceId,epoch,revision:1,commandId:f.command,resultingRevision:1,totalBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}
  const fetchImpl=vi.fn<typeof fetch>(async(url,init)=>{
   observed.push(init!.signal as AbortSignal)
   if(String(url).endsWith('read_head'))return Response.json(f.head)
   if(String(url).endsWith('read_history'))return Response.json({outcome:'HISTORY',auditProtocol:'workspace-audit-bytes-v1',userId,workspaceId,epoch,revision:1,rows:[{...row,receipt:undefined,auditDocument:document}],hasMore:false})
   expect(String(url)).toContain('read_audit_fragment');deadline.abort(new Error('ORIGINAL_TOTAL_DEADLINE'));throw deadline.signal.reason
  })
  const bridge=createWorkspaceRowsStagedBridge({...options,auditReadsEnabled:true,auditReadAuthorization:{userId,principal:'first_party_web'},fetchImpl})
  await expect(bridge.rowLayoutWriter!.commit(f.before,f.input)).rejects.toMatchObject({code:'WORKSPACE_UNAVAILABLE',retryable:true})
  expect(timeout).toHaveBeenCalledTimes(1);expect(fetchImpl).toHaveBeenCalledTimes(3);expect(observed.every(signal=>signal===deadline.signal)).toBe(true)
 })
 it('does not treat the legal one-effect Planning byte counterexample as an authorized staged family',async()=>{
  const f=await largePlanningFixture(),fetchImpl=vi.fn(),bridge=createWorkspaceRowsStagedBridge({...options,fetchImpl})
  await expect(bridge.rowLayoutWriter!.commit({userId,workspaceId,rowEpoch:epoch,revision:0,schemaVersion:4,snapshot:f.before},
   {userId,expectedRevision:0,commandId:'synthetic-planning',payloadHash:'b'.repeat(64),operation:'planning_management',principalKind:'delegated_mcp',clientId:'synthetic-client',snapshot:f.result.snapshot,compensation:f.result.compensation,managementAuthorization:{grantId:'44444444-4444-4444-8444-444444444444',grantRevision:1,consentVersion:4}})).rejects.toMatchObject({code:'WORKSPACE_INVALID'})
  expect(fetchImpl).not.toHaveBeenCalled()
 })
 it('does not count the staged audit marker against the unchanged small-command fast-path boundary',async()=>{
  const snapshot=createSnapshot({opportunities:[],processes:[],processEvents:[],actions:[],prep:[],applicationGroups:[],timeline:[]},'2030-01-01T00:00:00Z')
  const before={userId,workspaceId,rowEpoch:epoch,revision:0,schemaVersion:snapshot.version,snapshot}
  const input={userId,expectedRevision:0,commandId:'synthetic-boundary',payloadHash:'a'.repeat(64),operation:'domain:abandon_opportunity',principalKind:'first_party_web' as const,snapshot,compensation:null,receiptContext:{padding:''}}
  const request={...diffReadableWorkspaceRows(snapshot,snapshot),commandId:input.commandId,payloadHash:input.payloadHash,operation:input.operation,principal:input.principalKind,workspaceId,userId,expectedEpoch:epoch,expectedRevision:0,schemaVersion:snapshot.version,compensation:null,provenance:{},receiptContext:input.receiptContext,effectiveTime:null}
  input.receiptContext.padding='x'.repeat(2_097_140-Buffer.byteLength(JSON.stringify(request)))
  expect(Buffer.byteLength(JSON.stringify(request))).toBe(2_097_140)
  const fetchImpl=vi.fn<typeof fetch>(async(url,init)=>{
   expect(String(url)).toContain('commit_authoritative');expect(JSON.parse(String(init?.body)).req.auditReadProtocol).toBeUndefined()
   return Response.json({outcome:'COMMITTED',revision:1,receipt:{commandId:input.commandId,operation:input.operation,status:'COMMITTED',revision:1}})
  })
  const bridge=createWorkspaceRowsStagedBridge({...options,auditReadsEnabled:true,auditReadAuthorization:{userId,principal:'first_party_web'},fetchImpl})
  expect((await bridge.rowLayoutWriter!.commit(before,input)).outcome).toBe('COMMITTED');expect(fetchImpl).toHaveBeenCalledTimes(1)
 })
})
