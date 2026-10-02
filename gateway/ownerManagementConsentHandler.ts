import * as z from 'zod/v4'
import { createSupabaseIdentityResolver, type PjsdasIdentity } from './supabaseIdentity.js'
import type { AudienceAccessResult } from './audienceAccess.js'
import { createOwnerManagementConsentStore } from './ownerManagementConsentStore.js'
import { hashMutationPayload } from './mutationKernel.js'
import { WorkspaceSourceError } from './workspaceSource.js'

// Versioned capability text, returned before any final decision. Adding domains
// or external/security consequences requires a new consent version, not new copy.
export const OWNER_MANAGEMENT_CONSENT = Object.freeze({
 version:2 as const,
 capability:'workspace.manage' as const,
 title:'授权此客户端管理当前账号的指定业务数据',
 scope:Object.freeze(['创建、修改、可恢复归档独立准备任务','创建、修改、可恢复归档独立手动行动','创建、修改、可恢复归档投递组','撤销上述操作；若后续修改冲突则拒绝覆盖']),
 exclusions:Object.freeze(['不包含其他账号或其他业务域的扩展管理','不允许永久删除、账号安全设置、授权转授或外部消息/投递','后续扩大范围需要重新明确授权']),
 duration:'持续有效，直到你在此页面撤销；撤销不回滚此前已完成的修改。',
})
const decisionSchema=z.object({requestId:z.uuid(),expectedAccountId:z.uuid(),clientId:z.uuid(),decision:z.enum(['approve','revoke']),consentVersion:z.literal(2),consentTextHash:z.string().regex(/^[0-9a-f]{64}$/),expectedGrant:z.object({id:z.uuid(),revision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}).strict().nullable(),confirmed:z.literal(true)}).strict().refine(value=>value.decision==='approve'||value.expectedGrant!==null,'Revocation requires the current owned grant proof.')
const providerGrantsSchema=z.array(z.object({client:z.object({id:z.uuid(),name:z.string().trim().min(1).max(500)}),scopes:z.array(z.string()),granted_at:z.string()})).max(100)
export interface OwnerManagementConsentConfig {
 enabled?:string
 supabaseUrl:string
 supabasePublishableKey:string
 serviceRoleKey:string
 allowedOrigins:string[]
 authorizeIdentity:(identity:PjsdasIdentity)=>Promise<AudienceAccessResult>
 fetchImpl?:typeof fetch
}
/** Decode only after /auth/v1/user verified the bearer. This is a denial-only
 * client-type check, never an authentication or account-selection mechanism.
 * Any client_id claim (including unknown UUID versions) is delegated/uncertain.
 */
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
export function createOwnerManagementConsentHandler(config:OwnerManagementConsentConfig) {
 const fetchImpl=config.fetchImpl??fetch
 const resolveIdentity=createSupabaseIdentityResolver({supabaseUrl:config.supabaseUrl,publishableKey:config.supabasePublishableKey,fetchImpl})
 const store=createOwnerManagementConsentStore({...config,fetchImpl})
 async function providerClients(accessToken:string) {
  let response:Response
  try{response=await fetchImpl(`${config.supabaseUrl.replace(/\/+$/,'')}/auth/v1/user/oauth/grants`,{headers:{authorization:`Bearer ${accessToken}`,apikey:config.supabasePublishableKey}})}catch{throw new WorkspaceSourceError('AUTH_UNAVAILABLE','Connected clients could not be verified.',true)}
  if(!response.ok)throw new WorkspaceSourceError('AUTH_UNAVAILABLE','Connected clients could not be verified.',response.status>=500||response.status===429)
  const parsed=providerGrantsSchema.safeParse(await response.json().catch(()=>undefined))
  if(!parsed.success||new Set(parsed.data.map(g=>g.client.id)).size!==parsed.data.length)throw new WorkspaceSourceError('AUTH_INVALID','Connected client response is invalid.',false)
  return parsed.data.map(g=>g.client)
 }
 return async (request:Request)=>{
  const origin=request.headers.get('origin')
  const allowed=Boolean(origin&&config.allowedOrigins.includes(origin))
  const headers:Record<string,string>={'content-type':'application/json; charset=utf-8','cache-control':'no-store',vary:'Origin'}
  if(allowed){headers['access-control-allow-origin']=origin!;headers['access-control-allow-headers']='authorization, content-type';headers['access-control-allow-methods']='GET, POST, OPTIONS'}
  const respond=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers})
  if(config.enabled!=='enabled')return respond(404,{code:'CAPABILITY_DISABLED'})
  // Browsers omit Origin on same-origin GET fetches. This read-only entry
  // still requires provider-verified first-party owner authentication below.
  // An explicit foreign/null Origin remains rejected; POST/OPTIONS keep strict Origin.
  const originlessRead=request.method==='GET'&&origin===null
  if(!allowed&&!originlessRead)return respond(403,{code:'ORIGIN_NOT_ALLOWED'})
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers})
  if(!['GET','POST'].includes(request.method))return respond(405,{code:'METHOD_NOT_ALLOWED'})
  let decisionRequestId:string|undefined
  try{
   const {identity,accessToken}=await resolveIdentity(request)
   assertFirstPartyTokenShape(accessToken)
   if(identity.oauthClientId)throw new WorkspaceSourceError('AUTH_FORBIDDEN','Delegated clients cannot grant or revoke their own access.',false)
   const audience=await config.authorizeIdentity(identity)
   if(!audience.allowed||audience.mode!=='allowlist'||audience.role!=='owner')throw new WorkspaceSourceError('AUTH_FORBIDDEN','This capability is available only to the verified owner.',false)
   const consentTextHash=await hashMutationPayload('owner_management_consent_v2',OWNER_MANAGEMENT_CONSENT)
   if(request.method==='GET'){
    const [clients,grants]=await Promise.all([providerClients(accessToken),store.list(identity.userId)])
    const clientById=new Map(clients.map(c=>[c.id,c]))
    const ids=new Set([...clientById.keys(),...grants.map(g=>g.client_id)])
    return respond(200,{account:{id:identity.userId,email:identity.email},consent:OWNER_MANAGEMENT_CONSENT,consentTextHash,clients:[...ids].map(id=>({id,name:clientById.get(id)?.name??'已断开 OAuth 的客户端',canApprove:clientById.has(id),grant:grants.find(g=>g.client_id===id)??null}))})
   }
   const decision=decisionSchema.parse(await boundedJson(request))
   decisionRequestId=decision.requestId
   if(decision.expectedAccountId!==identity.userId)throw new WorkspaceSourceError('AUTH_FORBIDDEN','The signed-in account changed. Reload before a new explicit decision.',false)
   if(decision.consentTextHash!==consentTextHash)throw new WorkspaceSourceError('CONSENT_CONFLICT','Consent text changed. Read it again before a new explicit decision.',false)
   // Revoke remains available for an owned grant after its OAuth connection was
   // disconnected. Approval always requires a fresh provider-verified client.
   const clients=decision.decision==='approve'?await providerClients(accessToken):[]
   const providerClientVerified=clients.some(client=>client.id===decision.clientId)
   if(decision.decision==='approve'&&!providerClientVerified)throw new WorkspaceSourceError('AUTH_FORBIDDEN','The chosen client is not a current connection of this account.',false)
   const requestHash=await hashMutationPayload('owner_management_consent_decision_v2',{...decision,userId:identity.userId})
   const outcome=await store.decide({userId:identity.userId,clientId:decision.clientId,requestId:decision.requestId,requestHash,decision:decision.decision,consentTextHash,expectedGrant:decision.expectedGrant,providerClientVerified})
   return respond(200,{receipt:outcome,requestId:decision.requestId,decision:decision.decision,refreshRequired:true,notice:'这是此请求的历史决定回执，不代表当前授权状态。请刷新；撤销不会回滚已完成的业务修改。'})
  }catch(caught){
   if(caught instanceof z.ZodError)return respond(400,{code:'INVALID_ARGUMENT',message:'Explicit versioned consent and exact current grant state are required.'})
   const error=caught instanceof WorkspaceSourceError?caught:new WorkspaceSourceError('CONSENT_FAILED','Consent outcome is unconfirmed. Read current state before retrying the same request ID.',false)
   if(error.code==='CONSENT_OUTCOME_UNCONFIRMED')return respond(503,{code:error.code,message:error.message,requestId:decisionRequestId,outcome:'UNCONFIRMED',recovery:'READ_CURRENT_STATE_THEN_RETRY_SAME_REQUEST_ID_ONLY',retryable:false})
   const status=error.code==='AUTH_REQUIRED'||error.code==='AUTH_INVALID'?401:error.code==='AUTH_FORBIDDEN'?403:error.code==='CONSENT_CONFLICT'?409:error.code==='INVALID_ARGUMENT'?400:503
   return respond(status,{code:error.code,message:error.message,retryable:error.retryable})
  }
 }
}
