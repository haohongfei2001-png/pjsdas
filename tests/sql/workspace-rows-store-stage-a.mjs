import { testControlledRowWorker } from './workspace-rows-worker-stage-a.mjs'
import { createAiCaptureLedger } from '../../gateway/aiCaptureLedger.ts'
import { createDiscoveryReadinessReader } from '../../gateway/discoveryReadinessReader.ts'
import { createScopedManagementGrantReader } from '../../gateway/scopedManagementGrantStore.ts'
import { scopedManagementConsentHash } from '../../gateway/scopedManagementConsent.ts'
import { getPlanningManagementRead, planningManagementFingerprint } from '../../src/planningManagement.ts'
import { diffWorkspaceRows } from '../../gateway/workspaceRowsCodec.ts'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { encodeWorkspaceRows } from '../../gateway/workspaceRowsCodec.ts'
import { createWorkspaceRowsStoreBridge } from '../../gateway/workspaceRowsStoreBridge.ts'
import { createTransactionalWorkspaceStore } from '../../gateway/transactionalWorkspaceStore.ts'
import { createTransactionalWorkspaceSource } from '../../gateway/transactionalWorkspaceSource.ts'
import { createAuthoritativeCommandExecutor } from '../../gateway/authoritativeCommands.ts'
import { createSnapshot, upgradeSnapshotToLatest } from '../../src/snapshot.ts'
import { applyGmailSemanticBatch } from '../../src/gmailSemanticIntake.ts'
const equal=(a,b)=>assert(isDeepStrictEqual(JSON.parse(JSON.stringify(a)),JSON.parse(JSON.stringify(b))),'actual store complete wire equality')

export async function testActualStoreRows({db,origin,token,initial,records,rpcTransport,runtime=false}) {
 initial=createSnapshot({...initial.data,actions:[{id:'synthetic-store-task',opportunityId:initial.data.opportunities[0].id,kind:'manual',title:'Synthetic manual task',dueAt:'2030-01-03T12:00:00Z',timingMode:'fixed',estimatedMinutes:30,leverage:50,delayCost:50,status:'todo',createdAt:initial.exportedAt,updatedAt:initial.exportedAt}]},initial.exportedAt)
 const userId=randomUUID(),encoded=encodeWorkspaceRows(initial)
 await db.query('insert into auth.users(id) values($1)',[userId])
 const workspaceId=(await db.query('insert into public.pjsdas_workspaces(user_id,snapshot,schema_version) values($1,$2,4) returning id',[userId,initial])).rows[0].id
 const epoch=(await db.query('insert into pjsdas_rows_candidate.head(id,user_id,envelope,manifest,legacy_snapshot) values($1,$2,$3,$4,$5) returning epoch',[workspaceId,userId,encoded.envelope,JSON.stringify(encoded.manifest),initial])).rows[0].epoch
 await db.query('insert into pjsdas_rows_candidate.item select $1,$2,x.collection,x.id,x.ordinal,x.value,0 from jsonb_to_recordset($3) as x(collection text,id text,ordinal bigint,value jsonb)',[workspaceId,userId,JSON.stringify(encoded.rows)])
 await db.query('update public.pjsdas_workspaces set row_candidate_epoch=$2 where user_id=$1',[userId,epoch])
 const publicFetch=(url,init={})=>{if(runtime){candidateCalls.push({url:String(url),body:init.body});if(/\/rpc\/(?:pjsdas_rows_v1_)?commit_/.test(String(url)))commitSizes.push(Buffer.byteLength(init.body))}const headers=new Headers(init.headers);headers.set('accept-profile','public');headers.set('content-profile','public');return fetch(String(url).replace('/rest/v1/','/'),{...init,headers})}
 const commitSizes=[], candidateCalls=[]
 const bridge=createWorkspaceRowsStoreBridge({supabaseUrl:origin,serviceRoleKey:token,readsEnabled:true,writesEnabled:true,rpcTransport,fetchImpl:async(url,init)=>{
  candidateCalls.push({url:String(url),body:init.body})
  if(/\/rpc\/(?:pjsdas_rows_v1_)?commit_/.test(String(url)))commitSizes.push(Buffer.byteLength(init.body))
  return fetch(String(url).replace('/rest/v1/','/'),init)
 }})
 const config={supabaseUrl:origin,serviceRoleKey:token,fetchImpl:publicFetch,...(runtime?{}:bridge),emptyGmailCheckpointReads:true,emptyGmailCheckpoints:true}
 const store=createTransactionalWorkspaceStore(config),executor=createAuthoritativeCommandExecutor(config),principal={kind:'first_party_web',userId}
 const preference={commandId:'synthetic-store-preference',baseRevision:0,command:{type:'domain',value:{commandId:'synthetic-store-preference',kind:'set_opportunity_preference',opportunityId:initial.data.opportunities[0].id,roleType:'backup'}}}
 const applied=await executor.execute(principal,preference);assert.equal(applied.outcome,'COMMITTED');assert.equal(applied.revision,1)
 assert.equal(applied.snapshot.data.opportunities[0].roleType,'backup')
 const gmail=createTransactionalWorkspaceSource({...config,userId,principalKind:'automation',sourceId:'gmail:primary',timezone:'UTC'})
 const read=await gmail.read(),core=applyGmailSemanticBatch(read.snapshot,{runId:'synthetic-store-nonempty',sourceId:'gmail:primary',checkedAt:'2030-01-01T00:00:00.000Z',records,authorized:true,workspaceRevision:read.context.workspaceVersion})
 const writeInput={snapshot:core.snapshot,expectedWorkspaceVersion:read.context.workspaceVersion,command:{commandId:'synthetic-store-nonempty',operation:'gmail_semantic_intake',payload:{runId:'synthetic-store-nonempty'},compensation:core.compensation}}
 // Preserve the existing authoritative store normalization contract, not a new raw-core echo.
 const saved=await gmail.write(writeInput);assert.equal(saved.commandOutcome,'COMMITTED');assert.equal(saved.context.workspaceVersion,'txn:2');equal(JSON.parse(JSON.stringify(saved.snapshot)),upgradeSnapshotToLatest(core.snapshot))
 equal(JSON.parse(JSON.stringify((await store.readForUser(userId)).snapshot)),upgradeSnapshotToLatest(core.snapshot))
 // Lost response retry keeps the original receipt while returning newer current
 // logical state, not the obsolete input body or its old resulting revision.
 const extra={commandId:'synthetic-store-extra',baseRevision:2,command:{type:'domain',value:{commandId:'synthetic-store-extra',kind:'set_action_status',actionId:'synthetic-store-task',status:'done'}}}
 assert.equal((await executor.execute(principal,extra)).revision,3)
 const originalRetry=await gmail.write(writeInput)
 assert.equal(originalRetry.commandOutcome,'ALREADY_APPLIED');assert.equal(originalRetry.context.workspaceVersion,'txn:3');equal(originalRetry.commandReceipt,saved.commandReceipt)
 const current=await store.readForUser(userId)
 const replay=await store.commitAuthoritativeForUser({userId,commandId:'synthetic-store-nonempty',operation:'gmail_semantic_intake',payloadHash:(await store.readCommandForUser(userId,'synthetic-store-nonempty')).payloadHash,expectedRevision:current.revision,rowPreimage:current,snapshot:current.snapshot,schemaVersion:4,principalKind:'automation',provenance:{sourceId:'gmail:primary'},receiptContext:{},compensation:core.compensation})
 assert.equal(replay.outcome,'ALREADY_APPLIED');assert.equal(replay.revision,3);assert.equal(replay.receipt.revision,2);equal(replay.receipt,saved.commandReceipt);equal(replay.snapshot,current.snapshot)
 const undone=await executor.undo(principal,{commandId:'synthetic-store-undo-extra',targetCommandId:'synthetic-store-extra'})
 assert.equal(undone.outcome,'COMMITTED');assert.equal(undone.revision,4);assert.equal(undone.snapshot.data.actions.find(x=>x.id==='synthetic-store-task').status,'todo')
 // Old preimage cannot commit a new command or be silently rebound to current.
 const stale=await store.commitAuthoritativeForUser({userId,commandId:'synthetic-store-stale',operation:'SnapshotWrite',payloadHash:'f'.repeat(64),expectedRevision:current.revision,rowPreimage:current,snapshot:current.snapshot,schemaVersion:4,principalKind:'first_party_web',receiptContext:{}})
 assert.equal(stale.outcome,'CONFLICT');assert.equal(stale.revision,4)
 await assert.rejects(store.commitAuthoritativeForUser({userId,commandId:'synthetic-store-preference',operation:'domain:set_opportunity_preference',payloadHash:'f'.repeat(64),expectedRevision:current.revision,rowPreimage:current,snapshot:current.snapshot,schemaVersion:4,principalKind:'first_party_web',receiptContext:{}}),e=>e.code==='COMMAND_ID_REUSED')
 assert.equal((await db.query('select revision from public.pjsdas_workspaces where user_id=$1',[userId])).rows[0].revision,'0')
 assert.equal((await db.query('select count(*)::int n from public.pjsdas_command_ledger where user_id=$1',[userId])).rows[0].n,0)
 const clientId=randomUUID(),grantId=randomUUID()
 await db.query("insert into public.pjsdas_business_management_grants(id,user_id,client_id,capability,consent_version,consent_text_hash) values($1,$2,$3,'workspace.planning.manage',4,$4)",[grantId,userId,clientId,await scopedManagementConsentHash('planning')])
 const delegated={kind:'delegated_mcp',userId,clientId},planningExecutor=createAuthoritativeCommandExecutor({...config,resolvePlanningManagementGrant:createScopedManagementGrantReader('planning',config)})
 const planningRead=await getPlanningManagementRead((await store.readForUser(userId)).snapshot)
 const planningCommand={commandId:'synthetic-store-planning',baseRevision:4,command:{type:'planning_management',value:{operations:[{kind:'patch_time_preferences',expectedFingerprint:planningRead.timePreferences.fingerprint,patch:{defaultDailyMinutes:60}}]}}}
 const plan=await planningExecutor.execute(delegated,planningCommand);assert.equal(plan.outcome,'COMMITTED');assert.equal(plan.revision,5);assert.equal(plan.receipt.managementAuthorization.consentVersion,4)
 const planState=await store.readForUser(userId,{preserveRawData:true})
 const bypass={...diffWorkspaceRows(planState.snapshot,planState.snapshot),workspaceId,userId,expectedEpoch:epoch,expectedRevision:5,commandId:'synthetic-protected-undo',payloadHash:'f'.repeat(64),operation:'undo_command',principal:'first_party_web',schemaVersion:4,provenance:{undoOf:'synthetic-store-planning'}}
 assert.equal((await fetch(origin+'/rpc/'+(rpcTransport==='public-v1'?'pjsdas_rows_v1_':'')+'commit_authoritative',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({req:bypass})})).status,403)
 await assert.rejects(planningExecutor.undo(delegated,{commandId:'synthetic-store-planning-undo',targetCommandId:'synthetic-store-planning'}),e=>e.code==='INVALID_ARGUMENT')
 const compensation=(await store.readCommandForUser(userId,'synthetic-store-planning')).compensation
 const planUndo=await planningExecutor.undo(delegated,{commandId:'synthetic-store-planning-undo',targetCommandId:'synthetic-store-planning',expectedCompensationFingerprint:await planningManagementFingerprint(compensation)});assert.equal(planUndo.outcome,'COMMITTED');assert.equal(planUndo.revision,6)
 await db.query('update public.pjsdas_business_management_grants set revoked_at=now() where id=$1',[grantId])
 await assert.rejects(planningExecutor.execute(delegated,planningCommand),e=>e.code==='AUTH_FORBIDDEN')
 console.log('PASS central executor uses actual scoped-grant HTTP reader and planning SQL guard; guarded Undo works, generic Undo bypass and revoked replay reject')
 const nowState=await store.readForUser(userId,{preserveRawData:true})
 for(const operation of ['business_management','opportunity_management','planning_management','discovery_profile_management','private_reminder_management','ai_capture_confirm','ingest_verified_discovery','checkpoint_discovery_search','gmail_semantic_intake']) {
  const req={...diffWorkspaceRows(nowState.snapshot,nowState.snapshot),workspaceId,userId,expectedEpoch:epoch,expectedRevision:nowState.revision,commandId:'synthetic-bypass-'+operation,payloadHash:'a'.repeat(64),operation,principal:'first_party_web',schemaVersion:4,receiptContext:{}}
  const denied=await fetch(origin+'/rpc/'+(rpcTransport==='public-v1'?'pjsdas_rows_v1_':'')+'commit_authoritative',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({req})})
  assert.equal(denied.status,403,'generic endpoint cannot bypass '+operation)
 }
 const skipped=await store.checkpointEmptyGmailPollForUser({userId,executionToken:randomUUID(),commandId:'synthetic-row-empty',payloadHash:'a'.repeat(64),expectedRevision:nowState.revision,checkedAt:'2030-01-01T00:00:00Z',historyId:'1234',observation:{version:1,mode:'history',coverageComplete:true,fetchedCount:0,unavailableCount:0,sourceRecordCount:0,hasContinuation:false,hasRecoveryGap:false,backfillComplete:true}})
 assert.equal(skipped.outcome,'NOT_ELIGIBLE')
 assert.equal((await store.readIdentityForUser(userId)).revision,6)
 assert(commitSizes.length>=4&&Math.max(...commitSizes)<100000,'actual submitted row requests remain small for this synthetic domain batch')
 // Exercise non-snapshot callers through their real central implementations.
 const ledger=createAiCaptureLedger(config),requestId='synthetic-central-capture',at=new Date().toISOString()
 await db.query("insert into public.pjsdas_ai_capture_policies(user_id,enabled,data_scope_approved,funding_boundary_reference,valid_until,max_request_units,free_units_limit) values($1,true,true,'synthetic-local-test',now()+interval '1 hour',1,100)",[userId])
 const observation={contractVersion:1,inputId:'ai:'+requestId,statementMode:'current_intent',originalText:'Create synthetic central task',source:{kind:'web',sourceId:'todayaction-web',sourceRecordId:requestId,timezone:'UTC',observedAt:at},candidates:[{id:'ai-capture:1',kind:'manual_action',title:'Synthetic central task',objectConfidence:'high',eventConfidence:'high',evidenceRefs:[],sourceVersionRefs:[]}]}
 const admission={userId,requestId,payloadHash:'a'.repeat(64),text:observation.originalText,timezone:'UTC',referenceTime:at,reservationUnits:1,expectedRevision:6,contextRefs:[]}
 let start=candidateCalls.length
 await ledger.admit(admission)
 assert(!candidateCalls.slice(start).some(c=>c.url.includes('read_page')),'capture admission reads only bounded identity')
 await assert.rejects(ledger.admit(admission),e=>e.code==='AI_CAPTURE_ADMISSION_REJECTED')
 assert.equal(Number((await db.query('select reserved_units from public.pjsdas_ai_capture_policies where user_id=$1',[userId])).rows[0].reserved_units),1)
 await ledger.finish({userId,requestId,payloadHash:admission.payloadHash,status:'READY',review:{status:'ready_for_review',statementMode:'current_intent',candidates:observation.candidates,issues:[]},observation})
 const captureExecutor=createAuthoritativeCommandExecutor({...config,aiCaptureConfirmationEnabled:true})
 const captureCommand={commandId:'synthetic-central-confirm',baseRevision:6,command:{type:'ai_capture_confirm',value:{requestId}}}
 const confirmed=await captureExecutor.execute(principal,captureCommand)
 assert.equal(confirmed.outcome,'COMMITTED');assert.equal(confirmed.revision,7)
 assert.equal((await ledger.read(userId,requestId)).status,'COMMITTED')
 assert.equal((await captureExecutor.execute(principal,captureCommand)).outcome,'ALREADY_APPLIED')
 const profile={targetRoleQueries:['Synthetic role'],titleEquals:[],preferredLocations:[],mustHave:[],mustNotHave:[]}
 const configured=await executor.execute(principal,{commandId:'synthetic-central-profile',baseRevision:7,command:{type:'discovery_profile',value:profile}})
 assert.equal(configured.revision,8)
 start=candidateCalls.length
 assert.deepEqual(await createDiscoveryReadinessReader({...config,transactional:true})(userId),{profileConfigured:true,scopeConfirmed:true,budgetState:'approval_required'})
 assert(!candidateCalls.slice(start).some(c=>c.url.includes('read_page')),'readiness never fetches entity pages')
 assert.equal((await db.query("select snapshot->'data'->'discoveryProfile' profile from public.pjsdas_workspaces where user_id=$1",[userId])).rows[0].profile,null,'retained blob is not current readiness authority')
 start=candidateCalls.length
 assert.equal((await store.bootstrapForUser({userId,snapshot:initial,schemaVersion:4})).revision,8)
 const bootstrapRequest=JSON.parse(candidateCalls.slice(start).find(c=>c.url.endsWith('bootstrap_existing')).body)
 assert.equal(bootstrapRequest.initial_snapshot,null,'existing normal bootstrap does not retransmit unused full blob')
 const empty=createSnapshot(Object.fromEntries(['opportunities','processes','processEvents','actions','prep','applicationGroups','scheduleNodes','decisionRequests','semanticReceipts','reminderIntents','reminderOutbox','discoveryInbox','changeSets','timeline'].map(key=>[key,[]])))
 const bootstrap={userId,snapshot:empty,schemaVersion:4,migratedFrom:'explicit-consumer-empty-start',consumerAudienceMode:'allowlist'}
 await assert.rejects(store.bootstrapForUser(bootstrap),e=>e.code==='AUTH_FORBIDDEN')
 await db.query("insert into public.pjsdas_access_grants(user_id,role) values($1,'beta')",[userId])
 assert.equal((await store.bootstrapForUser(bootstrap)).revision,8)
 await assert.rejects(store.bootstrapForUser({...bootstrap,snapshot:initial}),e=>e.code==='AUTH_FORBIDDEN')
 await db.query('update public.pjsdas_access_grants set revoked_at=now() where user_id=$1',[userId])
 await assert.rejects(store.bootstrapForUser(bootstrap),e=>e.code==='AUTH_FORBIDDEN')
 assert.equal((await store.readIdentityForUser(userId)).revision,8)
 assert.equal((await db.query('select revision from public.pjsdas_workspaces where user_id=$1',[userId])).rows[0].revision,'0')
 console.log('PASS central row capture admission/confirmation/replay without provider; header-only current readiness; authorized existing bootstrap without overwrite or large blob upload')
 await testControlledRowWorker({db,origin,token,userId,revision:8,rpcTransport,runtime})
 console.log('PASS actual central executor + source HTTP: domain write/Undo, nonempty Gmail, original receipt/current-state replay, stale CAS, reused-ID rejection and no legacy write; requests <100KB for synthetic large snapshot')
}
