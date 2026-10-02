import * as z from 'zod/v4'
import { WorkspaceSourceError } from './workspaceSource.js'
export const ownerManagementGrantViewSchema = z.object({ id:z.uuid(), client_id:z.uuid(), revision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER), revoked_at:z.iso.datetime({offset:true}).nullable(), consent_version:z.literal(2) })
const unconfirmed=()=>new WorkspaceSourceError('CONSENT_OUTCOME_UNCONFIRMED','The consent decision may already have committed. Read current state before retrying, and reuse only the same request ID and exact decision.',false)
export type OwnerManagementGrantView = z.infer<typeof ownerManagementGrantViewSchema>
export function createOwnerManagementConsentStore(options:{supabaseUrl:string;serviceRoleKey:string;fetchImpl?:typeof fetch}) {
 const fetchImpl=options.fetchImpl??fetch
 async function request(path:string,init:RequestInit={}) {
  if(!options.serviceRoleKey.trim())throw new WorkspaceSourceError('AUTH_UNAVAILABLE','Consent storage is not configured.',false)
  let response:Response
  try {response=await fetchImpl(`${options.supabaseUrl.replace(/\/+$/,'')}/rest/v1/${path}`,{...init,headers:{authorization:`Bearer ${options.serviceRoleKey}`,apikey:options.serviceRoleKey,'content-type':'application/json'}})}
  catch {if(init.method==='POST')throw unconfirmed();throw new WorkspaceSourceError('AUTH_UNAVAILABLE','Consent storage is temporarily unavailable.',true)}
  const body:unknown=await response.json().catch(()=>undefined)
  if(!response.ok){const code=body&&typeof body==='object'&&'code'in body?body.code:undefined
   if(code==='40001'||code==='23505')throw new WorkspaceSourceError('CONSENT_CONFLICT','Consent changed or this request ID was reused. Reload before a new explicit decision.',false)
   if(code==='42501')throw new WorkspaceSourceError('AUTH_FORBIDDEN','Consent authorization is no longer valid.',false)
   if(init.method==='POST')throw unconfirmed()
   throw new WorkspaceSourceError('AUTH_UNAVAILABLE','Consent storage request failed.',response.status>=500||response.status===429)
  }
  return body
 }
 return {
  async list(userId:string) {
   const params=new URLSearchParams({select:'id,user_id,client_id,revision,revoked_at,consent_version',user_id:`eq.${userId}`,capability:'eq.workspace.manage',limit:'101'})
   const schema=z.array(ownerManagementGrantViewSchema.extend({user_id:z.literal(userId)})).max(100)
   const parsed=schema.safeParse(await request(`pjsdas_business_management_grants?${params}`))
   if(!parsed.success||new Set(parsed.data.map(g=>g.client_id)).size!==parsed.data.length)throw new WorkspaceSourceError('AUTH_INVALID','Consent state is invalid.',false)
   return parsed.data.map(({user_id:_userId,...grant})=>grant)
  },
  async decide(input:{userId:string;clientId:string;requestId:string;requestHash:string;decision:'approve'|'revoke';consentTextHash:string;expectedGrant:{id:string;revision:number}|null;providerClientVerified:boolean}) {
   const raw=await request('rpc/pjsdas_decide_management_consent_v1',{method:'POST',body:JSON.stringify({target_user_id:input.userId,target_client_id:input.clientId,target_request_id:input.requestId,target_request_hash:input.requestHash,target_decision:input.decision,target_consent_version:2,target_consent_text_hash:input.consentTextHash,target_expected_grant_id:input.expectedGrant?.id??null,target_expected_grant_revision:input.expectedGrant?.revision??null,target_first_party:true,target_provider_client_verified:input.providerClientVerified})})
   const parsed=z.array(z.object({outcome:z.enum(['APPROVED','REVOKED','ALREADY_REVOKED']),grant_id:z.uuid().nullable(),grant_revision:z.number().int().positive().nullable()})).length(1).safeParse(raw)
   if(!parsed.success || (parsed.data[0].outcome!=='ALREADY_REVOKED' && (!parsed.data[0].grant_id || !parsed.data[0].grant_revision)) || ((parsed.data[0].grant_id===null)!==(parsed.data[0].grant_revision===null)))throw unconfirmed()
   return parsed.data[0]
  },
 }
}
