import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { createSnapshot } from '../../src/snapshot.ts'
import { applySemanticIntake } from '../../src/semanticIntake.ts'
import { encodeWorkspaceRows, diffWorkspaceRows } from '../../gateway/workspaceRowsCodec.ts'
const at='2030-01-01T00:00:00.000Z',now=new Date(at),wire=x=>JSON.parse(JSON.stringify(x)),equal=(a,b)=>assert(isDeepStrictEqual(a,wire(b)),'capture wire equality')
export async function testCaptureRows({db,source,origin,token}) {
 const userId=randomUUID(),legacyUser=randomUUID(),initial=createSnapshot({opportunities:[],processes:[],processEvents:[],actions:[],prep:[],applicationGroups:[],timeline:[]},at)
 let workspaceId
 for(const owner of [userId,legacyUser]) {
  await db.query('insert into auth.users(id) values($1)',[owner])
  const wid=(await db.query('insert into public.pjsdas_workspaces(user_id,snapshot,schema_version) values($1,$2,4) returning id',[owner,initial])).rows[0].id
  if(owner===userId) workspaceId=wid
  // Local synthetic policy only. No external model/provider or credits are used.
  await db.query("insert into public.pjsdas_ai_capture_policies(user_id,enabled,data_scope_approved,funding_boundary_reference,valid_until,max_request_units,free_units_limit) values($1,true,true,'synthetic-local-test',now()+interval '1 hour',1,100)",[owner])
 }
 const encoded=encodeWorkspaceRows(initial)
 await db.query('insert into pjsdas_rows_candidate.head(id,user_id,envelope,manifest,legacy_snapshot) values($1,$2,$3,$4,$5)',[workspaceId,userId,encoded.envelope,JSON.stringify(encoded.manifest),initial])
 await db.query('insert into pjsdas_rows_candidate.item select $1,$2,x.collection,x.id,x.ordinal,x.value,0 from jsonb_to_recordset($3) as x(collection text,id text,ordinal bigint,value jsonb)',[workspaceId,userId,JSON.stringify(encoded.rows)])
 const observation=id=>({contractVersion:1,inputId:'ai:'+id,statementMode:'current_intent',originalText:'Create synthetic task '+id,source:{kind:'web',sourceId:'todayaction-web',sourceRecordId:id,timezone:'UTC',observedAt:at},candidates:[{id:'ai-capture:1',kind:'manual_action',title:'Synthetic task '+id,objectConfidence:'high',eventConfidence:'high',evidenceRefs:[],sourceVersionRefs:[]}]})
 const ready=async(owner,id,revision)=>{
  const obs=observation(id)
  if(owner===userId) {
   const state=await source.read(owner);assert.equal(state.revision,revision)
   await source.admitCapture(state,{requestId:id,payloadHash:'a'.repeat(64),text:obs.originalText,timezone:'UTC',referenceTime:at,reservationUnits:1})
  } else await db.query('select * from public.pjsdas_admit_ai_capture($1,$2,$3,$4,$5,$6,$7,$8)',[owner,id,'a'.repeat(64),obs.originalText,'UTC',at,revision,1])
  await db.query('select * from public.pjsdas_finish_ai_capture($1,$2,$3,$4,$5,$6)',[owner,id,'a'.repeat(64),'READY',{status:'ready_for_review',statementMode:'current_intent',candidates:obs.candidates},obs])
  return obs
 }
 const obs=await ready(userId,'synthetic-capture-atomic',0);await ready(legacyUser,'synthetic-capture-atomic',0)
 const admissionBefore=await source.read(userId)
 await assert.rejects(source.admitCapture(admissionBefore,{requestId:'synthetic-capture-atomic',payloadHash:'a'.repeat(64),text:obs.originalText,timezone:'UTC',referenceTime:at,reservationUnits:1}))
 assert.equal(Number((await db.query('select reserved_units from public.pjsdas_ai_capture_policies where user_id=$1',[userId])).rows[0].reserved_units),1)
 const before=await source.read(userId),core=applySemanticIntake(before.snapshot,obs,{authorized:true,workspaceRevision:'txn:0',now})
 assert.equal(core.status,'APPLIED');assert.equal(core.decisionRequests?.length??0,0)
 const command={commandId:'synthetic-capture-confirm',payloadHash:'b'.repeat(64),compensation:core.compensation??{},requestId:'synthetic-capture-atomic',observation:obs}
 const legacy=async(state,after,cmd)=> (await db.query('select * from public.pjsdas_commit_ai_capture($1,$2,$3,$4,$5,$6,4,$7,null,$8,$9,null,$10,$11,$12)',[legacyUser,cmd.commandId,'ai_capture_confirm',cmd.payloadHash,state.revision,JSON.stringify(after),'first_party_web','{}',JSON.stringify(cmd.compensation),'{}',cmd.requestId,cmd.observation])).rows[0]
 const raw=async(state,after,cmd,override={})=>fetch(origin+'/rpc/commit_ai_capture',{method:'POST',signal:AbortSignal.timeout(10000),headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({req:{...diffWorkspaceRows(state.snapshot,after),workspaceId,userId,expectedEpoch:state.epoch,expectedRevision:state.revision,commandId:cmd.commandId,payloadHash:cmd.payloadHash,compensation:cmd.compensation,operation:'ai_capture_confirm',principal:'first_party_web',...override},target_capture_request_id:cmd.requestId,target_capture_observation:cmd.observation})})
 for(const patch of [{requestId:'absent'},{observation:{...obs,originalText:'Changed'}}]) {
  await assert.rejects(legacy(before,core.snapshot,{...command,...patch}),e=>e.code==='42501')
  assert.equal((await raw(before,core.snapshot,{...command,...patch})).status,403)
 }
 for(const override of [{principal:'delegated_mcp'},{clientId:randomUUID()},{managementAuthorization:{}},{userId:randomUUID()}]) assert((await raw(before,core.snapshot,command,override)).status>=400)
 // Force the last preview transition to fail after row/ledger work: both existing
 // and candidate RPCs must roll the complete transaction back, not consume it.
 await db.query("create function public.synthetic_capture_failure() returns trigger language plpgsql as $$begin if new.request_id='synthetic-capture-atomic' and new.status='COMMITTED' then raise exception 'synthetic injected terminal failure';end if;return new;end$$; create trigger synthetic_capture_failure before update on public.pjsdas_ai_capture_previews for each row execute function public.synthetic_capture_failure()")
 await assert.rejects(legacy(before,core.snapshot,command))
 await assert.rejects(source.commitCapture(before,core.snapshot,command))
 equal((await source.read(userId)).snapshot,initial)
 assert.equal((await db.query('select count(*)::int n from pjsdas_rows_candidate.ledger where workspace_id=$1',[workspaceId])).rows[0].n,0)
 assert.deepEqual((await db.query('select distinct status from public.pjsdas_ai_capture_previews where user_id=any($1::uuid[])',[[userId,legacyUser]])).rows,[{status:'READY'}])
 await db.query('drop trigger synthetic_capture_failure on public.pjsdas_ai_capture_previews;drop function public.synthetic_capture_failure()')
 const old=await legacy(before,core.snapshot,command),saved=await source.commitCapture(before,core.snapshot,command)
 assert.equal(saved.outcome,'COMMITTED');equal((await source.read(userId)).snapshot,old.snapshot)
 assert.equal((await db.query('select status from public.pjsdas_ai_capture_previews where user_id=$1 and request_id=$2',[userId,command.requestId])).rows[0].status,'COMMITTED')
 await db.query("update public.pjsdas_ai_capture_previews set expires_at=now()-interval '1 second' where user_id=any($1::uuid[])",[[userId,legacyUser]])
 equal((await source.commitCapture(before,core.snapshot,command)).receipt,saved.receipt)
 assert.equal((await legacy(before,core.snapshot,command)).outcome,'ALREADY_APPLIED')
 await assert.rejects(source.commitCapture(before,core.snapshot,{...command,commandId:'different-consumer'}))
 const expiryObs=await ready(userId,'synthetic-capture-expiry',1), expiryBefore=await source.read(userId)
 const expiryCore=applySemanticIntake(expiryBefore.snapshot,expiryObs,{authorized:true,workspaceRevision:'txn:1',now})
 const expiryCommand={...command,requestId:'synthetic-capture-expiry',commandId:'synthetic-expiry-confirm',observation:expiryObs,compensation:expiryCore.compensation??{}}
 await db.query('begin');await db.query('select id from pjsdas_rows_candidate.head where id=$1 for update',[workspaceId])
 let settled=false;const pending=source.commitCapture(expiryBefore,expiryCore.snapshot,expiryCommand).then(value=>({value}),error=>({error})).finally(()=>{settled=true})
 try {
  const until=Date.now()+5000;for(;;){await db.query('select pg_stat_clear_snapshot()');const n=(await db.query("select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and pid<>pg_backend_pid()")).rows[0].n;if(n>0)break;if(Date.now()>until)throw new Error('capture workspace lock wait not observed');await new Promise(r=>setTimeout(r,20))}
  assert(!settled);await db.query("update public.pjsdas_ai_capture_previews set expires_at=clock_timestamp()-interval '1 second' where user_id=$1 and request_id=$2",[userId,expiryCommand.requestId]);await db.query('commit')
 } finally {await db.query('rollback')}
 assert((await pending).error);equal((await source.read(userId)).snapshot,core.snapshot)
 assert.equal((await db.query('select status from public.pjsdas_ai_capture_previews where user_id=$1 and request_id=$2',[userId,expiryCommand.requestId])).rows[0].status,'READY')
 const policyBefore=Number((await db.query('select reserved_units from public.pjsdas_ai_capture_policies where user_id=$1',[userId])).rows[0].reserved_units)
 const admissionState=await source.read(userId), invalidAdmission={requestId:'synthetic-funding-denied',payloadHash:'f'.repeat(64),text:'Synthetic denied request',timezone:'UTC',referenceTime:at,reservationUnits:1}
 for(const setting of ['enabled=false','data_scope_approved=false',"valid_until=clock_timestamp()-interval '1 second'",'max_request_units=3','free_units_limit=reserved_units']) {
  await db.query('update public.pjsdas_ai_capture_policies set '+setting+' where user_id=$1',[userId])
  await assert.rejects(source.admitCapture(admissionState,invalidAdmission))
  assert.equal(Number((await db.query('select reserved_units from public.pjsdas_ai_capture_policies where user_id=$1',[userId])).rows[0].reserved_units),policyBefore)
  assert.equal((await db.query('select count(*)::int n from public.pjsdas_ai_capture_previews where user_id=$1 and request_id=$2',[userId,invalidAdmission.requestId])).rows[0].n,0)
  await db.query("update public.pjsdas_ai_capture_policies set enabled=true,data_scope_approved=true,valid_until=clock_timestamp()+interval '1 hour',max_request_units=1,free_units_limit=100 where user_id=$1",[userId])
 }
 await assert.rejects(source.admitCapture({...admissionState,epoch:randomUUID()},invalidAdmission))
 console.log('PASS row-aware capture admission preserves free-policy/data-scope/floor/cap checks, epoch fence and at-most-once reservation; no provider dispatch')
 console.log('PASS durable AI capture actual semantic core: legacy differential, preview binding/first-party authority, terminal-failure atomic rollback, consumed replay, different consumer denial and expiry after real workspace lock wait; no model call')
}
