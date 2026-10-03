import * as z from 'zod/v4'
import { createSupabaseIdentityResolver } from './supabaseIdentity.js'
import type { OwnerManagementConsentConfig } from './ownerManagementConsentHandler.js'
import { scopedConsentDecisionSchema } from '../src/aiAccess/scopedConsentContract.js'
import { SCOPED_MANAGEMENT_CONSENTS, scopedManagementConsentHash, scopedManagementDomains } from './scopedManagementConsent.js'
import { createScopedManagementConsentStore } from './scopedManagementConsentStore.js'
import { hashMutationPayload } from './mutationKernel.js'
import { WorkspaceSourceError } from './workspaceSource.js'
const providerGrantsSchema=z.array(z.object({client:z.object({id:z.uuid(),name:z.string().trim().min(1).max(500)}),scopes:z.array(z.string()),granted_at:z.string()})).max(100)
function assertFirstPartyTokenShape(accessToken:string) {
 try {
  const parts=accessToken.split('.')
  if(parts.length!==3)throw new Error('uncertain token shape')
  const encoded=parts[1].replace(/-/g,'+').replace(/_/g,'/')
  const claims:unknown=JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length/4)*4,'=')))
  if(!claims||typeof claims!=='object'||Array.isArray(claims)||Object.prototype.hasOwnProperty.call(claims,'client_id'))throw new Error('delegated or uncertain claim')
 }catch{throw new WorkspaceSourceError('AUTH_FORBIDDEN','A verified first-party session without delegated client claims is required.',false)}
}
async function boundedJson(request:Request) {
 if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))throw new WorkspaceSourceError('INVALID_ARGUMENT','JSON content type is required.',false)
 const reader=request.body?.getReader(); if(!reader)throw new WorkspaceSourceError('INVALID_ARGUMENT','Explicit consent decision is required.',false)
 const chunks:Uint8Array[]=[];let size=0
 try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>8192){await reader.cancel();throw new WorkspaceSourceError('INVALID_ARGUMENT','Consent request is too large.',false)}chunks.push(value)}}finally{reader.releaseLock()}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}
 try{return JSON.parse(new TextDecoder().decode(bytes))}catch{throw new WorkspaceSourceError('INVALID_ARGUMENT','Consent JSON is invalid.',false)}
}

/** Consumer admission is independently default-off; existing audience policy still applies. */
export function createScopedManagementConsentHandler(config: OwnerManagementConsentConfig & { consumerEnabled?: string; audienceMode?: 'allowlist' | 'legacy' }) {
 const fetchImpl=config.fetchImpl??fetch
 const resolveIdentity=createSupabaseIdentityResolver({supabaseUrl:config.supabaseUrl,publishableKey:config.supabasePublishableKey,fetchImpl})
 const store=createScopedManagementConsentStore({...config,fetchImpl})
 async function providerClients(accessToken:string) {
  let response:Response
  try{response=await fetchImpl(`${config.supabaseUrl.replace(/\/+$/,'')}/auth/v1/user/oauth/grants`,{headers:{authorization:`Bearer ${accessToken}`,apikey:config.supabasePublishableKey}})}catch{throw new WorkspaceSourceError('AUTH_UNAVAILABLE','Connected clients could not be verified.',true)}
  if(!response.ok)throw new WorkspaceSourceError('AUTH_UNAVAILABLE','Connected clients could not be verified.',response.status>=500||response.status===429)
  const parsed=providerGrantsSchema.safeParse(await response.json().catch(()=>undefined))
  if(!parsed.success||new Set(parsed.data.map(g=>g.client.id)).size!==parsed.data.length)throw new WorkspaceSourceError('AUTH_INVALID','Connected client response is invalid.',false)
  return parsed.data.map(g=>g.client)
 }

 return async (request: Request) => {
  const origin=request.headers.get('origin'), allowed=Boolean(origin&&config.allowedOrigins.includes(origin))
  const headers:Record<string,string>={'content-type':'application/json; charset=utf-8','cache-control':'no-store',vary:'Origin'}
  if(allowed){headers['access-control-allow-origin']=origin!;headers['access-control-allow-headers']='authorization, content-type';headers['access-control-allow-methods']='GET, POST, OPTIONS'}
  const respond=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers})
  const consumerEnabled=config.consumerEnabled==='enabled'
  if(config.enabled!=='enabled'&&!consumerEnabled)return respond(404,{code:'CAPABILITY_DISABLED'})
  if(!allowed&&!(request.method==='GET'&&origin===null))return respond(403,{code:'ORIGIN_NOT_ALLOWED'})
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers})
  if(!['GET','POST'].includes(request.method))return respond(405,{code:'METHOD_NOT_ALLOWED'})
  try {
   const {identity,accessToken}=await resolveIdentity(request).catch(error=>{
    if(error instanceof WorkspaceSourceError&&error.code==='AUTH_INVALID')throw new WorkspaceSourceError('AUTH_REQUIRED','Your sign-in expired. Sign in again to read or change consent.',false)
    throw error
   })
   assertFirstPartyTokenShape(accessToken)
   if(identity.oauthClientId)throw new WorkspaceSourceError('AUTH_FORBIDDEN','Delegated clients cannot authorize their own access.',false)
   const decision=request.method==='POST'?scopedConsentDecisionSchema.parse(await boundedJson(request)):undefined
   if(decision&&decision.expectedAccountId!==identity.userId)throw new WorkspaceSourceError('AUTH_FORBIDDEN','Account changed. Read and explicitly choose again.',false)
   const revocationOnly=Boolean(decision&&decision.choices.every(choice=>choice.decision==='revoke'))
   // Withdrawing owned scopes requires no current audience or provider admission.
   // GET may expose only owned grant metadata when audience lookup denies/fails.
   let audience:Awaited<ReturnType<OwnerManagementConsentConfig['authorizeIdentity']>>|undefined
   if(!revocationOnly){
    try{audience=await config.authorizeIdentity(identity)}catch{/* Admission cannot be proved; only a historical or denied receipt may resolve this request. */}
   }
   const consumerAudience=audience?.mode==='legacy'&&audience.role==='legacy'||audience?.mode==='allowlist'&&['owner','beta'].includes(audience.role??'')
   const canApprove=Boolean(audience?.allowed&&(consumerEnabled?consumerAudience:audience.mode==='allowlist'&&audience.role==='owner'))
   const descriptors=await Promise.all(scopedManagementDomains.map(async domain=>({domain,canApprove:domain!=='business'||consumerEnabled,consent:SCOPED_MANAGEMENT_CONSENTS[domain],consentTextHash:await scopedManagementConsentHash(domain)})))
   if(request.method==='GET'){
    const [clients,grants]=await Promise.all([canApprove?providerClients(accessToken).catch(()=>[]):Promise.resolve([]),store.list(identity.userId)])
    const clientById=new Map(clients.map(c=>[c.id,c])),ids=new Set([...clientById.keys(),...grants.map(g=>g.client_id)])
    return respond(200,{account:{id:identity.userId,email:identity.email},descriptors,clients:[...ids].map(id=>({id,name:clientById.get(id)?.name??'当前仅可撤销权限的客户端',canApprove:clientById.has(id),grants:grants.filter(g=>g.client_id===id)}))})
   }
   if(!decision)throw new WorkspaceSourceError('INVALID_ARGUMENT','Explicit choices required.',false)
   for(const choice of decision.choices){
    const expected=descriptors.find(d=>d.domain===choice.domain)!
    if(choice.consentVersion!==expected.consent.version||choice.consentTextHash!==expected.consentTextHash)throw new WorkspaceSourceError('CONSENT_CONFLICT','Consent text or version changed. Read again before choosing.',false)
   }
   // Revocation works after OAuth disconnect. Any approval requires a fresh provider binding.
   const needsProvider=decision.choices.some(choice=>choice.decision==='approve')
   const clients=needsProvider?await providerClients(accessToken).catch(()=>[]):[]
   const verified=clients.some(client=>client.id===decision.clientId)
   const requestHash=await hashMutationPayload('scoped_management_consent_decision_v1',decision)
   const receipts=await store.decide(decision,requestHash,verified&&canApprove,consumerEnabled,audience?.mode??config.audienceMode??'allowlist')
   return respond(200,{requestId:decision.requestId,receipts,refreshRequired:true})
  } catch(error) {
   if(error instanceof z.ZodError)return respond(400,{code:'INVALID_ARGUMENT',message:'Choose explicit nonduplicate scopes and exact current proofs.'})
   if(error instanceof WorkspaceSourceError)return respond(error.code==='CONSENT_CONFLICT'?409:error.code==='AUTH_REQUIRED'?401:error.code==='AUTH_UNAVAILABLE'?503:error.code==='CONSENT_OUTCOME_UNCONFIRMED'?502:403,{code:error.code,message:error.message})
   return respond(500,{code:'CONSENT_OUTCOME_UNCONFIRMED',message:'No outcome was confirmed. Read current state before retrying the same choices.'})
  }
 }
}
