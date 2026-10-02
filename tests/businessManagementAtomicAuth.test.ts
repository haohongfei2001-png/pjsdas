import { describe, expect, it, vi } from 'vitest'
import { createBusinessManagementGrantReader } from '../gateway/businessManagementGrantStore.js'
import { bindManagementConsent, bindManagementUpgrade } from '../gateway/businessManagementConsent.js'
import { assertBusinessManagementGrant } from '../gateway/businessManagementAccess.js'
import { createTransactionalWorkspaceStore } from '../gateway/transactionalWorkspaceStore.js'
import type { PJSDASSnapshot } from '../src/snapshot.js'
const owner='00000000-0000-4000-8000-000000000001'
const client='00000000-0000-4000-8000-000000000002'
const grantId='00000000-0000-4000-8000-000000000003'
const authId='00000000-0000-4000-8000-000000000004'
const principal={kind:'delegated_mcp' as const,userId:owner,clientId:client}
const row={id:grantId,user_id:owner,client_id:client,capability:'workspace.manage',consent_version:2,revision:1,granted_at:'2026-10-01T00:00:00Z',revoked_at:null}
const fixture:PJSDASSnapshot={schema:'pjsdas-local-snapshot',version:4,exportedAt:'2026-10-02T00:00:00Z',data:{opportunities:[],processes:[],processEvents:[],actions:[],prep:[],applicationGroups:[],scheduleNodes:[],decisionRequests:[],semanticReceipts:[],reminderIntents:[],reminderOutbox:[]}}
const commit={userId:owner,clientId:client,principalKind:'delegated_mcp' as const,commandId:'synthetic-command',operation:'business_management',payloadHash:'synthetic-hash',expectedRevision:0,snapshot:fixture,schemaVersion:4,receiptContext:{},managementAuthorization:{grantId,grantRevision:1}}
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}})

describe('current transaction-bound management authorization',()=>{
 it('reads only the exact owner/client current grant with no writes',async()=>{
  const fetchImpl=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
   const url=new URL(String(input));expect(url.searchParams.get('user_id')).toBe(`eq.${owner}`);expect(url.searchParams.get('client_id')).toBe(`eq.${client}`);expect(init?.method??'GET').toBe('GET');return json([row])
  })
  const read=createBusinessManagementGrantReader({supabaseUrl:'https://example.invalid',serviceRoleKey:'synthetic',fetchImpl})
  expect(await read(principal)).toMatchObject({id:grantId,revision:1,userId:owner,clientId:client})
  expect(fetchImpl).toHaveBeenCalledTimes(1)
 })
 it('rejects foreign, duplicate, revoked, malformed and future grants',async()=>{
  for(const rows of [[{...row,user_id:client}],[{...row,client_id:owner}],[row,row],[{...row,revoked_at:'2026-10-02T00:00:00Z'}],[{...row,revoked_at:false}],[{...row,revision:0}],[{...row,granted_at:'2999-01-01T00:00:00Z'}]]){
   const read=createBusinessManagementGrantReader({supabaseUrl:'https://example.invalid',serviceRoleKey:'synthetic',fetchImpl:async()=>json(rows)})
   await expect(read(principal)).rejects.toThrow()
  }
 })
 it('does not treat a missing grant table or lookup failure as permission',async()=>{
  const read=createBusinessManagementGrantReader({supabaseUrl:'https://example.invalid',serviceRoleKey:'synthetic',fetchImpl:async()=>json({message:'missing'},404)})
  await expect(read(principal)).rejects.toThrow(/lookup failed/)
 })
 it('requires a delegated principal, valid grant identity and positive revision',()=>{
  const grant={id:grantId,revision:1,userId:owner,clientId:client,consentVersion:2 as const,capability:'workspace.manage' as const,grantedAt:row.granted_at}
  expect(()=>assertBusinessManagementGrant({...principal,kind:'automation'},grant)).toThrow()
  expect(()=>assertBusinessManagementGrant(principal,{...grant,id:'unbound'})).toThrow()
 })
 it('uses only atomic grant RPC and binds exact grant identity/version',async()=>{
  const fetchImpl=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
   expect(new URL(String(input)).pathname).toBe('/rest/v1/rpc/pjsdas_commit_management_workspace_v1')
   const body=JSON.parse(String(init?.body));expect(body.target_grant_id).toBe(grantId);expect(body.target_grant_revision).toBe(1);expect(body.target_user_id).toBe(owner);expect(body.target_client_id).toBe(client)
   return json([{outcome:'COMMITTED',workspace_id:'fixture-workspace',revision:1,receipt:{}}])
  })
  const store=createTransactionalWorkspaceStore({supabaseUrl:'https://example.invalid',serviceRoleKey:'synthetic',fetchImpl})
  expect((await store.commitAuthoritativeForUser(commit)).outcome).toBe('COMMITTED')
  expect(fetchImpl).toHaveBeenCalledTimes(1)
 })
 it('never falls back to the old RPC without grant evidence or after atomic denial',async()=>{
  const fetchImpl=vi.fn(async()=>json({code:'42501',message:'revoked'},403))
  const store=createTransactionalWorkspaceStore({supabaseUrl:'https://example.invalid',serviceRoleKey:'synthetic',fetchImpl})
  await expect(store.commitAuthoritativeForUser({...commit,managementAuthorization:undefined})).rejects.toThrow(/transaction-bound/)
  expect(fetchImpl).not.toHaveBeenCalled()
  await expect(store.commitAuthoritativeForUser(commit)).rejects.toThrow(/changed before commit/)
  expect(fetchImpl).toHaveBeenCalledTimes(1)
 })
})

describe('explicit first-party management consent binding',()=>{
 const identity={userId:owner}
 const decision={authorizationId:authId,consentVersion:2,decision:'approve'}
 const details={authorization_id:authId,user:{id:owner},client:{id:client,name:'Synthetic client'}}
 it('derives account/client from verified identity/provider details',()=>{
  expect(bindManagementConsent(identity,decision,details)).toMatchObject({userId:owner,clientId:client,decision:'approve'})
 })
 it('rejects delegated self-grant, foreign user, wrong auth request and body owner/client injection',()=>{
  expect(()=>bindManagementConsent({...identity,oauthClientId:client},decision,details)).toThrow(/cannot authorize/)
  expect(()=>bindManagementConsent(identity,decision,{...details,user:{id:client}})).toThrow(/does not match/)
  expect(()=>bindManagementConsent(identity,decision,{...details,authorization_id:grantId})).toThrow(/does not match/)
  expect(()=>bindManagementConsent(identity,{...decision,userId:client},details)).toThrow()
  expect(()=>bindManagementConsent(identity,{...decision,clientId:owner},details)).toThrow()
 })
 it('does not interpret already-consented OAuth redirect as expanded approval',()=>{
  expect(()=>bindManagementConsent(identity,decision,{redirect_url:'https://example.invalid/callback'})).toThrow(/auto-redirect/)
 })
 it('keeps a decline explicit, without issuing a grant',()=>{
  expect(bindManagementConsent(identity,{...decision,decision:'deny'},details).decision).toBe('deny')
 })
 it('upgrades an old OAuth connection only after selecting its verified provider grant',()=>{
  const grants=[{client:{id:client,name:'Synthetic client'},scopes:['email','profile'],granted_at:'2026-10-01T00:00:00Z'}]
  expect(bindManagementUpgrade(identity,{clientId:client,consentVersion:2,decision:'approve'},grants)).toMatchObject({userId:owner,clientId:client})
  expect(()=>bindManagementUpgrade(identity,{clientId:owner,consentVersion:2,decision:'approve'},grants)).toThrow(/not a verified connection/)
  expect(()=>bindManagementUpgrade({...identity,oauthClientId:client},{clientId:client,consentVersion:2,decision:'approve'},grants)).toThrow(/cannot authorize/)
 })
})
