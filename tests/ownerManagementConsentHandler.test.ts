import { describe, expect, it, vi } from 'vitest'
import { createOwnerManagementConsentHandler, OWNER_MANAGEMENT_CONSENT, type OwnerManagementConsentConfig } from '../gateway/ownerManagementConsentHandler.js'
import { hashMutationPayload } from '../gateway/mutationKernel.js'
const owner='00000000-0000-4000-8000-000000000001',client='00000000-0000-4000-8000-000000000002',grantId='00000000-0000-4000-8000-000000000003',requestId='00000000-0000-4000-8000-000000000004'
const origin='https://todayaction.example'
const sessionToken=`eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({sub:owner})).toString('base64url')}.synthetic`
const grant={id:grantId,user_id:owner,client_id:client,revision:1,revoked_at:null,consent_version:2}
function fixture(override:Partial<OwnerManagementConsentConfig>={}) {
 const posts:Record<string,unknown>[]=[]
 const fetchImpl=vi.fn<typeof fetch>(async(input,init)=>{
  const url=new URL(String(input))
  if(url.pathname==='/auth/v1/user')return Response.json({id:owner,email:'owner@example.invalid'})
  if(url.pathname==='/auth/v1/user/oauth/grants'){expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${sessionToken}`);return Response.json([{client:{id:client,name:'Synthetic client'},scopes:['email'],granted_at:'2026-10-01T00:00:00Z'}])}
  if(url.pathname.endsWith('/pjsdas_business_management_grants')){expect(url.searchParams.get('user_id')).toBe(`eq.${owner}`);return Response.json([grant])}
  if(url.pathname.endsWith('/pjsdas_decide_management_consent_v1')){posts.push(JSON.parse(String(init?.body)));return Response.json([{outcome:'APPROVED',grant_id:grantId,grant_revision:2}])}
  throw new Error('Unexpected synthetic request')
 })
 const authorizeIdentity=vi.fn(async()=>({mode:'allowlist' as const,allowed:true,role:'owner' as const}))
 const handler=createOwnerManagementConsentHandler({enabled:'enabled',supabaseUrl:'https://example.invalid',supabasePublishableKey:'synthetic-public',serviceRoleKey:'synthetic-service',allowedOrigins:[origin],fetchImpl,authorizeIdentity,...override})
 return {handler,fetchImpl,authorizeIdentity,posts}
}
function request(method='GET',body?:unknown,headers:Record<string,string>={}){return new Request('https://example.invalid/api/owner-management-consent',{method,headers:{origin,authorization:`Bearer ${sessionToken}`,'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)})}
async function decision(){return {requestId,expectedAccountId:owner,clientId:client,decision:'approve',consentVersion:2,consentTextHash:await hashMutationPayload('owner_management_consent_v2',OWNER_MANAGEMENT_CONSENT),expectedGrant:{id:grantId,revision:1},confirmed:true}}
describe('first-party owner capability consent boundary',()=>{
 it('defaults off before any identity or provider request',async()=>{const f=fixture({enabled:undefined});expect((await f.handler(request())).status).toBe(404);expect(f.fetchImpl).not.toHaveBeenCalled()})
 it.each(['https://foreign.invalid','null',''])('rejects origin %s before authentication',async origin=>{const f=fixture();expect((await f.handler(request('GET',undefined,{origin}))).status).toBe(403);expect(f.fetchImpl).not.toHaveBeenCalled()})
 it('accepts an Origin-less read only after first-party owner verification',async()=>{
  const f=fixture();const req=request();req.headers.delete('origin')
  const response=await f.handler(req);expect(response.status).toBe(200)
  expect(f.authorizeIdentity).toHaveBeenCalledTimes(1);expect(f.posts).toHaveLength(0)
  expect(response.headers.has('access-control-allow-origin')).toBe(false)
 })
 it('returns authentication-required, not an origin failure, for an anonymous Origin-less read',async()=>{
  const f=fixture();const req=request();req.headers.delete('origin');req.headers.delete('authorization')
  const response=await f.handler(req);expect(response.status).toBe(401)
  expect(await response.json()).toMatchObject({code:'AUTH_REQUIRED'});expect(f.posts).toHaveLength(0)
 })
 it.each(['POST','OPTIONS'])('keeps %s Origin mandatory before authentication or writes',async method=>{
  const f=fixture();const req=request(method,method==='POST'?await decision():undefined);req.headers.delete('origin')
  expect((await f.handler(req)).status).toBe(403);expect(f.fetchImpl).not.toHaveBeenCalled();expect(f.posts).toHaveLength(0)
 })
 it('still refuses delegated authentication on an Origin-less read',async()=>{
  const token=`eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({client_id:client})).toString('base64url')}.synthetic`
  const f=fixture();const req=request('GET',undefined,{authorization:`Bearer ${token}`});req.headers.delete('origin')
  expect((await f.handler(req)).status).toBe(403);expect(f.authorizeIdentity).not.toHaveBeenCalled();expect(f.posts).toHaveLength(0)
 })
 it('rejects delegated self-authorization before owner/provider checks',async()=>{
  const token=`eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({client_id:client})).toString('base64url')}.synthetic`
  const f=fixture();expect((await f.handler(request('POST',await decision(),{authorization:`Bearer ${token}`}))).status).toBe(403);expect(f.authorizeIdentity).not.toHaveBeenCalled();expect(f.posts).toHaveLength(0)
 })
 it.each(['00000000-0000-7000-8000-000000000002', 'malformed-client', '', null, 123])('rejects every present delegated claim including %s',async clientClaim=>{
  const token=`eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({client_id:clientClaim})).toString('base64url')}.synthetic`
  const f=fixture();expect((await f.handler(request('POST',await decision(),{authorization:`Bearer ${token}`}))).status).toBe(403);expect(f.authorizeIdentity).not.toHaveBeenCalled();expect(f.posts).toHaveLength(0)
 })
 it.each(['opaque-token','a.invalid-json.sig'])('rejects unclassifiable provider-validated token %s',async token=>{
  const f=fixture();expect((await f.handler(request('POST',await decision(),{authorization:`Bearer ${token}`}))).status).toBe(403);expect(f.posts).toHaveLength(0)
 })
 it.each([{mode:'allowlist',allowed:true,role:'beta'},{mode:'legacy',allowed:true,role:'legacy'},{mode:'allowlist',allowed:false,role:'owner'}])('rejects nonowner audience %#',async audience=>{
  const f=fixture({authorizeIdentity:async()=>audience as Awaited<ReturnType<OwnerManagementConsentConfig['authorizeIdentity']>>});expect((await f.handler(request('POST',await decision()))).status).toBe(403);expect(f.posts).toHaveLength(0)
 })
 it('GET returns exact versioned limited scope/client/proof without writes',async()=>{
  const f=fixture();const response=await f.handler(request());expect(response.status).toBe(200);const body=await response.json();expect(body).toMatchObject({account:{id:owner},consent:{version:2},clients:[{id:client,name:'Synthetic client',canApprove:true,grant:{id:grantId,revision:1}}]});expect(body.consent.scope).toHaveLength(4);expect(body.consent.exclusions).toContain('后续扩大范围需要重新明确授权');expect(f.posts).toHaveLength(0)
 })
 it.each([{confirmed:false},{consentVersion:1},{consentTextHash:'a'.repeat(64)},{userId:'foreign'},{expectedAccountId:client},{expectedGrant:undefined},{clientId:owner}])('rejects missing/forged approval %# before persistent writes',async change=>{
  const f=fixture();expect((await f.handler(request('POST',{...await decision(),...change}))).status).toBeGreaterThanOrEqual(400);expect(f.posts).toHaveLength(0)
 })
 it('binds approved account/client and CAS proof in one audited RPC',async()=>{
  const f=fixture();const response=await f.handler(request('POST',await decision()));expect(response.status).toBe(200)
  expect(f.posts).toHaveLength(1);expect(f.posts[0]).toMatchObject({target_user_id:owner,target_client_id:client,target_first_party:true,target_provider_client_verified:true,target_expected_grant_id:grantId,target_expected_grant_revision:1,target_request_id:requestId,target_consent_version:2})
  const body=await response.json();expect(body).toMatchObject({receipt:{outcome:'APPROVED'},refreshRequired:true});expect(body).not.toHaveProperty('authorized')
 })
 it('permits owned grant revocation after provider disconnect, but forbids a proofless target',async()=>{
  const f=fixture();const response=await f.handler(request('POST',{...await decision(),decision:'revoke'}));expect(response.status).toBe(200);expect(f.posts[0]).toMatchObject({target_decision:'revoke',target_provider_client_verified:false});expect(f.fetchImpl.mock.calls.some(([url])=>String(url).includes('/user/oauth/grants'))).toBe(false)
  const g=fixture();expect((await g.handler(request('POST',{...await decision(),decision:'revoke',expectedGrant:null}))).status).toBe(400);expect(g.posts).toHaveLength(0)
 })
 it('fails closed if provider lookup fails, never treats it as an active connection',async()=>{
  const f=fixture();f.fetchImpl.mockImplementation(async input=>String(input).endsWith('/auth/v1/user')?Response.json({id:owner}):Response.json({error:'private failure'},{status:503}))
  const response=await f.handler(request('POST',await decision()));expect(response.status).toBe(503);expect(f.posts).toHaveLength(0);expect(await response.text()).not.toContain('private failure')
 })
 it.each(['lost_response','server_error','malformed_success'] as const)('reports %s as an uncertain write with read-back and same-ID-only guidance',async fault=>{
  const f=fixture();const normal=f.fetchImpl.getMockImplementation()!
  f.fetchImpl.mockImplementation(async(input,init)=>{
   if(String(input).endsWith('/pjsdas_decide_management_consent_v1')){
    if(fault==='lost_response')throw new Error('synthetic transport loss after possible commit')
    if(fault==='server_error')return Response.json({error:'synthetic'}, {status:500})
    return Response.json([{outcome:'APPROVED',grant_id:null,grant_revision:null}])
   }
   return normal(input,init)
  })
  const response=await f.handler(request('POST',await decision()))
  expect(response.status).toBe(503);expect(await response.json()).toMatchObject({code:'CONSENT_OUTCOME_UNCONFIRMED',outcome:'UNCONFIRMED',requestId,recovery:'READ_CURRENT_STATE_THEN_RETRY_SAME_REQUEST_ID_ONLY',retryable:false})
 })
 it('rejects oversized or non-JSON consent payloads',async()=>{
  const f=fixture();expect((await f.handler(request('POST',{...await decision(),padding:'x'.repeat(9000)}))).status).toBe(400)
  expect((await f.handler(request('POST',await decision(),{'content-type':'text/plain'}))).status).toBe(400);expect(f.posts).toHaveLength(0)
 })
})

describe('existing workspace function allocation',()=>{
 it('routes the exact new surface to default-off denial without changing ordinary workspace requests',async()=>{
  const saved=process.env.PJSDAS_OWNER_MANAGEMENT_CONSENT
  delete process.env.PJSDAS_OWNER_MANAGEMENT_CONSENT
  try{
   vi.resetModules()
   const {default:endpoint}=await import('../api/workspace.js')
   const response=await endpoint.fetch(new Request('https://example.invalid/api/workspace?surface=owner-management-consent'))
   expect(response.status).toBe(404);expect(await response.json()).toMatchObject({code:'CAPABILITY_DISABLED'})
   const ordinary=await endpoint.fetch(new Request('https://example.invalid/api/workspace'))
   expect(ordinary.status).toBe(403);expect(await ordinary.json()).toMatchObject({code:'ORIGIN_NOT_ALLOWED'})
  }finally{if(saved===undefined)delete process.env.PJSDAS_OWNER_MANAGEMENT_CONSENT;else process.env.PJSDAS_OWNER_MANAGEMENT_CONSENT=saved}
 })
})
