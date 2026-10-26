/** Isolated real-DB concurrency and exit-guard supplement. No deadline/clock edits. */
import assert from 'node:assert/strict'
import {writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {setTimeout as sleep} from 'node:timers/promises'
import {fixture} from './workspace-rows-durable-v2-fixture.mjs'
import {verifySource,lock,selectGroup,safeError,safeRpcSummary} from './workspace-rows-durable-v2-source.mjs'
import {inventory,originalResource} from './workspace-rows-durable-v2-resource-inventory.mjs'
const evidence=process.env.TA_V2_EVIDENCE;assert(evidence);verifySource()
assert.equal(process.argv.length,2,'Unexpected barrier gate arguments')
const labels=selectGroup('barriers')
const report={contract:'ta-native-durable-v2-gate-v1',group:'barriers',source:lock.commit,tree:lock.tree,status:'RUNNING',localOnly:true,productionEligible:false,cases:labels.map(label=>({label,status:'NOT_RUN'})),observations:[]}
const save=()=>writeFileSync(join(evidence,'result.json'),JSON.stringify(report,null,2)+'\n')
const observe=(kind,value)=>{const clean=JSON.parse(JSON.stringify(value,(key,v)=>key==='query'?undefined:v));const item={kind,at:Date.now(),...clean};report.observations.push(item);console.log('BARRIER',JSON.stringify(item));save();return item}
const pass=(label,detail={})=>{const entry=report.cases.find(c=>c.label===label);assert(entry&&entry.status==='NOT_RUN','Unexpected or duplicate label');Object.assign(entry,{status:'PASS',...detail});save();console.log('PASS',label,JSON.stringify(detail))}
const payload=r=>r.result.body??r.result.structuredContent
const success=(r,outcome)=>{assert.equal(r.result.status,200,JSON.stringify(r.result));assert.equal(payload(r).outcome,outcome)}
const interrupted=r=>{assert.equal(r.result.status,503,JSON.stringify(r.result));assert.equal(payload(r).code,'WORKSPACE_UNAVAILABLE')}
const terminal=r=>{assert.equal(r.result.status,400,JSON.stringify(r.result));assert.equal(payload(r).code,'WORKSPACE_RECOVERY_TERMINAL');assert.equal(payload(r).retryable,false)}
const flight=promise=>{const state={settled:false};state.promise=promise.then(value=>{state.settled=true;state.value=value;return state},error=>{state.settled=true;state.error=error;return state});return state}
const completed=async state=>{await state.promise;if(state.error)throw state.error;return state.value}
let h,active
save()
async function stage(t,{path='large_v2_documents_finish',before=true}={}){
 const start=h.calls.length;h.setDrop({before,match:p=>p.endsWith(path)});const first=await h.invoke(t);interrupted(first);h.assertNoDrop();await h.drain()
 const row=await h.intent(t);assert(row);const reservation=await h.reservation(t),prepared=h.decoded(row,Number(reservation.reserved_bytes))
 const call=h.calls.slice(start).find(c=>c.path.endsWith(path));assert(call?.input)
 assert.equal((await h.ledger(t)).length,0)
 return{t,row,reservation,prepared,finish:call.input,calls:h.calls.slice(start),attempt:call.input.attempt}
}
async function dbNow(){return Number((await h.scalar('select floor(extract(epoch from clock_timestamp())*1000)::bigint ms')).ms)}
async function untilDbTime(at){while(true){const now=await dbNow();if(now>=at)return now;await sleep(Math.min(200,at-now))}}
async function poll(label,check,timeoutMs=3000){
 const started=performance.now();while(performance.now()-started<timeoutMs){const value=await check();if(value)return value;await sleep(25)}
 throw Error('Observed-lock barrier did not establish: '+label)
}
async function activityWait(name,blocker){
 return poll(name+' blocked by '+blocker,async()=>{
  await h.db.query('select pg_stat_clear_snapshot()')
  const rows=(await h.db.query(`select pid,application_name,state,wait_event_type,wait_event,pg_blocking_pids(pid) blockers,query from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and state='active' and query like $1`,['%pjsdas_rows_v1_'+name+'%'])).rows
  return rows.find(r=>r.wait_event_type==='Lock'&&r.blockers.includes(blocker))
 })
}
const GATE_NS=742621
let nextGate=1
async function gate(kind,t){
 const key=nextGate++,controller=await h.observer('gate_'+kind+'_'+key),trigger='ta_v2_barrier_'+key
 await controller.query('select pg_advisory_lock($1::integer,$2::integer)',[GATE_NS,key])
 const ledger=kind==='finish',table=ledger?'pjsdas_rows_candidate.ledger':'pjsdas_rows_candidate.large_command_attempt'
 const condition=ledger?`new.command_id='${t.commandId}'`:`new.stage_id='${t.stage}'::uuid and new.terminal_reason='CANCELLED'`
 await h.db.query(`create function public.${trigger}() returns trigger language plpgsql as $$ begin if ${condition} then perform pg_advisory_xact_lock(${GATE_NS},${key});end if;return new;end $$;create trigger ${trigger} ${ledger?'after insert':'before insert or update'} on ${table} for each row execute function public.${trigger}()`)
 let released=false
 const release=async()=>{if(!released){const r=(await controller.query('select pg_advisory_unlock($1::integer,$2::integer) ok',[GATE_NS,key])).rows[0];assert.equal(r.ok,true);released=true}}
 const entered=async()=>poll(kind+' advisory gate',async()=>{
  const rows=(await h.db.query(`select l.pid,l.granted,l.classid::bigint namespace,l.objid::bigint key,a.state,a.wait_event_type,a.wait_event,pg_blocking_pids(l.pid) blockers,a.query from pg_locks l join pg_stat_activity a on a.pid=l.pid where l.locktype='advisory' and l.classid=$1::oid and l.objid=$2::oid and l.objsubid=2 and not l.granted`,[GATE_NS,key])).rows
  const row=rows.find(r=>r.blockers.includes(controller.processID));if(row)observe('gate-entered',{gate:kind,stage:t.stage,controllerPid:controller.processID,...row});return row
 })
 const cleanup=async()=>{await release();await h.db.query(`drop trigger if exists ${trigger} on ${table};drop function if exists public.${trigger}()`)}
 return{controller,key,entered,release,cleanup}
}
async function proveHeadHeld(t,holderPid){
 const client=await h.observer('head_probe_'+nextGate),query=flight(client.query('select id from pjsdas_rows_candidate.head where id=$1 for update',[t.ids.workspaceId]))
 try{
  const state=await poll('head row held by '+holderPid,async()=>{
   await h.db.query('select pg_stat_clear_snapshot()')
   const r=await h.scalar('select pid,state,wait_event_type,wait_event,pg_blocking_pids(pid) blockers from pg_stat_activity where pid=$1',[client.processID]);return r?.wait_event_type==='Lock'&&r.blockers.includes(holderPid)?r:null
  })
  assert.equal(query.settled,false);observe('head-lock-observed',{stage:t.stage,holderPid,probe:state})
 }finally{
  if(!query.settled){const cancelled=await h.scalar('select pg_cancel_backend($1) ok',[client.processID]);assert.equal(cancelled.ok,true)}
  await query.promise;if(query.error)assert.equal(query.error.code,'57014','only this owned observation query is cancelled')
 }
}
async function immutable(s){assert.deepEqual(await h.intent(s.t),s.row);assert.deepEqual(await h.reservation(s.t),s.reservation)}
async function originalCommit(s){
 await immutable(s);const ledger=await h.ledger(s.t);assert.equal(ledger.length,1)
 assert.deepEqual((await h.current(s.t)).snapshot,s.prepared.input.snapshot);assert.deepEqual(ledger[0].compensation,s.prepared.input.compensation??null);assert.equal(ledger[0].receipt.contractVersion,5)
 for(const[k,v]of Object.entries(s.prepared.input.receiptContext??{}))assert.deepEqual(ledger[0].receipt[k],v)
 return ledger[0]
}
try{
 h=await fixture(evidence)
 active=labels[0]
 {
  const t=await h.make('api'),s=await stage(t),before=await inventory(h,t),g=await gate('finish',t)
  let finish,begin
  try{
   const remaining=s.attempt.deadlineAt-await dbNow();assert(remaining>1500,'fixture setup must leave an observable original attempt window')
   await untilDbTime(s.attempt.deadlineAt-4000)
   const startedAt=await dbNow();assert(startedAt<s.attempt.deadlineAt)
   finish=flight(h.rpc('large_v2_documents_finish',s.finish))
   const waiting=await g.entered();await proveHeadHeld(t,waiting.pid)
   begin=flight(h.rpc('large_v2_attempt_begin',{identity:s.row.identity,target_user_id:t.ids.userId}))
   const beginWait=await activityWait('large_v2_attempt_begin',waiting.pid);observe('new-attempt-waits-for-old-finalizer',{stage:t.stage,oldAttempt:s.attempt,finishPid:waiting.pid,begin:beginWait})
   assert.equal(begin.settled,false);assert.equal((await h.scalar('select generation from pjsdas_rows_candidate.large_command_attempt where stage_id=$1',[t.stage])).generation,String(s.attempt.generation))
   await untilDbTime(s.attempt.deadlineAt+100);assert.equal(finish.settled,false);assert.equal(begin.settled,false)
   await g.release();const failed=await completed(finish),opened=await completed(begin),endedAt=await dbNow()
   observe('attempt-transition',{oldGeneration:s.attempt.generation,oldDeadlineAt:s.attempt.deadlineAt,newGeneration:opened.body?.attempt?.generation,newDeadlineAt:opened.body?.attempt?.deadlineAt,newRemainingMs:opened.body?.remainingMs,returnedAt:endedAt,finishStatus:failed.status,finishSqlstate:safeRpcSummary([{path:'/rpc/pjsdas_rows_v1_large_v2_documents_finish',errorCode:failed.body?.code}])[0].sqlstate})
   assert.equal(failed.status,503,JSON.stringify(failed));assert.equal(failed.body.code,'PT503','exit attempt guard, not per-SQL 57014')
   assert(endedAt-startedAt<10000,'actual finalizer transaction remained below its own SQL 10s')
   assert.equal(opened.status,200,JSON.stringify(opened));assert(opened.body.attempt.generation>s.attempt.generation);assert.notEqual(opened.body.attempt.id,s.attempt.id)
   assert(opened.body.remainingMs<10000&&opened.body.remainingMs>0,'new begin lock wait is included, not refunded')
   assert.equal((await h.ledger(t)).length,0);assert.equal((await h.current(t)).revision,0);assert.deepEqual((await h.current(t)).snapshot,JSON.parse(JSON.stringify(t.f.before)))
   assert.deepEqual(await inventory(h,t),before,'failed finalization rolls back every business/audit/resource representation')
   await immutable(s);await g.cleanup()
   const recoveryStartedAt=Date.now(),recoveryCallsAt=h.calls.length,recoveryChildrenAt=h.children.length
   observe('recovery-dispatch',{at:recoveryStartedAt,generation:opened.body.attempt.generation,deadlineAt:opened.body.attempt.deadlineAt,remainingMs:opened.body.attempt.deadlineAt-recoveryStartedAt,afterBeginChecksMs:recoveryStartedAt-endedAt})
   let retry
   try{retry=await h.invoke(t)}finally{
    observe('recovery-rpc-timing',{elapsedMs:Date.now()-recoveryStartedAt,status:retry?.result?.status,rpcs:safeRpcSummary(h.calls.slice(recoveryCallsAt)),workers:h.children.slice(recoveryChildrenAt).map(({pid,startedAt,exitAt,code})=>({pid,startedAt,exitAt,code}))})
   }
   success(retry,'COMMITTED');await originalCommit(s);const after=await inventory(h,t);originalResource(after.reservation,before.reservation)
   pass(active,{oldGeneration:s.attempt.generation,newGeneration:opened.body.attempt.generation,finishSqlstate:failed.body.code,finishStatementMs:endedAt-startedAt,oldAttemptElapsedMs:endedAt-(s.attempt.deadlineAt-10000),newRemainingMs:opened.body.remainingMs,headWaitObserved:true,atomicRollback:true})
  }finally{
   await g.release();if(finish)await finish.promise;if(begin)await begin.promise;await g.cleanup()
  }
 }
 active=labels[1]
 {
  const t=await h.make('api'),s=await stage(t),g=await gate('finish',t);let finish,cancel
  try{
   finish=flight(h.rpc('large_v2_documents_finish',s.finish));const entered=await g.entered();await proveHeadHeld(t,entered.pid)
   cancel=flight(h.rpc('large_v2_intent_cancel',{identity:s.row.identity,target_user_id:t.ids.userId}))
   const waiting=await activityWait('large_v2_intent_cancel',entered.pid);observe('cancel-waits-for-finisher',{stage:t.stage,finishPid:entered.pid,cancel:waiting});assert.equal(cancel.settled,false)
   assert(s.attempt.deadlineAt-await dbNow()>250,'commit-first test must release before original deadline')
   await g.release();const committed=await completed(finish),resolved=await completed(cancel)
   assert.equal(committed.status,200,JSON.stringify(committed));assert.equal(committed.body.outcome,'COMMITTED');assert.equal(resolved.status,200);assert.equal(resolved.body.outcome,'ALREADY_APPLIED')
   const audit=await originalCommit(s),resource=await inventory(h,t);assert.equal(resource.reservation.phase,'committed')
   const replay=await h.invoke(t);success(replay,'ALREADY_APPLIED');assert.deepEqual((await h.ledger(t))[0],audit)
   pass(active,{headWaitObserved:true,cancelOutcome:resolved.body.outcome,originalReceiptUnchanged:true,oneBusinessCommit:true})
  }finally{await g.release();if(finish)await finish.promise;if(cancel)await cancel.promise;await g.cleanup()}
 }
 active=labels[2]
 {
  const t=await h.make('api'),s=await stage(t),before=await inventory(h,t),g=await gate('cancel',t);let finish,cancel
  try{
   cancel=flight(h.rpc('large_v2_intent_cancel',{identity:s.row.identity,target_user_id:t.ids.userId}));const entered=await g.entered();await proveHeadHeld(t,entered.pid)
   finish=flight(h.rpc('large_v2_documents_finish',s.finish));const waiting=await activityWait('large_v2_documents_finish',entered.pid);observe('finisher-waits-for-cancel',{stage:t.stage,cancelPid:entered.pid,finish:waiting});assert.equal(finish.settled,false)
   await g.release();const cancelled=await completed(cancel),late=await completed(finish)
   assert.equal(cancelled.status,200);assert.deepEqual(cancelled.body,{outcome:'TERMINAL_UNCOMMITTED',reason:'CANCELLED'});assert.equal(late.status,410,JSON.stringify(late));assert.equal(late.body.code,'PT410')
   assert.equal((await h.ledger(t)).length,0);assert.equal((await h.current(t)).revision,0);assert.deepEqual(await inventory(h,t),before,'cancel keeps held/present unchanged; no reclaim')
   await immutable(s);const read=await h.rpc('large_v2_intent_read',{identity:s.row.identity,target_user_id:t.ids.userId});assert.deepEqual(read.body,cancelled.body)
   terminal(await h.invoke(t));const begin=await h.rpc('large_v2_attempt_begin',{identity:s.row.identity,target_user_id:t.ids.userId});assert.deepEqual(begin.body,cancelled.body)
   pass(active,{headWaitObserved:true,lateSqlstate:late.body.code,persistentReason:'CANCELLED',businessCommit:false,capacityHeld:true})
  }finally{await g.release();if(finish)await finish.promise;if(cancel)await cancel.promise;await g.cleanup()}
 }
 active=labels[3]
 let sixteen
 {
  const t=await h.make('api'),s=await stage(t,{path:'large_v2_documents_append',before:false}),before=await inventory(h,t)
  const repeated=s.calls.find(c=>c.path.endsWith('large_v2_documents_append'));assert(repeated)
  const replay=await h.rpc('large_v2_documents_append',repeated.input);assert.equal(replay.status,200,JSON.stringify(replay));assert.deepEqual(await inventory(h,t),before,'same fragment cannot charge twice')
  const mutated=structuredClone(repeated.input),raw=Buffer.from(mutated.part.base64,'base64');raw[0]^=1;mutated.part.base64=raw.toString('base64')
  const denied=await h.rpc('large_v2_documents_append',mutated);assert(denied.status>=400);assert.deepEqual(await inventory(h,t),before,'changed repeat must not leak a charge')
  const done=await h.invoke(t);success(done,'COMMITTED');await originalCommit(s);const after=await inventory(h,t);originalResource(after.reservation,before.reservation)
  assert.equal(after.reservation.reserved,'16777216');assert.equal(after.reservation.present,after.reservation.occupied);sixteen={t,s,after}
  pass(active,{sameFragmentUncharged:true,changedFragmentRollback:true,exactOriginalRepresentations:true,globalAndOwnerSums:true,controlMetadataAndWalExcluded:true})
  pass(labels[5],{reservedBytes:16777216,occupied:after.reservation.occupied,present:after.reservation.present,originalExpiry:after.reservation.expires_at,noExpansion:true})
 }
 active=labels[4]
 {
  const t=await h.make('api',{reservedBytes:8388608}),s=await stage(t),before=await inventory(h,t)
  const size=await h.scalar("select octet_length(req::text)::bigint needed,octet_length((req#>'{receiptContext,projectionDelta}')::text)::bigint result_lower_bound from (select pjsdas_rows_internal.large_documents_request($1,$2) req) q",[t.stage,t.ids.userId])
  const oldBinding=Number((await h.scalar("select present from ta_resource_reservations.allocation where stage_id=$1 and allocation_id='stage-binding'",[t.stage])).present)
  const attemptedPeak=Number(before.reservation.occupied)+Number(size.needed),finalLowerBound=attemptedPeak-oldBinding+Number(size.result_lower_bound)
  assert(attemptedPeak>8388608);assert(finalLowerBound>8388608)
  const result=await h.rpc('large_v2_documents_finish',s.finish);assert.equal(result.status,200,JSON.stringify(result));assert.deepEqual(result.body,{outcome:'TERMINAL_UNCOMMITTED',reason:'RESOURCE_EXHAUSTED'})
  const after=await inventory(h,t);assert.deepEqual(after,before,'PT507 subtransaction rolls back partial charge/write before durable terminal; no reclaim')
  await immutable(s);assert.equal((await h.ledger(t)).length,0);assert.equal((await h.current(t)).revision,0)
  terminal(await h.invoke(t));const repeated=await h.rpc('large_v2_intent_read',{identity:s.row.identity,target_user_id:t.ids.userId});assert.deepEqual(repeated.body,result.body)
  const functionBody=await h.scalar("select prosrc from pg_proc where oid='public.pjsdas_rows_v1_large_v2_documents_finish(uuid,uuid,text,jsonb)'::regprocedure");assert(functionBody.prosrc.includes("exception when sqlstate 'PT507'"))
  pass(active,{reservedBytes:8388608,attemptedPrechargePeak:attemptedPeak,finalLogicalLowerBound:finalLowerBound,terminalReason:'RESOURCE_EXHAUSTED',wireSqlstate:null,pt507BranchEstablishedByFrozenHandlerAndActualCapacityViolation:true,heldNotReleased:true,occupied:after.reservation.occupied,present:after.reservation.present,physicalStorageOrWalClaim:false})
 }
 active=labels[6]
 {
  let freshAdmissions=0
  while(true){const pool=await h.scalar('select held,global_limit from ta_resource_reservations.pool');if(Number(pool.global_limit)-Number(pool.held)<16777216)break;assert(freshAdmissions++<16);await stage(await h.make('api'),{path:'large_v2_intent_admit',before:false})}
  const before=await h.scalar('select * from ta_resource_reservations.pool'),t=await h.make('api'),at=h.calls.length
  const result=await h.invoke(t);interrupted(result);assert.equal(await h.intent(t),undefined);assert.equal((await h.ledger(t)).length,0)
  const refusal=h.calls.slice(at).find(c=>c.path.endsWith('large_v2_intent_admit'));assert.equal(refusal.status,503);assert.equal(refusal.output.code,'PT503')
  assert.equal(Number((await h.scalar('select count(*) n from pjsdas_rows_candidate.large_command_attempt where stage_id=$1',[t.stage])).n),0)
  assert.deepEqual(await h.scalar('select * from ta_resource_reservations.pool'),before)
  const originalPositive=await inventory(h,sixteen.t);assert.equal(originalPositive.reservation.reserved,'16777216')
  pass(active,{freshAdmissions,refusalSqlstate:'PT503',admittedIntent:false,terminalTombstone:false,originalGlobalLimit:Number(before.global_limit),held:Number(before.held),noPoolExpansionOrReclaim:true})
 }
 assert.equal(report.cases.length,7);assert(report.cases.every(c=>c.status==='PASS'),'Missing native case');report.status='PASS_NATIVE_BARRIERS';report.finishedAt=new Date().toISOString();save()
}catch(error){report.status='FAIL';report.error=safeError(error);const c=report.cases.find(c=>c.label===active);if(c&&c.status==='NOT_RUN')Object.assign(c,{status:'FAIL',error:safeError(error)});save();process.exitCode=1}
finally{
 const errors=[];try{if(h)await h.close()}catch(error){errors.push(error)}try{verifySource()}catch(error){errors.push(error)}
 if(errors.length){report.status='FAIL_CLEANUP_OR_SOURCE';report.cleanupErrors=errors.map(safeError)}try{save()}catch(error){errors.push(error)}if(errors.length)process.exitCode=1
}
