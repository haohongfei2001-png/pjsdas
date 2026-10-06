import { describe, expect, it, vi } from 'vitest'
import { applyBusinessManagement, readBusinessManagement, restoreBusinessManagement } from '../src/businessManagement.js'
import { unknownDeadlineWorkspace } from './fixtures/unknownDeadlineWorkspace.js'
import { createOwnerBusinessManagementRuntime } from '../gateway/businessManagementRuntime.js'
const owner='00000000-0000-4000-8000-000000000001',client='00000000-0000-4000-8000-000000000002',grantId='00000000-0000-4000-8000-000000000003',now=new Date('2026-10-03T00:00:00Z')
function raw(){const s=unknownDeadlineWorkspace(1);s.data.actions[0].dueAt='2026-08-27T15:59:59Z';s.data.actions[0].timingMode='deadline';s.data.prep=[{id:'synthetic-b',title:'B',estimatedMinutes:30,createdAt:now.toISOString(),updatedAt:now.toISOString(),future:{keep:['raw',null]}} as any,{id:'synthetic-a',title:'A',estimatedMinutes:30,createdAt:now.toISOString(),updatedAt:now.toISOString()}];(s.data as any).futureSurface={nested:[1,'keep',null]};return s}
const protectedData=(s:ReturnType<typeof raw>)=>Object.fromEntries(Object.entries(s.data).filter(([key])=>!['prep','timeline'].includes(key)))
const create={operations:[{kind:'create_prep',value:{title:'Synthetic new prep',estimatedMinutes:30}}]}
describe('v2 exact raw preservation regression',()=>{
 it.each([create,{operations:[{kind:'update_prep',id:'synthetic-b',patch:{title:'Edited'}}]},{operations:[{kind:'archive_prep',id:'synthetic-b'}]}])('preserves unrelated raw facts and restores exact prep order/metadata %#',change=>{
  const before=raw(),unchanged=structuredClone(before)
  const read=readBusinessManagement(before,{type:'action',ids:[before.data.actions[0].id]});const {leverage:_leverage,delayCost:_delay,...visibleAction}=before.data.actions[0];expect(read.items[0]).toEqual(visibleAction);expect(read.items[0]).not.toHaveProperty('leverage');expect(read.items[0]).not.toHaveProperty('delayCost')
  const applied=applyBusinessManagement(before,change,'synthetic-v2-raw-command',now)
  expect(protectedData(applied.snapshot)).toEqual(protectedData(before));expect(before).toEqual(unchanged)
  const restored=restoreBusinessManagement(applied.snapshot,applied.compensation!,now)
  expect(protectedData(restored)).toEqual(protectedData(before));expect(restored.data.prep).toEqual(before.data.prep)
 })
 it('keeps a valid legacy envelope and does not manufacture protected collections',()=>{
  const before=raw();before.version=1
  for(const key of ['scheduleNodes','decisionRequests','semanticReceipts','reminderIntents','reminderOutbox'] as const)delete before.data[key]
  const applied=applyBusinessManagement(before,create,'synthetic-v2-legacy',now)
  expect(applied.snapshot.version).toBe(1);expect(protectedData(applied.snapshot)).toEqual(protectedData(before))
  expect(restoreBusinessManagement(applied.snapshot,applied.compensation!,now).version).toBe(1)
 })
 it.each(['commit','revoke','replacement','conflict'] as const)('actual v2 runtime keeps raw preimages through %s',async mode=>{
  const initial=raw();let snapshot=structuredClone(initial),revision=0,active=true,grantRevision=1
  const ledger:any[]=[],posts:any[]=[]
  const fetchImpl=vi.fn<typeof fetch>(async(input,init)=>{
   const u=new URL(String(input))
   if(init?.method==='POST'){
    const b=JSON.parse(String(init.body));posts.push(b);expect(protectedData(b.target_snapshot)).toEqual(protectedData(initial))
    if(mode==='conflict')return Response.json([{outcome:'CONFLICT',workspace_id:'synthetic-workspace',revision:1,receipt:{}}])
    snapshot=b.target_snapshot;revision++;const receipt={...b.target_receipt_context};ledger.push({user_id:owner,command_id:b.target_command_id,operation:b.target_operation,payload_hash:b.target_payload_hash,resulting_revision:revision,status:'COMMITTED',receipt,compensation:b.target_compensation})
    return Response.json([{outcome:'COMMITTED',workspace_id:'synthetic-workspace',revision,receipt}])
   }
   if(u.pathname.endsWith('pjsdas_business_management_grants'))return Response.json(active?[{id:grantId,user_id:owner,client_id:client,capability:'workspace.manage',consent_version:2,revision:grantRevision,granted_at:'2026-10-01T00:00:00Z',revoked_at:null}]:[])
   if(u.pathname.endsWith('pjsdas_workspaces')){if(mode==='revoke')active=false;if(mode==='replacement')grantRevision=2;return Response.json([{id:'synthetic-workspace',user_id:owner,snapshot,revision,schema_version:4}])}
   if(u.pathname.endsWith('pjsdas_command_ledger')){const id=u.searchParams.get('command_id'),after=u.searchParams.get('resulting_revision');return Response.json(ledger.filter(row=>(!id||id===`eq.${row.command_id}`)&&(!after||row.resulting_revision>Number(after.slice(3)))))}
   throw new Error('Unexpected synthetic request')
  })
  const runtime=createOwnerBusinessManagementRuntime({enabled:'enabled',transactional:true,identity:{userId:owner,oauthClientId:client},audience:{mode:'allowlist',allowed:true,role:'owner'},source:{read:async()=>{throw new Error('Normalized source must not be read')}},supabaseUrl:'https://synthetic.invalid',serviceRoleKey:'synthetic',fetchImpl})!
  if(mode==='commit'){
   const read=await runtime.invoke('get_business_management',{query:{type:'action',ids:[initial.data.actions[0].id]}});const {leverage:_leverage,delayCost:_delay,...visibleAction}=initial.data.actions[0];expect((read.structuredContent as any).data.items[0]).toEqual(visibleAction);expect((read.structuredContent as any).data.items[0]).not.toHaveProperty('leverage');expect((read.structuredContent as any).data.items[0]).not.toHaveProperty('delayCost')
  }
  const applied=await runtime.invoke('execute_business_management',{commandId:'synthetic-v2-runtime',baseRevision:0,change:create})
  for(const post of posts)expect(protectedData(post.target_snapshot)).toEqual(protectedData(initial))
  if(mode==='revoke'||mode==='replacement'){expect(applied.structuredContent).toMatchObject({code:'AUTH_FORBIDDEN'});expect(posts).toEqual([]);return}
  if(mode==='conflict'){expect(applied.isError===true||applied.structuredContent?.outcome==='CONFLICT').toBe(true);expect(snapshot).toEqual(initial);return}
  expect(applied.structuredContent).toMatchObject({outcome:'COMMITTED'})
  expect((await runtime.invoke('undo_business_management',{commandId:'synthetic-v2-undo',targetCommandId:'synthetic-v2-runtime'})).structuredContent).toMatchObject({outcome:'COMMITTED'})
  expect(protectedData(snapshot)).toEqual(protectedData(initial));expect(snapshot.data.prep).toEqual(initial.data.prep)
 })
})
