import * as z from 'zod/v4'
import type { ReminderIntent, ScheduleNode } from './model.js'
import { reminderDedupeKey, validateReminderIntent } from './reminders.js'
import { latestScheduleOccurrence } from './scheduleNodes.js'
import { SNAPSHOT_VERSION, validateSnapshot, type PJSDASSnapshot } from './snapshot.js'

const MAX_BYTES = 262144
const id = z.string().min(1).max(240).refine(value => value.trim().length > 0, 'An exact nonblank identifier is required.')
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/)
const trigger = z.iso.datetime({ offset: true })
const purpose = z.enum(['upcoming','deadline','prep','follow_up','custom'])
const nonempty = (value: object) => Object.values(value).some(item => item !== undefined)
export const privateReminderManagementOperationSchema = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('create_private_reminder'),scheduleNodeId:id,expectedNodeFingerprint:fingerprint,purpose,triggerAt:trigger}).strict(),
  z.object({kind:z.literal('update_private_reminder'),id,expectedFingerprint:fingerprint,expectedNodeFingerprint:fingerprint,patch:z.object({triggerAt:trigger.optional(),state:z.enum(['active','paused']).optional()}).strict().refine(nonempty)}).strict(),
  z.object({kind:z.literal('cancel_private_reminder'),id,expectedFingerprint:fingerprint}).strict(),
])
export const privateReminderManagementSchema = z.object({operations:z.array(privateReminderManagementOperationSchema).min(1).max(25)}).strict()
  .refine(value=>new TextEncoder().encode(JSON.stringify(value)).byteLength<=MAX_BYTES,'Private reminder batches must not exceed 256 KiB.')
export type PrivateReminderManagementInput=z.infer<typeof privateReminderManagementSchema>
interface Change { id:string;beforeIndex:number;before:ReminderIntent|null;after:ReminderIntent|null;nodeFingerprint:string }
export interface PrivateReminderManagementCompensation {operation:'private_reminder_management_restore';payload:{changes:Change[]}}
export class PrivateReminderManagementError extends Error {
  constructor(public readonly code:'NOT_FOUND'|'STALE_TARGET'|'TARGET_INACTIVE'|'EXTERNAL_REMINDER'|'REFERENCE_IN_USE'|'RESTORE_CONFLICT'|'INVALID_CONFIGURATION'|'INVALID_COMPENSATION',message:string){super(message);this.name='PrivateReminderManagementError'}
}
function canonical(value:unknown,compensation=false):string {
 let nodes=0
 const visit=(value:any,depth:number):any=>{
  if(++nodes>(compensation?25*2*8192+256:8192)||depth>(compensation?21:16))throw new PrivateReminderManagementError('INVALID_CONFIGURATION','Reminder evidence exceeds its structural bound.')
  if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return value
  if(Array.isArray(value))return Array.from(value,v=>visit(v,depth+1))
  if(value&&typeof value==='object'&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null))return Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,visit(value[key],depth+1)]))
  throw new PrivateReminderManagementError('INVALID_CONFIGURATION','Reminder evidence must contain finite JSON values.')
 }
 return JSON.stringify(visit(value,0))
}
const equal=(a:unknown,b:unknown)=>canonical(a)===canonical(b)
export async function privateReminderManagementFingerprint(value:unknown){
 const compensation=Boolean(value&&typeof value==='object'&&'operation'in value&&value.operation==='private_reminder_management_restore')
 const text=canonical(value,compensation)
 if(new TextEncoder().encode(text).byteLength>(compensation?25*(2*16384+6*240+256)+256:MAX_BYTES))throw new PrivateReminderManagementError('INVALID_CONFIGURATION','Reminder evidence exceeds its byte bound.')
 return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(x=>x.toString(16).padStart(2,'0')).join('')
}
function rawSnapshot(snapshot:PJSDASSnapshot){
 for(const key of ['scheduleNodes','decisionRequests','semanticReceipts','reminderIntents','reminderOutbox']as const)if(!snapshot.data||!Object.hasOwn(snapshot.data,key)||snapshot.data[key]===undefined)throw new PrivateReminderManagementError('INVALID_CONFIGURATION','The workspace needs a separate snapshot migration before private reminder management.')
 validateSnapshot(snapshot);const next=structuredClone(snapshot);next.version=SNAPSHOT_VERSION;validateSnapshot(next);return next
}
function isPrivate(snapshot:PJSDASSnapshot,reminder:ReminderIntent){return reminder.deliveryOwner==='pjsdas'&&reminder.channel==='in_product'&&reminder.capability===undefined&&reminder.externalLink===undefined&&!snapshot.data.reminderOutbox!.some(row=>row.reminderIntentId===reminder.id)}
function assertPrivate(snapshot:PJSDASSnapshot,reminder:ReminderIntent){
 if(!isPrivate(snapshot,reminder))throw new PrivateReminderManagementError('EXTERNAL_REMINDER','External or outbox-linked reminders require their separately authorized delivery workflow.')
 if(new TextEncoder().encode(canonical(reminder)).byteLength>16384)throw new PrivateReminderManagementError('INVALID_CONFIGURATION','Each reminder must not exceed 16 KiB.')
 if(!reminderRow.safeParse(reminder).success||validateReminderIntent(reminder,new Set(snapshot.data.scheduleNodes!.map(node=>node.id))).length)throw new PrivateReminderManagementError('INVALID_CONFIGURATION','The stored reminder is invalid.')
 const node=target(snapshot,reminder.scheduleNodeId)
 if(reminder.scheduleNodeVersion!==node.version||reminder.dedupeKey!==reminderDedupeKey(node,reminder.purpose))throw new PrivateReminderManagementError('INVALID_CONFIGURATION','The reminder target version or purpose identity is inconsistent.')
}
function target(snapshot:PJSDASSnapshot,nodeId:string){const node=snapshot.data.scheduleNodes!.find(node=>node.id===nodeId);if(!node)throw new PrivateReminderManagementError('NOT_FOUND','The schedule target was not found in this workspace.');return node}
function activeTarget(snapshot:PJSDASSnapshot,node:ScheduleNode){if(!['scheduled','in_progress','elapsed_unresolved'].includes(node.state)||latestScheduleOccurrence(snapshot.data.scheduleNodes!,node.occurrenceId)?.id!==node.id)throw new PrivateReminderManagementError('TARGET_INACTIVE','The target is not an active latest schedule node.')}
function assertActivationExclusive(snapshot:PJSDASSnapshot,reminder:ReminderIntent){
 if(snapshot.data.reminderIntents!.some(row=>row.id!==reminder.id&&(row.dedupeKey===reminder.dedupeKey||row.scheduleNodeId===reminder.scheduleNodeId&&row.purpose===reminder.purpose)))throw new PrivateReminderManagementError('REFERENCE_IN_USE','Another reminder owns this target and purpose. Review the conflict before activation.')
}
export async function applyPrivateReminderManagement(snapshot:PJSDASSnapshot,raw:unknown,commandId:string,now=new Date()){
 const input=privateReminderManagementSchema.parse(raw);if(commandId.trim().length<8||commandId.length>160)throw new Error('Invalid private reminder command identity.')
 const next=rawSnapshot(snapshot),at=now.toISOString(),changes:Change[]=[],seen=new Set<string>()
 for(const [index,operation]of input.operations.entries()){
  const reminderId=operation.kind==='create_private_reminder'?`managed:reminder:${commandId}:${index}`:operation.id
  if(seen.has(reminderId))throw new PrivateReminderManagementError('REFERENCE_IN_USE','A reminder may be targeted only once per batch.');seen.add(reminderId)
  const beforeIndex=next.data.reminderIntents!.findIndex(row=>row.id===reminderId),before=next.data.reminderIntents![beforeIndex]??null
  let node:ScheduleNode,after:ReminderIntent
  if(operation.kind==='create_private_reminder'){
   if(before)throw new PrivateReminderManagementError('RESTORE_CONFLICT','The deterministic reminder identity already exists.')
   node=target(next,operation.scheduleNodeId);activeTarget(next,node)
   if(await privateReminderManagementFingerprint(node)!==operation.expectedNodeFingerprint)throw new PrivateReminderManagementError('STALE_TARGET','The schedule target changed. Read its exact fingerprint again.')
   const dedupeKey=reminderDedupeKey(node,operation.purpose)
   if(next.data.reminderIntents!.some(row=>row.dedupeKey===dedupeKey||row.scheduleNodeId===node.id&&row.purpose===operation.purpose))throw new PrivateReminderManagementError('REFERENCE_IN_USE','This target and purpose already have a reminder. Review that exact record instead.')
   after={id:reminderId,scheduleNodeId:node.id,scheduleNodeVersion:node.version,purpose:operation.purpose,triggerAt:new Date(operation.triggerAt).toISOString(),deliveryOwner:'pjsdas',channel:'in_product',state:'active',dedupeKey,createdAt:at,updatedAt:at}
  }else{
   if(!before)throw new PrivateReminderManagementError('NOT_FOUND','The reminder was not found in this workspace.')
   assertPrivate(next,before);node=target(next,before.scheduleNodeId)
   if(await privateReminderManagementFingerprint(before)!==operation.expectedFingerprint)throw new PrivateReminderManagementError('STALE_TARGET','The reminder changed. Read its exact fingerprint again.')
   after=structuredClone(before)
   if(operation.kind==='cancel_private_reminder')after.state='cancelled'
   else{
    if(await privateReminderManagementFingerprint(node)!==operation.expectedNodeFingerprint)throw new PrivateReminderManagementError('STALE_TARGET','The schedule target changed. Read its exact fingerprint again.')
    if(operation.patch.triggerAt!==undefined)after.triggerAt=new Date(operation.patch.triggerAt).toISOString()
    if(operation.patch.state!==undefined)after.state=operation.patch.state
    if(after.state==='active')activeTarget(next,node)
   }
   if(equal(before,after))continue
   after.updatedAt=at
  }
  assertPrivate(next,after)
  if(after.state==='active')assertActivationExclusive(next,after)
  if(beforeIndex<0)next.data.reminderIntents!.push(after);else next.data.reminderIntents![beforeIndex]=after
  changes.push({id:reminderId,beforeIndex,before:structuredClone(before),after:structuredClone(after),nodeFingerprint:await privateReminderManagementFingerprint(node)})
 }
 const objects=[...seen].map(id=>({type:'reminder_intent',id}))
 if(!changes.length)return{status:'ALREADY_APPLIED'as const,changed:false,snapshot,objects,summary:'The private reminders are already current.'}
 const compensation:PrivateReminderManagementCompensation={operation:'private_reminder_management_restore',payload:{changes}}
 const compensationFingerprint=await privateReminderManagementFingerprint(compensation)
 next.data.timeline=[...(next.data.timeline??[]),{id:`private-reminders:${commandId}`,kind:'change_set_applied',category:'action',source:'user_action',occurredAt:at,recordedAt:at,title:`Updated ${changes.length} private reminder(s)`,commandId,commandOperation:'private_reminder_management'}]
 next.exportedAt=at;validateSnapshot(next)
 return{status:'APPLIED'as const,changed:true,snapshot:next,objects,summary:`Updated ${changes.length} in-product reminder intent(s); no external delivery was requested.`,compensation,compensationFingerprint}
}

const storedTimestamp=z.string().refine(value=>Number.isFinite(new Date(value).getTime()))
const reminderRow=z.object({id,scheduleNodeId:id,scheduleNodeVersion:z.number().int().positive(),purpose,triggerAt:storedTimestamp,deliveryOwner:z.literal('pjsdas'),channel:z.literal('in_product'),state:z.enum(['active','paused','cancelled','unsupported']),dedupeKey:z.string().min(1).max(500),createdAt:storedTimestamp,updatedAt:storedTimestamp}).passthrough()
const compensationSchema=z.object({operation:z.literal('private_reminder_management_restore'),payload:z.object({changes:z.array(z.object({id,beforeIndex:z.number().int().min(-1),before:reminderRow.nullable(),after:reminderRow,nodeFingerprint:fingerprint}).strict()).min(1).max(25)}).strict()}).strict()
export async function restorePrivateReminderManagement(snapshot:PJSDASSnapshot,compensation:PrivateReminderManagementCompensation,now=new Date()){
 const next=rawSnapshot(snapshot)
 try{await privateReminderManagementFingerprint(compensation);if(!compensationSchema.safeParse(compensation).success)throw new Error('Invalid shape')}catch{throw new PrivateReminderManagementError('INVALID_COMPENSATION','Private reminder compensation is invalid.')}
 const seen=new Set<string>()
 for(const change of compensation.payload.changes){
  if(seen.has(change.id)||change.after?.id!==change.id||change.before&&change.before.id!==change.id||(change.before?change.beforeIndex<0:change.beforeIndex!==-1))throw new PrivateReminderManagementError('INVALID_COMPENSATION','Private reminder compensation target is invalid.')
  seen.add(change.id)
  if(equal(change.before,change.after))throw new PrivateReminderManagementError('INVALID_COMPENSATION','Private reminder compensation contains no change.')
  const current=next.data.reminderIntents!.find(row=>row.id===change.id)??null
  if(!equal(current,change.after))throw new PrivateReminderManagementError('RESTORE_CONFLICT','The reminder has newer data; restore cannot overwrite it.')
  assertPrivate(next,current!)
  const node=target(next,current!.scheduleNodeId)
  if(await privateReminderManagementFingerprint(node)!==change.nodeFingerprint)throw new PrivateReminderManagementError('RESTORE_CONFLICT','The schedule target changed after this reminder command.')
  if(change.before){
   assertPrivate(next,change.before)
   if(change.before.scheduleNodeId!==change.after!.scheduleNodeId||change.before.scheduleNodeVersion!==change.after!.scheduleNodeVersion||change.before.purpose!==change.after!.purpose)throw new PrivateReminderManagementError('INVALID_COMPENSATION','Reminder target and purpose must remain stable.')
   if(change.before.state==='active'){activeTarget(next,node);assertActivationExclusive(next,change.before)}
  }
 }
 for(const change of compensation.payload.changes){
  if(change.before===null)next.data.reminderIntents=next.data.reminderIntents!.filter(row=>row.id!==change.id)
  else next.data.reminderIntents![next.data.reminderIntents!.findIndex(row=>row.id===change.id)]=structuredClone(change.before)
 }
 next.exportedAt=now.toISOString();validateSnapshot(next);return next
}
export const privateReminderManagementReadSchema=z.object({type:z.enum(['reminders','schedule_targets']),ids:z.array(id).min(1).max(50).optional(),afterId:id.optional(),limit:z.number().int().min(1).max(50).default(25)}).strict().refine(value=>!(value.ids&&value.afterId),'Choose exact IDs or pagination, not both.')
export async function readPrivateReminderManagement(snapshot:PJSDASSnapshot,raw:unknown){
 const input=privateReminderManagementReadSchema.parse(raw);const next=rawSnapshot(snapshot);const ids=input.ids?new Set(input.ids):undefined
 const rows=(input.type==='reminders'?next.data.reminderIntents!.filter(row=>isPrivate(next,row)):next.data.scheduleNodes!)
  .filter(row=>(!ids||ids.has(row.id))&&(!input.afterId||row.id>input.afterId)).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)
 const selected=rows.slice(0,input.limit)
 const items=await Promise.all(selected.map(async value=>{
  if(input.type==='reminders'){assertPrivate(next,value as ReminderIntent);return{raw:structuredClone(value),fingerprint:await privateReminderManagementFingerprint(value)}}
  const node=value as ScheduleNode
  return{target:{id:node.id,occurrenceId:node.occurrenceId,version:node.version,state:node.state,temporal:structuredClone(node.temporal),opportunityId:node.opportunityId},fingerprint:await privateReminderManagementFingerprint(node),activeLatest:['scheduled','in_progress','elapsed_unresolved'].includes(node.state)&&latestScheduleOccurrence(next.data.scheduleNodes!,node.occurrenceId)?.id===node.id}
 }))
 const result={type:input.type,items,nextAfterId:rows.length>input.limit?selected.at(-1)!.id:null}
 if(new TextEncoder().encode(JSON.stringify(result)).byteLength>MAX_BYTES)throw new PrivateReminderManagementError('INVALID_CONFIGURATION','The result exceeds 256 KiB; request fewer exact IDs or a smaller page.')
 return result
}

/** Include target occurrences in stale-base checks without claiming they are mutated. */
export function privateReminderManagementObjectRefs(snapshot:PJSDASSnapshot,input:PrivateReminderManagementInput,commandId:string){
 const refs: Array<{type:string;id:string}>=[]
 for(const [index,operation]of input.operations.entries()){
  const reminderId=operation.kind==='create_private_reminder'?`managed:reminder:${commandId}:${index}`:operation.id
  refs.push({type:'reminder_intent',id:reminderId})
  const nodeId=operation.kind==='create_private_reminder'?operation.scheduleNodeId:snapshot.data.reminderIntents?.find(row=>row.id===reminderId)?.scheduleNodeId
  const node=snapshot.data.scheduleNodes?.find(row=>row.id===nodeId)
  if(node)refs.push({type:'schedule_occurrence',id:node.occurrenceId})
 }
 return [...new Map(refs.map(ref=>[`${ref.type}:${ref.id}`,ref])).values()]
}
