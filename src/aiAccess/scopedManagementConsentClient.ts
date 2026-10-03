import * as z from 'zod/v4'
import { fetchBackend } from '../backendEndpoints.js'
import { OwnerConsentError as ScopedConsentError, type OwnerConsentSession } from './ownerManagementConsentClient.js'
import { scopedConsentDecisionSchema, scopedConsentDomainSchema, type ScopedConsentDecision } from './scopedConsentContract.js'
export { ScopedConsentError }
export type { ScopedConsentDecision }
const domains = { opportunity: [3,'workspace.opportunity.manage'], planning: [4,'workspace.planning.manage'], discoveryProfile: [5,'workspace.discovery-profile.manage'], privateReminder: [6,'workspace.reminders.manage'] } as const
const descriptorSchema=z.object({domain:scopedConsentDomainSchema,consentTextHash:z.string().regex(/^[a-f0-9]{64}$/),consent:z.object({version:z.number().int(),capability:z.string(),title:z.string().min(1).max(300),scope:z.array(z.string().min(1).max(500)).min(1).max(10),exclusions:z.array(z.string().min(1).max(500)).min(1).max(10),duration:z.string().min(1).max(500)})}).refine(x=>x.consent.version===domains[x.domain][0]&&x.consent.capability===domains[x.domain][1])
const grantSchema=z.object({domain:scopedConsentDomainSchema,id:z.uuid(),client_id:z.uuid(),revision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),revoked_at:z.string().nullable(),consent_version:z.number().int(),capability:z.string(),consent_text_hash:z.string().regex(/^[a-f0-9]{64}$/)}).refine(x=>x.consent_version===domains[x.domain][0]&&x.capability===domains[x.domain][1])
export const scopedConsentViewSchema=z.object({account:z.object({id:z.uuid(),email:z.string().optional()}),descriptors:z.array(descriptorSchema).length(4),clients:z.array(z.object({id:z.uuid(),name:z.string().min(1).max(500),canApprove:z.boolean(),grants:z.array(grantSchema).max(4)}).refine(c=>c.grants.every(g=>g.client_id===c.id)&&new Set(c.grants.map(g=>g.domain)).size===c.grants.length)).max(100)}).refine(v=>new Set(v.descriptors.map(d=>d.domain)).size===4&&new Set(v.clients.map(c=>c.id)).size===v.clients.length)
export type ScopedConsentView=z.infer<typeof scopedConsentViewSchema>
export type ScopedConsentSelections=Partial<Record<z.infer<typeof scopedConsentDomainSchema>,'approve'|'revoke'>>
export function buildScopedConsentDecision(view:ScopedConsentView,clientId:string,selections:ScopedConsentSelections,confirmed:boolean,requestId:string):ScopedConsentDecision{
 const client=view.clients.find(c=>c.id===clientId)
 if(!confirmed||!client||!Object.keys(selections).length)throw new ScopedConsentError('CONFIRMATION_REQUIRED','请明确选择本次权限变更，并核对账号及客户端。')
 const choices=Object.entries(selections).map(([domain,decision])=>{
  const descriptor=view.descriptors.find(d=>d.domain===domain),grant=client.grants.find(g=>g.domain===domain)
  if(!descriptor||!['approve','revoke'].includes(decision)||(decision==='approve'&&!client.canApprove)||(decision==='revoke'&&(!grant||grant.revoked_at)))throw new ScopedConsentError('CONFIRMATION_REQUIRED','本次权限选择无效，请重新读取。')
  return {domain:descriptor.domain,decision,consentVersion:descriptor.consent.version,consentTextHash:descriptor.consentTextHash,expectedGrant:grant?{id:grant.id,revision:grant.revision}:null}
 })
 return scopedConsentDecisionSchema.parse({requestId,expectedAccountId:view.account.id,clientId,choices,confirmed:true})
}
export function createScopedConsentClient(options:{getSession:()=>Promise<OwnerConsentSession|null>;request?:typeof fetchBackend}){
 const request=options.request??fetchBackend,path='/api/workspace?surface=scoped-management-consent'
 async function session(expected?:string){const s=await options.getSession();if(!s)throw new ScopedConsentError('SIGN_IN_REQUIRED','请登录当前 TodayAction 账号。');if(expected&&s.accountId!==expected)throw new ScopedConsentError('ACCOUNT_CHANGED','账号已切换，请重新读取并确认。');return s}
 const uncertain=()=>new ScopedConsentError('CONSENT_OUTCOME_UNCONFIRMED','操作可能已经完成。先读取当前状态；只能重试同一请求和选择。',true)
 return {
  async read(){const s=await session(),response=await request(path,{headers:{authorization:`Bearer ${s.accessToken}`}})
   if(response.status===404)throw new ScopedConsentError('CAPABILITY_DISABLED','分项管理授权尚未启用。')
   if(response.status===401)throw new ScopedConsentError('SIGN_IN_REQUIRED','登录已过期，请重新登录。')
   if(!response.ok)throw new ScopedConsentError('READ_FAILED','当前权限状态无法读取。')
   const parsed=scopedConsentViewSchema.safeParse(await response.json().catch(()=>undefined))
   if(!parsed.success||parsed.data.account.id!==s.accountId)throw new ScopedConsentError('ACCOUNT_CHANGED','授权页面与账号不一致，请重新读取。')
   await session(s.accountId);return parsed.data
  },
  async decide(body:ScopedConsentDecision){const validated=scopedConsentDecisionSchema.parse(body),s=await session(validated.expectedAccountId);let response:Response
   try{response=await request(path,{method:'POST',headers:{authorization:`Bearer ${s.accessToken}`,'content-type':'application/json'},body:JSON.stringify(validated)})}catch{throw uncertain()}
   if(response.status===401)throw new ScopedConsentError('SIGN_IN_REQUIRED','登录已过期，请重新登录后恢复同一请求。',true)
   const payload=await response.json().catch(()=>undefined)
   if(!response.ok){if(response.status>=500||payload?.code==='CONSENT_OUTCOME_UNCONFIRMED')throw uncertain();throw new ScopedConsentError(typeof payload?.code==='string'?payload.code:'DECISION_REJECTED','操作未确认，请重新读取后明确选择。')}
   const parsed=z.object({requestId:z.literal(body.requestId),refreshRequired:z.literal(true),receipts:z.array(z.object({domain:scopedConsentDomainSchema,outcome:z.enum(['APPROVED','REVOKED','ALREADY_REVOKED','DENIED']),grant_id:z.uuid().nullable(),grant_revision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable()})).min(1).max(4)}).safeParse(payload)
   if(!parsed.success||parsed.data.receipts.length!==body.choices.length||new Set(parsed.data.receipts.map(r=>r.domain)).size!==body.choices.length||parsed.data.receipts.some(r=>!body.choices.some(c=>c.domain===r.domain&&(r.outcome==='DENIED'||(c.decision==='approve'?r.outcome==='APPROVED':r.outcome==='REVOKED'||r.outcome==='ALREADY_REVOKED')))))throw uncertain()
   if(parsed.data.receipts.some(r=>r.outcome==='DENIED')){if(!parsed.data.receipts.every(r=>r.outcome==='DENIED'&&r.grant_id===null&&r.grant_revision===null))throw uncertain();throw new ScopedConsentError('CONSENT_DENIED','本次请求已明确拒绝，没有新增权限。请读取当前状态后重新选择。')}
   if(parsed.data.receipts.some(r=>r.grant_id===null||r.grant_revision===null))throw uncertain()
   return parsed.data
  }
 }
}
