import {afterEach,describe,expect,it,vi} from 'vitest'
import {createTransactionalWorkspaceStore} from '../gateway/transactionalWorkspaceStore.js'
import {createConnectedWorkspaceHandler} from '../gateway/connectedWorkspaceHandler.js'
import {createSnapshot} from '../src/snapshot.js'
import {emptyGmailRun} from '../gateway/emptyGmailCheckpoint.js'
const userId='11111111-1111-4111-8111-111111111111',workspaceId='22222222-2222-4222-8222-222222222222',epoch='33333333-3333-4333-8333-333333333333'
const origin='https://synthetic.invalid',rpc='/rest/v1/rpc/pjsdas_read_legacy_workspace_v1',at='2030-01-01T00:00:00.000Z'
const snapshot=createSnapshot({opportunities:[],processes:[],processEvents:[],actions:[],prep:[],applicationGroups:[],timeline:[]},at)
const record={id:workspaceId,user_id:userId,revision:0,schema_version:4,snapshot}
const methods=['readForUser','readIdentityForUser','readDiscoveryProfileForUser'] as const
const reader=()=>({read:vi.fn(),readIdentity:vi.fn(),readDiscoveryProfile:vi.fn()})
afterEach(()=>vi.unstubAllEnvs())
describe('inactive workspace read fence RPC',()=>{
 it.each(methods)('inactive projections use only the fixed server owner RPC: %s',async method=>{
  const fetchImpl=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
   const url=new URL(String(input));expect(url.pathname).toBe(rpc);expect(url.searchParams.get('target_user_id')).toBe(userId)
   expect(url.searchParams.has('user_id')).toBe(false);expect(url.searchParams.get('limit')).toBe('1');expect(init?.method).toBe('GET')
   expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-service');expect(new Headers(init?.headers).get('apikey')).toBe('synthetic-service')
   return Response.json([{...record,profile:null}])
  })
  const store=createTransactionalWorkspaceStore({supabaseUrl:origin,serviceRoleKey:'synthetic-service',fetchImpl})
  expect(await store[method](userId)).not.toBeNull();expect(fetchImpl).toHaveBeenCalledTimes(1)
  const select=new URL(String(fetchImpl.mock.calls[0][0])).searchParams.get('select')
  expect(select).toBe(method==='readForUser'?'id,user_id,snapshot,revision,schema_version':method==='readIdentityForUser'?'id,user_id,revision,schema_version':'user_id,profile:snapshot->data->discoveryProfile')
 })
 it.each(methods)('missing inactive owner is not fabricated: %s',async method=>{
  const store=createTransactionalWorkspaceStore({supabaseUrl:origin,serviceRoleKey:'synthetic',fetchImpl:async()=>Response.json([])})
  expect(await store[method](userId)).toBeNull()
 })
 it.each([403,404,409,429,503,'timeout'] as const)('never raw-falls-back/retries bridge failure %s',async failure=>{
  const fetchImpl=vi.fn(async(input:RequestInfo|URL)=>{expect(new URL(String(input)).pathname).toBe(rpc);if(failure==='timeout')throw new DOMException('Synthetic cancel','AbortError');return Response.json({code:failure===409?'PT409':'synthetic'},{status:failure})})
  const store=createTransactionalWorkspaceStore({supabaseUrl:origin,serviceRoleKey:'synthetic',fetchImpl})
  await expect(store.readForUser(userId)).rejects.toMatchObject({code:'WORKSPACE_UNAVAILABLE'});expect(fetchImpl).toHaveBeenCalledTimes(1)
 })
 it.each([{},[record,record],[{...record,user_id:workspaceId}],[{...record,revision:-1}]])('rejects malformed, multiple, foreign or invalid-revision rows %#',async rows=>{
  const store=createTransactionalWorkspaceStore({supabaseUrl:origin,serviceRoleKey:'synthetic',fetchImpl:async()=>Response.json(rows)})
  await expect(store.readForUser(userId)).rejects.toMatchObject({code:'WORKSPACE_INVALID'})
 })
 it('preserves the caller deadline and pre/post generation fences without raw snapshot access',async()=>{
  const signal=new AbortController().signal,rows=reader(),paths:string[]=[]
  const fetchImpl=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
   expect(init?.signal).toBe(signal);const u=new URL(String(input));paths.push(u.pathname)
   if(u.pathname===rpc)return Response.json([{user_id:userId,profile:null}])
   expect(u.pathname).toBe('/rest/v1/pjsdas_workspaces');expect(u.searchParams.get('select')).toBe('id,user_id,row_candidate_epoch');expect(u.searchParams.get('user_id')).toBe(`eq.${userId}`)
   return Response.json([{id:workspaceId,user_id:userId,row_candidate_epoch:null}])
  })
  const store=createTransactionalWorkspaceStore({supabaseUrl:origin,serviceRoleKey:'synthetic',fetchImpl,rowLayoutReader:rows})
  expect(await store.readDiscoveryProfileForUser(userId,signal)).toEqual({profile:null})
  expect(paths).toEqual(['/rest/v1/pjsdas_workspaces','/rest/v1/pjsdas_workspaces',rpc,'/rest/v1/pjsdas_workspaces']);expect(rows.read).not.toHaveBeenCalled()
 })
 it('rejects activation during the inactive RPC read rather than releasing its stale response',async()=>{
  let reads=0
  const store=createTransactionalWorkspaceStore({supabaseUrl:origin,serviceRoleKey:'synthetic',rowLayoutReader:reader(),fetchImpl:async input=>new URL(String(input)).pathname===rpc?Response.json([record]):Response.json([{id:workspaceId,user_id:userId,row_candidate_epoch:++reads<3?null:epoch}])})
  await expect(store.readForUser(userId)).rejects.toMatchObject({code:'WORKSPACE_CONFLICT'})
 })
 it('active owners still use the original row adapter, not the inactive RPC',async()=>{
  const rows=reader();rows.read.mockResolvedValue({workspaceId,userId,epoch,revision:7,snapshot})
  const fetchImpl=vi.fn(async(input:RequestInfo|URL)=>{expect(new URL(String(input)).pathname).toBe('/rest/v1/pjsdas_workspaces');expect(String(input)).not.toContain('snapshot');return Response.json([{id:workspaceId,user_id:userId,row_candidate_epoch:epoch}])})
  expect((await createTransactionalWorkspaceStore({supabaseUrl:origin,serviceRoleKey:'synthetic',fetchImpl,rowLayoutReader:rows}).readForUser(userId))?.rowEpoch).toBe(epoch)
  expect(rows.read).toHaveBeenCalledWith(userId)
 })
 it('keeps the complete 305 logical overlay and original ledger request, with no raw blob fallback',async()=>{
  const commandId=`gmail:auto:${at}`,run=emptyGmailRun(commandId,at,'1234'),paths:string[]=[]
  const fetchImpl=vi.fn(async(input:RequestInfo|URL)=>{
   const u=new URL(String(input));paths.push(u.pathname)
   if(u.pathname===rpc){expect(u.searchParams.get('select')).toContain('materialized_revision');return Response.json([{...record,revision:1,materialized_revision:0}])}
   expect(u.pathname).toBe('/rest/v1/pjsdas_command_ledger');expect(u.searchParams.get('user_id')).toBe(`eq.${userId}`)
   return Response.json([{user_id:userId,workspace_id:workspaceId,command_id:commandId,operation:'gmail_semantic_intake',principal_kind:'automation',status:'COMMITTED',resulting_revision:1,gmail_empty_poll_run:run}])
  })
  const store=createTransactionalWorkspaceStore({supabaseUrl:origin,serviceRoleKey:'synthetic',fetchImpl,emptyGmailCheckpointReads:true,emptyGmailCheckpoints:false})
  const value=await store.readForUser(userId,{preserveRawData:true,includeStoredSchema:true})
  expect(value).toMatchObject({revision:1,storedSchemaVersion:4});expect(value!.snapshot.data.timeline).toEqual([run]);expect(paths).toEqual([rpc,'/rest/v1/pjsdas_command_ledger'])
 })
 it('actual first-party handler derives RPC target only from verified identity, never request owner',async()=>{
  vi.stubEnv('PJSDAS_WORKSPACE_ROWS_READS','');vi.stubEnv('PJSDAS_WORKSPACE_ROWS_WRITES','')
  const fetchImpl=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
   const u=new URL(String(input));if(u.pathname==='/auth/v1/user'){expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-user');return Response.json({id:userId})}
   expect(u.pathname).toBe(rpc);expect(u.searchParams.get('target_user_id')).toBe(userId);expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-service');return Response.json([record])
  })
  const handler=createConnectedWorkspaceHandler({supabaseUrl:origin,supabasePublishableKey:'synthetic-publishable',serviceRoleKey:'synthetic-service',allowedOrigins:[origin],fetchImpl})
  const response=await handler(new Request(origin+'/api/workspace',{method:'POST',headers:{origin,authorization:'Bearer synthetic-user','content-type':'application/json'},body:JSON.stringify({action:'read',userId:workspaceId,target_user_id:workspaceId})}))
  expect(response.status).toBe(200);expect(await response.json()).toMatchObject({workspaceId,revision:0,snapshot});expect(fetchImpl).toHaveBeenCalledTimes(2)
 })
})
