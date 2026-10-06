import { describe, expect, it, vi } from 'vitest'
import { consumerWorkspaceBootstrapSchema, createEmptyConsumerWorkspace } from '../src/consumerWorkspaceBootstrap.js'
import { initializeEmptyConsumerWorkspace } from '../gateway/consumerWorkspaceBootstrap.js'
import { createConnectedWorkspaceHandler } from '../gateway/connectedWorkspaceHandler.js'
import { validateSnapshot } from '../src/snapshot.js'
import type { ConnectedWorkspaceRecord } from '../gateway/transactionalWorkspaceStore.js'
const owner='00000000-0000-4000-8000-000000000001'
const firstPartyToken=`a.${Buffer.from(JSON.stringify({sub:owner})).toString('base64url')}.synthetic`
const input={expectedAccountId:owner,action:'initialize_empty',commandId:'synthetic-bootstrap',timezone:'Europe/London',confirmStartEmpty:true} as const
const now=new Date('2026-10-02T12:00:00Z')
const workspace=(userId=owner):ConnectedWorkspaceRecord=>({workspaceId:'synthetic-ws',userId,revision:0,schemaVersion:4,snapshot:createEmptyConsumerWorkspace(input,now)})
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}})
const origin='https://todayaction.example'
const request=(body:unknown,token=firstPartyToken,from=origin)=>new Request(`${origin}/api/workspace`,{method:'POST',headers:{origin:from,authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)})

describe('explicit empty consumer workspace',()=>{
 it('builds a valid empty workspace without guessed capacity/preferences or external side effects',()=>{
  const result=createEmptyConsumerWorkspace(input,now)
  expect(()=>validateSnapshot(result)).not.toThrow()
  expect(result.data.opportunities).toEqual([]);expect(result.data.actions).toEqual([])
  expect(result.data.decisionRules).toBeUndefined()
  expect(result.data.timePlanning).toMatchObject({timezone:'Europe/London'})
  expect(result.data.timePlanning?.defaultDailyMinutes).toBeUndefined()
  expect(result.data.discoveryProfile?.targetRoleQueries).toEqual([])
  expect(result.data.reminderOutbox).toEqual([])
  expect(result.data.timeline?.[0].commandId).toBe(input.commandId)
 })
 it('rejects implicit initialization, invalid timezone and owner/raw snapshot injection',()=>{
  for(const candidate of [{...input,confirmStartEmpty:false},{...input,timezone:'Mars/Example'},{...input,userId:'other-account'},{...input,snapshot:{}},{...input,action:'reset'}]) expect(consumerWorkspaceBootstrapSchema.safeParse(candidate).success).toBe(false)
 })
 it('never resets an existing workspace or its selected timezone',async()=>{
  const existing=workspace();existing.revision=12
  existing.snapshot.data.prep.push({id:'synthetic-prep',title:'Keep me',estimatedMinutes:30,createdAt:now.toISOString(),updatedAt:now.toISOString()})
  const before=structuredClone(existing);const bootstrapForUser=vi.fn()
  const result=await initializeEmptyConsumerWorkspace({readForUser:async()=>existing,bootstrapForUser},owner,{...input,timezone:'America/New_York'},now)
  expect(result.outcome).toBe('EXISTING_WORKSPACE');expect(result.workspace).toEqual(before)
  expect(bootstrapForUser).not.toHaveBeenCalled()
 })
 it('uses the existing account uniqueness boundary for simultaneous initialization',async()=>{
  let saved:ConnectedWorkspaceRecord|undefined;let writes=0
  const store={readForUser:async()=>null,bootstrapForUser:async(value:Parameters<Parameters<typeof initializeEmptyConsumerWorkspace>[0]['bootstrapForUser']>[0])=>{
   await Promise.resolve()
   if(!saved){writes++;saved={workspaceId:'synthetic-ws',userId:value.userId,revision:0,schemaVersion:4,snapshot:value.snapshot}}
   return saved
  }}
  const results=await Promise.all([initializeEmptyConsumerWorkspace(store,owner,input,now),initializeEmptyConsumerWorkspace(store,owner,{...input,timezone:'America/New_York'},now)])
  expect(writes).toBe(1);expect(results[0].workspace).toEqual(results[1].workspace)
 })
 it('rejects a misrouted foreign account result',async()=>{
  await expect(initializeEmptyConsumerWorkspace({readForUser:async()=>workspace('synthetic-b'),bootstrapForUser:vi.fn()},owner,input,now)).rejects.toThrow(/ownership/)
 })
})

describe('consumer onboarding route remains gated and first-party only',()=>{
 const config={consumerCohort:{accountIds:owner+',00000000-0000-4000-8000-000000000009',clientId:'00000000-0000-4000-8000-000000000002'},authorizeIdentity:async()=>({allowed:true,mode:'allowlist',role:'beta'}),supabaseUrl:'https://fixture.invalid',supabasePublishableKey:'synthetic-public',serviceRoleKey:'synthetic-service',allowedOrigins:[origin]}
 it('is disabled by default before any workspace mutation or read',async()=>{
  const fetchImpl=vi.fn(async()=>json({id:owner}))
  const response=await createConnectedWorkspaceHandler({...config,fetchImpl})(request(input))
  expect(response.status).toBe(403);expect(fetchImpl).toHaveBeenCalledTimes(1)
 })
 it('accepts only a validated first-party explicit empty choice when enabled in an isolated fixture',async()=>{
  const calls:string[]=[]
  const fetchImpl=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
   const path=new URL(String(url)).pathname;calls.push(path)
   if(path==='/auth/v1/user')return json({id:owner})
   if(path==='/rest/v1/pjsdas_workspaces')return json([])
   if(path==='/rest/v1/rpc/pjsdas_bootstrap_consumer_workspace_v1'){
    const body=JSON.parse(String(init?.body));expect(body.target_user_id).toBe(owner);expect(body.initial_snapshot.data.opportunities).toEqual([])
    return json([{workspace_id:'synthetic-ws',revision:0,snapshot:body.initial_snapshot}])
   }
   return json({},500)
  })
  const response=await createConnectedWorkspaceHandler({...config,consumerOnboardingEnabled:true,fetchImpl})(request(input))
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({workspaceVersion:'txn:0',snapshot:{data:{timePlanning:{timezone:'Europe/London'}}}})
  expect(calls).toEqual(['/auth/v1/user','/rest/v1/pjsdas_workspaces','/rest/v1/rpc/pjsdas_bootstrap_consumer_workspace_v1'])
 })
 it('rejects delegated self-onboarding even when the fixture feature gate is enabled',async()=>{
  const payload=Buffer.from(JSON.stringify({client_id:'00000000-0000-4000-8000-000000000001'})).toString('base64url')
  const fetchImpl=vi.fn(async()=>json({id:owner}))
  const response=await createConnectedWorkspaceHandler({...config,consumerOnboardingEnabled:true,fetchImpl})(request(input,`header.${payload}.signature`))
  expect(response.status).toBe(403);expect(fetchImpl).toHaveBeenCalledTimes(1)
 })
 it('rejects origin and body target injection without touching workspaces',async()=>{
  const fetchImpl=vi.fn(async()=>json({id:owner}))
  const handler=createConnectedWorkspaceHandler({...config,consumerOnboardingEnabled:true,fetchImpl})
  expect((await handler(request(input,firstPartyToken,'https://other.invalid'))).status).toBe(403)
  expect(fetchImpl).not.toHaveBeenCalled()
  expect((await handler(request({...input,userId:'synthetic-b'}))).status).toBe(400)
  expect(fetchImpl).toHaveBeenCalledTimes(1)
 })
})
