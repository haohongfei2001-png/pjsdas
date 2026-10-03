import { describe, expect, it, vi } from 'vitest'
import { createScopedManagementConsentHandler } from '../gateway/scopedManagementConsentHandler.js'
import { SCOPED_MANAGEMENT_CONSENTS, scopedManagementConsentHash, scopedManagementDomains } from '../gateway/scopedManagementConsent.js'
import { scopedConsentDecisionSchema } from '../src/aiAccess/scopedConsentContract.js'
const owner='00000000-0000-4000-8000-000000000001',client='00000000-0000-4000-8000-000000000002',grant='00000000-0000-4000-8000-000000000003',requestId='00000000-0000-4000-8000-000000000004'
const origin='https://synthetic.invalid', token=`a.${Buffer.from(JSON.stringify({sub:owner})).toString('base64url')}.synthetic`
const req=(body?:unknown,headers:Record<string,string>={})=>new Request(`${origin}/api/workspace?surface=scoped-management-consent`,{method:body?'POST':'GET',headers:{origin,authorization:`Bearer ${token}`,'content-type':'application/json',...headers},body:body?JSON.stringify(body):undefined})
async function choice(domain='planning' as keyof typeof SCOPED_MANAGEMENT_CONSENTS){return {domain,decision:'approve',consentVersion:SCOPED_MANAGEMENT_CONSENTS[domain].version,consentTextHash:await scopedManagementConsentHash(domain),expectedGrant:null}}
async function body(){return {requestId,expectedAccountId:owner,clientId:client,choices:[await choice()],confirmed:true}}
function fixture(enabled='enabled'){
 const posts:any[]=[]
 const fetchImpl=vi.fn<typeof fetch>(async(input,init)=>{
  const path=new URL(String(input)).pathname
  if(path==='/auth/v1/user')return Response.json({id:owner})
  if(path==='/auth/v1/user/oauth/grants')return Response.json([{client:{id:client,name:'Synthetic client'},scopes:[],granted_at:'2026-10-01T00:00:00Z'}])
  if(path.endsWith('/pjsdas_business_management_grants'))return Response.json([])
  if(path.endsWith('/pjsdas_decide_scoped_management_consent_v1')){const p=JSON.parse(String(init?.body));posts.push(p);return Response.json([{receipts:p.target_choices.map((c:any)=>({domain:c.domain,outcome:c.decision==='approve'&&!p.target_provider_client_verified?'DENIED':c.decision==='approve'?'APPROVED':'REVOKED',grant_id:c.decision==='approve'&&!p.target_provider_client_verified?null:grant,grant_revision:c.decision==='approve'&&!p.target_provider_client_verified?null:1}))}])}
  throw new Error('Unexpected synthetic request')
 })
 const handler=createScopedManagementConsentHandler({enabled,supabaseUrl:origin,supabasePublishableKey:'synthetic-public',serviceRoleKey:'synthetic-service',allowedOrigins:[origin],authorizeIdentity:async()=>({allowed:true,mode:'allowlist',role:'owner'}),fetchImpl})
 return {handler,fetchImpl,posts}
}
describe('explicit scoped first-party consent',()=>{
 it('default-off handler performs no reads or writes',async()=>{const f=fixture('');expect((await f.handler(req())).status).toBe(404);expect(f.fetchImpl).not.toHaveBeenCalled()})
 it('reads five independent descriptors and provider client without granting anything',async()=>{const f=fixture();const response=await f.handler(req());expect(response.status).toBe(200);const v=await response.json();expect(v.descriptors.map((x:any)=>x.domain)).toEqual(scopedManagementDomains);expect(v.clients[0].grants).toEqual([]);expect(f.posts).toEqual([])})
 it.each(['origin','account','self-grant','hash','version','duplicate','empty','unknown','missing-proof','unconfirmed'])('rejects %s before persistent changes',async mode=>{
  const f=fixture(),v:any=await body(),headers:Record<string,string>={}
  if(mode==='origin')headers.origin='https://foreign.invalid'
  if(mode==='account')v.expectedAccountId=client
  if(mode==='client')v.clientId=owner
  if(mode==='self-grant')headers.authorization=`Bearer a.${Buffer.from(JSON.stringify({client_id:client})).toString('base64url')}.synthetic`
  if(mode==='hash')v.choices[0].consentTextHash='0'.repeat(64)
  if(mode==='version')v.choices[0].consentVersion=3
  if(mode==='duplicate')v.choices.push(v.choices[0])
  if(mode==='empty')v.choices=[]
  if(mode==='unknown')v.choices[0].domain='all'
  if(mode==='missing-proof')delete v.choices[0].expectedGrant
  if(mode==='unconfirmed')v.confirmed=false
  expect((await f.handler(req(v,headers))).status).toBeGreaterThanOrEqual(400);expect(f.posts).toEqual([])
 })
 it('only submits explicitly selected domains to one account-bound atomic RPC',async()=>{
  const f=fixture(),v=await body();v.choices.push(await choice('privateReminder'))
  const response=await f.handler(req(v));expect(response.status).toBe(200)
  expect(f.posts).toHaveLength(1);expect(f.posts[0]).toMatchObject({target_user_id:owner,target_client_id:client,target_choices:v.choices,target_provider_client_verified:true,target_first_party:true})
  expect(await response.json()).toMatchObject({refreshRequired:true,requestId,receipts:[{domain:'planning'},{domain:'privateReminder'}]})
 })
 it('revokes an owned proof after OAuth disconnect without looking up provider clients',async()=>{
  const f=fixture(),v:any=await body();v.choices[0].decision='revoke';v.choices[0].expectedGrant={id:grant,revision:1}
  expect((await f.handler(req(v))).status).toBe(200)
  expect(f.fetchImpl.mock.calls.some(([url])=>String(url).endsWith('/oauth/grants'))).toBe(false)
  expect(f.posts[0].target_provider_client_verified).toBe(false)
 })
 it('requires explicit absence or expected grant proof and never interprets empty choices as all',async()=>{
  const v=await body();expect(scopedConsentDecisionSchema.safeParse(v).success).toBe(true)
  expect(scopedConsentDecisionSchema.safeParse({...v,choices:[]}).success).toBe(false)
 })
 it('unconnected-client retry resolves only a terminal denial, never an approval',async()=>{
  const f=fixture(),v=await body();v.clientId=owner
  const response=await f.handler(req(v));expect(response.status).toBe(200);expect(await response.json()).toMatchObject({receipts:[{outcome:'DENIED',grant_id:null,grant_revision:null}]})
  expect(f.posts[0].target_provider_client_verified).toBe(false)
 })
 it.each(['GET','POST'])('maps provider-invalid session to401 for %s login recovery',async method=>{
  const f=fixture();f.fetchImpl.mockResolvedValue(Response.json({message:'expired'},{status:401}))
  const response=await f.handler(req(method==='POST'?await body():undefined));expect(response.status).toBe(401);expect(await response.json()).toMatchObject({code:'AUTH_REQUIRED'});expect(f.posts).toEqual([])
 })

})
