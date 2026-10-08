import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAutomationConnectionStore } from '../gateway/automationConnectionStore.js'
import { createDiscoveryAutomationHandler } from '../gateway/discoveryAutomationHandler.js'
import { createSnapshot } from '../src/snapshot.js'
const owner='00000000-0000-4000-8000-000000000001'
const options={supabaseUrl:'https://example.invalid',supabasePublishableKey:'synthetic-public',workerToken:'synthetic-worker',supabaseServiceRoleKey:'synthetic-service'}
afterEach(()=>vi.unstubAllEnvs())
function store(response:()=>Response){return createAutomationConnectionStore({...options,fetchImpl:async()=>response()})}
const methods=['updateDiscoveryRunState','updateGmailRunState','updateGmailWatchState'] as const
const voidBodies=[['204',()=>new Response(null,{status:204})],['empty',()=>new Response('',{status:200})],['whitespace',()=>new Response(' \n ',{status:200})],['json-null',()=>Response.json(null)]] as const
describe('explicit void automation RPC contracts',()=>{
 for(const method of methods){
  it.each(voidBodies)(`${method} accepts successful %s`,async(_name,response)=>{await expect(store(response)[method](owner,{})).resolves.toBeUndefined()})
  it.each(['{','{}','[]','false','"unexpected"'])(`${method} refuses invalid/nonvoid body %s`,async body=>{await expect(store(()=>new Response(body,{status:200}))[method](owner,{})).rejects.toMatchObject({code:'AUTH_INVALID'})})
  it.each([401,403])(`${method} preserves HTTP %s authorization failure`,async status=>{await expect(store(()=>Response.json({},{status}))[method](owner,{})).rejects.toMatchObject({code:'AUTOMATION_AUTH_REQUIRED'})})
 }
 it.each([204,500])('nonvoid read never accepts HTTP %s without expected data',async status=>{
  await expect(store(()=>new Response(null,{status})).listDiscoveryBindings()).rejects.toMatchObject({code:status===204?'AUTH_INVALID':'AUTH_UNAVAILABLE'})
 })
 it('preserves valid nullable nonvoid execution results and invalid JSON detection',async()=>{
  await expect(store(()=>Response.json(null)).beginGmailExecution(owner,'synthetic-execution')).resolves.toBeUndefined()
  await expect(store(()=>new Response('{')).listDiscoveryBindings()).rejects.toMatchObject({code:'AUTH_INVALID'})
 })
 it('preserves missing-contract and transport errors',async()=>{
  await expect(store(()=>Response.json({code:'PGRST202'},{status:404})).listDiscoveryBindings()).rejects.toMatchObject({code:'AUTOMATION_RPC_NOT_DEPLOYED'})
  const failed=createAutomationConnectionStore({...options,fetchImpl:async()=>{throw new Error('synthetic network loss')}})
  await expect(failed.updateDiscoveryRunState(owner,{})).rejects.toMatchObject({code:'AUTH_UNAVAILABLE'})
 })
})

describe('background discovery finalizes through the generation-fenced wrapper',()=>{
 it('finishes a no-model check with one confirmed fenced update and no false AUTH_INVALID',async()=>{
  vi.stubEnv('PJSDAS_CONNECTED_AUTHORITY','transactional');vi.stubEnv('PJSDAS_SUPABASE_SERVICE_ROLE_KEY','synthetic-service')
  const snapshot=createSnapshot({opportunities:[],processes:[],processEvents:[],actions:[],prep:[],applicationGroups:[]})
  const updates:Record<string,unknown>[]=[]
  const generateTextImpl=vi.fn(async()=>{throw new Error('No paid/model call is allowed in this fixture')})
  const fetchImpl=vi.fn<typeof fetch>(async(input,init)=>{
   const url=String(input)
   if(url.includes('pjsdas_claim_enabled_discovery_automation_bindings'))return Response.json([{user_id:owner,google_subject:'synthetic-subject',refresh_token_ciphertext:'synthetic-unused',granted_scopes:[]}])
   if(url.includes('/pjsdas_workspaces?'))return Response.json([{id:'synthetic-workspace',user_id:owner,snapshot,revision:0,schema_version:4}])
   if(url.includes('pjsdas_update_google_automation_state')){const body=JSON.parse(String(init?.body));expect(body.expected_ciphertext).toBe('synthetic-unused');expect(body.state_operation).toBe('pjsdas_update_discovery_automation_state');updates.push(body.state_patch);return Response.json(true)}
   throw new Error('Unexpected fixture request')
  })
  const handler=createDiscoveryAutomationHandler({...options,tokenEncryptionKey:'synthetic-unused',googleClientId:'synthetic-unused',googleClientSecret:'synthetic-unused',fetchImpl,generateTextImpl,now:()=>new Date('2026-10-02T15:15:00Z')})
  const response=await handler(new Request('https://example.invalid/api/automation-discovery',{headers:{authorization:'Bearer synthetic-worker'}}))
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({failedUsers:0,durableCompletedUsers:0,results:[{status:'not_configured',producer:'server_scheduler',durableCommit:false}]})
  expect(updates).toHaveLength(1);expect(updates[0]).toMatchObject({checked_at:'2026-10-02T15:15:00.000Z',success_at:null,last_error:null,set_last_error:true})
  expect(generateTextImpl).not.toHaveBeenCalled()
 })
})
