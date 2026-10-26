/** Additive real api/workspace + real scoped runtime proof, not a mock adapter.
 * Called only by the exact-source copied baseline harness after ALL its tests. */
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import pg from 'pg'
import {applyDomainCompensation,applyUserDomainCommand} from '../../src/domainCommands.ts'
import {restoreOpportunityManagement} from '../../src/opportunityManagement.ts'
import {decodePreparedIntent} from '../../gateway/workspaceRowsDurableIntent.ts'
const wire=x=>JSON.parse(JSON.stringify(x)),hash=x=>createHash('sha256').update(x).digest('hex')
export async function runResourceRpcProof(c){
 const {db,seed,post,rpc,count,current,coldPost,cold,calls,f,incoming,scopedFixture,setDrop,pending,ownedClients}=c
 const SYNTHETIC_RESERVED=16777216,SYNTHETIC_GLOBAL=276824064
 async function reserve(ids,command,family,bytes=SYNTHETIC_RESERVED){const stage=await c.reserve(ids,command,family);await db.query('update pjsdas_rows_candidate.large_document_reservation set reserved_bytes=$2 where stage_id=$1',[stage,bytes]);return stage}
 const scalar=async(sql,args=[])=>Object.values((await db.query(sql,args)).rows[0])[0]
 const record=async stage=>(await db.query('select * from ta_resource_reservations.reservation where stage_id=$1',[stage])).rows[0]
 const enroll=async ids=>db.query('insert into ta_resource_reservations.rpc_scope values($1)',[ids.userId])
 const original=async ids=>(await db.query('select receipt,compensation from pjsdas_rows_candidate.ledger where user_id=$1 order by resulting_revision',[ids.userId])).rows
 const summary=async()=>wire((await db.query('select held,occupied,present,revision,rpc_peak_occupied from ta_resource_reservations.pool')).rows[0])
 async function exactInventory(stage){
  const r=await record(stage);assert(r);assert.equal(r.occupied,r.present);assert(BigInt(r.present)<=BigInt(r.reserved))
  const actual=(await db.query(`select allocation_id,bytes,sha256 from ta_resource_reservations.chunk c where stage_id=$1 and not exists(select 1 from ta_resource_reservations.allocation a where a.stage_id=c.stage_id and a.allocation_id=c.allocation_id and a.removed) order by allocation_id,byte_offset`,[stage])).rows
  assert.equal(actual.reduce((n,x)=>n+BigInt(x.bytes),0n),BigInt(r.present))
  const intent=(await db.query('select * from pjsdas_rows_candidate.large_command_intent where stage_id=$1',[stage])).rows[0]
  assert.deepEqual(r.binding,intent.binding);assert.equal(r.deadline_at,intent.deadline_at)
  const physical=(await db.query(`select representation,sum(n)::text bytes from (
   select 'intent-record' representation,octet_length(jsonb_build_object('identity',identity,'binding',binding,'encoded',encoded)::text)::bigint n from pjsdas_rows_candidate.large_command_intent where stage_id=$1
   union all select 'manifest-wire',octet_length(manifest_wire) from pjsdas_rows_candidate.large_document_bundle where stage_id=$1
   union all select 'manifest-jsonb',octet_length(manifest::text) from pjsdas_rows_candidate.large_document_bundle where stage_id=$1
   union all select 'document:'||document_name,octet_length(bytes) from pjsdas_rows_candidate.large_document_fragment where stage_id=$1
   union all select 'effect-wire',octet_length(wire) from pjsdas_rows_candidate.large_effect where stage_id=$1
   union all select 'effect-jsonb',octet_length(effect::text) from pjsdas_rows_candidate.large_effect where stage_id=$1
   union all select case when family like 'documents:%' then 'stage-binding' else 'reconstructed-request' end,octet_length(request::text) from pjsdas_rows_candidate.large_stage where id=$1
   union all select 'stage-result',octet_length(result::text) from pjsdas_rows_candidate.large_stage where id=$1 and result is not null
  ) x group by representation order by representation`,[stage])).rows
  const accounted=(await db.query(`select case when allocation_id like 'effect-wire:%' then 'effect-wire' when allocation_id like 'effect-jsonb:%' then 'effect-jsonb' else allocation_id end representation,sum(present)::text bytes from ta_resource_reservations.allocation where stage_id=$1 and not removed group by 1 order by 1`,[stage])).rows
  assert.deepEqual(accounted,physical,'each independent actual original-table representation matches its logical charge')
  assert.equal(physical.reduce((n,x)=>n+BigInt(x.bytes),0n),BigInt(r.present))
  assert(BigInt(r.rpc_peak_occupied)>=BigInt(r.occupied));assert(BigInt(r.rpc_peak_occupied)<=BigInt(r.reserved))
  assert.equal(await scalar('select count(*)::int from ta_resource_reservations.temporary_bytes'),0)
  console.log('RESOURCE_REPRESENTATIONS',JSON.stringify({stageId:stage,held:r.reserved,occupied:r.occupied,present:r.present,peakLogicalOccupied:r.rpc_peak_occupied,representations:physical,notPhysicalStorageOrMemory:true}))
  return r
 }
 async function apiOn(ids,label,bytes=SYNTHETIC_RESERVED){const command='resource-'+label,stage=await reserve(ids,command,undefined,bytes),input={...incoming,commandId:command,command:{type:'domain',value:{...incoming.command.value,commandId:command}}};return{ids,command,stage,input}}
 async function apiFixture(label,bytes=SYNTHETIC_RESERVED){const ids=await seed(f.before,true);await enroll(ids);return apiOn(ids,label,bytes)}
 const invoke=async t=>post(t.ids,t.input)
 async function pendingApi(label,point={path:'large_documents_append',document:'metadata'}){
  const t=await apiFixture(label);setDrop(point);const result=await invoke(t);assert.equal(result.status,503,JSON.stringify(result));assert.equal(await count(t.ids.userId),0);return t
 }
 async function assertCommitted(t,result){
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.outcome,'COMMITTED');assert.equal(await count(t.ids.userId),1)
  const r=await exactInventory(t.stage),[ledger]=await original(t.ids);assert.equal(r.phase,'committed');assert.equal(ledger.receipt.contractVersion,5)
  assert.equal(r.outcome.revision,ledger.receipt.revision);assert(ledger.receipt.projectionDelta)
  const request=(await db.query('select request from pjsdas_rows_candidate.large_stage where id=$1',[t.stage])).rows[0].request
  for(const [key,value] of Object.entries(request.receiptContext))assert.deepEqual(ledger.receipt[key],value)
  assert.deepEqual(ledger.compensation,request.compensation)
  assert.deepEqual((await current(t.ids)).snapshot,wire(applyUserDomainCommand(f.before,t.input.command.value,new Date((await current(t.ids)).snapshot.exportedAt)).snapshot))
 }
 assert.equal(await scalar('select count(*)::int from ta_resource_reservations.reservation'),0)
 assert.equal(await scalar('select count(*)::int from ta_resource_reservations.pool'),0)
 console.log('PASS_RESOURCE_RPC default-off: every original baseline assertion ran without resource admission or a seeded policy')
 // Explicit SYNTHETIC limits only. No SQL/runtime defaults. The prior reservation
 // remains 8 MiB in the retained negative case. Separate fresh admissions use
 // explicit 16 MiB prior reservations; no admitted reservation is ever enlarged.
 await db.query(`insert into ta_resource_reservations.pool(singleton,enabled,command_limit,owner_limit,global_limit,generation,inventory_verified,inventory_revision)
  values(true,true,16777216,33554432,276824064,'rpc-local-v1',true,0)`)
 Object.assign(process.env,{PJSDAS_WORKSPACE_ROWS_STAGED_DOCUMENTS:'1',PJSDAS_WORKSPACE_ROWS_DURABLE_INTENT:'1',PJSDAS_WORKSPACE_ROWS_AUDIT_BYTES:'1',PJSDAS_WORKSPACE_ROWS_AUDIT_PAGES:'1'})
 const tooSmall=await apiFixture('original-eight-mib-negative',8388608),smallResult=await invoke(tooSmall);assert.equal(smallResult.status,503,JSON.stringify(smallResult));assert.equal(await count(tooSmall.ids.userId),0);assert.equal((await current(tooSmall.ids)).revision,0)
 const smallRecord=await exactInventory(tooSmall.stage),wouldBeRequest=(await db.query("select octet_length(req::text)::bigint needed,octet_length((req#>'{receiptContext,projectionDelta}')::text)::bigint result_lower_bound from (select pjsdas_rows_internal.large_documents_request($1,$2) req) q",[tooSmall.stage,tooSmall.ids.userId])).rows[0]
 const needed=Number(wouldBeRequest.needed),oldBinding=Number(await scalar("select present from ta_resource_reservations.allocation where stage_id=$1 and allocation_id='stage-binding'",[tooSmall.stage])),attemptedPeak=Number(smallRecord.occupied)+needed,afterReplacement=attemptedPeak-oldBinding,finalLowerBound=afterReplacement+Number(wouldBeRequest.result_lower_bound)
 assert.equal(smallRecord.reserved,'8388608');assert(attemptedPeak>8388608);assert(finalLowerBound>8388608,'even final materialized representations (without replaced old binding) cannot fit the retained original reservation')
 console.log('PASS_RESOURCE_RPC_RETAINED_CAPACITY_COUNTEREXAMPLE',JSON.stringify({reservedBytes:8388608,occupiedBeforeFinalization:Number(smallRecord.occupied),committedLogicalPeak:Number(smallRecord.rpc_peak_occupied),additionalReconstructedRequestBytes:needed,replacedOldBindingBytes:oldBinding,attemptedPrechargePeak:attemptedPeak,afterReplacementLogicalBytes:afterReplacement,additionalStageResultLowerBoundBytes:Number(wouldBeRequest.result_lower_bound),finalLogicalLowerBound:finalLowerBound,actualStageResultBytes:null,actualStageResultReason:'original transaction refused before publishing receipt/result',businessCommitted:false,heldNotReleased:true,largerPolicyNotInferred:true}))
 const a=await apiFixture('api-unknown-v5'),offset=calls.length;await assertCommitted(a,await invoke(a));assert(calls.slice(offset).some(x=>x.path.endsWith('large_intent_admit')));assert(calls.slice(offset).some(x=>x.path.endsWith('large_documents_finish')))
 const before=await summary(),[ledger]=await original(a.ids),saved=await current(a.ids),replay=await invoke(a);assert.equal(replay.body.outcome,'ALREADY_APPLIED');assert.deepEqual(await summary(),before)
 const undo='resource-original-undo',undoStage=await reserve(a.ids,undo),undone=await post(a.ids,{action:'undo',projection:'delta-v1',commandId:undo,targetCommandId:a.command});assert.equal(undone.status,200,JSON.stringify(undone));assert.equal(undone.body.outcome,'COMMITTED');assert.equal((await exactInventory(undoStage)).phase,'committed')
 const restored=await current(a.ids);assert.deepEqual(restored.snapshot,wire(applyDomainCompensation(saved.snapshot,ledger.compensation,new Date(restored.snapshot.exportedAt))));assert.deepEqual((await original(a.ids))[0],ledger)
 console.log('PASS_RESOURCE_RPC actual API admission/upload/finalize and original Undo share ledger/CAS transactions; exact logical inventory + complete V5/unknown fields retained')
 const v=await scopedFixture(2050,true);await db.query('update pjsdas_rows_candidate.large_document_reservation set reserved_bytes=$2 where stage_id=$1',[v.vStage,SYNTHETIC_RESERVED]);await enroll(v.vIds);const vi={commandId:v.vf.commandId,baseRevision:0,change:v.vf.input},vs=await v.scoped.opportunity.invoke('execute_opportunity_management',vi);assert.equal(vs.isError,undefined,JSON.stringify(vs));assert.equal((await exactInventory(v.vStage)).phase,'committed')
 const vBefore=await current(v.vIds),[vl]=await original(v.vIds);assert.equal(vl.receipt.managementAuthorization.grantId,v.grantId)
 const vu='resource-original-scoped-undo',vus=await reserve(v.vIds,vu,'opportunity_v3'),vr=await v.scoped.opportunity.invoke('restore_opportunity_management',{commandId:vu,targetCommandId:v.vf.commandId,expectedCompensationFingerprint:vl.receipt.result.compensationFingerprint});assert.equal(vr.isError,undefined,JSON.stringify(vr));assert.equal((await exactInventory(vus)).phase,'committed');const vAfter=await current(v.vIds);assert.deepEqual(vAfter.snapshot,wire(restoreOpportunityManagement(vBefore.snapshot,vl.compensation,new Date(vAfter.snapshot.exportedAt))));assert.deepEqual((await original(v.vIds))[0],vl)
 console.log('PASS_RESOURCE_RPC actual scoped-v3 factory and original protected Undo preserve current grant, V5 receipt, projectionDelta, compensation and exact original-table byte inventory')
 const lost=await apiFixture('lost-finish');setDrop({path:'large_documents_finish'});const lr=await invoke(lost);assert.equal(lr.status,503);assert.equal(await count(lost.ids.userId),1);const lhold=await summary();assert.equal((await record(lost.stage)).phase,'committed');assert.equal((await invoke(lost)).body.outcome,'ALREADY_APPLIED');assert.deepEqual(await summary(),lhold)
 // Frozen startup inventory must block new bytes, NOT hide original receipts.
 await db.query('update ta_resource_reservations.pool set inventory_verified=false where singleton')
 const frozen=await invoke(lost);assert.equal(frozen.body.outcome,'ALREADY_APPLIED',JSON.stringify(frozen));assert.deepEqual(await summary(),lhold)
 await db.query('update ta_resource_reservations.pool set inventory_verified=true where singleton')
 // Simulated uncertain sidecar state: only the original ledger can resolve it.
 await db.query("update ta_resource_reservations.reservation set phase='unknown',outcome=null,finalize_attempt='fixture-unknown' where stage_id=$1",[lost.stage])
 assert.equal((await invoke(lost)).body.outcome,'ALREADY_APPLIED');assert.equal((await record(lost.stage)).phase,'committed');assert.equal((await record(lost.stage)).reserved,(await exactInventory(lost.stage)).reserved)
 console.log('PASS_RESOURCE_RPC committed-but-lost HTTP ACK keeps all held capacity; original ledger replay resolves without a second mutation or resource charge')
 const partial=await pendingApi('repeat-fragment');const pr=await exactInventory(partial.stage)
 const fragment=(await db.query('select f.*,b.manifest_sha256 from pjsdas_rows_candidate.large_document_fragment f join pjsdas_rows_candidate.large_document_bundle b using(stage_id) where f.stage_id=$1 order by f.document_name,f.byte_offset limit 1',[partial.stage])).rows[0]
 const args={part:{stageId:partial.stage,manifestSha256:fragment.manifest_sha256,document:fragment.document_name,offset:Number(fragment.byte_offset),base64:fragment.bytes.toString('base64')},target_user_id:partial.ids.userId}
 const replayFragment=await rpc('pjsdas_rows_v1_large_documents_append',args);assert.equal(replayFragment.status,200,JSON.stringify(replayFragment));assert.deepEqual(await record(partial.stage),pr)
 const changed=Buffer.from(fragment.bytes);changed[0]^=1;assert.notEqual((await rpc('pjsdas_rows_v1_large_documents_append',{...args,part:{...args.part,base64:changed.toString('base64')}})).status,200);assert.deepEqual(await record(partial.stage),pr)
 const recovered=await coldPost(partial.ids,partial.input);assert.equal(recovered.status,200,JSON.stringify(recovered));assert.equal((await exactInventory(partial.stage)).phase,'committed')
 console.log('PASS_RESOURCE_RPC exact fragment retries do not charge twice; changed bytes roll back; real cold original API resumes same admitted deadline and resource record')
 const cancel=await apiFixture('caller-cancel'),controller=new AbortController();c.setCancel(controller)
 const cr=await c.entry.fetch(new Request('https://synthetic.invalid/api/workspace',{method:'POST',signal:controller.signal,headers:{origin:c.webOrigin,authorization:'Bearer '+c.jwt({role:'authenticated',sub:cancel.ids.userId}),'content-type':'application/json'},body:JSON.stringify(cancel.input)}))
 assert.equal(cr.status,503);assert(controller.signal.aborted);assert.equal(await count(cancel.ids.userId),0);const cancelledHold=await exactInventory(cancel.stage);assert.equal(cancelledHold.phase,'open');assert.equal(cancelledHold.reserved,String(SYNTHETIC_RESERVED))
 console.log('PASS_RESOURCE_RPC original caller cancellation retains durable charge and uploaded bytes without guessing noncommit/reclaim')
 // Capacity is conservative on abandonment/expiry; no request-finally release.
 const expired=await pendingApi('expired');const heldExpired=await record(expired.stage)
 const remaining=Math.max(0,Number(heldExpired.deadline_at)-Date.now()+30);await new Promise(r=>setTimeout(r,remaining));assert.equal((await coldPost(expired.ids,expired.input)).status,503);assert.deepEqual(await record(expired.stage),heldExpired)
 console.log('PASS_RESOURCE_RPC original absolute expiry retains admitted intent, fragments and held capacity; no invented TTL or destructive reclamation')
 // Complete finalizer executes inside an explicit TEST transaction solely to
 // observe rollback atomicity. Runtime remains public PostgREST only.
 const atomic=await pendingApi('atomic-rollback',{path:'large_documents_finish',before:true}),ar=await record(atomic.stage),ai=(await db.query('select * from pjsdas_rows_candidate.large_command_intent where stage_id=$1',[atomic.stage])).rows[0]
 await db.query('begin');try{const result=await scalar('select public.pjsdas_rows_v1_large_documents_finish($1,$2,$3)',[atomic.stage,atomic.ids.userId,ai.binding.manifestSha256]);assert.equal(result.outcome,'COMMITTED');assert.equal((await record(atomic.stage)).phase,'committed');await db.query('rollback')}finally{await db.query('rollback')}
 assert.equal(await count(atomic.ids.userId),0);assert.deepEqual(await record(atomic.stage),ar);assert.equal((await current(atomic.ids)).revision,0)
 const committed=await rpc('pjsdas_rows_v1_large_documents_finish',{stage_id:atomic.stage,target_user_id:atomic.ids.userId,manifest_sha256:ai.binding.manifestSha256});assert.equal(committed.status,200,JSON.stringify(committed));assert.equal((await exactInventory(atomic.stage)).phase,'committed')
 console.log('PASS_RESOURCE_RPC original finalizer business+audit+CAS and resource transition all roll back together, then public HTTP commits exactly once')
 // Bidirectional real grant/finalizer scheduling. Both start at the actual
 // scoped factory and use only the already-authorized original public RPC.
 async function waitLock(pattern,min=1){for(let i=0;i<200;i++){await db.query('select pg_stat_clear_snapshot()');if(await scalar("select count(*)::int from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock' and query like $1",[pattern])>=min)return;await new Promise(r=>setTimeout(r,5))}assert.fail('expected observed PostgreSQL lock wait: '+pattern)}
 async function stagedScoped(){const t=await scopedFixture(2050,true);await db.query('update pjsdas_rows_candidate.large_document_reservation set reserved_bytes=$2 where stage_id=$1',[t.vStage,SYNTHETIC_RESERVED]);await enroll(t.vIds);setDrop({path:'large_documents_finish',before:true});const result=await t.scoped.opportunity.invoke('execute_opportunity_management',{commandId:t.vf.commandId,baseRevision:0,change:t.vf.input});assert.equal(result.isError,true);t.intent=(await db.query('select * from pjsdas_rows_candidate.large_command_intent where stage_id=$1',[t.vStage])).rows[0];assert(t.intent);t.finish={stage_id:t.vStage,target_user_id:t.vIds.userId,manifest_sha256:t.intent.binding.manifestSha256};return t}
 const gr=await stagedScoped(),probe=new pg.Client({connectionString:c.connectionString});ownedClients.push(probe);await probe.connect()
 await db.query('begin');await db.query('select 1 from public.pjsdas_business_management_grants where id=$1 for update',[gr.grantId]);const blocked=rpc('pjsdas_rows_v1_large_documents_finish',gr.finish);pending.push(blocked)
 try{await waitLock('%pjsdas_rows_v1_large_documents_finish%');await probe.query('begin');await probe.query('select 1 from ta_resource_reservations.pool for update nowait');await probe.query('select 1 from pjsdas_rows_candidate.head where id=$1 for update nowait',[gr.vIds.workspaceId]);await probe.query('rollback');await db.query('update public.pjsdas_business_management_grants set revoked_at=clock_timestamp() where id=$1',[gr.grantId]);await db.query('commit')}finally{await db.query('rollback');await probe.query('rollback')}
 assert.equal((await blocked).status,403);assert.equal(await count(gr.vIds.userId),0);assert.equal((await record(gr.vStage)).phase,'open')
 const fg=await stagedScoped();await probe.query('begin');await probe.query('select public.pjsdas_rows_v1_large_documents_finish($1,$2,$3)',[fg.vStage,fg.vIds.userId,fg.finish.manifest_sha256])
 const revoker=new pg.Client({connectionString:c.connectionString});ownedClients.push(revoker);await revoker.connect();let revoked=false;const revoke=revoker.query('update public.pjsdas_business_management_grants set revoked_at=clock_timestamp() where id=$1',[fg.grantId]).then(()=>{revoked=true});pending.push(revoke)
 try{await waitLock('update public.pjsdas_business_management_grants%');assert.equal(revoked,false);await probe.query('commit');await revoke}finally{await probe.query('rollback')}
 assert.equal(await count(fg.vIds.userId),1);assert.equal((await exactInventory(fg.vStage)).phase,'committed')
 console.log('PASS_RESOURCE_RPC observed grant-first wait leaves global/head free; reverse finalizer-first holds original grant through atomic resource/business COMMIT and drains revoker')
 // Existing partial inventory cannot be enrolled after the fact.
 const unowned=await seed(f.before,true),unownedCommand='resource-no-retrofit',unownedStage=await reserve(unowned,unownedCommand);setDrop({path:'large_documents_begin'});assert.equal((await post(unowned,{...incoming,commandId:unownedCommand,command:{type:'domain',value:{...incoming.command.value,commandId:unownedCommand}}})).status,503)
 await assert.rejects(()=>enroll(unowned),/inventory requires migration/);assert.equal(await record(unownedStage),undefined)
 // Exhaust same-owner capacity with third explicitly preapproved synthetic 16 MiB reservation. Denial
 // is inside original admission transaction: no durable intent and no charge.
 const denied='resource-owner-ceiling',deniedStage=await reserve(a.ids,denied),snapshot=await summary();const deniedInput={...incoming,commandId:denied,baseRevision:2,command:{type:'domain',value:{...incoming.command.value,commandId:denied}}};const refused=await post(a.ids,deniedInput);assert.notEqual(refused.status,200);assert.equal(await record(deniedStage),undefined);assert.deepEqual(await summary(),snapshot);assert.equal(await scalar('select count(*)::int from pjsdas_rows_candidate.large_command_intent where stage_id=$1',[deniedStage]),0)
 console.log('PASS_RESOURCE_RPC owner ceiling denies atomically and existing partial inventory is never retroactively treated as empty')
 // Same-owner two-command admission race, also at the real API entry.
 const ownerHeld=await pendingApi('owner-race-held',{path:'large_documents_begin',before:true}),oa=await apiOn(ownerHeld.ids,'owner-race-a'),ob=await apiOn(ownerHeld.ids,'owner-race-b')
 await db.query('begin');await db.query('select 1 from ta_resource_reservations.pool for update');const ownerRace=[invoke(oa),invoke(ob)];pending.push(...ownerRace)
 try{await waitLock('%pjsdas_rows_v1_large_intent_%',2);await db.query('commit')}finally{await db.query('rollback')}
 const ownerResults=await Promise.all(ownerRace);assert.equal(ownerResults.filter(x=>x.status===200).length,1,JSON.stringify(ownerResults));assert.equal([await record(oa.stage),await record(ob.stage)].filter(Boolean).length,1)
 assert.equal(await scalar('select held from ta_resource_reservations.owner where user_id=$1',[ownerHeld.ids.userId]),String(SYNTHETIC_RESERVED*2))
 console.log('PASS_RESOURCE_RPC actual same-owner concurrent commands compete for one remaining original reservation; observed two-session resource-lock wait and no loser admission')
 // Fill only through actual original API admissions. No hand-minted sidecar
 // reservation: final two cross-owner requests race for the last 16 MiB slot.
 let fill=0;while(BigInt((await summary()).held)<BigInt(SYNTHETIC_GLOBAL-SYNTHETIC_RESERVED)){await pendingApi('fill-'+fill++,{path:'large_documents_begin',before:true})}
 const ga=await apiFixture('global-race-a'),gb=await apiFixture('global-race-b');await db.query('begin');await db.query('select 1 from ta_resource_reservations.pool for update')
 setDrop(undefined);const racing=[invoke(ga),invoke(gb)];pending.push(...racing)
 try{await waitLock('%pjsdas_rows_v1_large_intent_%',2);await db.query('commit')}finally{await db.query('rollback')}
 const race=await Promise.all(racing);assert.equal(race.filter(x=>x.status===200).length,1,JSON.stringify(race));assert.equal([await record(ga.stage),await record(gb.stage)].filter(Boolean).length,1);assert.equal((await summary()).held,String(SYNTHETIC_GLOBAL))
 console.log('PASS_RESOURCE_RPC actual cross-owner API race serializes at global pool, one last full reservation wins and loser has no durable intent or sidecar allocation')
 // Counters are exact sums of immutable reservations and named allocations.
 const all=await summary(),totals=(await db.query('select sum(reserved)::text held,sum(occupied)::text occupied,sum(present)::text present from ta_resource_reservations.reservation')).rows[0];for(const key of ['held','occupied','present'])assert.equal(all[key],totals[key])
 for(const role of ['anon','authenticated'])assert([401,403].includes((await rpc('pjsdas_rows_v1_large_intent_read',{identity:ai.identity,target_user_id:atomic.ids.userId},c.jwt({role}))).status))
 assert.equal(await scalar("select has_table_privilege('service_role','ta_resource_reservations.rpc_scope','INSERT')"),false)
 console.log('RESOURCE_RPC_PASS',JSON.stringify({publicOnly:true,realApiAndScoped:true,runtimeDirectPg:false,defaultOff:true,syntheticOnly:true,originalBudgetMs:10000,logicalCounters:all,physicalMemoryFsSpoolBounded:false,productionEligible:false}))
}
