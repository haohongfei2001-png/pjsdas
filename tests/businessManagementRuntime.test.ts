import { describe, expect, it, vi } from 'vitest'
import { createOwnerBusinessManagementRuntime } from '../gateway/businessManagementRuntime.js'
const owner='00000000-0000-4000-8000-000000000001', client='00000000-0000-4000-8000-000000000002'
const grant={id:'00000000-0000-4000-8000-000000000003',user_id:owner,client_id:client,revision:1,consent_version:2,capability:'workspace.manage',granted_at:'2026-10-01T00:00:00Z',revoked_at:null}
const args={commandId:'synthetic-command-1',baseRevision:0,change:{operations:[{kind:'create_prep',value:{title:'Synthetic',estimatedMinutes:30}}]}}
function fixture() {
 const fetchImpl=vi.fn<typeof fetch>(async()=>Response.json([grant]))
 return {enabled:'enabled',transactional:true,identity:{userId:owner,oauthClientId:client},audience:{mode:'allowlist' as const,allowed:true,role:'owner' as const},source:{read:async()=>{throw new Error('unexpected workspace read')}},supabaseUrl:'https://example.invalid',serviceRoleKey:'synthetic',fetchImpl}
}
describe('owner-only management runtime',()=>{
 it.each([{}, {enabled:undefined},{enabled:'true'},{transactional:false},{identity:{userId:owner}},{audience:{mode:'allowlist',allowed:true,role:'beta'}},{audience:{mode:'public',allowed:true,role:'legacy'}},{audience:{mode:'allowlist',allowed:false,role:'owner'}}])('default denies unsupported activation %#',override=>{
  const options=fixture();const candidate=Object.keys(override).length?{...options,...override}:{...options,enabled:undefined}
  expect(createOwnerBusinessManagementRuntime(candidate as typeof options)).toBeUndefined();expect(options.fetchImpl).not.toHaveBeenCalled()
 })
 it('constructs enabled adapter without granting access or network writes',()=>{
  const options=fixture();expect(createOwnerBusinessManagementRuntime(options)).toBeDefined();expect(options.fetchImpl).not.toHaveBeenCalled()
 })
 it.each(['revoke','revision','identity'] as const)('refuses %s between adapter admission and executor admission',async change=>{
  const options=fixture();let reads=0
  options.fetchImpl.mockImplementation(async(input,init)=>{
   const url=String(input);expect(url).toContain('/pjsdas_business_management_grants?');expect(init?.method??'GET').toBe('GET');reads++
   const next=change==='revoke'?[]:[{...grant,...(change==='revision'?{revision:2}:{id:'00000000-0000-4000-8000-000000000004'})}]
   return Response.json(reads===1?[grant]:next)
  })
  const response=await createOwnerBusinessManagementRuntime(options)!.invoke('execute_business_management',args)
  expect(response.isError).toBe(true);expect(response.structuredContent).toMatchObject({code:'AUTH_FORBIDDEN'});expect(reads).toBe(2)
 })
})

describe('runtime-to-authoritative SQL adapter',()=>{
 it.each([200,403])('uses the exact owner/client/proof atomic RPC and never a fallback (HTTP %s)',async status=>{
  const options=fixture();const posts:string[]=[]
  const snapshot={schema:'pjsdas-local-snapshot',version:4,exportedAt:'2026-10-02T00:00:00Z',data:{opportunities:[],processes:[],processEvents:[],actions:[],prep:[],applicationGroups:[],timeline:[],scheduleNodes:[],decisionRequests:[],semanticReceipts:[],reminderIntents:[],reminderOutbox:[]}}
  options.fetchImpl.mockImplementation(async(input,init)=>{
   const url=new URL(String(input))
   if((init?.method??'GET')==='POST'){
    posts.push(url.pathname)
    expect(url.pathname).toBe('/rest/v1/rpc/pjsdas_commit_management_workspace_v1')
    const body=JSON.parse(String(init?.body))
    expect(body).toMatchObject({target_user_id:owner,target_client_id:client,target_grant_id:grant.id,target_grant_revision:1,target_operation:'business_management',target_command_id:args.commandId})
    expect(body.target_snapshot.data.prep[0].title).toBe('Synthetic')
    return status===403?Response.json({code:'42501',message:'revoked'},{status}):Response.json([{outcome:'COMMITTED',workspace_id:'fixture-workspace',revision:1,receipt:{}}])
   }
   expect(url.searchParams.get('user_id')).toBe(`eq.${owner}`)
   if(url.pathname.endsWith('pjsdas_business_management_grants'))return Response.json([grant])
   if(url.pathname.endsWith('pjsdas_workspaces'))return Response.json([{id:'fixture-workspace',user_id:owner,snapshot,revision:0,schema_version:4}])
   if(url.pathname.endsWith('pjsdas_command_ledger'))return Response.json([])
   throw new Error('Unexpected fixture request')
  })
  const response=await createOwnerBusinessManagementRuntime(options)!.invoke('execute_business_management',args)
  expect(posts,JSON.stringify(response)).toEqual(['/rest/v1/rpc/pjsdas_commit_management_workspace_v1'])
  expect(response.isError===true).toBe(status===403)
  expect(response.structuredContent).toMatchObject(status===403?{code:'AUTH_FORBIDDEN'}:{outcome:'COMMITTED',workspaceVersion:'txn:1'})
 })
})
