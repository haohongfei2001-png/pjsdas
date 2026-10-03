import { describe, expect, it, vi } from 'vitest'
import { createOwnerScopedManagementRuntime } from '../gateway/scopedManagementRuntime.js'
import { createOwnerBusinessManagementRuntime } from '../gateway/businessManagementRuntime.js'
import { hashMutationPayload } from '../gateway/mutationKernel.js'
import { scopedManagementConsentHash } from '../gateway/scopedManagementConsent.js'
import { unknownDeadlineWorkspace } from './fixtures/unknownDeadlineWorkspace.js'
const owner='00000000-0000-4000-8000-000000000001',client='00000000-0000-4000-8000-000000000002'
const change={operations:[{kind:'create_prep',value:{title:'Synthetic replay',estimatedMinutes:30}}]}
async function fixture(version:2|7,receiptVersion:2|7,undo=false,regrantDuringRead=false){
 let revision=1
 const commandId='synthetic-shared-id',targetCommandId='synthetic-original-id'
 const hash=await hashMutationPayload(version===7?(undo?'consumer_business_management_undo_v7':'consumer_business_management_v7'):(undo?'undo_command':'business_management'),undo?{targetCommandId}:{type:'business_management',value:change})
 const row={user_id:owner,command_id:commandId,operation:undo?'undo_command':'business_management',payload_hash:hash,resulting_revision:1,status:'COMMITTED',receipt:{managementAuthorization:{consentVersion:receiptVersion,grantRevision:1},result:{summary:'historical same-account result'}},compensation:{}}
 const target={...row,command_id:targetCommandId,operation:'business_management',receipt:{managementAuthorization:{consentVersion:version}},compensation:{operation:'business_management_restore',payload:{changes:[]}}}
 const posts=vi.fn(),snapshot=unknownDeadlineWorkspace(0),consumerHash=await scopedManagementConsentHash('business')
 const fetchImpl=vi.fn<typeof fetch>(async(input,init)=>{
  const u=new URL(String(input));expect(u.searchParams.get('user_id')).toBe(`eq.${owner}`)
  if(init?.method==='POST'){posts();throw new Error('Replay must never write')}
  if(u.pathname.endsWith('pjsdas_business_management_grants'))return Response.json([{id:'00000000-0000-4000-8000-000000000003',user_id:owner,client_id:client,revision,consent_version:version,capability:version===7?'workspace.business.manage':'workspace.manage',consent_text_hash:consumerHash,granted_at:'2026-10-01T00:00:00Z',revoked_at:null}])
  if(u.pathname.endsWith('pjsdas_workspaces'))return Response.json([{id:'synthetic-workspace',user_id:owner,revision:1,schema_version:4,snapshot}])
  if(u.pathname.endsWith('pjsdas_command_ledger')){if(regrantDuringRead)revision=2;return Response.json([u.searchParams.get('command_id')===`eq.${targetCommandId}`?target:row])}
  throw new Error('Unexpected synthetic request')
 })
 const options={enabled:'enabled',consumerEnabled:'enabled',transactional:true,identity:{userId:owner,oauthClientId:client},audience:{mode:'allowlist' as const,role:'owner' as const,allowed:true},supabaseUrl:'https://synthetic.invalid',serviceRoleKey:'synthetic',fetchImpl}
 const runtime=version===7?createOwnerScopedManagementRuntime(options)!.business!:createOwnerBusinessManagementRuntime({...options,source:{read:async()=>{throw new Error('No normalized read')}}})!
 const name=undo?(version===7?'undo_consumer_business_management':'undo_business_management'):(version===7?'execute_consumer_business_management':'execute_business_management')
 const invoke=()=>runtime.invoke(name as never,undo?{commandId,targetCommandId}:{commandId,baseRevision:0,change})
 return{invoke,posts}
}
describe('business receipt family replay fencing',()=>{
 it.each([2,7] as const)('rejects opposite-family execute replay even with a matching supplied hash (caller%s)',async version=>{
  const f=await fixture(version,version===2?7:2);expect((await f.invoke()).structuredContent).toMatchObject({code:'COMMAND_ID_REUSED'});expect(f.posts).not.toHaveBeenCalled()
 })
 it.each([2,7] as const)('rejects opposite-family undo-ID replay (caller%s)',async version=>{
  const f=await fixture(version,version===2?7:2,true);expect((await f.invoke()).structuredContent).toMatchObject({code:'COMMAND_ID_REUSED'});expect(f.posts).not.toHaveBeenCalled()
 })
 it.each([2,7] as const)('preserves true same-family execute and undo retry (caller%s)',async version=>{
  for(const undo of [false,true]){const f=await fixture(version,version,undo);expect((await f.invoke()).structuredContent).toMatchObject({outcome:'ALREADY_APPLIED'});expect(f.posts).not.toHaveBeenCalled()}
 })
 it.each([false,true])('withholds same-v7 historical replay after an in-flight regrant (undo%s)',async undo=>{
  const f=await fixture(7,7,undo,true);expect((await f.invoke()).structuredContent).toMatchObject({code:'AUTH_FORBIDDEN'});expect(f.posts).not.toHaveBeenCalled()
 })
})
