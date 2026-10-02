import {describe,expect,it} from 'vitest'
import {applyPrivateReminderManagement as apply,restorePrivateReminderManagement as restore,privateReminderManagementFingerprint as fp,readPrivateReminderManagement as read} from '../src/privateReminderManagement.js'
import {unknownDeadlineWorkspace} from './fixtures/unknownDeadlineWorkspace.js'
import type{ReminderIntent}from'../src/model.js'
const now=new Date('2026-10-02T21:00:00Z')
function fixture(){const s=unknownDeadlineWorkspace(1);s.data.scheduleNodes!.push({id:'private-target',occurrenceId:'private-occurrence',version:1,kind:'interview',state:'scheduled',temporal:{shape:'fixed_range',precision:'datetime',timezone:'Asia/Shanghai',startAt:'2026-10-03T02:00:00Z',endAt:'2026-10-03T03:00:00Z',resolutionBasis:'user_explicit'},constraintKind:'user_plan',evidenceRefs:[],sourceVersionRefs:[],relatedActionIds:[],relatedPrepIds:[],createdAt:now.toISOString(),updatedAt:now.toISOString()});return s}
async function create(s=fixture(),extra:any={}){return apply(s,{operations:[{kind:'create_private_reminder',scheduleNodeId:'private-target',expectedNodeFingerprint:await fp(s.data.scheduleNodes!.find(n=>n.id==='private-target')),purpose:'upcoming',triggerAt:'2026-10-03T09:30:00+08:00',...extra}]},'reminder-create',now)}
function protectedData(s:any){return Object.fromEntries(Object.entries(s.data).filter(([k])=>!['reminderIntents','timeline'].includes(k)))}
async function edit(s:any,row:ReminderIntent,patch:any,id='reminder-edit'){return apply(s,{operations:[{kind:'update_private_reminder',id:row.id,expectedFingerprint:await fp(row),expectedNodeFingerprint:await fp(s.data.scheduleNodes.find((n:any)=>n.id===row.scheduleNodeId)),patch}]},id,now)}
describe('source-only private reminder management reducer',()=>{
 it('creates one private intent, preserves every unrelated domain and restores exact absence',async()=>{
  const s=fixture();const result=await create(s);const row=result.snapshot.data.reminderIntents![0]
  expect(row).toMatchObject({deliveryOwner:'pjsdas',channel:'in_product',triggerAt:'2026-10-03T01:30:00.000Z',state:'active',dedupeKey:'private-target@1|upcoming'})
  expect(row).not.toHaveProperty('externalLink');expect(protectedData(result.snapshot)).toEqual(protectedData(s));expect(s.data.reminderIntents).toEqual([])
  const undone=await restore(result.snapshot,result.compensation!,now);expect(undone.data.reminderIntents).toEqual([]);expect(undone.data.timeline).toEqual(result.snapshot.data.timeline)
 })
 it('updates, pauses, cancels and restores raw metadata without writing outbox',async()=>{
  const first=await create();let s=first.snapshot;let row=s.data.reminderIntents![0];(row as any).future={keep:'exact'}
  const updated=await edit(s,row,{state:'paused',triggerAt:'2026-10-03T00:30:00Z'});expect(updated.snapshot.data.reminderIntents![0]).toMatchObject({state:'paused',future:{keep:'exact'}})
  expect((await restore(updated.snapshot,updated.compensation!,now)).data.reminderIntents).toEqual(s.data.reminderIntents)
  const cancelled=await apply(s,{operations:[{kind:'cancel_private_reminder',id:row.id,expectedFingerprint:await fp(row)}]},'reminder-cancel',now)
  expect(cancelled.snapshot.data.reminderIntents![0].state).toBe('cancelled');expect(cancelled.snapshot.data.reminderOutbox).toEqual([])
  expect((await restore(cancelled.snapshot,cancelled.compensation!,now)).data.reminderIntents).toEqual(s.data.reminderIntents)
 })
 it('refuses external ownership and outbox-linked records including cancellation',async()=>{
  for(const kind of ['external','outbox']){const first=await create();const s=first.snapshot,row=s.data.reminderIntents![0]
   if(kind==='external')Object.assign(row,{deliveryOwner:'external_task',channel:'task',capability:'chatgpt_tasks',externalLink:{capability:'chatgpt_tasks',state:'unmapped'}})
   else s.data.reminderOutbox!.push({id:'protected-outbox',reminderIntentId:row.id,operation:'upsert',capability:'chatgpt_tasks',state:'pending',attemptCount:0,payloadFingerprint:'test',createdAt:now.toISOString(),updatedAt:now.toISOString()})
   await expect(apply(s,{operations:[{kind:'cancel_private_reminder',id:row.id,expectedFingerprint:await fp(row)}]},'deny-external',now)).rejects.toThrow(/External|outbox/)
   expect((await read(s,{type:'reminders'})).items).toEqual([])
  }
 })
 it.each(['completed','cancelled','superseded'])('refuses creation on %s targets',async state=>{const s=fixture();s.data.scheduleNodes!.at(-1)!.state=state as any;await expect(create(s)).rejects.toThrow(/active latest/)})
 it('requires latest node, exact target/reminder proofs and no dedupe or ID reuse',async()=>{
  const s=fixture();await expect(create(s,{expectedNodeFingerprint:'f'.repeat(64)})).rejects.toThrow(/changed/)
  const result=await create(s);await expect(create(result.snapshot)).rejects.toThrow(/identity already exists/)
  await expect(apply(result.snapshot,{operations:[{kind:'create_private_reminder',scheduleNodeId:'private-target',expectedNodeFingerprint:await fp(s.data.scheduleNodes!.at(-1)),purpose:'upcoming',triggerAt:'2026-10-03T01:00:00Z'}]},'different-create',now)).rejects.toThrow(/already have a reminder/)
  const newer={...s.data.scheduleNodes!.at(-1)!,id:'newer-node',version:2};s.data.scheduleNodes!.push(newer);await expect(create(s)).rejects.toThrow(/active latest/)
 })
 it('rejects newer reminder or changed target during restore and preserves unrelated later data',async()=>{
  const result=await create();const changed=structuredClone(result.snapshot);changed.data.reminderIntents![0].triggerAt='2026-10-03T00:00:00Z';await expect(restore(changed,result.compensation!,now)).rejects.toThrow(/newer data/)
  const nodeChanged=structuredClone(result.snapshot);nodeChanged.data.scheduleNodes!.at(-1)!.updatedAt='2026-10-02T22:00:00Z';await expect(restore(nodeChanged,result.compensation!,now)).rejects.toThrow(/target changed/)
  result.snapshot.data.opportunities[0].company='New unrelated';const restored=await restore(result.snapshot,result.compensation!,now);expect(restored.data.opportunities[0].company).toBe('New unrelated')
 })
 it('returns bounded target and private-record fingerprints with pagination',async()=>{
  const s=fixture();const target=await read(s,{type:'schedule_targets',ids:['private-target']});expect(target.items[0]).toMatchObject({target:{id:'private-target'},activeLatest:true,fingerprint:await fp(s.data.scheduleNodes!.at(-1))})
  const created=await create(s);const result=await read(created.snapshot,{type:'reminders',limit:1});expect(result.items).toHaveLength(1);expect(result.nextAfterId).toBe(null)
 })
 it('atomic invalid batch leaves original data untouched and no-op edits preserve timestamps',async()=>{
  const result=await create();const s=result.snapshot,row=s.data.reminderIntents![0];const before=structuredClone(s)
  const unchanged=await edit(s,row,{state:'active'});expect(unchanged.status).toBe('ALREADY_APPLIED');expect(unchanged.snapshot).toBe(s)
  await expect(apply(s,{operations:[{kind:'cancel_private_reminder',id:row.id,expectedFingerprint:await fp(row)},{kind:'cancel_private_reminder',id:'missing',expectedFingerprint:'f'.repeat(64)}]},'atomic-reminders',now)).rejects.toThrow(/not found/)
  expect(s).toEqual(before)
 })
 it.each([{deliveryOwner:'external_task'},{triggerAt:'2026-10-03T09:30:00'},{purpose:'arbitrary'},{budget:10}])('rejects unsupported create field or missing timezone %#',async extra=>{await expect(create(fixture(),extra)).rejects.toThrow()})
})

it.each(['version','dedupe'])('refuses malformed imported private %s identity without reinterpreting its target',async field=>{
 const created=await create();const s=created.snapshot,row=s.data.reminderIntents![0]
 if(field==='version')row.scheduleNodeVersion=9;else row.dedupeKey='arbitrary-key'
 await expect(edit(s,row,{state:'active'})).rejects.toThrow(/inconsistent/)
 await expect(read(s,{type:'reminders'})).rejects.toThrow(/inconsistent/)
})
it('cannot create duplicate purpose by trusting a malformed existing external dedupe key',async()=>{
 const created=await create();const s=created.snapshot,row=s.data.reminderIntents![0]
 Object.assign(row,{deliveryOwner:'external_task',channel:'task',capability:'chatgpt_tasks',dedupeKey:'wrong-import-key'})
 await expect(apply(s,{operations:[{kind:'create_private_reminder',scheduleNodeId:'private-target',expectedNodeFingerprint:await fp(s.data.scheduleNodes!.at(-1)),purpose:'upcoming',triggerAt:'2026-10-03T01:00:00Z'}]},'duplicate-purpose',now)).rejects.toThrow(/already have a reminder/)
})

it('roundtrips a maximum batch of25 maximum-size reminders with maximum-length IDs',async()=>{
 const s=fixture(),base=s.data.scheduleNodes!.at(-1)!;s.data.reminderIntents=[];const operations:any[]=[]
 for(let i=0;i<25;i++){
  const node={...base,id:`bound-node-${i}`,occurrenceId:`bound-occurrence-${i}`};s.data.scheduleNodes!.push(node)
  const row:any={id:String(i).padStart(2,'0')+'x'.repeat(238),scheduleNodeId:node.id,scheduleNodeVersion:1,purpose:'custom',triggerAt:'2026-10-03T01:00:00.000Z',deliveryOwner:'pjsdas',channel:'in_product',state:'active',dedupeKey:`${node.id}@1|custom`,createdAt:now.toISOString(),updatedAt:now.toISOString(),metadata:''}
  row.metadata='x'.repeat(16384-new TextEncoder().encode(JSON.stringify(row)).byteLength);s.data.reminderIntents.push(row)
  operations.push({kind:'update_private_reminder',id:row.id,expectedFingerprint:await fp(row),expectedNodeFingerprint:await fp(node),patch:{state:'paused'}})
 }
 const result=await apply(s,{operations},'max-reminder-batch',now)
 expect(result.compensation!.payload.changes).toHaveLength(25);expect(result.compensationFingerprint).toBe(await fp(result.compensation))
 expect((await restore(result.snapshot,result.compensation!,now)).data.reminderIntents).toEqual(s.data.reminderIntents)
})
it('cancellation on an inactive target retains evidence but never restores unsafe active intent',async()=>{
 const created=await create(),s=created.snapshot,row=s.data.reminderIntents![0];s.data.scheduleNodes!.at(-1)!.state='completed'
 const result=await apply(s,{operations:[{kind:'cancel_private_reminder',id:row.id,expectedFingerprint:await fp(row)}]},'cancel-stale-reminder',now)
 expect(result.snapshot.data.reminderIntents![0].state).toBe('cancelled');expect(result.compensation).toBeDefined()
 await expect(restore(result.snapshot,result.compensation!,now)).rejects.toThrow(/active latest/)
})
it('refuses non-JSON array entries rather than equating undefined metadata with null',async()=>{
 await expect(fp({metadata:[undefined]})).rejects.toThrow(/finite JSON/)
})
it('preserves exact whitespace-bearing stored IDs and pagination cursors',async()=>{
 const created=await create(),s=created.snapshot,row=s.data.reminderIntents![0];row.id='a '
 s.data.reminderIntents!.push({...row,id:'b',purpose:'custom',dedupeKey:'private-target@1|custom'})
 const exact=await read(s,{type:'reminders',ids:['a ']});expect(exact.items).toHaveLength(1);expect((exact.items[0] as any).raw.id).toBe('a ')
 const first=await read(s,{type:'reminders',limit:1});expect(first.nextAfterId).toBe('a ')
 const second=await read(s,{type:'reminders',limit:1,afterId:first.nextAfterId!});expect((second.items[0] as any).raw.id).toBe('b');expect(second.nextAfterId).toBe(null)
 const cancelled=await apply(s,{operations:[{kind:'cancel_private_reminder',id:'a ',expectedFingerprint:await fp(row)}]},'exact-id-command',now);expect(cancelled.snapshot.data.reminderIntents![0].state).toBe('cancelled')
})
it('refuses activation or active restore across a logical external-owner collision but allows safe cancellation',async()=>{
 const created=await create();const original=created.snapshot.data.reminderIntents![0];const paused=await edit(created.snapshot,original,{state:'paused'})
 const s=paused.snapshot,row=s.data.reminderIntents![0]
 s.data.reminderIntents!.push({...row,id:'external-duplicate',deliveryOwner:'external_task',channel:'task',capability:'chatgpt_tasks',state:'active',dedupeKey:'malformed-external-key'})
 await expect(edit(s,row,{state:'active'},'resume-collision')).rejects.toThrow(/Another reminder/)
 await expect(restore(s,paused.compensation!,now)).rejects.toThrow(/Another reminder/)
 const cancelled=await apply(s,{operations:[{kind:'cancel_private_reminder',id:row.id,expectedFingerprint:await fp(row)}]},'safe-cancel-collision',now)
 expect(cancelled.snapshot.data.reminderIntents![0].state).toBe('cancelled');expect(cancelled.snapshot.data.reminderIntents![1]).toEqual(s.data.reminderIntents![1])
})
it('rejects sparse array metadata instead of fingerprinting it as null',async()=>{
 await expect(fp({metadata:new Array(1)})).rejects.toThrow(/finite JSON/)
})
