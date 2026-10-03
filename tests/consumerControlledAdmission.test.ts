import { expect, it, vi } from 'vitest'
import { consumerTestAccountAllowed } from '../gateway/consumerTestCohort.js'
import { createOwnerScopedManagementRuntime } from '../gateway/scopedManagementRuntime.js'
import { createScopedManagementConsentHandler } from '../gateway/scopedManagementConsentHandler.js'
import { scopedManagementConsentHash } from '../gateway/scopedManagementConsent.js'
const A='00000000-0000-4000-8000-000000000101',B='00000000-0000-4000-8000-000000000102',C='00000000-0000-4000-8000-000000000103',client='00000000-0000-4000-8000-000000000104',grant='00000000-0000-4000-8000-000000000105'
const cohort={accountIds:`${A},${B}`,clientId:client},origin='https://synthetic.invalid'
const runtime=(userId=A,role='beta',consumerCohort:typeof cohort|undefined=cohort,consumerEnabled='enabled',oauthClientId=client,enabled='')=>createOwnerScopedManagementRuntime({consumerCohort,consumerEnabled,enabled,identity:{userId,oauthClientId},audience:{allowed:true,mode:'allowlist',role:role as 'beta'|'owner'},transactional:true,supabaseUrl:origin,serviceRoleKey:'synthetic',fetchImpl:vi.fn(async()=>{throw Error('Unexpected data access')})})
it('limits new tools to both selected beta accounts and the exact existing client',()=>{
 for(const id of [A,B]) {const r=runtime(id)!;expect(r.business).toBeDefined();for(const d of ['opportunity','planning','discoveryProfile','privateReminder'] as const)expect(r[d]).toBeUndefined()}
 for(const r of [runtime(C),runtime(A,'owner'),runtime(A,'beta',cohort,''),runtime(A,'beta',cohort,'enabled',C),runtime(A,'beta',{accountIds:'',clientId:''})])expect(r).toBeUndefined()
 const owner=runtime(C,'owner',cohort,'enabled',client,'enabled')!;expect(owner.business).toBeUndefined();expect(owner.planning).toBeDefined()
})
it.each([undefined,'',A,`${A},${A}`,`${A},${B},${C}`,`${A},*`,`${A},bad`])('fails closed on absent/malformed/overbroad account configuration %s',accountIds=>{expect(consumerTestAccountAllowed(A,{accountIds,clientId:client})).toBe(false)})
function fixture(userId=A,off=false){
 const posts:any[]=[]
 const fetchImpl=vi.fn<typeof fetch>(async(input,init)=>{
  const path=new URL(String(input)).pathname
  if(path==='/auth/v1/user')return Response.json({id:userId})
  if(path.endsWith('/oauth/grants')){if(off)throw Error('Provider disconnected');return Response.json([{client:{id:client,name:'Original test client'},scopes:[],granted_at:'2026-10-03T00:00:00Z'}])}
  if(path.endsWith('pjsdas_business_management_grants'))return Response.json([{id:grant,user_id:userId,client_id:client,revision:1,revoked_at:null,consent_version:7,capability:'workspace.business.manage',consent_text_hash:await scopedManagementConsentHash('business')}])
  const p=JSON.parse(String(init?.body));posts.push(p)
  return Response.json([{receipts:p.target_choices.map((c:any)=>({domain:c.domain,outcome:c.decision==='revoke'?'REVOKED':p.target_provider_client_verified?'APPROVED':'DENIED',grant_id:c.decision==='revoke'||p.target_provider_client_verified?grant:null,grant_revision:c.decision==='revoke'||p.target_provider_client_verified?2:null}))}])
 })
 const handler=createScopedManagementConsentHandler({consumerEnabled:off?'':'enabled',consumerCohort:off?undefined:cohort,consumerOnboardingEnabled:!off,supabaseUrl:origin,supabasePublishableKey:'synthetic',serviceRoleKey:'synthetic',allowedOrigins:[origin],authorizeIdentity:async()=>{if(off)throw Error('No current audience');return {allowed:true,mode:'allowlist',role:'beta'}},fetchImpl})
 const req=(body?:unknown,delegated=false)=>new Request(origin+'/api/workspace?surface=scoped-management-consent',{method:body?'POST':'GET',headers:{origin,authorization:`Bearer a.${Buffer.from(JSON.stringify({sub:userId,...(delegated?{client_id:client}:{})})).toString('base64url')}.synthetic`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined})
 return {handler,req,posts,fetchImpl}
}
async function decision(domain='business',account=A,decision='approve') {return {expectedAccountId:account,clientId:client,requestId:C,confirmed:true,choices:[{domain,decision,consentVersion:domain==='business'?7:4,consentTextHash:await scopedManagementConsentHash(domain as 'business'|'planning'),expectedGrant:domain==='business'?{id:grant,revision:1}:null}]}}
it('advertises and accepts v7 only; denies a forged other-domain or mixed approval atomically',async()=>{
 const f=fixture();const view=await (await f.handler(f.req())).json();expect(view.canInitialize).toBe(true);expect(view.descriptors.filter((d:any)=>d.canApprove).map((d:any)=>d.domain)).toEqual(['business'])
 for(const choices of [[...(await decision('planning')).choices],[...(await decision()).choices,...(await decision('planning')).choices]]){
  const r=await f.handler(f.req({...await decision(),choices}));expect((await r.json()).receipts.every((x:any)=>x.outcome==='DENIED')).toBe(true);expect(f.posts.at(-1).target_provider_client_verified).toBe(false)
 }
 const approved=await f.handler(f.req(await decision()));expect((await approved.json()).receipts[0].outcome).toBe('APPROVED')
})
it('an admitted but nonselected beta user cannot initialize or approve new scopes',async()=>{
 const f=fixture(C);const view=await (await f.handler(f.req())).json();expect(view.canInitialize).toBe(false);expect(view.descriptors.every((d:any)=>!d.canApprove)).toBe(true)
 const response=await f.handler(f.req(await decision('business',C)));expect((await response.json()).receipts[0].outcome).toBe('DENIED')
})
it('after all flags/cohort/audience/provider access are removed, keeps owned revocation and denies approvals',async()=>{
 const f=fixture(A,true);const view=await (await f.handler(f.req())).json();expect(view.canInitialize).toBe(false);expect(view.clients[0].canApprove).toBe(false);expect(view.clients[0].grants[0].id).toBe(grant)
 const r=await f.handler(f.req(await decision('business',A,'revoke')));expect((await r.json()).receipts[0].outcome).toBe('REVOKED');expect(f.posts[0]).toMatchObject({target_consumer_enabled:false,target_provider_client_verified:false})
 expect(f.fetchImpl.mock.calls.some(([url])=>String(url).endsWith('/oauth/grants'))).toBe(false)
 const approve=await f.handler(f.req(await decision()));expect((await approve.json()).receipts[0].outcome).toBe('DENIED')
 const before=f.posts.length;expect((await f.handler(f.req(await decision('business',B,'revoke')))).status).toBe(403);expect((await f.handler(f.req(await decision('business',A,'revoke'),true))).status).toBe(403);expect(f.posts).toHaveLength(before)
})
