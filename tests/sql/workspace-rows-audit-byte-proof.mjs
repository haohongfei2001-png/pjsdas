/** Actual-entry proof extension. All data/credentials/servers are synthetic and
 * loopback-owned by the existing native fixture. Never a production migration. */
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { restoreOpportunityManagement } from '../../src/opportunityManagement.ts'
import { createTransactionalWorkspaceStore } from '../../gateway/transactionalWorkspaceStore.ts'
import { createAuditMeasure } from './workspace-rows-audit-measure.mjs'
import { PJSDAS_SUPABASE_URL } from '../../gateway/supabaseProject.ts'

const wire = x => JSON.parse(JSON.stringify(x))
const spoolNames = async () => (await readdir(tmpdir())).filter(x => x.startsWith('ta-audit-read-')).sort()
export async function runAuditByteProof(h) {
 const { db, scopedFixture, reserve, current, count, cold, coldPost, post, rpc, serviceToken, jwt, calls, reportTransport, oversized, auditHooks, entry, webOrigin } = h
 process.env.PJSDAS_WORKSPACE_ROWS_AUDIT_BYTES='1'
 const measure=createAuditMeasure(db,calls)
 const profile=process.env.TA_AUDIT_PROFILE_ONLY==='1',diagnostic=process.env.TA_AUDIT_DESCRIPTOR_DIAGNOSTIC==='1'
 const pages=process.env.TA_ROW_AUDIT_PAGES_PROOF==='1',fragmentRpc=pages?'read_audit_page':'read_audit_fragment',span=65536*(pages?16:1),middle=pages?1048576:65536
 process.env.PJSDAS_WORKSPACE_ROWS_AUDIT_PAGES=pages?'1':'0'
 const initialSpools=await spoolNames()
 const x=await scopedFixture(2050)
 assert.deepEqual(x.vf.before,oversized.vf.before,'EXACT retained long-ID fixture, not compact replacement')
 assert.deepEqual(x.vf.input,oversized.vf.input)
 const input={commandId:x.vf.commandId,baseRevision:0,change:x.vf.input},offset=calls.length,start=performance.now()
 const archiveMeasure=await measure.start('original-long-id-2050-v3-archive')
 const saved=await x.scoped.opportunity.invoke('execute_opportunity_management',input)
 await measure.end(archiveMeasure)
 assert.equal(saved.isError,undefined,JSON.stringify(saved));assert.equal(saved.structuredContent.outcome,'COMMITTED');assert.equal(await count(x.vIds.userId),1)
 reportTransport('original-long-id-2050-v3-archive',offset,performance.now()-start,saved)
 const after=await current(x.vIds),record=(await db.query('select to_jsonb(l) row from pjsdas_rows_internal.discovery_history l where user_id=$1',[x.vIds.userId])).rows[0].row
 const req=(await db.query('select request from pjsdas_rows_candidate.large_stage where id=$1',[x.vStage])).rows[0].request
 for(const [key,value] of Object.entries(req.receiptContext))assert.deepEqual(record.receipt[key],value)
 assert.deepEqual(record.compensation,req.compensation);assert.equal(record.receipt.contractVersion,5)
 const total=Number((await db.query('select octet_length(to_jsonb(l)::text) n from pjsdas_rows_internal.discovery_history l where user_id=$1',[x.vIds.userId])).rows[0].n)
 assert(total>=2105291)
 const replayMeasure=await measure.start('original-long-id-2050-v3-cold-replay')
 const replayOffset=calls.length,replay=await cold({mode:'scoped',userId:x.vIds.userId,clientId:x.clientId,tool:'execute_opportunity_management',body:input})
 await measure.end(replayMeasure)
 assert.equal(replay.isError,undefined,JSON.stringify(replay));assert.equal(replay.structuredContent.outcome,'ALREADY_APPLIED');assert.deepEqual(replay.structuredContent.result,saved.structuredContent.result)
 assert(calls.slice(replayOffset).some(c=>c.path.endsWith(fragmentRpc)));assert.equal(await count(x.vIds.userId),1)
 const receiptMeasure=await measure.start('original-long-id-2050-cold-api-receipt')
 const receipt=await coldPost(x.vIds,{action:'receipt',commandId:x.vf.commandId,projection:'delta-v1'})
 await measure.end(receiptMeasure)
 assert.equal(receipt.status,200,JSON.stringify(receipt));assert.equal(receipt.body.found,true)
 assert.deepEqual({...receipt.body.receipt,projectionDelta:receipt.body.delta},record.receipt)
 assert.deepEqual(await spoolNames(),initialSpools)
 console.log('PASS AUDIT_ORIGINAL_LONG_ID complete V5 exact fixture commits; cold scoped replay and cold original API receipt fetch complete original logical audit',JSON.stringify({totalSqlBytes:total,minimumReceiptCompensationBytes:2105291,contractVersion:5}))

 const authorization={userId:x.vIds.userId,principal:'delegated_mcp',family:'opportunity_v3',grantId:x.grantId,grantRevision:1,clientId:x.clientId}
 const store=()=>createTransactionalWorkspaceStore({supabaseUrl:PJSDAS_SUPABASE_URL,serviceRoleKey:serviceToken,auditReadAuthorization:authorization})
 const historyMeasure=await measure.start('original-long-id-2050-scoped-store-history')
 const history=await store().readCommandForUser(x.vIds.userId,x.vf.commandId)
 await measure.end(historyMeasure)
 assert.deepEqual(history.receipt,record.receipt);assert.deepEqual(history.compensation,record.compensation)
 if(!profile&&!diagnostic){
 // Wire faults reach the real actual endpoint; no fake row adapter or grant
 // resolver. Every partial spool must disappear on every rejected read.
 for(const kind of ['disconnect','bytes','identity','digest','offset','tail']) {
  auditHooks.push({match:(path,body)=>path.endsWith(fragmentRpc)&&body.byte_offset===middle,run:async({body})=>{
   if(kind==='disconnect')return 'disconnect'
   const p=JSON.parse(Buffer.from(body).toString()),part=pages?p.fragments[0]:p,descriptor=pages?p.document:p
   if(kind==='bytes'){const bytes=Buffer.from(part.base64,'base64');bytes[0]^=1;part.base64=bytes.toString('base64')}
   if(kind==='identity')descriptor.workspaceId=randomUUID()
   if(kind==='digest')descriptor.sha256='f'.repeat(64)
   if(kind==='offset')part.offset++
   if(kind==='tail')part.base64=Buffer.from(part.base64,'base64').subarray(0,7).toString('base64')
   return Buffer.from(JSON.stringify(p))
  }})
  const bad=await post(x.vIds,{action:'receipt',commandId:x.vf.commandId});assert.notEqual(bad.status,200,kind);assert.equal(auditHooks.length,0)
  assert.deepEqual(await spoolNames(),initialSpools,kind);assert.equal(await count(x.vIds.userId),1)
 }
 console.log('PASS AUDIT_FAULTS original API rejects disconnect/changed bytes/wrong identity/digest/gap/short chunk and removes every provisional spool')

 for(const kind of ['revision','epoch']) {
  const prior=(await db.query('select epoch,revision from pjsdas_rows_candidate.head where id=$1',[x.vIds.workspaceId])).rows[0]
  auditHooks.push({match:(path,body)=>path.endsWith(fragmentRpc)&&body.byte_offset===middle,run:async()=>{
   await db.query(kind==='revision'?'update pjsdas_rows_candidate.head set revision=revision+1 where id=$1':'update pjsdas_rows_candidate.head set epoch=$2 where id=$1',kind==='revision'?[x.vIds.workspaceId]:[x.vIds.workspaceId,randomUUID()])
  }})
  const bad=await post(x.vIds,{action:'receipt',commandId:x.vf.commandId});assert.equal(bad.status,409,JSON.stringify(bad));assert.equal(auditHooks.length,0);assert.deepEqual(await spoolNames(),initialSpools)
  await db.query('update pjsdas_rows_candidate.head set epoch=$2,revision=$3 where id=$1',[x.vIds.workspaceId,prior.epoch,prior.revision])
 }
 // Change only AFTER the last fragment, proving the final fence is essential.
 auditHooks.push({match:(path,body)=>path.endsWith(fragmentRpc)&&body.byte_offset+span>=total,run:async()=>{await db.query('update pjsdas_rows_candidate.head set revision=revision+1 where id=$1',[x.vIds.workspaceId])}})
 assert.equal((await post(x.vIds,{action:'receipt',commandId:x.vf.commandId})).status,409);assert.deepEqual(await spoolNames(),initialSpools)
 await db.query('update pjsdas_rows_candidate.head set revision=1 where id=$1',[x.vIds.workspaceId])
 console.log('PASS AUDIT_GENERATION concurrent revision/epoch and post-last-byte revision changes reject provisional complete bytes')

 for(const finalOnly of [false,true]) {
  auditHooks.push({match:(path,body)=>path.endsWith(fragmentRpc)&&(finalOnly?body.byte_offset+span>=total:body.byte_offset===middle),run:async()=>{await db.query('update pjsdas_business_management_grants set revoked_at=clock_timestamp() where id=$1',[x.grantId])}})
  const denied=await x.scoped.opportunity.invoke('execute_opportunity_management',input);assert.equal(denied.isError,true);assert.equal(denied.structuredContent.code,'AUTH_FORBIDDEN',JSON.stringify(denied));assert.deepEqual(await spoolNames(),initialSpools)
  await db.query('update pjsdas_business_management_grants set revoked_at=null where id=$1',[x.grantId])
 }
 console.log('PASS AUDIT_AUTHORITY original scoped grant is rechecked before fragments and after all bytes; revocation never releases a replay')

 const controller=new AbortController()
 auditHooks.push({match:(path,body)=>path.endsWith(fragmentRpc)&&body.byte_offset===middle,run:async()=>{controller.abort()}})
 const cancelled=await entry.fetch(new Request('https://synthetic.invalid/api/workspace',{method:'POST',signal:controller.signal,headers:{origin:webOrigin,authorization:'Bearer '+jwt({role:'authenticated',sub:x.vIds.userId}),'content-type':'application/json'},body:JSON.stringify({action:'receipt',commandId:x.vf.commandId})}))
 assert.equal(cancelled.status,503);assert.deepEqual(await spoolNames(),initialSpools)
 console.log('PASS AUDIT_CANCEL caller abort cancels current HTTP fragment and removes provisional disk bytes')
 const delayedReplies=[]
 for(const [byte_offset,delay] of [[0,6000],[middle,5000]]) {
  let finish;delayedReplies.push(new Promise(r=>{finish=r}))
  auditHooks.push({match:(path,body)=>path.endsWith(fragmentRpc)&&body.byte_offset===byte_offset,run:async()=>{await new Promise(r=>setTimeout(r,delay));setTimeout(finish,0)}})
 }
 const timeoutStart=performance.now(),timedOut=await post(x.vIds,{action:'receipt',commandId:x.vf.commandId}),timeoutMs=performance.now()-timeoutStart
 assert.equal(timedOut.status,503);assert(timeoutMs>=9000&&timeoutMs<11000,JSON.stringify({timeoutMs}));assert.equal(auditHooks.length,0);assert.deepEqual(await spoolNames(),initialSpools)
 await Promise.all(delayedReplies) // drain this owned disconnected proxy response before measuring the next invocation
 console.log('PASS AUDIT_TOTAL_READ_DEADLINE two sub-10s fragment waits cannot reset the one10s whole-read signal',JSON.stringify({elapsedMs:Math.round(timeoutMs),originalReadBudgetMs:10000}))

 }
 // Read the exact original complete compensation through the actual scoped
 // factory in a brand-new process, then the ORIGINAL protected Undo path.
 const undo='synthetic-original-long-id-undo';await reserve(x.vIds,undo,'opportunity_v3')
 const undoMeasure=await measure.start('original-long-id-2050-v3-cold-undo')
 const undoOffset=calls.length,undoStart=performance.now(),undone=await cold({mode:'scoped',userId:x.vIds.userId,clientId:x.clientId,tool:'restore_opportunity_management',body:{commandId:undo,targetCommandId:x.vf.commandId,expectedCompensationFingerprint:record.receipt.result.compensationFingerprint}})
 await measure.end(undoMeasure)
 assert.equal(undone.isError,undefined,JSON.stringify(undone));assert.equal(undone.structuredContent.outcome,'COMMITTED');assert.equal(await count(x.vIds.userId),2)
 reportTransport('original-long-id-2050-v3-undo',undoOffset,performance.now()-undoStart,undone)
 const restored=await current(x.vIds)
 assert.deepEqual(restored.snapshot,wire(restoreOpportunityManagement(after.snapshot,record.compensation,new Date(restored.snapshot.exportedAt))))
 assert.equal(calls.slice(undoOffset).filter(c=>c.path.endsWith(fragmentRpc)).length,Math.ceil(total/span),'lookup and Undo share only the same fully verified audit, with fresh original authority/descriptor/fences')
 assert(calls.slice(undoOffset).some(c=>c.path.endsWith('large_documents_finish')))
 assert.deepEqual(await spoolNames(),initialSpools)
 const last=await coldPost(x.vIds,{action:'receipt',commandId:x.vf.commandId});assert.equal(last.status,200);assert.deepEqual({...last.body.receipt,projectionDelta:last.body.delta},record.receipt)
 console.log('PASS AUDIT_ORIGINAL_UNDO cold real scoped restore reads complete compensation, stages original2052-effect Undo and preserves original receipt after newer revision')
 if(diagnostic){const {runAuditDescriptorDiagnostic}=await import('./workspace-rows-audit-descriptor-diagnostic.mjs');await runAuditDescriptorDiagnostic({...h,x,record});return}
 if(profile){console.log('AUDIT_PROFILE_ONLY_PASS',JSON.stringify({pages,total,originalFixture:true,statsControl:'autovacuum off in disposable schema; full ANALYZE before each measured phase',completeFaultSuiteNotRun:true}));return}
 authorization.grantRevision=Number((await db.query('select revision from pjsdas_business_management_grants where id=$1',[x.grantId])).rows[0].revision)
 const mixed=await store().readCommandsAfterRevision(x.vIds.userId,0)
 assert.equal(mixed.length,2);assert.deepEqual(mixed[0].receipt,record.receipt);assert.deepEqual(mixed[0].compensation,record.compensation);assert.equal(mixed[1].operation,'undo_command')
 assert.deepEqual(await spoolNames(),initialSpools)
 console.log('PASS AUDIT_HISTORY actual store after-revision history mixes oversized original audit and inline original Undo without truncation')
 const reference=await rpc('pjsdas_rows_v1_read_history',{target_user_id:x.vIds.userId,target_epoch:x.vIds.epoch,target_revision:2,query:{mode:'command',commandId:x.vf.commandId,auditProtocol:'workspace-audit-bytes-v1',auditAuthorization:authorization}})
 assert.equal(reference.status,200);const originalDocument=reference.body.rows[0].auditDocument
 for(const [field,value] of [['userId',randomUUID()],['workspaceId',randomUUID()],['epoch',randomUUID()],['revision',1],['commandId','synthetic-foreign-command'],['sha256','f'.repeat(64)],['totalBytes',total-1],['resultingRevision',0]]) {
  const refused=await rpc('pjsdas_rows_v1_read_audit_fragment',{document:{...originalDocument,[field]:value},byte_offset:0,proof:authorization})
  assert([403,409].includes(refused.status)||refused.status===200&&refused.body.outcome==='CONFLICT',JSON.stringify({field,refused}));assert.equal(refused.body.base64,undefined)
 }
 for(const byte_offset of [-1,1,total,Number.MAX_SAFE_INTEGER])assert.equal((await rpc('pjsdas_rows_v1_read_audit_fragment',{document:originalDocument,byte_offset,proof:authorization})).status,400)
 const wrongGrant=await rpc('pjsdas_rows_v1_read_audit_fragment',{document:originalDocument,byte_offset:0,proof:{...authorization,grantRevision:authorization.grantRevision+1}})
 assert.equal(wrongGrant.status,403);assert.equal(wrongGrant.body.base64,undefined)
 console.log('PASS AUDIT_SQL_BINDING owner/workspace/epoch/current/resulting revision/command/SHA/size/offset/original grant mismatch refuses before bytes')

 const retainedId='synthetic-retained-only-large-audit',retainedReceipt={...record.receipt,commandId:retainedId,unknownForward:{unicode:'未来😀"\\',empty:[],optional:null}}
 await db.query("insert into public.pjsdas_command_ledger(workspace_id,user_id,command_id,operation,payload_hash,principal_kind,status,resulting_revision,receipt,compensation) values($1,$2,$3,'opportunity_management',$4,'delegated_mcp','COMMITTED',1,$5,$6)",[x.vIds.workspaceId,x.vIds.userId,retainedId,'b'.repeat(64),retainedReceipt,record.compensation])
 const retained=await coldPost(x.vIds,{action:'receipt',commandId:retainedId});assert.equal(retained.status,200,JSON.stringify(retained));assert.deepEqual({...retained.body.receipt,projectionDelta:retained.body.delta},retainedReceipt)
 await db.query("insert into public.pjsdas_command_ledger(workspace_id,user_id,command_id,operation,payload_hash,principal_kind,status,resulting_revision,receipt,compensation) values($1,$2,$3,'planning_management',$4,'delegated_mcp','COMMITTED',1,$5,$6)",[x.vIds.workspaceId,x.vIds.userId,x.vf.commandId,'c'.repeat(64),record.receipt,record.compensation])
 const beforeCollision=calls.length,collision=await post(x.vIds,{action:'receipt',commandId:x.vf.commandId});assert.equal(collision.status,403);assert(!calls.slice(beforeCollision).some(c=>c.path.endsWith(fragmentRpc)))
 await db.query('delete from public.pjsdas_command_ledger where user_id=$1 and command_id=$2',[x.vIds.userId,x.vf.commandId]);assert.deepEqual(await spoolNames(),initialSpools)
 console.log('PASS AUDIT_RETAINED legacy-only complete oversized audit/unknown fields remain readable; split-store collision denies before any byte fragment')

 const edgeId='synthetic-near-old-page-cap',edgeReceipt={commandId:edgeId,operation:'opportunity_management',status:'COMMITTED',contractVersion:5,unknownForward:''}
 await db.query("insert into public.pjsdas_command_ledger(workspace_id,user_id,command_id,operation,payload_hash,principal_kind,status,resulting_revision,receipt) values($1,$2,$3,'opportunity_management',$4,'delegated_mcp','COMMITTED',2,$5)",[x.vIds.workspaceId,x.vIds.userId,edgeId,'e'.repeat(64),edgeReceipt])
 const baseBytes=Number((await db.query('select octet_length(to_jsonb(l)::text) n from pjsdas_rows_internal.discovery_history l where user_id=$1 and command_id=$2',[x.vIds.userId,edgeId])).rows[0].n)
 edgeReceipt.unknownForward='x'.repeat(2097100-baseBytes)
 await db.query('update public.pjsdas_command_ledger set receipt=$3 where user_id=$1 and command_id=$2',[x.vIds.userId,edgeId,edgeReceipt])
 const firstParty={userId:x.vIds.userId,principal:'first_party_web'}
 const edgeRef=await rpc('pjsdas_rows_v1_read_history',{target_user_id:x.vIds.userId,target_epoch:x.vIds.epoch,target_revision:2,query:{mode:'command',commandId:edgeId,auditProtocol:'workspace-audit-bytes-v1',auditAuthorization:firstParty}})
 assert.equal(edgeRef.status,200);assert.equal(edgeRef.body.auditProtocol,'workspace-audit-bytes-v1');assert.equal(edgeRef.body.rows[0].auditDocument.totalBytes,2097100)
 assert(Buffer.byteLength(JSON.stringify(edgeRef.body))<2097152)
 const edge=await coldPost(x.vIds,{action:'receipt',commandId:edgeId});assert.equal(edge.status,200);assert.deepEqual(edge.body.receipt,edgeReceipt)
 console.log('PASS AUDIT_WIRE_BOUNDARY formerly legal near-2MiB inline row uses exact-envelope-aware reference without increasing old body/page caps')

 // Actual blocked lock observation: a writer holding original grant may take
 // head; a reader must still be waiting on grant, never hold head first.
 authorization.grantRevision=Number((await db.query('select revision from pjsdas_business_management_grants where id=$1',[x.grantId])).rows[0].revision)
 await db.query('begin');await db.query('select 1 from pjsdas_business_management_grants where id=$1 for update',[x.grantId])
 const waiting=rpc('pjsdas_rows_v1_read_audit_fence',{target_user_id:x.vIds.userId,target_workspace_id:x.vIds.workspaceId,target_epoch:x.vIds.epoch,target_revision:2,proof:authorization})
 let observed=false
 try {
  for(let n=0;n<100;n++){await db.query('select pg_stat_clear_snapshot()');if((await db.query("select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%pjsdas_rows_v1_read_audit_fence%' and pid<>pg_backend_pid()")).rows[0].n){observed=true;break}await new Promise(r=>setTimeout(r,10))}
  assert(observed,'reader really waits on original grant');await db.query('select 1 from pjsdas_rows_candidate.head where id=$1 for update nowait',[x.vIds.workspaceId])
  await db.query('update pjsdas_business_management_grants set revoked_at=clock_timestamp() where id=$1',[x.grantId]);await db.query('commit')
 } finally { await db.query('rollback') }
 assert.equal((await waiting).status,403)
 await db.query('update pjsdas_business_management_grants set revoked_at=null where id=$1',[x.grantId]);assert.deepEqual(await spoolNames(),initialSpools)
 console.log('PASS AUDIT_LOCK_ORDER observed grant-before-head read fence wait; concurrent writer acquires head without deadlock and changed authority rejects')

 // Required installed reader missing: zero-row lookups still pass, but the
 // original atomic finalizer must roll back instead of publishing unreadable
 // immutable evidence. This is a disposable local schema only.
 const missing=await scopedFixture(2050),signature='public.pjsdas_rows_v1_read_audit_fragment(jsonb,bigint,jsonb)'
 const definition=(await db.query('select pg_get_functiondef($1::regprocedure) body',[signature])).rows[0].body
 await db.query('drop function '+signature)
 const refused=await missing.scoped.opportunity.invoke('execute_opportunity_management',{commandId:missing.vf.commandId,baseRevision:0,change:missing.vf.input})
 assert.equal(refused.isError,true);assert.equal(refused.structuredContent.code,'WORKSPACE_INVALID',JSON.stringify(refused));assert.equal(await count(missing.vIds.userId),0);assert.equal((await current(missing.vIds)).revision,0)
 await db.query(definition);await db.query('revoke all on function '+signature+' from public,anon,authenticated;grant execute on function '+signature+' to service_role')
 console.log('PASS AUDIT_READER_CAPABILITY missing public fragment implementation atomically refuses unreadable immutable audit publication')
 for(const role of ['anon','authenticated'])assert([401,403].includes((await rpc('pjsdas_rows_v1_read_audit_fragment',{document:{},byte_offset:0,proof:{}},jwt({role}))).status))
 if(pages){const {runAuditPageCounterexamples}=await import('./workspace-rows-audit-page-proof.mjs');await runAuditPageCounterexamples({...h,x,record,total,authorization,initialSpools})}
 console.log('AUDIT_BYTES_REAL_ENTRY_PASS',JSON.stringify({originalLongIds:true,totalSqlBytes:total,pages,defaultOff:true,productionEligibility:false}))
}
