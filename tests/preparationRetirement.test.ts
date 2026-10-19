import { describe, expect, it } from 'vitest'
import { rankActions } from '../src/decisionV3.js'
import { scheduleNodeEligible } from '../src/scheduleEligibility.js'
import { scheduleNodeForAction } from '../src/scheduleNodes.js'
import { applyBusinessManagement } from '../src/businessManagement.js'
import { invokeReadTool } from '../gateway/readTools.js'
import type { Action, ScheduleNode } from '../src/model.js'
import type { PJSDASSnapshot } from '../src/snapshot.js'
const now = new Date('2026-10-19T00:00:00Z')
const at = now.toISOString()
const temporal = { shape: 'fixed_range', precision: 'datetime', timezone: 'UTC', startAt: '2026-10-19T10:00:00Z', resolutionBasis: 'user_explicit' } as const
function action(id: string, patch: Partial<Action> = {}): Action { return { id, kind:'manual', title:id, estimatedMinutes:30, leverage:0, delayCost:0, status:'todo', createdAt:at, updatedAt:at, ...patch } }
function snapshot(): PJSDASSnapshot { return { schema:'pjsdas-local-snapshot',version:4,exportedAt:at,data:{opportunities:[],processes:[],processEvents:[],actions:[],prep:[],applicationGroups:[],timeline:[],scheduleNodes:[],decisionRequests:[],semanticReceipts:[],reminderIntents:[],reminderOutbox:[]} } }
function node(kind: ScheduleNode['kind']): ScheduleNode { return { id:'node',occurrenceId:'occurrence',version:1,kind,state:'scheduled',temporal,constraintKind:'user_plan',evidenceRefs:[],sourceVersionRefs:[],relatedActionIds:[],relatedPrepIds:['legacy-prep'],createdAt:at,updatedAt:at } }
describe('preparation feature retirement',()=>{
 it('excludes preparation and explicitly linked preparation actions without changing legacy raw records',()=>{
  const actions=[action('prep',{kind:'prep'}),action('linked',{prepId:'legacy-prep'}),action('ordinary'),action('interview',{processEventId:'event',prepId:'legacy-prep'})]
  const before=structuredClone(actions)
  expect(rankActions(actions,[],now,undefined,'UTC').map(x=>x.action.id)).toEqual(['interview','ordinary'])
  expect(actions).toEqual(before)
 })
 it('never projects a preparation action into a new schedule node',()=>{
  expect(scheduleNodeForAction(action('prep',{kind:'prep',scheduledTemporal:temporal}))).toBeUndefined()
  expect(scheduleNodeForAction(action('ordinary',{scheduledTemporal:temporal}))).toMatchObject({kind:'follow_up'})
 })
 it('hides prep-only legacy nodes but keeps employer interviews with a legacy prep association',()=>{
  expect(scheduleNodeEligible(node('prep_trigger'),{actions:[],processEvents:[]})).toBe(false)
  expect(scheduleNodeEligible({...node('interview'),constraintKind:'employer_hard'},{actions:[],processEvents:[]})).toBe(true)
 })
 it('rejects an entire mixed management batch before creating any preparation or ordinary task',()=>{
  const initial=snapshot(),before=structuredClone(initial)
  expect(()=>applyBusinessManagement(initial,{operations:[{kind:'create_manual_action',value:{title:'Normal task',estimatedMinutes:15}},{kind:'create_prep',value:{title:'Interview prep',estimatedMinutes:30}}]},'retirement-batch',now)).toThrow(/retired/i)
  expect(initial).toEqual(before)
 })
 it('returns an explicit retired contract for stale installed get_prep_graph without reading data',async()=>{
  let reads=0
  const result=await invokeReadTool({read:async()=>{reads++;return{snapshot:snapshot(),context:{now,timezone:'UTC',workspaceVersion:'txn:1'}}}},'get_prep_graph',{})
  expect(result.isError).toBe(true)
  expect(JSON.parse((result.content[0] as {text:string}).text)).toMatchObject({code:'PREPARATION_RETIRED',retryable:false})
  expect(reads).toBe(0)
 })
})

import { isPreparationTaskText, isPreparationAction, isPreparationNode, withoutPreparationSurfaces } from '../src/preparationRetirement.js'
import { applyUserDomainCommand } from '../src/domainCommands.js'
import { applySemanticIntake } from '../src/semanticIntake.js'
import { buildWebSemanticInterpretation } from '../src/webSemanticInterpretation.js'
import { getTodayPlan } from '../src/ai/readLayer.js'
import { selectTodayWeb } from '../src/today/todayWebSelector.js'
import { validateSnapshot } from '../src/snapshot.js'
import { captureActionStatusUndo, restoreActionStatusUndo } from '../src/actionStatusUndo.js'
import { applyPrivateReminderManagement, restorePrivateReminderManagement, privateReminderManagementFingerprint as fp, readPrivateReminderManagement } from '../src/privateReminderManagement.js'
import { actionableDecision, partitionDecisions } from '../src/decisionActionability.js'
import type { SemanticCandidate, SemanticIntakeObservation, DecisionRequest } from '../src/model.js'
function observation(candidates: SemanticCandidate[]): SemanticIntakeObservation { return { contractVersion:1,inputId:'retired-input',statementMode:'assertion',source:{kind:'web',sourceId:'web',sourceRecordId:'retired-input',observedAt:at,assertedAt:at,timezone:'UTC'},candidates } }
function candidate(title: string): SemanticCandidate { return { id:`task:${title}`,kind:'manual_action',title,objectConfidence:'high',eventConfidence:'high',evidenceRefs:[],sourceVersionRefs:[] } }
function reminderSnapshot() {
 const s=snapshot();s.data.actions=[action('prep',{kind:'prep',scheduledTemporal:temporal}),action('normal',{plannedDate:'2026-10-19'})]
 s.data.scheduleNodes=[{...node('prep_trigger'),relatedActionIds:['prep']}]
 s.data.reminderIntents=[{id:'old-reminder',scheduleNodeId:'node',scheduleNodeVersion:1,purpose:'prep',triggerAt:at,deliveryOwner:'pjsdas',channel:'in_product',state:'active',dedupeKey:'node@1|prep',createdAt:at,updatedAt:at}]
 return s
}
describe('retirement boundaries and preserved legacy evidence',()=>{
 it.each(['准备','准备材料','明天15:00准备材料','事项：整理面试材料','面试准备','面试练习','准备申请材料','Prepare interview','Interview prep','Prep for interview'])('refuses explicit task purpose %s at both new domain and semantic boundaries',title=>{
  const s=snapshot(),before=structuredClone(s)
  expect(isPreparationTaskText(title)).toBe(true)
  expect(()=>applyUserDomainCommand(s,{kind:'add_manual_action',commandId:'new-prep-task',title},now)).toThrow(/retired/)
  const result=applySemanticIntake(s,observation([candidate('Return badge'),candidate(title)]),{authorized:true,now})
  expect(result).toMatchObject({status:'NO_WRITE',changed:false});expect(result.snapshot).toEqual(before);expect(s).toEqual(before)
 })
 it.each(['准备投递京东','准备申请','准备投递简历','准备投递北京材料研究院','准备申请材料工程师','准备申请中科院材料所','填写报销单','确认面试地址','准备好就出发'])('does not infer preparation from application planning or unrelated task %s',title=>{
  expect(isPreparationTaskText(title)).toBe(false)
 })
 it.each(['事项：缴费；准备面试','事项：准备面试；事项：缴费','事项：缴费。准备面试','事项：缴费！准备面试'])('rejects a mixed first-party preparation instruction consistently: %s',text=>{
  const parsed=buildWebSemanticInterpretation(text,[],snapshot(),[],now,'UTC')
  expect(parsed.candidates).toEqual([]);expect(parsed.unresolved.length).toBeGreaterThan(0)
 })
 it('uses exact legacy operation provenance, leaving ambiguous manual and notes untouched',()=>{
  const legacy=action('progress-action:abc',{title:'面试材料',sourceLabel:'自然语言更新'})
  const log={id:'timeline:progress:abc',kind:'action_added',source:'natural_language',occurredAt:at,recordedAt:at,title:'Added',detail:'准备面试材料'} as const
  expect(isPreparationAction(legacy,[log])).toBe(true)
  expect(isPreparationAction(legacy,[{...log,id:'timeline:progress:other'}])).toBe(false)
  expect(isPreparationAction(action('manual',{title:'准备面试材料',notes:'prepare',sourceLabel:'unknown'}),[log])).toBe(false)
  expect(isPreparationAction(action('real-event',{title:'准备材料',processEventId:'event',prepId:'old'}),[log])).toBe(false)
  expect(isPreparationAction(action('application',{kind:'apply',title:'准备申请材料',prepId:'old'}),[log])).toBe(false)
 })
 it('keeps a mixed node with an independent ordinary owner',()=>{
  const data={actions:[action('prep',{kind:'prep'}),action('normal')]}
  expect(isPreparationNode({...node('follow_up'),relatedActionIds:['prep','normal']},data)).toBe(false)
  expect(isPreparationNode({...node('follow_up'),relatedActionIds:['prep','unknown']},data)).toBe(false)
 })
 it('removes preparation from capacity and MCP/Web Today without invalidating attached old reminders',()=>{
  const s=reminderSnapshot(),before=structuredClone(s);validateSnapshot(s)
  const projected=withoutPreparationSurfaces(s);validateSnapshot(projected)
  expect(projected.data.actions.map(row=>row.id)).toEqual(['normal']);expect(projected.data.scheduleNodes).toEqual([]);expect(projected.data.reminderIntents).toEqual([])
  const external=getTodayPlan(s,{availableMinutes:30},{now,timezone:'UTC'})
  expect(external.plannedMinutes).toBe(30);expect(external.fixedEvents).toEqual([])
  const web=selectTodayWeb(s,{availableMinutes:30},{now,timezone:'UTC'})
  expect(web.actions).toHaveLength(1);expect(web.actions[0].title).toBe('normal')
  expect(s).toEqual(before)
 })
 it('filters dependent reminder outbox copies without dropping unrelated or invalid raw evidence',()=>{
  const s=reminderSnapshot();Object.assign(s.data.reminderIntents![0],{deliveryOwner:'external_task',channel:'task',capability:'chatgpt_tasks'})
  s.data.reminderOutbox=[{id:'out',reminderIntentId:'old-reminder',operation:'upsert',capability:'chatgpt_tasks',state:'pending',attemptCount:0,payloadFingerprint:'old',createdAt:at,updatedAt:at}]
  const before=structuredClone(s);validateSnapshot(s)
  expect(withoutPreparationSurfaces(s).data.reminderOutbox).toEqual([]);expect(s).toEqual(before)
  s.data.reminderIntents![0].scheduleNodeId='missing';s.data.reminderIntents![0].purpose='custom'
  expect(()=>getTodayPlan(s,{}, {now,timezone:'UTC'})).toThrow(/missing ScheduleNode/)
 })
 it('allows exact old completion Undo while keeping the restored preparation hidden',()=>{
  const before=reminderSnapshot(),after=structuredClone(before);after.data.actions[0].status='done'
  const undo=captureActionStatusUndo(before.data,after.data,['prep']);restoreActionStatusUndo(after.data,undo)
  expect(after.data.actions).toEqual(before.data.actions)
  expect(withoutPreparationSurfaces(after).data.actions.map(row=>row.id)).toEqual(['normal'])
 })
 it('rejects retired reminder creation/update, permits guarded cancel/Undo, and labels exact archival reads',async()=>{
  const s=reminderSnapshot(),before=structuredClone(s),r=s.data.reminderIntents![0],n=s.data.scheduleNodes![0]
  await expect(applyPrivateReminderManagement(s,{operations:[{kind:'create_private_reminder',scheduleNodeId:n.id,expectedNodeFingerprint:await fp(n),purpose:'custom',triggerAt:at}]},'new-prep-reminder',now)).rejects.toThrow(/retired/)
  await expect(applyPrivateReminderManagement(s,{operations:[{kind:'update_private_reminder',id:r.id,expectedFingerprint:await fp(r),expectedNodeFingerprint:await fp(n),patch:{state:'active'}}]},'edit-prep-reminder',now)).rejects.toThrow(/retired/)
  expect((await readPrivateReminderManagement(s,{type:'reminders'})).items).toEqual([])
  expect((await readPrivateReminderManagement(s,{type:'schedule_targets'})).items).toEqual([])
  expect((await readPrivateReminderManagement(s,{type:'reminders',ids:[r.id]})).items[0]).toMatchObject({retired:true,allowedOperations:['cancel_private_reminder']})
  const cancelled=await applyPrivateReminderManagement(s,{operations:[{kind:'cancel_private_reminder',id:r.id,expectedFingerprint:await fp(r)}]},'cancel-old-prep',now)
  expect(cancelled.snapshot.data.reminderIntents![0].state).toBe('cancelled')
  expect((await restorePrivateReminderManagement(cancelled.snapshot,cancelled.compensation!,now)).data.reminderIntents).toEqual(before.data.reminderIntents)
  expect(s).toEqual(before)
 })
 it('retires stale decisions bound by occurrence ID without mutating their audit records',()=>{
  const s=reminderSnapshot()
  const c:SemanticCandidate={id:'old-candidate',kind:'reminder_intent',purpose:'custom',triggerAt:at,target:{occurrenceId:'occurrence'},objectConfidence:'high',eventConfidence:'high',evidenceRefs:[],sourceVersionRefs:[]}
  const request:DecisionRequest={id:'old-decision',reason:'low_confidence',state:'open',question:'Confirm?',choices:[{id:'yes',label:'Yes',consequence:'Record',resolution:{confirm:true}},{id:'no',label:'No',consequence:'Dismiss',resolution:{dismiss:true}}],affectedObjects:[],evidenceRefs:[],createdAt:at,updatedAt:at,payloadBinding:{contractVersion:1,inputId:'old',candidateId:c.id,statementMode:'assertion',source:observation([]).source,candidate:c}}
  s.data.decisionRequests=[request];const before=structuredClone(s),context={...s.data,now}
  expect(actionableDecision(request,context)).toBe(false);expect(partitionDecisions([request],context)).toEqual({actionable:[],dataQuality:[]})
  expect(withoutPreparationSurfaces(s).data.decisionRequests).toEqual([])
  const result=applySemanticIntake(s,observation([c]),{authorized:true,now});expect(result.status).toBe('NO_WRITE');expect(s).toEqual(before)
 })
})

import { restoreBusinessManagement } from '../src/businessManagement.js'
it('retains exact historical Prep edit/archive compensation while rejecting every new Prep operation',()=>{
 const s=snapshot(),row={id:'legacy-prep',title:'Interview materials',estimatedMinutes:30,createdAt:at,updatedAt:at,notes:'Retained raw record'}
 s.data.prep=[row]
 const prior={...row,title:'Original title'}
 const compensation={operation:'business_management_restore' as const,payload:{changes:[{type:'prep' as const,id:row.id,beforeIndex:0,before:prior,after:row}]}}
 expect(restoreBusinessManagement(s,compensation,now).data.prep).toEqual([prior]);expect(s.data.prep).toEqual([row])
 const archived=snapshot();expect(restoreBusinessManagement(archived,{operation:'business_management_restore',payload:{changes:[{type:'prep',id:row.id,beforeIndex:0,before:row,after:null}]}},now).data.prep).toEqual([row])
 for(const operation of [{kind:'create_prep',value:{title:'New',estimatedMinutes:30}},{kind:'update_prep',id:row.id,patch:{title:'Changed'}},{kind:'archive_prep',id:row.id}])expect(()=>applyBusinessManagement(s,{operations:[operation]},'new-prep-rejected',now)).toThrow(/retired/)
 const changed=structuredClone(s);changed.data.prep[0].title='Later edit';expect(()=>restoreBusinessManagement(changed,compensation,now)).toThrow(/overwrite newer/)
})
it('preserves same-command legacy task replay while rejecting ID reuse or fresh preparation writes',()=>{
 const s=snapshot(),command={kind:'add_manual_action' as const,commandId:'old-preparation',title:'准备材料'}
 s.data.actions=[action('legacy',{title:command.title,sourceLabel:'用户明确命令'})]
 s.data.timeline=[{id:'legacy-receipt',kind:'action_added',source:'user_action',title:'Old command',occurredAt:at,recordedAt:at,commandId:command.commandId,commandOperation:command.kind,changes:{planFacts:{before:undefined,after:JSON.stringify({kind:command.kind,title:command.title})}}}]
 const before=structuredClone(s)
 expect(applyUserDomainCommand(s,command,now).status).toBe('ALREADY_APPLIED');expect(s).toEqual(before)
 expect(()=>applyUserDomainCommand(s,{...command,title:'Different facts'},now)).toThrow(/reused/)
 expect(()=>applyUserDomainCommand(s,{...command,commandId:'fresh-preparation'},now)).toThrow(/retired/)
})
it('preserves real application planning and recruiting facts whose company or instructions mention preparation',()=>{
 const created=applyUserDomainCommand(snapshot(),{kind:'add_user_opportunity',commandId:'real-job',company:'材料研究院',role:'材料工程师',notes:'面试需准备身份证件'},now)
 const job=created.snapshot.data.opportunities[0]
 const planned=applyUserDomainCommand(created.snapshot,{kind:'plan_application_action',commandId:'real-application',opportunityId:job.id,plannedDate:'2026-10-19'},now)
 expect(planned.snapshot.data.actions).toHaveLength(1);expect(planned.snapshot.data.actions[0].kind).toBe('apply')
 const event=applyUserDomainCommand(planned.snapshot,{kind:'record_process_event',commandId:'real-interview',opportunityId:job.id,eventType:'interview_invite',temporal,notes:'请准备申请材料，在面试现场出示',source:'manual'},now)
 const projected=withoutPreparationSurfaces(event.snapshot)
 expect(projected.data.processEvents).toEqual(event.snapshot.data.processEvents)
 expect(projected.data.actions.some(row=>Boolean(row.processEventId))).toBe(true)
 expect(projected.data.scheduleNodes?.some(row=>row.kind==='interview')).toBe(true)
 expect(projected.data.opportunities[0].company).toBe('材料研究院')
})
