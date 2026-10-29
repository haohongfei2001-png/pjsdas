/** Real API/PostgREST/PG evidence, explicitly not browser or consumer-v2 recovery. */
import assert from 'node:assert/strict'
import {mkdirSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {fixture} from './owned-fixture.mjs'
import {verifySource,sourceImport,sha,safeError,safeRpcSummary} from '../workspace-rows-durable-v2-source.mjs'
const source=verifySource(),evidence=process.env.TA_STOP_EVIDENCE;assert(evidence)
const {largeAbandonFixture}=await sourceImport('tests/fixtures/workspaceRowsLargeCommand.ts')
const {applyUserDomainCommand,applyDomainCompensation}=await sourceImport('src/domainCommands.ts')
const {diffReadableWorkspaceRows}=await sourceImport('gateway/workspaceRowsCodec.ts')
const {upgradeSnapshotToLatest}=await sourceImport('src/snapshot.ts')
export const labels=['small-direct-save-original-undo','shared-governance-refused','large-without-reservation-refused']
const results=[]
for(const label of labels){
 const directory=join(evidence,label);mkdirSync(directory)
 const count=label.startsWith('large')?2100:20,report={label,sourceCommit:source.commit,sourceTree:source.tree,status:'RUNNING',actualBrowser:false,uiCreatedCommands:false,actionCount:count,durableAdmission:false,priorReservationInserted:false}
 const requests=[]
 let h,error
 try{
  h=await fixture(directory)
  const snapshot=largeAbandonFixture().before;snapshot.data.actions=snapshot.data.actions.slice(0,count)
  if(label.startsWith('shared')){snapshot.data.opportunities[0].applicationGroupId='synthetic-shared';snapshot.data.applicationGroups=[{id:'synthetic-shared',company:'Synthetic shared capacity',remaining:0}]}
  const before=JSON.parse(JSON.stringify(upgradeSnapshotToLatest(snapshot))),owner=await h.consumer(before)
  assert.equal(h.env.PJSDAS_WORKSPACE_ROWS_DURABLE_ATTEMPTS_V2,'1');assert.equal(h.env.PJSDAS_WORKSPACE_ROWS_DURABLE_INTENT_ADMISSION,'1')
  const tables=['pjsdas_rows_candidate.large_command_intent','pjsdas_rows_candidate.large_command_attempt','pjsdas_rows_candidate.large_stage','pjsdas_rows_candidate.large_effect','pjsdas_rows_candidate.large_document_reservation','pjsdas_rows_candidate.large_document_bundle','pjsdas_rows_candidate.large_document_fragment','ta_resource_reservations.reservation','ta_resource_reservations.allocation','ta_resource_reservations.chunk','ta_resource_reservations.temporary_bytes']
  const inventory=async()=>{const values={};for(const table of tables)values[table]=(await h.scalar(`select count(*)::int n from ${table}`)).n;return values}
  const control=async()=>({pool:(await h.scalar('select to_jsonb(p) value from ta_resource_reservations.pool p')).value,
   scope:sha((await h.scalar("select coalesce(jsonb_agg(to_jsonb(s) order by user_id),'[]'::jsonb)::text value from ta_resource_reservations.rpc_scope s")).value)})
  const initial=await inventory(),controls=await control();assert(Object.values(initial).every(n=>n===0))
  assert.equal(controls.pool.enabled,true);assert.equal(Number(controls.pool.command_limit),16777216);assert.equal(Number(controls.pool.owner_limit),33554432);assert.equal(Number(controls.pool.global_limit),276824064)
  const commandId='stop-api-'+randomUUID(),command={type:'domain',value:{commandId,kind:'abandon_opportunity',opportunityId:'synthetic-opp'}},body={action:'command',projection:'delta-v1',commandId,baseRevision:0,command}
  const call=async body=>{const startedAt=Date.now();const response=await h.cold({body,headers:{origin:'https://synthetic.invalid',authorization:'Bearer '+owner.accessToken,'content-type':'application/json'}},{PJSDAS_CONNECTED_AUTHORITY:'transactional'});requests.push({startedAt,finishedAt:Date.now(),action:body.action,commandIdSha256:sha(body.commandId),...(body.targetCommandId?{targetCommandIdSha256:sha(body.targetCommandId)}:{}),requestSha256:sha(body),status:response.result.status,outcome:response.result.body?.outcome,code:response.result.body?.code,processExited:response.process.code===0});return response.result}
  const evaluated=applyUserDomainCommand(before,command.value,new Date()),effects=diffReadableWorkspaceRows(before,evaluated.snapshot).changes.length
  assert.equal(effects,count+2);report.effects=effects
  const result=await call(body)
  if(label.startsWith('small')){
   assert.equal(result.status,200);assert.equal(result.body.outcome,'COMMITTED')
   const first=(await h.ledger(owner))[0];assert.equal(first.command_id,commandId);assert.equal(first.receipt.contractVersion,5);assert.equal(first.receipt.operation,'domain:abandon_opportunity');assert.equal(first.receipt.undoAvailable,true);assert.equal(first.compensation.operation,'restore_participation');assert(result.body.delta);assert.deepEqual({...result.body.receipt,projectionDelta:result.body.delta},first.receipt)
   const saved=await h.current(owner);assert.equal(saved.revision,1);assert(saved.snapshot.data.actions.every(a=>a.status==='skipped'))
   const committedAt=Date.parse(saved.snapshot.exportedAt);assert(committedAt>=requests[0].startedAt&&committedAt<=requests[0].finishedAt)
   const expected=applyUserDomainCommand(before,command.value,new Date(saved.snapshot.exportedAt));assert.deepEqual(saved.snapshot,JSON.parse(JSON.stringify(upgradeSnapshotToLatest(expected.snapshot))));assert.deepEqual(first.compensation,expected.compensation)
   const replay=await call(body);assert.equal(replay.status,200);assert.equal(replay.body.outcome,'ALREADY_APPLIED');assert(replay.body.delta);assert.deepEqual({...replay.body.receipt,projectionDelta:replay.body.delta},first.receipt)
   const undoId='stop-api-undo-'+randomUUID(),undoBody={action:'undo',projection:'delta-v1',commandId:undoId,targetCommandId:commandId},undo=await call(undoBody)
   assert.equal(undo.status,200);assert.equal(undo.body.outcome,'COMMITTED')
   const ledger=await h.ledger(owner),final=await h.current(owner);assert.equal(ledger.length,2);assert.equal(final.revision,2)
   assert.equal(ledger[1].command_id,undoId);assert.equal(ledger[1].receipt.operation,'undo_command');assert.equal(ledger[1].receipt.undoOf,commandId);assert(undo.body.delta);assert.deepEqual({...undo.body.receipt,projectionDelta:undo.body.delta},ledger[1].receipt)
   assert.deepEqual(final.snapshot,JSON.parse(JSON.stringify(upgradeSnapshotToLatest(applyDomainCompensation(saved.snapshot,first.compensation,new Date(final.snapshot.exportedAt))))))
   const replayUndo=await call(undoBody);assert.equal(replayUndo.status,200);assert.equal(replayUndo.body.outcome,'ALREADY_APPLIED');assert(replayUndo.body.delta);assert.deepEqual({...replayUndo.body.receipt,projectionDelta:replayUndo.body.delta},ledger[1].receipt)
   for(const original of ledger){const found=await call({action:'receipt',projection:'snapshot',commandId:original.command_id});assert.equal(found.status,200);assert.equal(found.body.found,true);assert.deepEqual(found.body.receipt,original.receipt)}
   assert.equal((await h.current(owner)).revision,2);report.originalReceiptAndUndo=true;report.exactReplay=true
  }else{
   assert.equal(result.status,label.startsWith('shared')?400:403)
   assert.equal(result.body.code,label.startsWith('shared')?'SHARED_GOVERNANCE_REQUIRED':'AUTH_FORBIDDEN');assert.equal(result.body.retryable,false)
   assert.deepEqual(await h.ledger(owner),[]);assert.deepEqual(await h.current(owner),{revision:0,snapshot:before})
   report.exactNoBusinessWrite=true;report.refusalCode=result.body.code
   if(label.startsWith('large')){const rejected=h.calls.filter(x=>x.path.endsWith('large_v2_intent_admit'));assert.equal(rejected.length,1);assert.equal(rejected[0].status,403);assert.equal(rejected[0].output.code,'42501');assert.match(rejected[0].output.message,/prior complete-intent reservation required/);report.exactPriorReservationFailure=true}
  }
  assert.deepEqual(await inventory(),initial);assert.deepEqual(await control(),controls)
  const owners=(await h.db.query('select to_jsonb(o) value from ta_resource_reservations.owner o')).rows.map(x=>x.value)
  assert.deepEqual(owners,[{user_id:owner.ids.userId,held:0,occupied:0,present:0,rpc_peak_occupied:0}])
  const probes=h.calls.filter(x=>x.path.endsWith('large_v2_intent_read'));assert(probes.length>0);assert(probes.every(x=>x.status===200&&x.output===null))
  assert(!h.calls.some(x=>x.path.endsWith('large_v2_attempt_begin')))
  assert.equal(h.calls.filter(x=>x.path.endsWith('large_v2_intent_admit')).length,label.startsWith('large')?1:0)
  report.inventory={before:initial,after:await inventory(),controlsUnchanged:true,exactZeroOwner:true};report.requests=requests;report.rpc=safeRpcSummary(h.calls);report.status='PASS_API_ONLY'
  verifySource()
 }catch(e){error=e;report.status='FAIL';report.error=safeError(e)}finally{report.requests=requests;report.rpc=h?safeRpcSummary(h.calls):[];if(h)try{await h.close();report.cleanup='PASS'}catch(e){error??=e;report.status='FAIL';report.cleanup='FAIL';report.cleanupError=safeError(e)}writeFileSync(join(directory,'result.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});results.push(report)}
 if(error){writeFileSync(join(evidence,'result.json'),JSON.stringify({status:'FAIL',results},null,2)+'\n',{flag:'wx'});throw error}
}
writeFileSync(join(evidence,'result.json'),JSON.stringify({status:'PASS_API_ONLY',actualBrowser:false,uiCreatedCommands:false,durableConsumerRecovery:false,results},null,2)+'\n',{flag:'wx'})
