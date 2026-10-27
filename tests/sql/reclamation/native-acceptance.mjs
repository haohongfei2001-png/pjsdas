/** Synthetic actual API/scoped public-only acceptance. NOT production policy. */
import assert from 'node:assert/strict'
import {isDeepStrictEqual} from 'node:util'
import {writeFileSync,readFileSync,symlinkSync,unlinkSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {setTimeout as sleep} from 'node:timers/promises'
import {fixture} from './native-fixture.mjs'
import {resolveReclamationHistoricalSource,verifyReclamationHistoricalSource} from './historical-source.mjs'
import {controlMath} from './control-math.mjs'
import {finishReclamationRun} from './finish-run.mjs'
import {verifySource,lock,sha,sourceImport,source} from './source.mjs'
const evidence=process.env.TA_V2_EVIDENCE;assert(evidence);verifySource()
const group=process.env.TA_RECLAIM_GROUP??'basic';assert(['basic','terminal','faults','locks','compat','historical','control'].includes(group))
const compatibilityVersion=process.env.TA_RECLAIM_COMPAT_VERSION;assert(!compatibilityVersion||['v1','v2'].includes(compatibilityVersion))
const report={group,compatibilityVersion:compatibilityVersion??'both',source:lock.commit,status:'RUNNING',logicalOnly:true,hostedReady:false,cases:[]}
const save=()=>writeFileSync(join(evidence,'result.json'),JSON.stringify(report,null,2)+'\n')
const pass=(label,detail={})=>{report.cases.push({label,status:'PASS',...detail});save();h?.checkpoint(label);console.log('PASS_RECLAMATION',label,JSON.stringify(detail))}
const same=(a,b,label='exact deep equality')=>assert(isDeepStrictEqual(a,b),label+' '+JSON.stringify({actual:{type:typeof a,hash:a===undefined?null:sha(a),keys:a&&typeof a==='object'?Object.keys(a).slice(0,30):[]},expected:{type:typeof b,hash:b===undefined?null:sha(b),keys:b&&typeof b==='object'?Object.keys(b).slice(0,30):[]}}))
const apiOriginalReceipt=(r,audit)=>{const {projectionDelta,...receipt}=audit.receipt;same(r.result.body.receipt,receipt,'original API projected receipt');same(r.result.body.delta,projectionDelta,'original API projection delta')}
const shape=r=>r.result.body??r.result.structuredContent
const brief=r=>JSON.stringify({status:r.result.status,isError:r.result.isError,code:shape(r).code,outcome:shape(r).outcome})
const ok=(r,outcome)=>{if(r.result.status!==undefined)assert.equal(r.result.status,200,brief(r));else assert.equal(r.result.isError,undefined,brief(r));if(outcome)assert.equal(shape(r).outcome,outcome)}
const interrupted=r=>{assert.equal(shape(r).code,'WORKSPACE_UNAVAILABLE',brief(r));if(r.result.status!==undefined)assert.equal(r.result.status,503);else assert.equal(r.result.isError,true)}
const modeEnv=mode=>mode==='legacy-inline-v1'?{PJSDAS_WORKSPACE_ROWS_AUDIT_BYTES:'0',PJSDAS_WORKSPACE_ROWS_AUDIT_PAGES:'0',PJSDAS_WORKSPACE_ROWS_RELEASE_PROFILE:undefined}:{PJSDAS_WORKSPACE_ROWS_AUDIT_BYTES:'1',PJSDAS_WORKSPACE_ROWS_AUDIT_PAGES:mode==='pages-v1'?'1':'0',PJSDAS_WORKSPACE_ROWS_RELEASE_PROFILE:mode==='pages-v1'?'compatible-pages-v1':'compatible-fragments-v1'}
let h,primaryError,active='setup',gateId=1
const flight=promise=>{const f={settled:false};f.done=promise.then(value=>{f.value=value;f.settled=true;return value},error=>{f.error=error;f.settled=true});return f}

const resource=async t=>h.scalar('select * from ta_resource_reservations.reservation where stage_id=$1',[t.stage])
const held=async()=>h.scalar('select held,occupied,present,rpc_peak_occupied from ta_resource_reservations.pool')
// Independently expand ACTUAL surviving rows and ACTUAL resource controls. No
// production mapper call, prospective retirement fields or masked removed flags.
async function inventory(t,kind='COMMITTED'){
 const i=await h.intent(t),r=await resource(t);assert.equal(i.encoded,null);assert.equal(r.phase,'reclaimed')
 assert.equal(i.retirement.kind,kind);assert.equal(BigInt(r.current_held)+BigInt(r.released_bytes),BigInt(r.reserved))
 const row=await h.scalar(`select convert_to(jsonb_build_object(
 'intent',to_jsonb(i),'stage',(select to_jsonb(s) from pjsdas_rows_candidate.large_stage s where s.id=i.stage_id),
 'documentReservation',(select to_jsonb(d) from pjsdas_rows_candidate.large_document_reservation d where d.stage_id=i.stage_id),
 'attempt',(select to_jsonb(a) from pjsdas_rows_candidate.large_command_attempt a where a.stage_id=i.stage_id),
 'resourceReservation',to_jsonb(r),
 'controlAllocation',(select to_jsonb(a) from ta_resource_reservations.allocation a where a.stage_id=r.stage_id and allocation_id='retained-control'),
 'controlChunk',(select to_jsonb(c)||jsonb_build_object('sha256',repeat('0',64)) from ta_resource_reservations.chunk c where c.stage_id=r.stage_id and allocation_id='retained-control' and byte_offset=0),
 'allocationTombstones',(select coalesce(jsonb_agg(to_jsonb(a) order by a.allocation_id),'[]'::jsonb) from ta_resource_reservations.allocation a where a.stage_id=r.stage_id and a.allocation_id<>'retained-control'),
 'chunkTombstones',(select coalesce(jsonb_agg(to_jsonb(c) order by c.allocation_id,c.byte_offset),'[]'::jsonb) from ta_resource_reservations.chunk c where c.stage_id=r.stage_id and c.allocation_id<>'retained-control')
 )::text,'UTF8') raw from pjsdas_rows_candidate.large_command_intent i join ta_resource_reservations.reservation r on r.stage_id=i.stage_id::text where i.stage_id=$1`,[t.stage])
 const c=await h.scalar("select * from ta_resource_reservations.chunk where stage_id=$1 and allocation_id='retained-control'",[t.stage]);assert.equal(c.sha256,sha(row.raw));assert.equal(BigInt(c.bytes),BigInt(row.raw.length))
 for(const k of ['current_held','occupied','present','retained_control_bytes'])assert.equal(BigInt(r[k]),BigInt(row.raw.length),k)
 assert(BigInt(r.rpc_peak_occupied)>BigInt(r.current_held));assert(BigInt(r.rpc_peak_occupied)<=BigInt(r.reserved))
 assert.equal((await h.scalar(`select (select count(*) from pjsdas_rows_candidate.large_document_bundle where stage_id=$1)+(select count(*) from pjsdas_rows_candidate.large_document_fragment where stage_id=$1)+(select count(*) from pjsdas_rows_candidate.large_effect where stage_id=$1) n`,[t.stage])).n,'0')
 const stage=await h.scalar('select request,result from pjsdas_rows_candidate.large_stage where id=$1',[t.stage]);if(stage){assert.equal(stage.request,null);assert.equal(stage.result,null)}
 const totals=await h.scalar('select sum(current_held)::text held,sum(occupied)::text occupied,sum(present)::text present from ta_resource_reservations.reservation'),p=await held()
 for(const k of ['held','occupied','present'])assert.equal(p[k],totals[k])
 const owners=(await h.db.query('select o.user_id,o.held,o.occupied,o.present,sum(r.current_held)::text actual_held,sum(r.occupied)::text actual_occupied,sum(r.present)::text actual_present from ta_resource_reservations.owner o join ta_resource_reservations.reservation r using(user_id) group by o.user_id')).rows
 for(const o of owners)for(const k of ['held','occupied','present'])assert.equal(o[k],o['actual_'+k])
 return{R:r.reserved,H:r.current_held,L:r.released_bytes,C:r.retained_control_bytes,peak:r.rpc_peak_occupied,controlSha256:c.sha256}
}
async function pause(t,env={}){
 h.setDrop({match:p=>p.endsWith('large_v2_intent_admit')||p.endsWith('large_intent_admit')});const r=await h.invoke(t,env);interrupted(r);h.assertNoDrop();await h.drain()
 const row=await h.intent(t);assert(row?.encoded);t.identity=row.identity;return{row,prepared:h.decoded(row),reservation:await h.reservation(t)}
}
async function preserve(t,saved){
 const audit=(await h.ledger(t)).find(x=>x.command_id===t.commandId);assert(audit);assert.equal(audit.receipt.contractVersion,5)
 same((await h.current(t)).snapshot,saved.prepared.input.snapshot)
 for(const[k,v]of Object.entries(saved.prepared.input.receiptContext??{}))same(audit.receipt[k],v,k)
 same(audit.compensation,saved.prepared.input.compensation??null);same(await h.reservation(t),saved.reservation)
 const i=await h.intent(t);same(i.identity,saved.row.identity);same(i.binding,saved.row.binding)
 if(i.retirement)assert.equal(i.retirement.encodedSha256,sha((await h.scalar('select $1::jsonb::text text',[saved.row.encoded])).text))
 else same(i.encoded,saved.row.encoded)
 return audit
}
save()
try{
 h=await fixture(evidence)
 assert.equal((await h.scalar('select reclamation_enabled from ta_resource_reservations.pool')).reclamation_enabled,false)
 await h.db.query('update ta_resource_reservations.pool set reclamation_enabled=true')
 if(group==='basic'){
 // Distinct smaller SYNTHETIC ceiling, fixed before admission. It proves that
 // R+C fits while 2R does not, and accumulated C still eventually denies R.
 await h.db.query('update ta_resource_reservations.pool set owner_limit=16809984')
 for(const family of ['api','scoped']){
  active='turnover-'+family;const t=await h.make(family),saved=await pause(t),result=await h.invoke(t);ok(result,'COMMITTED')
  const audit=await preserve(t,saved),first=await inventory(t),pool=await held()
  const replay=await h.invoke(t);ok(replay,'ALREADY_APPLIED');same(await held(),pool);same((await h.ledger(t)).find(x=>x.command_id===t.commandId),audit)
  const oldRead=await h.rpc('large_intent_read',{identity:t.identity,target_user_id:t.ids.userId});assert.equal(oldRead.status,200,JSON.stringify(oldRead));assert.equal(oldRead.body.outcome,'ALREADY_APPLIED');same(await held(),pool)
  const finish=await h.rpc('large_v2_documents_finish',{stage_id:t.stage,target_user_id:t.ids.userId,manifest_sha256:saved.row.binding.manifestSha256,attempt:{id:randomUUID(),generation:999,deadlineAt:1}})
  assert.equal(finish.status,200,JSON.stringify(finish));same(finish.body.receipt,audit.receipt);same(await held(),pool)
  const undoId='reclaim-undo-'+randomUUID(),u={...t,commandId:undoId,undo:true,input:family==='api'?{action:'undo',projection:'delta-v1',commandId:undoId,targetCommandId:t.commandId}:{commandId:undoId,targetCommandId:t.commandId,expectedCompensationFingerprint:audit.receipt.result.compensationFingerprint}}
  u.stage=await h.reserve(t.ids,undoId,family==='api'?'first_party_abandon':'opportunity_v3')
  const us=await pause(u),ur=await h.invoke(u);ok(ur,'COMMITTED');await preserve(u,us);const second=await inventory(u);same((await h.ledger(t))[0],audit)
  const thirdId='reclaim-third-'+randomUUID(),third={...t,commandId:thirdId,input:family==='api'?{...t.input,commandId:thirdId,baseRevision:2,command:{type:'domain',value:{...t.input.command.value,commandId:thirdId}}}:{...t.input,commandId:thirdId,baseRevision:2}}
  third.stage=await h.reserve(t.ids,thirdId,family==='api'?'first_party_abandon':'opportunity_v3');const beforeThird=await held();interrupted(await h.invoke(third));assert.equal(await resource(third),undefined);same(await held(),beforeThird)
  pass(active,{first,second,syntheticOwnerLimit:16809984,residualAccumulationRefusedThird:true,originalReceiptSha256:sha(audit.receipt),originalCompensationSha256:sha(audit.compensation),secondCommandSameOwner:true})
 }
 }
 if(group==='terminal')await terminalCases()
 if(group==='faults')await faultCases()
 if(group==='locks')await lockCases()
 if(group==='compat')await compatibilityCases()
 if(group==='historical')await historicalCases()
 if(group==='control'){active='complete-control-math';const t=await h.make('api'),s=await pause(t);ok(await h.invoke(t),'COMMITTED');await preserve(t,s);await controlMath(h,t,s,inventory,pass)}
}catch(error){primaryError=error;report.failedAt=active;report.error=String(error.stack??error)}
await finishReclamationRun({report,primaryError,close:async()=>{if(h)await h.close()},verifySource,save})

async function until(at){while(Date.now()<at)await sleep(Math.min(200,at-Date.now()))}
async function staged(t){
 const start=h.calls.length;h.setDrop({before:true,match:p=>p.endsWith('large_v2_documents_finish')});interrupted(await h.invoke(t));h.assertNoDrop();await h.drain()
 const row=await h.intent(t),call=h.calls.slice(start).find(c=>c.path.endsWith('large_v2_documents_finish'));assert(row?.encoded);assert(call?.input);t.identity=row.identity
 return{row,prepared:h.decoded(row),reservation:await h.reservation(t),finish:call.input}
}
async function terminalCases(){
 active='live-read-cancel-retire-late-writer';{
 const t=await h.make('api'),saved=await pause(t),begin=await h.rpc('large_v2_attempt_begin',{identity:t.identity,target_user_id:t.ids.userId});assert.equal(begin.status,200)
 const cancel=await h.rpc('large_v2_intent_cancel',{identity:t.identity,target_user_id:t.ids.userId});assert.equal(cancel.status,200);assert.equal(cancel.body.reason,'CANCELLED')
 const C=await inventory(t,'TERMINAL_UNCOMMITTED'),before=await held();assert.equal((await h.ledger(t)).length,0)
 const late=await h.rpc('large_v2_append',{stage_id:t.stage,target_user_id:t.ids.userId,parts:[],attempt:begin.body.attempt});assert([409,410].includes(late.status),JSON.stringify(late))
 const again=await h.rpc('large_v2_intent_cancel',{identity:t.identity,target_user_id:t.ids.userId});same(again,cancel);same(await held(),before)
 assert.equal((await h.rpc('large_intent_read',{identity:t.identity,target_user_id:t.ids.userId})).body.outcome,'TERMINAL_UNCOMMITTED')
 assert.equal(saved.row.encoded.sha256,saved.prepared.sha256??saved.row.encoded.sha256);pass(active,{...C,lateSqlstate:late.body.code})
 }
 active='attempt-expiry-alone-keeps-intent';{
 const t=await h.make('api'),saved=await pause(t),begun=await h.rpc('large_v2_attempt_begin',{identity:t.identity,target_user_id:t.ids.userId});assert(begun.body.attempt)
 await until(begun.body.attempt.deadlineAt+25);const before=await resource(t),read=await h.rpc('large_v2_intent_read',{identity:t.identity,target_user_id:t.ids.userId});assert.equal(read.status,200);assert(read.body.encoded)
 same(await h.intent(t),saved.row);same(await resource(t),before);assert.equal(before.current_held,before.reserved);pass(active,{expiredAttempt:begun.body.attempt,stillAdmitted:true})
 }
 active='unknown-outcome-keeps-original-full-charge';{
 const t=await h.make('api'),saved=await pause(t)
 // Owned fixture fault: no authoritative ledger and no legal terminal evidence.
 await h.db.query("update ta_resource_reservations.reservation set phase='unknown',finalize_attempt='synthetic-lost-dispatch' where stage_id=$1",[t.stage])
 const before=await snapshot(t),result=await h.scalar('select ta_resource_reservations.rpc_reclaim_original($1,$2) outcome',[t.stage,t.ids.userId])
 assert.equal(result.outcome,'unresolved');same(await snapshot(t),before);same((await h.intent(t)).encoded,saved.row.encoded)
 assert.equal((await resource(t)).current_held,(await resource(t)).reserved);pass(active,{syntheticUnknownFaultOnly:true,noOutcomeNoRelease:true})
 }
 active='changed-epoch-terminal-fences-old-writer-and-readmission';{
 const t=await h.make('api'),saved=await pause(t),begun=await h.rpc('large_v2_attempt_begin',{identity:t.identity,target_user_id:t.ids.userId}),epoch=randomUUID()
 assert.equal(begun.status,200,JSON.stringify(begun));assert.match(begun.body.attempt.id,/^[a-f0-9-]{36}$/);assert(begun.body.attempt.generation>=1);assert(begun.body.attempt.deadlineAt>Date.now())
 // There is no production epoch-rotation endpoint in this candidate. This is
 // an owned-fixture generation transition only, not an old-writer capability.
 // Restore the retained-blob guard BEFORE every tested public RPC.
 await h.db.query('begin');try{await h.db.query('alter table public.pjsdas_workspaces disable trigger pjsdas_candidate_retained_blob_guard');await h.db.query('update pjsdas_rows_candidate.head set epoch=$2 where id=$1',[t.ids.workspaceId,epoch]);await h.db.query('update public.pjsdas_workspaces set row_candidate_epoch=$2 where id=$1',[t.ids.workspaceId,epoch]);await h.db.query('alter table public.pjsdas_workspaces enable trigger pjsdas_candidate_retained_blob_guard');await h.db.query('commit')}catch(error){await h.db.query('rollback');throw error}
 assert.equal((await h.scalar("select tgenabled from pg_trigger where tgrelid='public.pjsdas_workspaces'::regclass and tgname='pjsdas_candidate_retained_blob_guard'")).tgenabled,'O')
 const terminal=await h.rpc('large_v2_intent_read',{identity:t.identity,target_user_id:t.ids.userId});assert.equal(terminal.status,200,JSON.stringify(terminal));assert.equal(terminal.body.reason,'BASE_CHANGED')
 const C=await inventory(t,'TERMINAL_UNCOMMITTED'),before=await snapshot(t)
 const late=await h.rpc('large_v2_append',{stage_id:t.stage,target_user_id:t.ids.userId,parts:[],attempt:begun.body.attempt});assert([409,410].includes(late.status),JSON.stringify(late))
 const readmit=await h.rpc('large_intent_admit',{identity:t.identity,binding:{...saved.row.binding,expectedEpoch:epoch},encoded:saved.row.encoded,deadline_at:Date.now()+10000,target_user_id:t.ids.userId})
 assert.equal(readmit.status,200,JSON.stringify(readmit));assert.equal(readmit.body.reason,'BASE_CHANGED');same(await snapshot(t),before);assert.equal((await h.ledger(t)).length,0)
 pass(active,{...C,oldWriterSqlstate:late.body.code,newEpochCannotReadmit:true,syntheticOwnerEpochTransition:true})
 }
 active='true-reservation-expiry-fenced-terminal';{
 const t=await h.make('api',{lifetimeMs:6000}),saved=await pause(t);await until(new Date(saved.reservation.expires_at).getTime()+25)
 const read=await h.rpc('large_v2_intent_read',{identity:t.identity,target_user_id:t.ids.userId});assert.equal(read.status,200,JSON.stringify(read));assert.equal(read.body.reason,'RESOURCE_EXPIRED_OR_INVALID')
 pass(active,await inventory(t,'TERMINAL_UNCOMMITTED'))
 }
 active='original-eight-mib-peak-still-refused';{
 const t=await h.make('api');await h.db.query('update pjsdas_rows_candidate.large_document_reservation set reserved_bytes=8388608 where stage_id=$1',[t.stage]);const result=await h.invoke(t)
 assert.equal(shape(result).code,'WORKSPACE_RECOVERY_TERMINAL',JSON.stringify(result.result));assert.equal((await h.ledger(t)).length,0);const r=await resource(t);assert.equal(r.reserved,'8388608');assert(BigInt(r.rpc_peak_occupied)<=8388608n)
 pass(active,{...(await inventory(t,'TERMINAL_UNCOMMITTED')),businessCommitted:false,peakNotRescuedByEarlyRelease:true})
 }
 active='resource-off-original-identity-fence';{
 const t=await h.make('api',{resource:false}),saved=await pause(t);const x=saved.prepared.input,b=saved.prepared.before
 const {diffWorkspaceRows}=await sourceImport('gateway/workspaceRowsCodec.ts'),{prepareStagedRequestDocuments}=await sourceImport('gateway/workspaceRowsStagedDocumentsPrototype.ts')
 const req={...diffWorkspaceRows(b.snapshot,b.snapshot),commandId:x.commandId,payloadHash:x.payloadHash,operation:x.operation,principal:x.principalKind,workspaceId:b.workspaceId,userId:b.userId,expectedEpoch:b.rowEpoch,expectedRevision:b.revision,schemaVersion:b.snapshot.version,compensation:null,provenance:x.provenance??{},receiptContext:{},effectiveTime:x.effectiveTime??null}
 const cancel=await h.rpc('large_v2_intent_cancel',{identity:t.identity,target_user_id:t.ids.userId});assert.equal(cancel.body.reason,'CANCELLED')
 const small=await h.rpc('commit_authoritative',{req});assert.equal(small.status,409)
 const {changes,...meta}=req,{preparedSha256,manifestSha256,...binding}=saved.row.binding,alternate=randomUUID(),docs=prepareStagedRequestDocuments(meta,{...binding,stageId:alternate},{protocol:'workspace-effect-chain-v1',count:0,sha256:sha('')})
 const alias=await h.rpc('large_documents_begin',{manifest_wire:docs.manifestWire,manifest_sha256:docs.manifest.sha256,target_user_id:t.ids.userId});assert.equal(alias.status,409)
 assert.equal(await resource(t),undefined);assert.equal((await h.ledger(t)).length,0);assert((await h.intent(t)).encoded);pass(active,{smallSqlstate:small.body.code,aliasSqlstate:alias.body.code,resourceDisabled:true,noUnaccountedDeletion:true})
 }
}
async function complete(f){await f.done;if(f.error)throw f.error;return f.value}
async function poll(label,fn,limit=4000){const start=performance.now();while(performance.now()-start<limit){const value=await fn();if(value)return value;await sleep(20)}throw Error('Actual lock observation absent: '+label)}
async function gate(t,cut){
 const id=gateId++,name='ta_reclaim_cut_'+id,ns=743726,controller=await h.observer(name)
 const map={
  ledger:['pjsdas_rows_candidate.ledger','after insert',`new.command_id='${t.commandId}'`],
  terminal:['pjsdas_rows_candidate.large_command_attempt','before insert or update',`new.stage_id='${t.stage}'::uuid and new.terminal_reason='CANCELLED'`],
  tombstone:['pjsdas_rows_candidate.large_command_intent','after update',`new.stage_id='${t.stage}'::uuid and new.retirement is not null`],
  fragments:['pjsdas_rows_candidate.large_document_fragment','after delete',`old.stage_id='${t.stage}'::uuid`],
  effects:['pjsdas_rows_candidate.large_effect','after delete',`old.stage_id='${t.stage}'::uuid`],
  bundle:['pjsdas_rows_candidate.large_document_bundle','after delete',`old.stage_id='${t.stage}'::uuid`],
  clear:['pjsdas_rows_candidate.large_stage','after update',`new.id='${t.stage}'::uuid and new.request is null`],
  counters:['ta_resource_reservations.allocation','after update',`new.stage_id='${t.stage}' and new.removed and not old.removed`],
  release:['ta_resource_reservations.reservation','after update',`new.stage_id='${t.stage}' and new.phase='reclaimed'`],
  commit:['ta_resource_reservations.reservation','after update',`new.stage_id='${t.stage}' and new.phase='reclaimed'`],
 }
 const [table,event,condition]=map[cut];await controller.query('select pg_advisory_lock($1,$2)',[ns,id])
 await h.db.query(`create function public.${name}() returns trigger language plpgsql as $$begin if ${condition} then perform pg_advisory_xact_lock(${ns},${id});end if;if tg_op='DELETE' then return old;end if;return new;end$$;create ${cut==='commit'?'constraint ':''}trigger ${name} ${event} on ${table} ${cut==='commit'?'deferrable initially deferred ':''}for each row execute function public.${name}()`)
 let released=false
 const release=async()=>{if(!released){assert.equal((await controller.query('select pg_advisory_unlock($1,$2) ok',[ns,id])).rows[0].ok,true);released=true}}
 const entered=()=>poll(cut,async()=>{await h.db.query('select pg_stat_clear_snapshot()');return(await h.db.query(`select l.pid,a.datname,a.query,a.wait_event_type,pg_blocking_pids(l.pid) blockers from pg_locks l join pg_stat_activity a on a.pid=l.pid where l.locktype='advisory' and l.classid=$1::oid and l.objid=$2::oid and not l.granted and a.datname=current_database()`,[ns,id])).rows.find(r=>r.blockers.includes(controller.processID))})
 return{entered,release,controller,cleanup:async()=>{await release();await h.db.query(`drop trigger if exists ${name} on ${table};drop function if exists public.${name}()`)} }
}
async function blocked(name,blocker){return poll(name,async()=>{await h.db.query('select pg_stat_clear_snapshot()');return(await h.db.query("select pid,query,wait_event_type,pg_blocking_pids(pid) blockers from pg_stat_activity where datname=current_database() and state='active' and query like $1",['%pjsdas_rows_v1_'+name+'%'])).rows.find(r=>r.wait_event_type==='Lock'&&r.blockers.includes(blocker))})}
async function snapshot(t){
 const result={};for(const[table,key]of[['pjsdas_rows_candidate.large_command_intent','stage_id'],['pjsdas_rows_candidate.large_command_attempt','stage_id'],['pjsdas_rows_candidate.large_stage','id'],['pjsdas_rows_candidate.large_document_bundle','stage_id'],['pjsdas_rows_candidate.large_document_fragment','stage_id'],['pjsdas_rows_candidate.large_effect','stage_id'],['ta_resource_reservations.reservation','stage_id'],['ta_resource_reservations.allocation','stage_id'],['ta_resource_reservations.chunk','stage_id']]){
  result[table]=await h.scalar(`select count(*)::text count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'' order by to_jsonb(x)::text),''),'UTF8')),'hex') digest from ${table} x where ${key}::text=$1`,[t.stage])
 }
 result.pool=await h.scalar('select * from ta_resource_reservations.pool');result.owner=await h.scalar('select * from ta_resource_reservations.owner where user_id=$1',[t.ids.userId]);result.business=await h.current(t);result.ledger=await h.ledger(t);return result
}
async function faultCases(){
 const completed=[]
 for(const cut of ['tombstone','fragments','effects','bundle','clear','counters','release','commit']){
  active='backend-kill-'+cut;const t=await h.make('api'),s=await staged(t),before=await snapshot(t),g=await gate(t,cut);let running
  try{
   running=flight(h.rpc('large_v2_documents_finish',s.finish));const row=await g.entered();if(cut==='commit')assert.equal(row.query,'COMMIT');else assert.match(row.query,/pjsdas_rows_v1_large_v2_documents_finish/)
   assert.equal((await h.scalar('select pg_terminate_backend($1) killed',[row.pid])).killed,true)
   await complete(running).catch(()=>{});await g.release();same(await snapshot(t),before,'business + every delete/counter/held mutation must roll back')
   completed.push({cut,pid:row.pid});pass(active,{ownedBackend:row.pid,blockers:row.blockers,rolledBackBusinessAndEveryRepresentation:true})
  }finally{await g.cleanup();if(running)await running.done}
 }
 active='committed-lost-ack-cold-replay';{
  const t=await h.make('api'),saved=await pause(t),offset=h.calls.length;h.setDrop({match:p=>p.endsWith('large_v2_documents_finish')});const lost=await h.invoke(t);if(lost.result.status===200)ok(lost,'ALREADY_APPLIED');else interrupted(lost);h.assertNoDrop();await h.drain();assert(h.calls.slice(offset).some(c=>c.path.endsWith('large_v2_documents_finish')&&c.droppedAfter&&c.status===200))
  const audit=await preserve(t,saved),C=await inventory(t),before=await held();ok(await h.invoke(t),'ALREADY_APPLIED');same(await held(),before);same((await h.ledger(t))[0],audit);pass(active,{...C,sameRequestAuthoritativeRecovery:lost.result.status===200,secondColdRequestReplayed:true})
 }
 active='inventory-corruption-refuses-new-success-release';{
  const t=await h.make('api'),s=await staged(t);await h.db.query("update ta_resource_reservations.chunk set sha256=repeat('0',64) where stage_id=$1 and allocation_id='intent-record'",[t.stage]);const before=await snapshot(t)
  const result=await h.rpc('large_v2_documents_finish',s.finish);assert.equal(result.status,409,JSON.stringify(result));same(await snapshot(t),before);assert.equal((await h.ledger(t)).length,0)
  pass(active,{sqlstate:result.body.code,allChargeRetained:true,noPartialBusinessCommit:true})
 }
 active='cleanup-consumes-original-attempt-budget';{
  const t=await h.make('api'),s=await staged(t),before=await snapshot(t),g=await gate(t,'tombstone');let running
  try{running=flight(h.rpc('large_v2_documents_finish',s.finish));const row=await g.entered();await until(s.finish.attempt.deadlineAt+25);await g.release();const result=await complete(running);assert.equal(result.status,503,JSON.stringify(result));same(await snapshot(t),before);pass(active,{originalAttempt:s.finish.attempt,ownedBackend:row.pid,sqlstate:result.body.code,noBudgetExtension:true})}
  finally{await g.cleanup();if(running)await running.done}
  ok(await h.invoke(t),'COMMITTED');await preserve(t,s);await inventory(t);pass('cleanup-timeout-original-intent-next-attempt-recovers',{singleCommit:(await h.ledger(t)).length})
 }
}
async function lockCases(){
 for(const contender of ['large_v2_intent_cancel','large_v2_intent_read']){
  active='finish-first-'+contender;const t=await h.make('api'),s=await staged(t),g=await gate(t,'ledger');let finish,other
  try{finish=flight(h.rpc('large_v2_documents_finish',s.finish));const holder=await g.entered();other=flight(h.rpc(contender,{identity:t.identity,target_user_id:t.ids.userId}));const wait=await blocked(contender,holder.pid);assert.equal(other.settled,false)
   await g.release();const result=await complete(finish);assert.equal(result.status,200,JSON.stringify(result));const observed=await complete(other);assert.equal(observed.status,200);assert.equal(observed.body.outcome,'ALREADY_APPLIED');await preserve(t,s);const C=await inventory(t);pass(active,{...C,holder:holder.pid,waiter:wait.pid,blockers:wait.blockers})
  }finally{await g.cleanup();await Promise.all([finish?.done,other?.done])}
 }
 active='cancel-first-old-finalizer-fenced';{
  const t=await h.make('api'),s=await staged(t),g=await gate(t,'terminal');let cancel,finish
  try{cancel=flight(h.rpc('large_v2_intent_cancel',{identity:t.identity,target_user_id:t.ids.userId}));const holder=await g.entered();finish=flight(h.rpc('large_v2_documents_finish',s.finish));const wait=await blocked('large_v2_documents_finish',holder.pid)
   await g.release();assert.equal((await complete(cancel)).body.reason,'CANCELLED');const rejected=await complete(finish);assert([409,410].includes(rejected.status),JSON.stringify(rejected));assert.equal((await h.ledger(t)).length,0);pass(active,{...(await inventory(t,'TERMINAL_UNCOMMITTED')),holder:holder.pid,waiter:wait.pid,sqlstate:rejected.body.code})
  }finally{await g.cleanup();await Promise.all([cancel?.done,finish?.done])}
 }
 active='grant-before-global-lock-order';{
  const t=await h.make('scoped'),s=await staged(t),grant=await h.observer('grant-first'),pool=await h.observer('pool-probe');let finish
  await grant.query('begin');await grant.query('select id from public.pjsdas_business_management_grants where id=$1 for update',[t.grantId])
  try{finish=flight(h.rpc('large_v2_documents_finish',s.finish));const wait=await blocked('large_v2_documents_finish',grant.processID)
   await pool.query('begin');await pool.query("set local lock_timeout='500ms'");await pool.query('select singleton from ta_resource_reservations.pool for update');await pool.query('rollback')
   await grant.query('rollback');assert.equal((await complete(finish)).status,200);await preserve(t,s);await inventory(t);pass(active,{grantHolder:grant.processID,finalizer:wait.pid,poolLockAvailableWhileGrantBlocked:true})
  }finally{await grant.query('rollback');await pool.query('rollback');if(finish)await finish.done}
 }
 active='global-held-finalizer-holds-original-grant';{
  const t=await h.make('scoped'),s=await staged(t),pool=await h.observer('pool-first'),revoker=await h.observer('grant-update');let finish,revoke
  await pool.query('begin');await pool.query('select singleton from ta_resource_reservations.pool for update')
  try{finish=flight(h.rpc('large_v2_documents_finish',s.finish));const blockedPool=await blocked('large_v2_documents_finish',pool.processID)
   await revoker.query('begin');revoke=flight(revoker.query('select id from public.pjsdas_business_management_grants where id=$1 for update',[t.grantId]))
   const wait=await poll('grant update blocked behind finalizer',async()=>{await h.db.query('select pg_stat_clear_snapshot()');const x=await h.scalar('select pid,pg_blocking_pids(pid) blockers,wait_event_type from pg_stat_activity where pid=$1',[revoker.processID]);return x?.blockers.includes(blockedPool.pid)?x:null})
   await pool.query('rollback');assert.equal((await complete(finish)).status,200);await complete(revoke);await revoker.query('rollback');await inventory(t);pass(active,{poolHolder:pool.processID,finalizer:blockedPool.pid,grantWaiter:wait.pid,blockers:wait.blockers})
  }finally{await pool.query('rollback');if(revoke)await revoke.done;await revoker.query('rollback');if(finish)await finish.done}
 }
}
async function compatibilityCases(){
 for(const version of compatibilityVersion?[compatibilityVersion]:['v1','v2'])for(const mode of ['legacy-inline-v1','fragments-v1','pages-v1'])for(const family of ['api','scoped']){
  active=version+'-'+mode+'-'+family;const t=await h.make(family,{compactIds:true}),env={...modeEnv(mode),PJSDAS_WORKSPACE_ROWS_DURABLE_ATTEMPTS_V2:version==='v2'?'1':'0'},saved=await pause(t,env)
  ok(await h.invoke(t,env),'COMMITTED');const audit=await preserve(t,saved),C=await inventory(t),before=await held();ok(await h.invoke(t,env),'ALREADY_APPLIED');same(await held(),before)
  for(const route of ['large_intent_read','large_v2_intent_read']){const r=await h.rpc(route,{identity:t.identity,target_user_id:t.ids.userId});assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.body.outcome,'ALREADY_APPLIED')}
  same((await h.ledger(t))[0],audit);pass(active,C)
 }
 active='default-off-and-on-demand-existing-completion';{
  await h.db.query('update ta_resource_reservations.pool set reclamation_enabled=false');const t=await h.make('api'),s=await pause(t);ok(await h.invoke(t),'COMMITTED');const live=await h.intent(t);assert(live.encoded);assert.equal(live.retirement,null);const before=await held()
  const args={stage_id:t.stage,target_user_id:t.ids.userId,manifest_sha256:s.row.binding.manifestSha256,attempt:{id:randomUUID(),generation:999,deadlineAt:1}},replay=await h.rpc('large_v2_documents_finish',args);assert.equal(replay.status,200,JSON.stringify(replay));same(await held(),before)
  const cached=(await h.scalar('select result from pjsdas_rows_candidate.large_stage where id=$1',[t.stage])).result
  await h.db.query("update pjsdas_rows_candidate.large_stage set result=result-'outcome' where id=$1",[t.stage]);await h.db.query('update ta_resource_reservations.pool set reclamation_enabled=true')
  await assert.rejects(h.db.query('select ta_resource_reservations.rpc_reclaim_original($1,$2)',[t.stage,t.ids.userId]),e=>e.code==='PT409'&&e.message==='exact original result required for retirement')
  const corruptRead=await h.rpc('large_v2_intent_read',{identity:t.identity,target_user_id:t.ids.userId});assert.equal(corruptRead.body.outcome,'ALREADY_APPLIED');same(await held(),before);assert((await h.intent(t)).encoded)
  await h.db.query('update pjsdas_rows_candidate.large_stage set result=$2 where id=$1',[t.stage,cached]);pass('missing-outcome-rejects-cleanup-without-hiding-original')
  const read=await h.rpc('large_v2_intent_read',{identity:t.identity,target_user_id:t.ids.userId});assert.equal(read.body.outcome,'ALREADY_APPLIED');pass(active,await inventory(t))
  await h.db.query('update ta_resource_reservations.pool set inventory_verified=false');const frozen=await h.rpc('large_v2_intent_read',{identity:t.identity,target_user_id:t.ids.userId});assert.equal(frozen.status,200);assert.equal(frozen.body.outcome,'ALREADY_APPLIED');await h.db.query('update ta_resource_reservations.pool set inventory_verified=true')
  pass('frozen-inventory-does-not-hide-original-receipt')
  const stable=await held();await h.db.query("update ta_resource_reservations.allocation set kind='intent-decoded' where stage_id=$1 and allocation_id='retained-control'",[t.stage])
  await assert.rejects(h.db.query('select ta_resource_reservations.rpc_reclaim_original($1,$2)',[t.stage,t.ids.userId]),e=>e.code==='PT409'&&e.message==='retained control changed')
  assert.equal((await h.rpc('large_v2_intent_read',{identity:t.identity,target_user_id:t.ids.userId})).body.outcome,'ALREADY_APPLIED');same(await held(),stable)
  await h.db.query("update ta_resource_reservations.allocation set kind='retained-control' where stage_id=$1 and allocation_id='retained-control'",[t.stage]);await inventory(t);pass('retired-meter-corruption-rejected-no-double-release')
  const pool=await h.scalar('select * from ta_resource_reservations.pool');await h.db.query('delete from ta_resource_reservations.pool')
  try{const absent=await h.rpc('large_v2_intent_read',{identity:t.identity,target_user_id:t.ids.userId});assert.equal(absent.status,200);assert.equal(absent.body.outcome,'ALREADY_APPLIED')}
  finally{await h.db.query('insert into ta_resource_reservations.pool select * from jsonb_populate_record(null::ta_resource_reservations.pool,$1::jsonb)',[pool])}
  await inventory(t);pass('missing-policy-row-does-not-hide-original-receipt')
  const utc=await h.scalar('select ta_resource_reservations.rpc_control_bytes($1,$2) raw',[t.stage,(await h.intent(t)).retirement]);await h.db.query("set timezone='Pacific/Honolulu'")
  try{same((await h.scalar('select ta_resource_reservations.rpc_control_bytes($1,$2) raw',[t.stage,(await h.intent(t)).retirement])).raw,utc.raw)}finally{await h.db.query("set timezone='UTC'")}
  await inventory(t);pass('retained-control-hash-independent-of-session-timezone')
 }
 active='legacy-ledger-only-stays-readable-not-reclaimable';{
  await h.db.query('update ta_resource_reservations.pool set reclamation_enabled=false');const t=await h.make('api'),s=await pause(t);ok(await h.invoke(t),'COMMITTED');const audit=await preserve(t,s),before=await held()
  // Fixture-owner historical import fault only: preserve exact original receipt,
  // compensation/provenance/times in the ORIGINAL legacy ledger. Runtime code
  // never performs this DML and never deletes either authoritative ledger.
  await h.db.query(`insert into public.pjsdas_command_ledger(workspace_id,user_id,command_id,operation,payload_hash,expected_revision,principal_kind,client_id,provenance,compensation,effective_time,status,resulting_revision,receipt,created_at,updated_at)
   select workspace_id,user_id,command_id,receipt->>'operation',payload_hash,expected_revision,principal_kind,client_id,provenance,nullif(compensation,'null'::jsonb),effective_time,'COMMITTED',resulting_revision,receipt,created_at,created_at from pjsdas_rows_candidate.ledger where user_id=$1`,[t.ids.userId])
  await h.db.query('alter table pjsdas_rows_candidate.ledger disable trigger freeze_ledger')
  try{await h.db.query('delete from pjsdas_rows_candidate.ledger where user_id=$1',[t.ids.userId])}finally{await h.db.query('alter table pjsdas_rows_candidate.ledger enable trigger freeze_ledger')}
  await h.db.query('update ta_resource_reservations.pool set reclamation_enabled=true')
  for(const route of ['large_intent_read','large_v2_intent_read']){const r=await h.rpc(route,{identity:t.identity,target_user_id:t.ids.userId});assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.body.outcome,'ALREADY_APPLIED')}
  const replay=await h.invoke(t);ok(replay,'ALREADY_APPLIED');apiOriginalReceipt(replay,audit);same(await held(),before);assert((await h.intent(t)).encoded)
  pass(active,{exactOriginalLegacyReceipt:true,capacityStillFullyHeld:true,syntheticHistoricalImportOnly:true})
 }
 active='retired-scoped-replay-still-requires-original-current-grant';{
  const t=await h.make('scoped'),s=await pause(t);ok(await h.invoke(t),'COMMITTED');const before=await held(),audit=await preserve(t,s)
  await h.db.query('update public.pjsdas_business_management_grants set revoked_at=clock_timestamp() where id=$1',[t.grantId]);const denied=await h.rpc('large_v2_intent_read',{identity:t.identity,target_user_id:t.ids.userId});assert.equal(denied.status,403);same(await held(),before);same((await h.ledger(t))[0],audit);pass(active,{sqlstate:denied.body.code})
 }
}
async function historicalCases(){
 const historical=resolveReclamationHistoricalSource(),legacy=historical.root,provenance=verifyReclamationHistoricalSource(historical)
 report.historicalSource={...provenance,fixtureDependency:historical.fixtureDependency,resolverSha256:historical.resolverSha256};save()
 const bundle=join(evidence,'historical-r0p-worker.mjs'),deps=join(evidence,'node_modules')
 symlinkSync(join(source,'node_modules'),deps)
 try{
  execFileSync(join(source,'node_modules/esbuild/bin/esbuild'),[join(legacy,'tests/sql/workspace-rows-intent-cold-worker.mjs'),'--bundle','--platform=node','--packages=external','--format=esm','--outfile='+bundle],{stdio:'pipe'})
  const env={TA_RECLAIM_HISTORICAL_WORKER:bundle,PJSDAS_WORKSPACE_ROWS_DURABLE_ATTEMPTS_V2:'0',PJSDAS_WORKSPACE_ROWS_RELEASE_PROFILE:'compatible-fragments-v1',PJSDAS_WORKSPACE_ROWS_AUDIT_PAGES:'0',PJSDAS_WORKSPACE_ROWS_AUDIT_BYTES:'1'}
  for(const family of ['api','scoped']){
   active='actual-r0p-retired-receipt-'+family;const t=await h.make(family),s=await pause(t);ok(await h.invoke(t),'COMMITTED');const audit=await preserve(t,s),before=await snapshot(t)
   const old=await h.invoke(t,env);ok(old,'ALREADY_APPLIED');same(await snapshot(t),before)
   if(family==='api')apiOriginalReceipt(old,audit)
   pass(active,{sourceCommit:provenance.sourceCommit,manifestSha256:provenance.manifestSha256,bundleSha256:sha(readFileSync(bundle)),coldPid:old.process.pid,exactOriginalReceiptRetained:true})
  }
  for(const state of ['pending','terminal']){
   active='actual-r0p-'+state+'-cannot-revive';const t=await h.make('api'),s=await pause(t)
   if(state==='terminal'){const cancel=await h.rpc('large_v2_intent_cancel',{identity:t.identity,target_user_id:t.ids.userId});assert.equal(cancel.body.reason,'CANCELLED')}
   const before=await snapshot(t),offset=h.calls.length,old=await h.invoke(t,env);assert.notEqual(old.result.status,200,brief(old));same(await snapshot(t),before)
   assert(!h.calls.slice(offset).some(c=>/intent_admit$/.test(c.path)));assert.equal((await h.ledger(t)).length,0)
   pass(active,{sourceCommit:provenance.sourceCommit,coldPid:old.process.pid,code:shape(old).code,noReadmit:true,originalIntentSha256:s.row.encoded.sha256})
  }
 }finally{try{verifyReclamationHistoricalSource(historical)}finally{unlinkSync(deps)}}
}
