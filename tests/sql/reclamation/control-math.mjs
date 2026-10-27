/** Local private SQL representation mathematics, NOT an admitted product command.
 * Every synthetic row is fresh inside one rolled-back fixture transaction. */
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
export async function controlMath(h,t,saved,inventory,pass){
 await inventory(t)
 const original=await h.intent(t)
 const base=JSON.parse((await h.scalar('select ta_resource_reservations.rpc_control_bytes($1,$2) raw',[t.stage,original.retirement])).raw.toString())
 const stage=randomUUID(),command='v2-independent-'+randomUUID(),q=10_000_000,n0=10_000
 const identity={...saved.row.identity,commandId:command},binding={...saved.row.binding,stageId:stage,commandId:command}
 const tombstone={...original.retirement,fenceRevision:1,inventoryRevision:0}
 const initialResource={...base.resourceReservation,stage_id:stage,command_id:command,binding,phase:'open',revision:0,occupied:0,present:0,finalize_attempt:null,stop_reason:null,outcome:null,reclaim_id:null,writer_fence:null,writer_fence_revision:null,reclaim_inventory_revision:null,rpc_peak_occupied:0,current_held:0,released_bytes:0,retained_control_bytes:0}
 const shape=(n,R,release=R-n)=>{
  const x=structuredClone(base)
  x.intent={...x.intent,stage_id:stage,command_id:command,identity,binding,retirement:tombstone}
  x.stage={...x.stage,id:stage};x.documentReservation={...x.documentReservation,stage_id:stage,reserved_bytes:R}
  if(x.attempt)x.attempt={...x.attempt,stage_id:stage}
  x.resourceReservation={...initialResource,reserved:R,phase:'reclaimed',revision:2,occupied:n,present:n,current_held:n,released_bytes:release,retained_control_bytes:n,rpc_peak_occupied:n,
   outcome:tombstone.resourceOutcome,reclaim_id:tombstone.reclaimId,writer_fence:tombstone.writerFence,writer_fence_revision:1,reclaim_inventory_revision:0}
  for(const a of x.allocationTombstones)a.stage_id=stage
  for(const c of x.chunkTombstones)c.stage_id=stage
  x.controlAllocation={...x.controlAllocation,stage_id:stage,next_offset:n,occupied:n,present:n}
  x.controlChunk={...x.controlChunk,stage_id:stage,bytes:n}
  return x
 }
 const length=async x=>Number((await h.scalar("select octet_length(convert_to($1::jsonb::text,'UTF8')) n",[JSON.stringify(x)])).n)
 // Exact two-cycle construction: release loses one decimal digit at c+1;
 // every C/R/peak slot retains its own decimal width across both candidates.
 h.checkpoint('control-math-original-projection-verified')
 const c=await length(shape(n0,q+n0,q-1)),R=q+c
 assert.equal(String(c).length,String(n0).length);assert.equal(String(c+1).length,String(n0).length)
 assert.equal(await length(shape(c,R)),c+1);assert.equal(await length(shape(c+1,R)),c)
 // In this fixture O=P=0, so exactly nine numeric slots vary with C
 // (four resource counters, three allocation counters, chunk bytes, peak).
 // The only other varying slot is R-C. Every possible fixed point must lie
 // in this exhaustive output-length bound, where all C slots have d digits.
 const digits=n=>String(n).length,K=(await length(shape(n0,R)))-9*digits(n0)-digits(R-n0)
 const lower=K+10,upper=K+10*digits(R)
 assert.equal(digits(lower),digits(c));assert.equal(digits(upper),digits(c))
 assert(lower<=c&&upper>=c+1&&upper<R)
 assert.equal(digits(R-lower),digits(q));assert.equal(digits(R-upper),digits(q-1))
 for(let n=lower;n<=upper;n++)assert.notEqual(K+9*digits(n)+digits(R-n),n,'no exact fixed point anywhere in the possible output range')
 const trajectory=[];let candidate=1
 for(let iteration=0;iteration<32;iteration++){trajectory.push(candidate);candidate=await length(shape(candidate,R))}
 assert(trajectory.slice(-4).every((n,index)=>n===(index%2?trajectory.at(-3):trajectory.at(-4))))
 assert(new Set(trajectory.slice(-4)).size===2)
 await h.db.query('begin')
 try{
  const insert=async(table,row)=>h.db.query(`insert into ${table} select * from jsonb_populate_record(null::${table},$1::jsonb)`,[JSON.stringify(row)])
  await insert('pjsdas_rows_candidate.large_document_reservation',{...base.documentReservation,stage_id:stage,reserved_bytes:R})
  await insert('pjsdas_rows_candidate.large_command_intent',{...saved.row,stage_id:stage,command_id:command,identity,binding})
  await insert('pjsdas_rows_candidate.large_stage',{...base.stage,id:stage,request:{commandId:command,payloadHash:identity.payloadHash}})
  if(base.attempt)await insert('pjsdas_rows_candidate.large_command_attempt',{...base.attempt,stage_id:stage})
  await insert('ta_resource_reservations.reservation',{...initialResource,reserved:R})
  for(const a of base.allocationTombstones)await insert('ta_resource_reservations.allocation',{...a,stage_id:stage})
  for(const c of base.chunkTombstones)await insert('ta_resource_reservations.chunk',{...c,stage_id:stage})
  await h.db.query('update ta_resource_reservations.owner set held=held+$2 where user_id=$1;',[t.ids.userId,R]);await h.db.query('update ta_resource_reservations.pool set held=held+$1',[R])
  const before=await h.scalar('select to_jsonb(r) resource,to_jsonb(i) intent from ta_resource_reservations.reservation r join pjsdas_rows_candidate.large_command_intent i on i.stage_id::text=r.stage_id where r.stage_id=$1',[stage])
  const calculated=(await h.scalar('select ta_resource_reservations.rpc_control_bytes($1,$2) raw',[stage,tombstone])).raw
  assert.equal(calculated===null,true,'nonconvergent length must return null; actual bytes='+calculated?.length)
  const after=await h.scalar('select to_jsonb(r) resource,to_jsonb(i) intent from ta_resource_reservations.reservation r join pjsdas_rows_candidate.large_command_intent i on i.stage_id::text=r.stage_id where r.stage_id=$1',[stage])
  assert(isDeepStrictEqual(before,after),'nonconvergent calculator must not mutate any original field or charge')
  assert.equal(Number(after.resource.current_held),R);assert.equal(Number(after.resource.released_bytes),0)
  assert.equal(after.resource.writer_fence,null);assert(after.intent.encoded)
 }finally{await h.db.query('rollback')}
 await inventory(t)
 pass('control-byte-length-decimal-two-cycle-defers-without-mutation',{privateRepresentationMathOnly:true,R,c,Fc:c+1,FcPlusOne:c,trajectory,noFixedPointCandidateRange:[lower,upper],originalChargeRetained:true})
}
