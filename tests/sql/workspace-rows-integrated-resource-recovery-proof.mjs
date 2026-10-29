/** Resource ON x three saved modes x actual API/scoped x original Undo.
 * Fresh synthetic policy per invocation; never increases admitted reservations.
 * Runs separately for the integrated runtime and fixed full R0p recovery.
 * This is not historical-103 provenance (the separate 81-case pair owns that).
 */
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {decodePreparedIntent} from '../../gateway/workspaceRowsDurableIntent.ts'

export async function runIntegratedResourceRecoveryProof(c){
 const {db,seed,reserve,scopedFixture,cold,calls,count,current,f,incoming,jwt,webOrigin,setDrop,getDrop}=c
 const target=process.env.TA_INTEGRATION_RECOVERY_TARGET
 assert(['integrated','r0p'].includes(target),'explicit frozen recovery target required')
 const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0]
 const intent=async stage=>scalar('select * from pjsdas_rows_candidate.large_command_intent where stage_id=$1',[stage])
 const reservation=async stage=>scalar('select * from ta_resource_reservations.reservation where stage_id=$1',[stage])
 const ledger=async ids=>(await db.query('select command_id,receipt,compensation,resulting_revision from pjsdas_rows_candidate.ledger where user_id=$1 order by resulting_revision',[ids.userId])).rows
 assert.equal((await scalar('select count(*)::int n from ta_resource_reservations.pool')).n,0)
 assert.equal((await scalar('select count(*)::int n from ta_resource_reservations.rpc_scope')).n,0)
 await db.query(`insert into ta_resource_reservations.pool(singleton,enabled,command_limit,owner_limit,global_limit,generation,inventory_verified,inventory_revision)
 values(true,true,16777216,33554432,276824064,'rpc-local-v1',true,0)`)
 // These are the SAME explicit synthetic positive-case limits as 12fa444.
 // Twelve fresh admissions hold 192 MiB of the fixture's 264 MiB global pool.
 const env=mode=>({PJSDAS_WORKSPACE_ROWS_STAGED_DOCUMENTS:'1',PJSDAS_WORKSPACE_ROWS_DURABLE_INTENT:'1',
  PJSDAS_WORKSPACE_ROWS_DURABLE_INTENT_ADMISSION:'1',PJSDAS_WORKSPACE_ROWS_AUDIT_BYTES:mode==='legacy-inline-v1'?'0':'1',
  PJSDAS_WORKSPACE_ROWS_AUDIT_PAGES:mode==='pages-v1'?'1':'0',
  ...(mode==='legacy-inline-v1'?{}:{PJSDAS_WORKSPACE_ROWS_RELEASE_PROFILE:mode==='pages-v1'?'compatible-pages-v1':'compatible-fragments-v1'})})
 const recoveryEnv={...env(target==='r0p'?'fragments-v1':'pages-v1'),PJSDAS_WORKSPACE_ROWS_DURABLE_INTENT_ADMISSION:'0'}
 async function priorReservation(ids,command,family){
  const stage=await reserve(ids,command,family)
  assert.equal(await intent(stage),undefined,'prior reservation only, before original admission')
  assert.equal(await reservation(stage),undefined,'no resource admission can be enlarged')
  await db.query('update pjsdas_rows_candidate.large_document_reservation set reserved_bytes=16777216 where stage_id=$1',[stage])
  return stage
 }
 async function fixture(family,mode){
  if(family==='api'){
   const ids=await seed(f.before,true),command='integration-resource-'+randomUUID(),stage=await priorReservation(ids,command)
   await db.query('insert into ta_resource_reservations.rpc_scope values($1)',[ids.userId])
   return{ids,command,stage,input:{...incoming,commandId:command,command:{type:'domain',value:{...incoming.command.value,commandId:command}}}}
  }
  const x=await scopedFixture(2050,mode==='legacy-inline-v1')
  assert.equal(await intent(x.vStage),undefined)
  await db.query('update pjsdas_rows_candidate.large_document_reservation set reserved_bytes=16777216 where stage_id=$1',[x.vStage])
  await db.query('insert into ta_resource_reservations.rpc_scope values($1)',[x.vIds.userId])
  return{x,ids:x.vIds,command:x.vf.commandId,stage:x.vStage,input:{commandId:x.vf.commandId,baseRevision:0,change:x.vf.input}}
 }
 async function invoke(t,family,input,release,options,undo=false){
  const common={integrationRelease:release,integrationEnv:options,body:input}
  return cold(family==='api'?{...common,headers:{origin:webOrigin,authorization:'Bearer '+jwt({role:'authenticated',sub:t.ids.userId}),'content-type':'application/json'}}:
   {...common,mode:'scoped',userId:t.ids.userId,clientId:t.x.clientId,tool:undo?'restore_opportunity_management':'execute_opportunity_management'})
 }
 function success(family,result,outcome){
  if(family==='api'){assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.outcome,outcome)}
  else{assert.equal(result.isError,undefined,JSON.stringify(result));assert.equal(result.structuredContent.outcome,outcome)}
 }
 function interrupted(family,result){
  if(family==='api'){assert.equal(result.status,503,JSON.stringify(result));assert.equal(result.body.code,'WORKSPACE_UNAVAILABLE')}
  else{assert.equal(result.isError,true);assert.equal(result.structuredContent.code,'WORKSPACE_UNAVAILABLE')}
  assert.equal(getDrop(),undefined,'original interruption hook must be consumed')
 }
 function sameReplay(family,initial,replay){
  if(family==='api'){assert.deepEqual(replay.body.receipt,initial.body.receipt);assert.deepEqual(replay.body.delta,initial.body.delta)}
  else assert.deepEqual(replay.structuredContent.result,initial.structuredContent.result)
 }
 async function inventory(stage,r){
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
  assert.deepEqual(accounted,physical,'all independent original-table representations charged exactly')
  assert.equal(physical.reduce((n,x)=>n+BigInt(x.bytes),0n),BigInt(r.present))
  for(const user of [r.user_id,null]){
   const rows=(await db.query('select reserved,occupied,present from ta_resource_reservations.reservation'+(user?' where user_id=$1':''),user?[user]:[])).rows
   const totals={held:rows.reduce((n,x)=>n+BigInt(x.reserved),0n),occupied:rows.reduce((n,x)=>n+BigInt(x.occupied),0n),present:rows.reduce((n,x)=>n+BigInt(x.present),0n)}
   const aggregate=await scalar('select held,occupied,present from ta_resource_reservations.'+(user?'owner where user_id=$1':'pool'),user?[user]:[])
   for(const key of Object.keys(totals))assert.equal(BigInt(aggregate[key]),totals[key])
  }
  console.log('INTEGRATED_RESOURCE_REPRESENTATIONS',JSON.stringify({stage,representations:physical,occupied:r.occupied,peak:r.rpc_peak_occupied,notPhysicalStorageOrMemory:true}))
 }
 async function exact(stage,saved,resource,expectedCount,t,mode){
  assert.deepEqual(await intent(stage),saved,'all original encoded bytes, binding, authority and absolute deadline unchanged')
  const prepared=decodePreparedIntent(saved.encoded,8388608),r=await reservation(stage)
  for(const key of ['stage_id','user_id','command_id','binding','reserved','deadline_at','expires_at'])assert.deepEqual(r[key],resource[key],key)
  assert.equal(r.phase,'committed');assert.equal(r.reserved,'16777216');assert.equal(r.present,r.occupied)
  assert(BigInt(r.present)<=BigInt(r.reserved));assert(BigInt(r.rpc_peak_occupied)>=BigInt(r.occupied))
  assert.equal(await count(t.ids.userId),expectedCount)
  const state=await current(t.ids);assert.equal(state.revision,expectedCount);assert.deepEqual(state.snapshot,prepared.input.snapshot)
  const records=await ledger(t.ids),record=records[expectedCount-1]
  assert.equal(Number(record.resulting_revision),expectedCount);assert.equal(record.receipt.revision,expectedCount);assert.equal(r.outcome.revision,expectedCount)
  assert.equal(record.receipt.contractVersion,5);assert(record.receipt.projectionDelta)
  for(const[key,value]of Object.entries(prepared.input.receiptContext))assert.deepEqual(record.receipt[key],value)
  assert.deepEqual(record.compensation,prepared.input.compensation??null)
  const stored=await scalar('select s.request,b.manifest_sha256 from pjsdas_rows_candidate.large_stage s join pjsdas_rows_candidate.large_document_bundle b on b.stage_id=s.id where s.id=$1',[stage])
  assert.equal(stored.manifest_sha256,saved.binding.manifestSha256)
  assert.equal(stored.request.auditReadPageProtocol,mode==='pages-v1'?'workspace-audit-page-v1':undefined)
  assert.equal(stored.request.auditReadProtocol,mode==='legacy-inline-v1'?undefined:'workspace-audit-bytes-v1')
  assert.equal((await scalar('select count(*)::int n from ta_resource_reservations.temporary_bytes')).n,0)
  await inventory(stage,r)
  return record
 }
 let passed=0
 for(const family of ['api','scoped'])for(const mode of ['legacy-inline-v1','fragments-v1','pages-v1']){
  const t=await fixture(family,mode),offset=calls.length
  setDrop({path:'large_intent_admit'})
  interrupted(family,await invoke(t,family,t.input,'integrated',env(mode)))
  assert.equal(await count(t.ids.userId),0)
  assert.equal(calls.slice(offset).filter(x=>x.path.endsWith('large_intent_admit')).length,1)
  const saved=await intent(t.stage),resource=await reservation(t.stage),held=(await scalar('select held from ta_resource_reservations.pool')).held,start=calls.length
  assert(saved&&resource);assert.equal(resource.deadline_at,saved.deadline_at)
  const recovered=await invoke(t,family,t.input,target,recoveryEnv);success(family,recovered,'COMMITTED')
  const audit=await exact(t.stage,saved,resource,1,t,mode)
  const receipt=await invoke(t,'api',{action:'receipt',commandId:t.command,projection:'delta-v1'},target,recoveryEnv)
  assert.equal(receipt.status,200,JSON.stringify(receipt));assert.deepEqual({...receipt.body.receipt,projectionDelta:receipt.body.delta},audit.receipt)
  if(family==='api')assert.deepEqual({...recovered.body.receipt,projectionDelta:recovered.body.delta},audit.receipt)
  assert.equal((await scalar('select held from ta_resource_reservations.pool')).held,held)
  assert(!calls.slice(start).some(x=>x.path.endsWith('large_intent_admit')),'resource recovery cannot readmit')
  const replayOffset=calls.length,replayResource=await reservation(t.stage)
  const replay=await invoke(t,family,t.input,target,recoveryEnv);success(family,replay,'ALREADY_APPLIED');sameReplay(family,recovered,replay)
  assert.deepEqual(await reservation(t.stage),replayResource)
  assert(!calls.slice(replayOffset).some(x=>x.path.endsWith('large_intent_admit')))
  console.log('PASS_INTEGRATED_RESOURCE_RECOVERY',JSON.stringify({family,mode,target,phase:'forward',originalDeadline:saved.deadline_at,manifest:saved.binding.manifestSha256,noReplacementAdmission:true,held}));passed++
  const undo='integration-resource-undo-'+randomUUID(),undoStage=await priorReservation(t.ids,undo,family==='api'?'first_party_abandon':'opportunity_v3')
  const undoInput=family==='api'?{action:'undo',projection:'delta-v1',commandId:undo,targetCommandId:t.command}:{commandId:undo,targetCommandId:t.command,expectedCompensationFingerprint:audit.receipt.result.compensationFingerprint}
  const undoOffset=calls.length;setDrop({path:'large_documents_append',document:'metadata'})
  interrupted(family,await invoke(t,family,undoInput,'integrated',env(mode),true))
  assert.equal(await count(t.ids.userId),1)
  assert.equal(calls.slice(undoOffset).filter(x=>x.path.endsWith('large_intent_admit')).length,1)
  const undoSaved=await intent(undoStage),undoResource=await reservation(undoStage),undoHeld=(await scalar('select held from ta_resource_reservations.pool')).held,resumeOffset=calls.length
  const undone=await invoke(t,family,undoInput,target,recoveryEnv,true);success(family,undone,'COMMITTED')
  const undoAudit=await exact(undoStage,undoSaved,undoResource,2,t,mode)
  const undoReceipt=await invoke(t,'api',{action:'receipt',commandId:undo,projection:'delta-v1'},target,recoveryEnv)
  assert.equal(undoReceipt.status,200,JSON.stringify(undoReceipt));assert.deepEqual({...undoReceipt.body.receipt,projectionDelta:undoReceipt.body.delta},undoAudit.receipt)
  if(family==='api')assert.deepEqual({...undone.body.receipt,projectionDelta:undone.body.delta},undoAudit.receipt)
  assert.deepEqual((await ledger(t.ids))[0],audit,'protected original audit is retained after original Undo')
  assert.equal((await scalar('select held from ta_resource_reservations.pool')).held,undoHeld)
  assert(!calls.slice(resumeOffset).some(x=>x.path.endsWith('large_intent_admit')))
  const undoReplayResource=await reservation(undoStage),undoReplayOffset=calls.length
  const undoReplay=await invoke(t,family,undoInput,target,recoveryEnv,true);success(family,undoReplay,'ALREADY_APPLIED');sameReplay(family,undone,undoReplay)
  assert.deepEqual(await reservation(undoStage),undoReplayResource)
  assert(!calls.slice(undoReplayOffset).some(x=>x.path.endsWith('large_intent_admit')))
  console.log('PASS_INTEGRATED_RESOURCE_RECOVERY',JSON.stringify({family,mode,target,phase:'original-undo',originalDeadline:undoSaved.deadline_at,manifest:undoSaved.binding.manifestSha256,noReplacementAdmission:true,held:undoHeld}));passed++
 }
 assert.equal(passed,12)
 assert.equal((await scalar('select held from ta_resource_reservations.pool')).held,String(12*16777216))
 console.log('INTEGRATED_RESOURCE_RECOVERY_PASS',JSON.stringify({target,assertionGroups:passed,localSyntheticOnly:true,noReclaim:true,productionEligible:false}))
}
