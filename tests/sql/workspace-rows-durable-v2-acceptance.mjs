/** Executable independent acceptance; never changes clock/deadline/production policy. */
import assert from 'node:assert/strict'
import {writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {setTimeout as sleep} from 'node:timers/promises'
import {fixture} from './workspace-rows-durable-v2-fixture.mjs'
import {verifySource,lock,sha,sourceImport,selectGroup,safeError} from './workspace-rows-durable-v2-source.mjs'
const evidence=process.env.TA_V2_EVIDENCE;assert(evidence)
const group=process.argv[2]
assert(['core','safety'].includes(group),'Expected exactly core or safety')
assert.equal(process.argv.length,3,'Unexpected native gate arguments')
verifySource()
const labels=selectGroup(group)
const report={contract:'ta-native-durable-v2-gate-v1',group,source:lock.commit,tree:lock.tree,status:'RUNNING',localOnly:true,hostedReady:false,cases:labels.map(label=>({label,status:'NOT_RUN'}))}
const save=()=>writeFileSync(join(evidence,'result.json'),JSON.stringify(report,null,2)+'\n')
const pass=(label,detail={})=>{const entry=report.cases.find(c=>c.label===label);assert(entry&&entry.status==='NOT_RUN','Unexpected or duplicate label');Object.assign(entry,{status:'PASS',...detail});save();console.log('PASS',label,JSON.stringify(detail))}
const shape=r=>r.result.body??r.result.structuredContent
const ok=(r,outcome)=>{if(r.result.status!==undefined)assert.equal(r.result.status,200,JSON.stringify(r.result));else assert.equal(r.result.isError,undefined,JSON.stringify(r.result));if(outcome)assert.equal(shape(r).outcome,outcome)}
const interrupted=r=>{assert.equal(shape(r).code,'WORKSPACE_UNAVAILABLE',JSON.stringify(r.result));if(r.result.status!==undefined)assert.equal(r.result.status,503);else assert.equal(r.result.isError,true)}
const terminal=r=>{assert.equal(shape(r).code,'WORKSPACE_RECOVERY_TERMINAL',JSON.stringify(r.result));assert.notEqual(shape(r).retryable,true)}
const mutation=path=>/large_(?:v2_)?(?:intent_admit|attempt_begin|documents_(?:begin|append|finish|check_reservation)|append)$/.test(path)
const admission=path=>/large_(?:v2_)?intent_admit$/.test(path)
const commandCalls=(h,start)=>h.calls.slice(start).filter(c=>c.path.startsWith('/rpc/'))
const originalIntent=async(h,t)=>{
 const row=await h.intent(t);assert(row);t.identity=row.identity;const prepared=h.decoded(row)
 assert.equal(prepared.input.commandId,t.commandId);return{row,prepared,reservation:await h.reservation(t)}
}
async function pause(h,t,path='large_v2_intent_admit',overrides={}){
 h.setDrop({match:p=>p.endsWith(path)});const r=await h.invoke(t,overrides);interrupted(r);h.assertNoDrop();await h.drain()
 assert.equal((await h.ledger(t)).filter(x=>x.command_id===t.commandId).length,0)
 const saved=await originalIntent(h,t);t.admittedAt=Date.now();t.pausedProcess=r.process
 assert(Number.isInteger(r.process.code)&&r.process.exitAt,'original process exited before recovery');return saved
}
async function invariant(h,t,saved){
 assert.deepEqual(await h.intent(t),saved.row,'immutable identity/binding/encoded bytes never change')
 assert.deepEqual(await h.reservation(t),saved.reservation,'original reserved bytes/expiry never renew')
 const audit=(await h.ledger(t)).find(x=>x.command_id===t.commandId);assert(audit);assert.equal(audit.receipt.contractVersion,5)
 assert.deepEqual((await h.current(t)).snapshot,saved.prepared.input.snapshot,'all original prepared business time/snapshot bytes preserved')
 for(const[k,v]of Object.entries(saved.prepared.input.receiptContext??{}))assert.deepEqual(audit.receipt[k],v,'original receipt context '+k)
 assert.deepEqual(audit.compensation,saved.prepared.input.compensation??null)
 if(t.family==='scoped')assert.equal(audit.receipt.managementAuthorization.grantId,t.grantId)
 assert.equal((await h.ledger(t)).filter(x=>x.command_id===t.commandId).length,1)
 return audit
}
async function terminalRecheck(h,t,saved,reason){
 const first=await h.invoke(t);terminal(first)
 const next=await h.invoke(t);terminal(next)
 assert.equal((await h.ledger(t)).filter(x=>x.command_id===t.commandId).length,0)
 assert.deepEqual(await h.intent(t),saved.row)
 const resolved=await h.rpc('large_v2_intent_read',{identity:saved.row.identity,target_user_id:t.ids.userId})
 assert.equal(resolved.status,200,JSON.stringify(resolved));assert.equal(resolved.body.outcome,'TERMINAL_UNCOMMITTED');assert.equal(typeof resolved.body.reason,'string')
 if(reason)assert.equal(resolved.body.reason,reason)
 return resolved.body
}
async function oldWriterFence(h,t,saved){
 const {diffWorkspaceRows}=await sourceImport('gateway/workspaceRowsCodec.ts')
 const x=saved.prepared.input,b=saved.prepared.before
 const req={...diffWorkspaceRows(b.snapshot,b.snapshot),commandId:x.commandId,payloadHash:x.payloadHash,operation:x.operation,principal:x.principalKind,workspaceId:b.workspaceId,userId:b.userId,expectedEpoch:b.rowEpoch,expectedRevision:b.revision,schemaVersion:b.snapshot.version,compensation:null,provenance:x.provenance??{},receiptContext:{},effectiveTime:x.effectiveTime??null}
 const before=await h.current(t),beforeLedger=await h.ledger(t),alternate=randomUUID()
 // Fresh owner was never enrolled; do not toggle protected existing scopes.
 assert.equal(Number((await h.scalar('select count(*) n from ta_resource_reservations.rpc_scope where user_id=$1',[t.ids.userId])).n),0)
 {
  const small=await h.rpc('commit_authoritative',{req});assert.equal(small.status,409,JSON.stringify(small));assert.equal(small.body.code,'PT409')
  const {changes,...metadata}=req
  const {prepareStagedRequestDocuments}=await sourceImport('gateway/workspaceRowsStagedDocumentsPrototype.ts')
  const {preparedSha256,manifestSha256,...binding}=saved.row.binding
  const prepared=prepareStagedRequestDocuments(metadata,{...binding,stageId:alternate},{protocol:'workspace-effect-chain-v1',count:0,sha256:sha('')})
  const old=await h.rpc('large_documents_begin',{manifest_wire:prepared.manifestWire,manifest_sha256:prepared.manifest.sha256,target_user_id:t.ids.userId});assert.equal(old.status,409,JSON.stringify(old));assert.equal(old.body.code,'PT409')
  if(saved.prepared.protocol==='workspace-prepared-intent-v2'){
   const opened=await h.rpc('large_v2_attempt_begin',{identity:saved.row.identity,target_user_id:t.ids.userId});assert.equal(opened.status,200);assert(opened.body.attempt)
   const changed=prepareStagedRequestDocuments(metadata,binding,{protocol:'workspace-effect-chain-v1',count:0,sha256:sha('')});assert.notEqual(changed.manifest.sha256,saved.prepared.manifestSha256)
   const rewritten=await h.rpc('large_v2_documents_begin',{manifest_wire:changed.manifestWire,manifest_sha256:changed.manifest.sha256,target_user_id:t.ids.userId,attempt:opened.body.attempt});assert.equal(rewritten.status,403,JSON.stringify(rewritten));assert.equal(rewritten.body.code,'42501')
   assert.equal(Number((await h.scalar('select count(*) n from pjsdas_rows_candidate.large_document_bundle where stage_id=$1',[t.stage])).n),0,'first bundle cannot replace admitted manifest even without accounting enrollment')
  }
  assert.equal(Number((await h.scalar('select count(*) n from pjsdas_rows_candidate.large_stage where id=$1',[alternate])).n),0)
  assert.deepEqual(await h.current(t),before);assert.deepEqual(await h.ledger(t),beforeLedger);assert.deepEqual(await h.intent(t),saved.row)
 }
 return{smallSqlstate:'PT409',alternateStageSqlstate:'PT409',resourceScopeOff:true,compiledOldReleaseTest:false,alteredManifestWithValidAttemptDenied:saved.prepared.protocol==='workspace-prepared-intent-v2'}
}
save();let h,activeLabel
try{
 h=await fixture(evidence)
 // Two separate owners, reservations and commands; one truly disconnected wall
 // interval covers both. Recorded elapsed is independently based on each admit.
 const minute=[]
 if(group==='core'){
 for(const family of ['api','scoped']){
  activeLabel='minute-'+family;const t=await h.make(family),saved=await pause(h,t)
  assert.equal(saved.prepared.protocol,'workspace-prepared-intent-v2');assert.equal(Object.hasOwn(saved.prepared,'deadlineAt'),false)
  assert.equal(saved.row.deadline_at,null);assert.equal(saved.row.protocol,'workspace-prepared-intent-v2')
  assert(new Date(saved.reservation.expires_at).getTime()>Date.now()+60000,'prior synthetic reservation explicitly covers offline interval')
  minute.push({t,saved})
 }
 await h.drain();h.setOffline(true)
 const offlineAt=Date.now(),offlineMono=performance.now()
 console.log('REAL_OFFLINE_START',JSON.stringify({at:offlineAt,pids:minute.map(x=>x.t.pausedProcess.pid),minimumMs:60000}))
 const firstOfflineProbe=await h.probeDisconnected()
 await sleep(60_100)
 const lastOfflineProbe=await h.probeDisconnected()
 const onlineAt=Date.now(),offlineElapsedMs=performance.now()-offlineMono
 assert(offlineElapsedMs>=60000&&onlineAt-offlineAt>=60000);assert(h.isOffline());h.setOffline(false)
 console.log('REAL_OFFLINE_END',JSON.stringify({at:onlineAt,offlineElapsedMs,firstOfflineProbe,lastOfflineProbe}))
 for(const {t,saved}of minute){
  activeLabel='minute-'+t.family;const start=h.calls.length,r=await h.invoke(t,{PJSDAS_WORKSPACE_ROWS_DURABLE_INTENT_ADMISSION:'0',PJSDAS_WORKSPACE_ROWS_RELEASE_PROFILE:'compatible-fragments-v1',PJSDAS_WORKSPACE_ROWS_AUDIT_PAGES:'0'});ok(r,'COMMITTED')
  assert.notEqual(r.process.pid,t.pausedProcess.pid);assert(t.pausedProcess.exitAt<r.process.startedAt)
  assert(r.process.startedAt-t.admittedAt>=60000);assert(!commandCalls(h,start).some(c=>admission(c.path)))
  const audit=await invariant(h,t,saved)
  assert(Date.parse(audit.receipt.committedAt)>=onlineAt-1000,'receipt is new DB transaction time, not old preparation time')
  pass(activeLabel,{offlineElapsedMs,admittedToRecoveryMs:r.process.startedAt-t.admittedAt,oldPid:t.pausedProcess.pid,newPid:r.process.pid,preparedSha256:saved.row.encoded.sha256,manifestSha256:saved.prepared.manifestSha256,businessExportedAt:saved.prepared.input.snapshot.exportedAt,committedAt:audit.receipt.committedAt,oneCommit:true})
  // Original protected Undo is separately admitted, interrupted, and recovered.
  // This proves cold Undo, NOT a second minute-long Undo outage.
  activeLabel='original-undo-'+t.family
  const undoId='v2-independent-undo-'+randomUUID(),u={...t,commandId:undoId,undo:true,stage:await h.reserve(t.ids,undoId,t.family==='api'?'first_party_abandon':'opportunity_v3')}
  u.input=t.family==='api'?{action:'undo',projection:'delta-v1',commandId:undoId,targetCommandId:t.commandId}:{commandId:undoId,targetCommandId:t.commandId,expectedCompensationFingerprint:audit.receipt.result.compensationFingerprint}
  const undoSaved=await pause(h,u);const undoStart=h.calls.length,undone=await h.invoke(u,{PJSDAS_WORKSPACE_ROWS_DURABLE_INTENT_ADMISSION:'0',PJSDAS_WORKSPACE_ROWS_RELEASE_PROFILE:'compatible-fragments-v1',PJSDAS_WORKSPACE_ROWS_AUDIT_PAGES:'0'});ok(undone,'COMMITTED');await invariant(h,u,undoSaved)
  assert(!commandCalls(h,undoStart).some(c=>admission(c.path)));assert.equal((await h.ledger(t)).length,2)
  const {applyDomainCompensation}=await sourceImport('src/domainCommands.ts'),{restoreOpportunityManagement}=await sourceImport('src/opportunityManagement.ts')
  const restored=(await h.current(t)).snapshot,expected=(t.family==='api'?applyDomainCompensation:restoreOpportunityManagement)(saved.prepared.input.snapshot,audit.compensation,new Date(restored.exportedAt))
  assert.deepEqual(restored,JSON.parse(JSON.stringify(expected)))
  const authorization=t.family==='api'?{userId:t.ids.userId,principal:'first_party_web'}:{userId:t.ids.userId,principal:'delegated_mcp',family:'opportunity_v3',grantId:t.grantId,grantRevision:1,clientId:t.clientId}
  const history=await h.cold({mode:'history',userId:t.ids.userId,authorization});assert.equal(history.result.length,2);assert.deepEqual(history.result[0].receipt,audit.receipt);assert.deepEqual(history.result[0].compensation,audit.compensation)
  pass(activeLabel,{originalUndoSha256:undoSaved.row.encoded.sha256,completeOriginalHistory:true,minuteLongUndo:false})
 }
 }else{
  activeLabel='old-small-alternate-stage-v2';const off=await h.make('api',{enroll:false}),saved=await pause(h,off);pass(activeLabel,await oldWriterFence(h,off,saved))
  const t=await h.make('scoped'),committed=await h.invoke(t);ok(committed,'COMMITTED');const anchor=await originalIntent(h,t);minute.push({t,saved:anchor})
 }
 if(group==='safety'){
 activeLabel='real-attempt-timeout-rollback'
 {
  const t=await h.make('api')
  // Trigger exists ONLY in this owned fixture database, for this exact command.
  // It delays a real business-row insertion; no virtual clock or deadline edit.
  await h.db.query(`create function public.ta_v2_test_delay() returns trigger language plpgsql as $$ begin if new.command_id='${t.commandId}' then perform pg_sleep(10.2); end if; return new; end $$; create trigger ta_v2_delay after insert on pjsdas_rows_candidate.ledger for each row execute function public.ta_v2_test_delay()`)
  const start=h.calls.length,at=performance.now();let first
  try{first=await h.invoke(t);interrupted(first);await h.drain()}finally{await h.drain();await h.db.query('drop trigger ta_v2_delay on pjsdas_rows_candidate.ledger;drop function public.ta_v2_test_delay()')}
  assert(performance.now()-at>=10000,'real timeout duration');const finish=commandCalls(h,start).find(c=>c.path.endsWith('large_v2_documents_finish'));assert(finish,'real finish reached');assert(finish.status>=400)
  assert.equal((await h.ledger(t)).length,0);assert.equal((await h.current(t)).revision,0);assert.deepEqual((await h.current(t)).snapshot,t.f.before)
  const saved=await originalIntent(h,t),resumed=await h.invoke(t);ok(resumed,'COMMITTED');await invariant(h,t,saved)
  pass(activeLabel,{elapsedMs:performance.now()-at,finishSqlstate:finish.errorCode,rollbackBeforeRetry:true,timeoutMs:10000})
 }
 activeLabel='late-old-attempt-generation'
 {
  const t=await h.make('api'),start=h.calls.length,saved=await pause(h,t,'large_v2_documents_append')
  const stale=commandCalls(h,start).find(c=>c.path.endsWith('large_v2_documents_append'));assert(stale?.input.attempt)
  const old=stale.input.attempt,waitMs=Math.max(0,old.deadlineAt-Date.now()+50);await sleep(waitMs)
  const fresh=await h.rpc('large_v2_attempt_begin',{identity:saved.row.identity,target_user_id:t.ids.userId});assert.equal(fresh.status,200,JSON.stringify(fresh));assert(fresh.body.attempt.generation>old.generation)
  const before=await h.scalar('select count(*)::integer n from pjsdas_rows_candidate.large_document_fragment where stage_id=$1',[t.stage])
  const late=await h.rpc('large_v2_documents_append',stale.input);assert(late.status>=400,JSON.stringify(late))
  assert.deepEqual(await h.scalar('select count(*)::integer n from pjsdas_rows_candidate.large_document_fragment where stage_id=$1',[t.stage]),before);assert.equal((await h.ledger(t)).length,0)
  const reuse=await h.rpc('large_v2_attempt_begin',{identity:saved.row.identity,target_user_id:t.ids.userId});assert.deepEqual(reuse.body.attempt,fresh.body.attempt,'active attempt is reused, not renewed')
  const done=await h.invoke(t);ok(done,'COMMITTED');await invariant(h,t,saved)
  pass(activeLabel,{oldGeneration:old.generation,newGeneration:fresh.body.attempt.generation,oldSqlstate:late.body.code,activeAttemptNotRenewed:true})
 }
 activeLabel='concurrent-same-command'
 {
  const t=await h.make('api'),saved=await pause(h,t),start=h.calls.length
  const responses=await Promise.all([h.invoke(t),h.invoke(t)])
  assert(responses.some(r=>['COMMITTED','ALREADY_APPLIED'].includes(shape(r).outcome)),JSON.stringify(responses.map(r=>r.result)))
  const settled=await h.invoke(t);ok(settled,'ALREADY_APPLIED');await invariant(h,t,saved)
  const open=commandCalls(h,start).filter(c=>c.path.endsWith('large_v2_attempt_begin')&&c.output?.attempt)
  assert(open.length>=1);const active=open.map(c=>c.output.attempt);for(const attempt of active)assert.deepEqual(attempt,active[0])
  assert(!commandCalls(h,start).some(c=>admission(c.path)))
  pass(activeLabel,{requests:2,oneCommit:true,duplicateAdmission:false,activeAttemptIds:[...new Set(active.map(x=>x.id))]})
 }
 for(const family of ['api','scoped']){
  activeLabel='lost-ack-'+family;const t=await h.make(family);h.setDrop({match:p=>p.endsWith('large_v2_documents_finish')})
  const first=await h.invoke(t);interrupted(first);h.assertNoDrop();await h.drain();const saved=await originalIntent(h,t),audit=(await h.ledger(t))[0];assert(audit)
  const start=h.calls.length,replay=await h.invoke(t);ok(replay,'ALREADY_APPLIED');assert(!commandCalls(h,start).some(c=>mutation(c.path)),'receipt-first recovery must not reopen execution')
  assert.deepEqual((await h.ledger(t))[0],audit);await invariant(h,t,saved)
  pass(activeLabel,{oneCommit:true,receiptFirstNoWriteRpc:true,oldPid:first.process.pid,newPid:replay.process.pid})
 }
 for(const replace of [false,true]){
  activeLabel=replace?'replaced-original-grant':'revoked-original-grant';const t=await h.make('scoped'),saved=await pause(h,t)
  await h.db.query('update pjsdas_business_management_grants set revoked_at=clock_timestamp() where id=$1',[t.grantId])
  if(replace){
   const before=await h.scalar('select * from pjsdas_business_management_grants where id=$1',[t.grantId])
   const choice={domain:'opportunity',decision:'approve',consentVersion:3,consentTextHash:before.consent_text_hash,expectedGrant:{id:t.grantId,revision:Number(before.revision)}}
   // Existing public first-party consent function performs legitimate same-row
   // regrant and the original revision trigger; never insert a duplicate grant.
   const decided=await h.scalar("select * from public.pjsdas_decide_scoped_management_consent_v1($1,$2,$3,$4,$5,true,true,false,'allowlist')",[t.ids.userId,t.clientId,randomUUID(),sha(JSON.stringify(choice)),JSON.stringify([choice])])
   assert.equal(decided.receipts[0].outcome,'APPROVED')
   const after=await h.scalar('select * from pjsdas_business_management_grants where id=$1',[t.grantId]);assert.equal(after.id,t.grantId);assert.equal(after.revoked_at,null);assert(Number(after.revision)>Number(before.revision));assert(Number(after.revision)>saved.row.identity.authority.grantRevision)
  }
  const start=h.calls.length,denied=await h.invoke(t);assert.equal(denied.result.isError,true)
  // Entry prevalidation may reject before DB intent resolution. It must never
  // pretend that ordinary 403 is a DB-confirmed permanent noncommit.
  if(shape(denied).code==='AUTH_FORBIDDEN')assert(!commandCalls(h,start).some(c=>c.output?.outcome==='TERMINAL_UNCOMMITTED'))
  else terminal(denied)
  const resolved=await h.rpc('large_v2_intent_read',{identity:saved.row.identity,target_user_id:t.ids.userId})
  assert.equal(resolved.status,403,JSON.stringify(resolved));assert.equal(resolved.body.code,'42501')
  const cancel=await h.rpc('large_v2_intent_cancel',{identity:saved.row.identity,target_user_id:t.ids.userId});assert.equal(cancel.status,403);assert.equal(cancel.body.code,'42501')
  assert.equal((await h.ledger(t)).length,0);assert.deepEqual(await h.intent(t),saved.row);assert(!commandCalls(h,start).some(c=>admission(c.path)))
  pass(activeLabel,{entryCode:shape(denied).code,readAndCancelSqlstate:'42501',authoritativeTerminal:false,originalGrantNotSubstituted:true,replacementKind:replace?'same-id-regrant-new-revision':'revoked'})
 }
 activeLabel='real-resource-expiry'
 {
  const t=await h.make('api',{lifetimeMs:12000}),saved=await pause(h,t)
  const expiresAt=new Date(saved.reservation.expires_at).getTime(),wait=Math.max(0,expiresAt-Date.now()+100),at=Date.now();await sleep(wait)
  assert(Date.now()>=expiresAt);const result=await terminalRecheck(h,t,saved)
  assert.deepEqual(await h.reservation(t),saved.reservation);pass(activeLabel,{expiresAt,wallWaitMs:Date.now()-at,reason:result.reason,reservationNotRenewed:true})
 }
 for(const epoch of [false,true]){
  activeLabel=epoch?'epoch-layout-mismatch-safe-refusal':'cas-terminal';const t=await h.make('api'),saved=await pause(h,t)
  if(epoch){
   const oldSnapshot=(await h.current(t)).snapshot
   await h.db.query('update pjsdas_rows_candidate.head set epoch=$2 where id=$1',[t.ids.workspaceId,randomUUID()])
   // Keep the immutable public layout marker intact. This is an inconsistent
   // generation negative, NOT an authorized production epoch migration.
   const result=await h.invoke(t);assert(result.result.status>=400);assert.notEqual(shape(result).code,'WORKSPACE_RECOVERY_TERMINAL')
   const read=await h.rpc('large_v2_intent_read',{identity:saved.row.identity,target_user_id:t.ids.userId});assert.equal(read.status,409);assert.equal(read.body.code,'PT409')
   assert.equal((await h.ledger(t)).length,0);assert.deepEqual((await h.current(t)).snapshot,oldSnapshot);assert.deepEqual(await h.intent(t),saved.row)
   pass(activeLabel,{authorityLayoutFence:true,authoritativeTerminal:false,noReducerRebase:true})
  }else{
   await h.db.query('update pjsdas_rows_candidate.head set revision=revision+1 where id=$1',[t.ids.workspaceId])
   const resolved=await terminalRecheck(h,t,saved);pass(activeLabel,{reason:resolved.reason,originalPreparedBytes:true,noReducerRebase:true})
  }
 }
 activeLabel='explicit-intent-cancel'
 {
  const t=await h.make('scoped'),saved=await pause(h,t)
  const bad=[{identity:saved.row.identity,target_user_id:minute[0].t.ids.userId},{identity:{...saved.row.identity,userId:minute[0].t.ids.userId},target_user_id:t.ids.userId},...['clientId','grantId','grantRevision'].map(key=>({identity:{...saved.row.identity,authority:{...saved.row.identity.authority,[key]:key==='grantRevision'?99:randomUUID()}},target_user_id:t.ids.userId}))]
  for(const args of bad){const denied=await h.rpc('large_v2_intent_cancel',args);assert(denied.status>=400,JSON.stringify(denied));assert.equal((await h.ledger(t)).length,0);assert.deepEqual(await h.intent(t),saved.row);const a=await h.scalar('select terminal_reason from pjsdas_rows_candidate.large_command_attempt where stage_id=$1',[t.stage]);assert(!a?.terminal_reason)}
  const cancel=await h.rpc('large_v2_intent_cancel',{identity:saved.row.identity,target_user_id:t.ids.userId});assert.equal(cancel.status,200,JSON.stringify(cancel));assert.equal(cancel.body.outcome,'TERMINAL_UNCOMMITTED')
  const resolved=await terminalRecheck(h,t,saved);assert.equal(resolved.reason,cancel.body.reason)
  pass(activeLabel,{serviceOnly:true,noNewBrowserEntry:true,authoritativeFence:true,reason:resolved.reason})
  const committed=minute.find(x=>x.t.family==='scoped');const before=await h.ledger(committed.t),again=await h.rpc('large_v2_intent_cancel',{identity:committed.saved.row.identity,target_user_id:committed.t.ids.userId})
  assert.equal(again.status,200);assert.equal(again.body.outcome,'ALREADY_APPLIED');assert.deepEqual(await h.ledger(committed.t),before);assert.equal(again.body.commandId,committed.t.commandId)
  pass('cancel-authority-and-committed-first',{wrongOwnerClientGrantRevisionDenied:true,revokedReplacedDenied:true,committedResultFirst:true,receiptStillOriginalAuthorizedReader:true})
 }
 activeLabel='legacy-v1-expired'
 {
  const t=await h.make('api'),saved=await pause(h,t,'large_intent_admit',{PJSDAS_WORKSPACE_ROWS_DURABLE_ATTEMPTS_V2:'0'})
  const off=await h.make('api',{enroll:false}),offSaved=await pause(h,off,'large_intent_admit',{PJSDAS_WORKSPACE_ROWS_DURABLE_ATTEMPTS_V2:'0'})
  assert.equal(saved.prepared.protocol,'workspace-prepared-intent-v1');assert(Number.isFinite(saved.prepared.deadlineAt));await sleep(Math.max(0,Math.max(saved.prepared.deadlineAt,offSaved.prepared.deadlineAt)-Date.now()+50))
  const result=await terminalRecheck(h,t,saved,'LEGACY_INTENT_EXPIRED');assert.deepEqual(await h.reservation(t),saved.reservation)
  pass(activeLabel,{reason:result.reason,originalSha256:saved.row.encoded.sha256,noResign:true,noUpgrade:true})
  await terminalRecheck(h,off,offSaved,'LEGACY_INTENT_EXPIRED');pass('old-small-alternate-stage-terminal-v1',await oldWriterFence(h,off,offSaved))
 }
 activeLabel='capacity-exhaustion-pre-admission'
 {
  let fill=0
  while(true){const p=await h.scalar('select held,global_limit from ta_resource_reservations.pool');if(Number(p.global_limit)-Number(p.held)<16777216)break;assert(fill++<16);const t=await h.make('api');await pause(h,t)}
  const before=await h.scalar('select held,occupied,present from ta_resource_reservations.pool'),t=await h.make('api'),at=h.calls.length,result=await h.invoke(t)
  interrupted(result);assert(commandCalls(h,at).some(c=>admission(c.path)&&c.status>=400));assert.equal(await h.intent(t),undefined);assert.equal((await h.ledger(t)).length,0)
  assert.deepEqual(await h.scalar('select held,occupied,present from ta_resource_reservations.pool'),before);pass(activeLabel,{newIntent:false,newCommit:false,poolNotExpanded:true,existingIntentTerminalClaim:false})
 }
 activeLabel='read-and-resource-fences'
 assert.equal((await h.scalar("select has_column_privilege('service_role','pjsdas_workspaces','snapshot','SELECT') ok")).ok,false)
 assert(!h.calls.some(c=>c.path.startsWith('/pjsdas_workspaces?')&&decodeURIComponent(c.path).includes('snapshot')))
 for(const seeded of h.snapshots)assert.deepEqual((await h.scalar('select snapshot from pjsdas_workspaces where user_id=$1',[seeded.userId])).snapshot,seeded.snapshot)
 const attemptClaims=new Map()
 for(const call of h.calls){if(call.output?.attempt){assert(call.output.remainingMs>=0&&call.output.remainingMs<=10000);const a=call.output.attempt;const prior=attemptClaims.get(a.id);if(prior)assert.deepEqual(a,prior,'active attempt deadline cannot refresh');else attemptClaims.set(a.id,a)}if(call.input?.attempt){const expected=attemptClaims.get(call.input.attempt.id);if(expected)assert.deepEqual(call.input.attempt,expected,'all pages bind the exact original attempt')}}
 const pool=await h.scalar('select * from ta_resource_reservations.pool');assert.equal(Number(pool.command_limit),16777216);assert.equal(Number(pool.owner_limit),33554432);assert.equal(Number(pool.global_limit),276824064);assert(Number(pool.held)<=Number(pool.global_limit))
 pass(activeLabel,{retainedBlobsUnchanged:true,noRawFallback:true,originalSyntheticCaps:true,hostedCapacityProof:false})
 }
 assert.equal(report.cases.length,group==='core'?4:17);assert(report.cases.every(c=>c.status==='PASS'),'Missing native case');report.status='PASS_NATIVE_'+group.toUpperCase();report.finishedAt=new Date().toISOString();save()
}catch(error){
 report.status='FAIL';report.error=safeError(error)
 const active=report.cases.find(c=>c.label===activeLabel);if(active&&active.status==='NOT_RUN')Object.assign(active,{status:'FAIL',error:safeError(error)})
 save();process.exitCode=1
}finally{
 const errors=[]
 try{if(h)await h.close()}catch(error){errors.push(error)}
 try{verifySource()}catch(error){errors.push(error)}
 if(errors.length){report.status='FAIL_CLEANUP_OR_SOURCE';report.cleanupErrors=errors.map(safeError)}
 try{save()}catch(error){errors.push(error)}
 if(errors.length)process.exitCode=1
}
