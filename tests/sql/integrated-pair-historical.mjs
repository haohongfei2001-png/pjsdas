/** Old103d8c9 actually admits historical bytes. New releases must recover them;
 * a new writer plus its new decoder agreeing is not a historical-byte oracle. */
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {decodePreparedIntent} from '../../gateway/workspaceRowsDurableIntent.ts'
const modes=['legacy-inline-v1','fragments-v1','pages-v1']
export async function runHistoricalThreeMode(h,helpers){
 const {db,seed,reserve,current,count,calls,scopedFixture,setDrop,getDrop}=h
 const {api,scoped,receiptCheck,makeInput,record,modeCheck,pass,f}=helpers
 const oldOptions=mode=>({profile:null,pages:mode==='pages-v1',audit:mode!=='legacy-inline-v1'})
 const getIntent=async stage=>(await db.query('select * from pjsdas_rows_candidate.large_command_intent where stage_id=$1',[stage])).rows[0]
 const call=async(release,family,ids,x,input,options={},undo=false)=>family==='api'?api(release,ids,input,options):scoped(release,x,undo?'restore_opportunity_management':'execute_opportunity_management',input,options)
 const success=(family,result)=>{if(family==='api')assert.equal(result.status,200,JSON.stringify(result).slice(0,500));else assert.equal(result.isError,undefined,JSON.stringify(result).slice(0,500))}
 const failure=(family,result,code)=>{if(family==='api'){assert.notEqual(result.status,200);if(code)assert.equal(result.body.code,code)}else{assert.equal(result.isError,true);if(code)assert.equal(result.structuredContent.code,code)}}
 async function fixture(family,mode){
  if(family==='api'){const ids=await seed(f.before,true),commandId='synthetic-old-mode-'+randomUUID();return {ids,commandId,stage:await reserve(ids,commandId),input:makeInput(f,commandId)}}
  const x=await scopedFixture(2050,mode==='legacy-inline-v1');return{x,ids:x.vIds,commandId:x.vf.commandId,stage:x.vStage,input:{commandId:x.vf.commandId,baseRevision:0,change:x.vf.input}}
 }
 async function assertExact(ids,stage,intent,prepared,expectedCount){
  assert.equal(await count(ids.userId),expectedCount);assert.deepEqual((await current(ids)).snapshot,prepared.input.snapshot)
  assert.deepEqual(await getIntent(stage),intent)
  const audit=(await record(ids))[expectedCount-1]
  for(const[key,value]of Object.entries(prepared.input.receiptContext))assert.deepEqual(audit.receipt[key],value)
  assert.deepEqual(audit.compensation,prepared.input.compensation??null);return audit
 }
 for(const to of ['a','b'])for(const family of ['api','scoped'])for(const mode of modes){
  const {x,ids,commandId,stage,input}=await fixture(family,mode)
  setDrop({path:'large_intent_admit'})
  failure(family,await call('legacy',family,ids,x,input,oldOptions(mode)),'WORKSPACE_UNAVAILABLE');assert.equal(getDrop(),undefined);assert.equal(await count(ids.userId),0)
  const intent=await getIntent(stage);assert(intent);const prepared=decodePreparedIntent(intent.encoded,8388608),offset=calls.length
  // Stop-new-admission is deliberately active during every recovery. The
  // constructor's source profile changes new mode but not authenticated bytes.
  const recovered=await call(to,family,ids,x,input,{admission:false});success(family,recovered)
  const audit=await assertExact(ids,stage,intent,prepared,1);await modeCheck(ids,commandId,mode)
  assert(!calls.slice(offset).some(c=>c.path.endsWith('large_intent_admit')))
  await receiptCheck(to,ids,commandId,audit)
  pass('historical103-'+mode+'-'+family+'-to-'+to+'-admission-stopped-recovery',{oldSource:'103d8c92c485f1e8fd5cba901e75b1de403fbc91',originalPreparedSha256:intent.encoded.sha256,originalManifestSha256:prepared.manifestSha256,originalDeadlineAt:prepared.deadlineAt,exactOriginalMode:mode,noReplacementAdmission:true,originalLongIds:family!=='scoped'||mode!=='legacy-inline-v1'})
  const undoId='synthetic-old-undo-'+randomUUID(),undoStage=await reserve(ids,undoId,family==='api'?'first_party_abandon':'opportunity_v3')
  const undoInput=family==='api'?{action:'undo',projection:'delta-v1',commandId:undoId,targetCommandId:commandId}:{commandId:undoId,targetCommandId:commandId,expectedCompensationFingerprint:audit.receipt.result.compensationFingerprint}
  setDrop({path:'large_documents_append',document:'metadata'})
  failure(family,await call('legacy',family,ids,x,undoInput,oldOptions(mode),true),'WORKSPACE_UNAVAILABLE');assert.equal(getDrop(),undefined)
  const undoIntent=await getIntent(undoStage);assert(undoIntent);const undoPrepared=decodePreparedIntent(undoIntent.encoded,8388608),undoOffset=calls.length
  const undone=await call(to,family,ids,x,undoInput,{admission:false},true);success(family,undone)
  await assertExact(ids,undoStage,undoIntent,undoPrepared,2);await modeCheck(ids,undoId,mode)
  assert(!calls.slice(undoOffset).some(c=>c.path.endsWith('large_intent_admit')))
  await receiptCheck(to,ids,commandId,audit)
  pass('historical103-original-Undo-'+mode+'-'+family+'-to-'+to+'-admission-stopped-recovery',{originalPreparedSha256:undoIntent.encoded.sha256,originalManifestSha256:undoPrepared.manifestSha256,originalDeadlineAt:undoPrepared.deadlineAt,exactOriginalMode:mode,noReplacementAdmission:true})
 }
 // R0p may read pages while its release profile still admits fragments.
 const readPreferred=await scopedFixture(2050),readInput={commandId:readPreferred.vf.commandId,baseRevision:0,change:readPreferred.vf.input}
 success('scoped',await scoped('a',readPreferred,'execute_opportunity_management',readInput,{pages:true}))
 await modeCheck(readPreferred.vIds,readPreferred.vf.commandId,'fragments-v1')
 const readAudit=(await record(readPreferred.vIds))[0],readOffset=calls.length
 await receiptCheck('a',readPreferred.vIds,readPreferred.vf.commandId,readAudit,{pages:true})
 assert(calls.slice(readOffset).some(c=>c.path.endsWith('read_audit_page')))
 pass('r0p-page-read-preference-keeps-fragment-new-admission',{admissionMode:'fragments-v1',readMode:'pages-v1'})
 // Admission-off is not permission to bypass durable admission with ephemeral
 // staging. New commands may be rejected; existing prepared recovery above runs.
 for(const release of ['a','b'])for(const family of ['api','scoped']){
  const {x,ids,input}=await fixture(family,release==='a'?'fragments-v1':'pages-v1'),offset=calls.length
  failure(family,await call(release,family,ids,x,input,{admission:false}),'WORKSPACE_UNAVAILABLE')
  assert.equal(await count(ids.userId),0);assert.equal((await current(ids)).revision,0)
  assert.equal((await db.query('select count(*)::int n from pjsdas_rows_candidate.large_command_intent where user_id=$1',[ids.userId])).rows[0].n,0)
  assert(!calls.slice(offset).some(c=>c.path.endsWith('large_intent_admit')||c.path.endsWith('large_documents_begin')||c.path.endsWith('large_documents_finish')))
  pass('new-durable-admission-stopped-'+family+'-'+release,{newIntent:false,newLedger:false,ephemeralBypass:false})
 }
 // A historical original grant remains binding. The recovery registry must not
 // turn the new runtime's lookup or current preference into replacement consent.
 for(const to of ['a','b']){
  const {x,ids,input,stage}=await fixture('scoped','pages-v1')
  setDrop({path:'large_intent_admit'});failure('scoped',await call('legacy','scoped',ids,x,input,oldOptions('pages-v1')),'WORKSPACE_UNAVAILABLE');assert.equal(getDrop(),undefined)
  const intent=await getIntent(stage),offset=calls.length
  await db.query('update pjsdas_business_management_grants set revoked_at=clock_timestamp() where id=$1',[x.grantId])
  failure('scoped',await call(to,'scoped',ids,x,input,{admission:false}),'AUTH_FORBIDDEN')
  assert.equal(await count(ids.userId),0);assert.deepEqual(await getIntent(stage),intent)
  assert(!calls.slice(offset).some(c=>c.path.endsWith('large_documents_begin')||c.path.endsWith('large_documents_finish')||c.path.endsWith('large_intent_admit')))
  pass('historical-page-intent-revoked-original-grant-denied-'+to,{noReplacementConsent:true,noPreparedWrite:true})
 }
}
