/** Independent fixed-source page-ready three-mode pair proof. Only synthetic state in owned loopback DB.
 * A = preloaded fragment-admission fallback; B = page-admission forward.
 * The legacy worker makes actual historical admitted bytes without the new selector. */
import assert from 'node:assert/strict'
import {source,sourceChecks,reportFile} from './integrated-pair-source-contract.mjs'
import {randomUUID,createHash} from 'node:crypto'
import {writeFileSync,readdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {resolve} from 'node:path'
import {largeAbandonFixture} from '../fixtures/workspaceRowsLargeCommand.ts'
import {applyUserDomainCommand,applyDomainCompensation} from '../../src/domainCommands.ts'
import {restoreOpportunityManagement} from '../../src/opportunityManagement.ts'
import {decodePreparedIntent} from '../../gateway/workspaceRowsDurableIntent.ts'
const wire=x=>JSON.parse(JSON.stringify(x)),sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex')
const points=[{path:'large_intent_admit'},{path:'large_documents_begin'},...['metadata','beforeEnvelope','afterEnvelope','compensation'].map(document=>({path:'large_documents_append',document})),{path:'large_append'},{path:'large_documents_finish'}]
const spoolNames=()=>readdirSync(tmpdir()).filter(x=>x.startsWith('ta-audit-read-')).sort()
export async function runRollbackPair(h){
 const {assertProxyQuiescent,assertOnlySettledHookRequest,assertResourceDefaultOff,assertFrozenSources,db,seed,reserve,current,count,cold,rpc,jwt,serviceToken,calls,auditHooks,fullBodies,scopedFixture,setDrop,getDrop,webOrigin,seededSnapshots}=h
 const report={contract:'ta-integrated-candidate-complete-r0p-three-mode-pair-v1',plannedCases:81,source,sourceChecks,resourceInstallation:'same-original-public-routes-default-off',resourceActivationMatrix:false,previousEvidence:{full81:'55 PASS / case 56 deadline FAIL / remaining NOT_RUN',independentTail:'25 PASS only, not merged into full81',earlierAttempt:'14 PASS / 1 deadline FAIL',supersedesFailures:false},status:'RUNNING',localOnly:true,hostedReady:false,productionEligible:false,pageReadyPair:'RUNNING',pagePendingRollback:'NOT_YET_VERIFIED',cases:[]},initialSpools=spoolNames()
 const save=()=>writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n')
 const pass=(label,detail={})=>{assertProxyQuiescent();assert(!report.cases.some(c=>c.label===label),'duplicate case label');report.cases.push({label,status:'PASS',...detail});save();console.log('PASS PAIR',label,JSON.stringify(detail))}
 save()
 try{
 const api=(release,ids,body,options={})=>cold({release,...options,body,headers:{origin:webOrigin,authorization:'Bearer '+jwt({role:'authenticated',sub:ids.userId}),'content-type':'application/json'}})
 const scoped=(release,x,tool,body,options={})=>cold({release,...options,mode:'scoped',userId:x.vIds.userId,clientId:x.clientId,tool,body})
 const history=(release,ids,authorization)=>cold({release,mode:'history',userId:ids.userId,authorization:authorization??{userId:ids.userId,principal:'first_party_web'}})
 const makeInput=(f,commandId)=>({action:'command',projection:'delta-v1',commandId,baseRevision:0,command:{type:'domain',value:{...f.command,commandId}}})
 const record=async(ids,legacy=false)=>(await db.query('select receipt,compensation from '+(legacy?'public.pjsdas_command_ledger':'pjsdas_rows_candidate.ledger')+' where user_id=$1 order by resulting_revision',[ids.userId])).rows
 const modeCheck=async(ids,commandId,expected)=>{const req=(await db.query("select request from pjsdas_rows_candidate.large_stage where user_id=$1 and request->>'commandId'=$2",[ids.userId,commandId])).rows[0]?.request;assert(req);assert.equal(req.auditReadProtocol,expected==='legacy-inline-v1'?undefined:'workspace-audit-bytes-v1');assert.equal(req.auditReadPageProtocol,expected==='pages-v1'?'workspace-audit-page-v1':undefined)}
 const receiptCheck=async(release,ids,commandId,audit,options={})=>{const r=await api(release,ids,{action:'receipt',commandId,projection:'delta-v1'},options);assert.equal(r.status,200,JSON.stringify(r).slice(0,500));assert.deepEqual({...r.body.receipt,projectionDelta:r.body.delta},audit.receipt);return r}
 const f=largeAbandonFixture();f.before.futureHeader={utf8:'未来😀',nested:{preserve:['x',null,1]}};f.before.data.futureData={preserve:true}
 for(const [from,to] of [['a','b'],['b','a']]){
  for(const active of [false,true]){
   const ids=await seed(f.before,active),commandId='synthetic-pair-'+from+'-'+to+'-'+active,input=makeInput(f,commandId)
   if(active)await reserve(ids,commandId)
   const offset=calls.length,saved=await api(from,ids,input);assert.equal(saved.status,200,JSON.stringify(saved).slice(0,500));assert.equal(saved.body.outcome,'COMMITTED')
   const audit=(await record(ids,!active))[0];assert.equal(audit.receipt.contractVersion,5)
   if(!active){const full=fullBodies.at(-1);assert.equal(full.target_command_id,commandId);assert.equal(full.target_receipt_context.contractVersion,5)}
   const replay=await api(to,ids,input);assert.equal(replay.status,200);assert.equal(replay.body.outcome,'ALREADY_APPLIED');assert.deepEqual(replay.body.receipt,saved.body.receipt);assert.deepEqual(replay.body.delta,saved.body.delta)
   await receiptCheck(to,ids,commandId,audit)
   const after=active?(await current(ids)).snapshot:(await db.query('select snapshot from pjsdas_workspaces where user_id=$1',[ids.userId])).rows[0].snapshot
   assert.deepEqual(after,wire(applyUserDomainCommand(f.before,input.command.value,new Date(after.exportedAt)).snapshot))
   const undoId=commandId+'-undo';if(active)await reserve(ids,undoId)
   const undone=await api(to,ids,{action:'undo',projection:'delta-v1',commandId:undoId,targetCommandId:commandId});assert.equal(undone.status,200,JSON.stringify(undone).slice(0,500));assert.equal(undone.body.outcome,'COMMITTED')
   const restored=active?(await current(ids)).snapshot:(await db.query('select snapshot from pjsdas_workspaces where user_id=$1',[ids.userId])).rows[0].snapshot
   assert.deepEqual(restored,wire(applyDomainCompensation(after,audit.compensation,new Date(restored.exportedAt))));assert.equal((await record(ids,!active)).length,2)
   await receiptCheck(from,ids,commandId,audit)
   if(active){await modeCheck(ids,commandId,from==='a'?'fragments-v1':'pages-v1');const rows=await history(from,ids);assert.equal(rows.length,2);assert.deepEqual(rows[0].receipt,audit.receipt);assert.deepEqual(rows[0].compensation,audit.compensation);assert(calls.slice(offset).some(x=>x.path.endsWith('large_documents_finish')))}
   else assert(calls.slice(offset).some(x=>x.path.endsWith('pjsdas_commit_workspace_v4')))
   pass((active?'active-api':'inactive-full-v4')+'-'+from+'-write-'+to+'-undo-'+from+'-read',{unknownFieldsPreserved:true,receiptV5:true,noRawFallback:true})
  }
  const x=await scopedFixture(2050),input={commandId:x.vf.commandId,baseRevision:0,change:x.vf.input},offset=calls.length
  const saved=await scoped(from,x,'execute_opportunity_management',input);assert.equal(saved.isError,undefined,JSON.stringify(saved).slice(0,500));assert.equal(saved.structuredContent.outcome,'COMMITTED')
  const audit=(await record(x.vIds))[0],after=await current(x.vIds);await modeCheck(x.vIds,x.vf.commandId,from==='a'?'fragments-v1':'pages-v1')
  assert.equal(audit.receipt.managementAuthorization.grantId,x.grantId);assert.equal(audit.receipt.contractVersion,5)
  const total=Number((await db.query('select octet_length(to_jsonb(l)::text) n from pjsdas_rows_internal.discovery_history l where user_id=$1',[x.vIds.userId])).rows[0].n);assert(total>=2105291)
  const replay=await scoped(to,x,'execute_opportunity_management',input);assert.equal(replay.isError,undefined,JSON.stringify(replay).slice(0,500));assert.equal(replay.structuredContent.outcome,'ALREADY_APPLIED');assert.deepEqual(replay.structuredContent.result,saved.structuredContent.result)
  await receiptCheck(to,x.vIds,x.vf.commandId,audit)
  const authorization={userId:x.vIds.userId,principal:'delegated_mcp',family:'opportunity_v3',grantId:x.grantId,grantRevision:1,clientId:x.clientId}
  const rows=await history(to,x.vIds,authorization);assert.equal(rows.length,1);assert.deepEqual(rows[0].receipt,audit.receipt);assert.deepEqual(rows[0].compensation,audit.compensation)
  const undoId='synthetic-pair-scoped-undo';await reserve(x.vIds,undoId,'opportunity_v3')
  const disabledOffset=calls.length,disabledUndo=await scoped(to,x,'restore_opportunity_management',{commandId:undoId,targetCommandId:x.vf.commandId,expectedCompensationFingerprint:audit.receipt.result.compensationFingerprint},{profile:null,pages:false,audit:false})
  assert.equal(disabledUndo.isError,true);assert.equal(await count(x.vIds.userId),1);assert.equal((await current(x.vIds)).revision,1);assert(!calls.slice(disabledOffset).some(c=>c.path.endsWith('large_intent_admit')||c.path.endsWith('large_documents_finish')))
  assert.equal(disabledUndo.structuredContent.code,'WORKSPACE_INVALID');assert.equal(calls.slice(disabledOffset).findLast(c=>c.path.endsWith('read_history'))?.errorCode,'22023')
  pass('complete-byte-capability-off-original-Undo-pre-resume-denied-'+to,{newLedger:false,admission:false,originalReaderGuardNotProfileConfig:true,observedCode:disabledUndo.structuredContent.code,observedSqlstate:'22023'})
  const undone=await scoped(to,x,'restore_opportunity_management',{commandId:undoId,targetCommandId:x.vf.commandId,expectedCompensationFingerprint:audit.receipt.result.compensationFingerprint});assert.equal(undone.isError,undefined,JSON.stringify(undone).slice(0,500));assert.equal(undone.structuredContent.outcome,'COMMITTED')
  const restored=await current(x.vIds);assert.deepEqual(restored.snapshot,wire(restoreOpportunityManagement(after.snapshot,audit.compensation,new Date(restored.snapshot.exportedAt))));assert.equal(await count(x.vIds.userId),2)
  await receiptCheck(from,x.vIds,x.vf.commandId,audit)
  assert(calls.slice(offset).some(x=>x.path.endsWith('read_audit_fragment')));assert(calls.slice(offset).some(x=>x.path.endsWith('read_audit_page')))
  await db.query('update pjsdas_business_management_grants set revoked_at=clock_timestamp() where id=$1',[x.grantId])
  for(const release of [from,to]){const denied=await scoped(release,x,'execute_opportunity_management',input);assert.equal(denied.isError,true);assert.equal(denied.structuredContent.code,'AUTH_FORBIDDEN')}
  pass('active-scoped-original-long2050-'+from+'-write-'+to+'-undo-'+from+'-read',{totalSqlBytes:total,originalGrant:true,revokedReplayDeniedBoth:true,completeReceiptProjectionCompensation:true})
  for(const family of ['api','scoped'])for(const point of points){
   let ids,x2,input2,stage,commandId
   if(family==='api'){ids=await seed(f.before,true);commandId='synthetic-pair-intent-'+randomUUID();stage=await reserve(ids,commandId);input2=makeInput(f,commandId)}
   else{x2=await scopedFixture(2050,true);ids=x2.vIds;commandId=x2.vf.commandId;stage=x2.vStage;input2={commandId,baseRevision:0,change:x2.vf.input}}
   setDrop({...point});const failed=family==='api'?await api(from,ids,input2):await scoped(from,x2,'execute_opportunity_management',input2);assert.equal(getDrop(),undefined);if(family==='api')assert.equal(failed.status,503);else assert.equal(failed.isError,true)
   const intent=(await db.query('select * from pjsdas_rows_candidate.large_command_intent where stage_id=$1',[stage])).rows[0];assert(intent)
   const prepared=decodePreparedIntent(intent.encoded,8388608),offset=calls.length
   assert.equal(await count(ids.userId),point.path==='large_documents_finish'?1:0)
   const resumed=family==='api'?await api(to,ids,input2):await scoped(to,x2,'execute_opportunity_management',input2)
   if(family==='api'){assert.equal(resumed.status,200,JSON.stringify(resumed).slice(0,500));assert.equal(resumed.body.outcome,point.path==='large_documents_finish'?'ALREADY_APPLIED':'COMMITTED')}
   else{assert.equal(resumed.isError,undefined,JSON.stringify(resumed).slice(0,500));assert.equal(resumed.structuredContent.outcome,point.path==='large_documents_finish'?'ALREADY_APPLIED':'COMMITTED')}
   assert.equal(await count(ids.userId),1);assert.deepEqual((await current(ids)).snapshot,prepared.input.snapshot);await modeCheck(ids,commandId,from==='a'?'fragments-v1':'pages-v1')
   const audit=(await record(ids))[0];for(const [key,value]of Object.entries(prepared.input.receiptContext))assert.deepEqual(audit.receipt[key],value);assert.deepEqual(audit.compensation,prepared.input.compensation??null)
   const again=(await db.query('select * from pjsdas_rows_candidate.large_command_intent where stage_id=$1',[stage])).rows[0];assert.deepEqual(again,intent)
   assert(!calls.slice(offset).some(c=>c.path.endsWith('large_intent_admit')))
   pass('durable-'+family+'-'+from+'-to-'+to+'-'+point.path+'-'+(point.document??'boundary'),{originalPreparedSha256:intent.encoded.sha256,originalManifestSha256:prepared.manifestSha256,originalDeadlineAt:prepared.deadlineAt,oneCommit:true,noReplacementAdmission:true})
   if(point.path==='large_intent_admit'){
    const undoId='synthetic-pair-pending-undo-'+randomUUID(),undoStage=await reserve(ids,undoId,family==='api'?'first_party_abandon':'opportunity_v3')
    const undoInput=family==='api'?{action:'undo',projection:'delta-v1',commandId:undoId,targetCommandId:commandId}:{commandId:undoId,targetCommandId:commandId,expectedCompensationFingerprint:audit.receipt.result.compensationFingerprint}
    setDrop({path:'large_documents_append',document:'metadata'})
    const stopped=family==='api'?await api(to,ids,undoInput):await scoped(to,x2,'restore_opportunity_management',undoInput)
    assert.equal(getDrop(),undefined);if(family==='api')assert.equal(stopped.status,503);else assert.equal(stopped.isError,true)
    const intentReadStartedAtMs=Date.now(),harnessReadCpu=process.cpuUsage()
    const undoIntent=(await db.query('select * from pjsdas_rows_candidate.large_command_intent where stage_id=$1',[undoStage])).rows[0]
    const decodeStartedAtMs=Date.now(),harnessDecodeCpu=process.cpuUsage(),undoPrepared=decodePreparedIntent(undoIntent.encoded,8388608),decodeEndedAtMs=Date.now(),resumeOffset=calls.length
    console.log('HARNESS_ORIGINAL_UNDO_DECODE',JSON.stringify({family,from:to,to:from,stageId:undoStage,commandId:undoId,intentReadStartedAtMs,decodeStartedAtMs,decodeEndedAtMs,deadlineAt:undoPrepared.deadlineAt,remainingAtReadStartMs:undoPrepared.deadlineAt-intentReadStartedAtMs,remainingAfterDecodeMs:undoPrepared.deadlineAt-decodeEndedAtMs,encodedOriginalBytes:undoIntent.encoded.bytes,harnessReadAndDecodeCpuUs:process.cpuUsage(harnessReadCpu),harnessDecodeCpuUs:process.cpuUsage(harnessDecodeCpu)}))
    const recovered=family==='api'?await api(from,ids,undoInput):await scoped(from,x2,'restore_opportunity_management',undoInput)
    if(family==='api')assert.equal(recovered.status,200,JSON.stringify(recovered).slice(0,500));else assert.equal(recovered.isError,undefined,JSON.stringify(recovered).slice(0,500))
    assert.equal(await count(ids.userId),2);assert.deepEqual((await current(ids)).snapshot,undoPrepared.input.snapshot);await modeCheck(ids,undoId,to==='a'?'fragments-v1':'pages-v1')
    const undoAudit=(await record(ids))[1];for(const [key,value]of Object.entries(undoPrepared.input.receiptContext))assert.deepEqual(undoAudit.receipt[key],value);assert.deepEqual(undoAudit.compensation,undoPrepared.input.compensation??null)
    assert.deepEqual((await db.query('select * from pjsdas_rows_candidate.large_command_intent where stage_id=$1',[undoStage])).rows[0],undoIntent)
    assert(!calls.slice(resumeOffset).some(c=>c.path.endsWith('large_intent_admit')))
    pass('durable-original-undo-'+family+'-'+to+'-to-'+from,{originalPreparedSha256:undoIntent.encoded.sha256,originalDeadlineAt:undoPrepared.deadlineAt,noReplacementAdmission:true})
   }
  }
 }
 assertProxyQuiescent()
 // Missing reader cannot publish an immutable record that the pair cannot read.
 const fragmentSignature='public.pjsdas_rows_v1_read_audit_fragment(jsonb,bigint,jsonb)',fragmentDef=(await db.query('select pg_get_functiondef($1::regprocedure) body',[fragmentSignature])).rows[0].body
 assertProxyQuiescent();await db.query('drop function '+fragmentSignature)
 try{for(const release of ['a','b']){const x=await scopedFixture(2050),bad=await scoped(release,x,'execute_opportunity_management',{commandId:x.vf.commandId,baseRevision:0,change:x.vf.input});assert.equal(bad.isError,true);assert.equal(bad.structuredContent.code,'WORKSPACE_INVALID');assert.equal(await count(x.vIds.userId),0);assert.equal((await current(x.vIds)).revision,0);pass('missing-fragment-reader-atomic-refusal-'+release)}}
 finally{await db.query(fragmentDef);await db.query('revoke all on function '+fragmentSignature+' from public,anon,authenticated;grant execute on function '+fragmentSignature+' to service_role')}
 for(const release of ['a','b']){const x=await scopedFixture(2050),bad=await scoped(release,x,'execute_opportunity_management',{commandId:x.vf.commandId,baseRevision:0,change:x.vf.input},{audit:false,durable:false,pages:false,profile:null});assert.equal(bad.isError,true);assert.equal(bad.structuredContent.code,'WORKSPACE_INVALID');assert.equal(await count(x.vIds.userId),0);pass('unnegotiated-complete-reader-atomic-refusal-'+release)}
 const {runHistoricalThreeMode}=await import('./integrated-pair-historical.mjs')
 await runHistoricalThreeMode(h,{api,scoped,history,receiptCheck,makeInput,record,modeCheck,pass,f})
 // All 81 cases, including the two final global guards, must pass before any aggregate PASS.
 assertProxyQuiescent()
 const sig='public.pjsdas_rows_v1_read_audit_page(jsonb,bigint,jsonb)',definition=(await db.query('select pg_get_functiondef($1::regprocedure) body',[sig])).rows[0].body
 let pageDropped=false
 // Keep the reader present through real initial history authorization. Remove
 // it only AFTER begin succeeds so this proves the atomic finalizer guard,
 // rather than merely proving that the earlier entry preflight fails closed.
 // The hook retains its one callback count until finally: its upstream response
 // has been fully consumed. This is NOT a claim of zero callbacks at DROP.
 auditHooks.push({match:path=>path.endsWith('large_documents_begin'),run:async()=>{assertOnlySettledHookRequest();await db.query('drop function '+sig);pageDropped=true}})
 try{
  const x=await scopedFixture(2050),offset=calls.length,bad=await scoped('b',x,'execute_opportunity_management',{commandId:x.vf.commandId,baseRevision:0,change:x.vf.input},{pages:true})
  assert(pageDropped);assert.equal(auditHooks.length,0);assert.equal(bad.isError,true);assert.equal(bad.structuredContent.code,'WORKSPACE_INVALID');assert.equal(await count(x.vIds.userId),0);assert.equal((await current(x.vIds)).revision,0)
  assert.equal(calls.slice(offset).findLast(c=>c.path.endsWith('large_documents_finish'))?.errorCode,'22023')
  pass('missing-selected-page-reader-atomic-refusal',{observedCode:bad.structuredContent.code,observedSqlstate:'22023',removedAfterBegin:true,finalizerReached:true,proxyCallbacksBeforeFaultRegistration:0,proxyCallbacksAtDrop:1,otherUnsettledRequestsAtDrop:0})
 }finally{if(pageDropped){await db.query(definition);await db.query('revoke all on function '+sig+' from public,anon,authenticated;grant execute on function '+sig+' to service_role')}}
 assert.equal((await rpc('pjsdas_rows_v1_read_audit_fragment',{document:{},byte_offset:0,proof:{}},jwt({role:'authenticated'}))).status,403)
 assert.equal((await db.query("select has_column_privilege('service_role','pjsdas_workspaces','snapshot','SELECT') ok")).rows[0].ok,false)
 assert(!calls.some(c=>c.fullPath.startsWith('/pjsdas_workspaces?')&&decodeURIComponent(c.fullPath).includes('snapshot')))
 for(const seeded of seededSnapshots.filter(x=>x.active))assert.deepEqual((await db.query('select snapshot from pjsdas_workspaces where user_id=$1',[seeded.userId])).rows[0].snapshot,seeded.snapshot)
 assert.deepEqual(spoolNames(),initialSpools);pass('read-fence-and-request-spool-cleanup',{effectiveSnapshotSelect:false,unauthorizedFragmentDenied:true,noRawBlobFallback:true,allActiveRetainedBlobsUnchanged:true})
 assertProxyQuiescent();await assertResourceDefaultOff();assertFrozenSources('after-scenarios')
 assert.equal(report.cases.length,81,'fixed complete pair inventory');assert(report.cases.every(c=>c.status==='PASS'))
 report.pageReadyPair='PASS_LOCAL_CROSS_PROFILE_AND_HISTORICAL_THREE_MODE';report.pagePendingRollback='PASS_LOCAL'
 report.status='PASS_LOCAL_INTEGRATED_COMPLETE_R0P_THREE_MODE_PAIR';report.finishedAtUtc=new Date().toISOString();report.caseDigest=sha(report.cases);save()
 console.log('INTEGRATED_PAIR_COMPLETE',JSON.stringify({status:report.status,cases:report.cases.length,source,hostedReady:false,pageReadyRollbackLocal:true,resourceActivationMatrix:false}))
 }catch(error){
  report.status='FAIL_LOCAL_INTEGRATED_PAIR';report.pageReadyPair='FAILED_INCOMPLETE';report.pagePendingRollback='FAILED_INCOMPLETE';report.finishedAtUtc=new Date().toISOString();report.failure={message:String(error),stack:error?.stack,passedCases:report.cases.length,nextCaseOrdinal:report.cases.length+1};report.caseDigest=sha(report.cases);save();throw error
 }
}
