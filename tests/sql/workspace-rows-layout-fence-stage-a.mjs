import assert from 'node:assert/strict'
import pg from 'pg'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { seed,checkpoint,full,logical } from './gmail-empty-checkpoint-fixture.mjs'
import { encodeWorkspaceRows } from '../../gateway/workspaceRowsCodec.ts'
import { applyGmailSemanticBatch } from '../../src/gmailSemanticIntake.ts'
import { createTransactionalWorkspaceStore } from '../../gateway/transactionalWorkspaceStore.ts'
import { createSnapshot } from '../../src/snapshot.ts'
const equal=(a,b)=>assert(isDeepStrictEqual(a,JSON.parse(JSON.stringify(b))),'layout fence value equality')
export async function testLayoutFenceRows({db,source,connectionString,origin,token}) {
 const catalog=async()=> (await db.query("select oid,proowner,proacl,prosecdef,proconfig,provolatile from pg_proc where pronamespace='public'::regnamespace order by oid")).rows
 const beforeCatalog=await catalog()
 const beforeTable=(await db.query("select relacl,relrowsecurity,relforcerowsecurity from pg_class where oid='public.pjsdas_workspaces'::regclass")).rows
 await db.query('begin')
 try {await db.query(readFileSync(new URL('./candidates/workspace-rows-layout-fence-stage-a.sql',import.meta.url),'utf8'));await db.query('commit')}catch(error){await db.query('rollback');throw error}
 assert.deepEqual(await catalog(),beforeCatalog,'legacy owner/ACL/security/search-path/volatility must not drift')
 assert.deepEqual((await db.query("select relacl,relrowsecurity,relforcerowsecurity from pg_class where oid='public.pjsdas_workspaces'::regclass")).rows,beforeTable)
 const w=await seed(db,9931),checked=new Date().toISOString(),pending=await checkpoint(db,w,0,checked)
 assert.equal(pending.outcome,'COMMITTED')
 const pendingRun=(await db.query('select gmail_empty_poll_run from public.pjsdas_command_ledger where user_id=$1 and command_id=$2',[w.user,'gmail:auto:'+checked])).rows[0].gmail_empty_poll_run
 const state=await logical(db,w.user);assert.equal(Number(state.revision),1);assert.equal(Number(state.materialized_revision),0)
 const row=(await db.query('select id,snapshot from public.pjsdas_workspaces where user_id=$1',[w.user])).rows[0],encoded=encodeWorkspaceRows(state.snapshot)
 await db.query('insert into pjsdas_rows_candidate.head(id,user_id,revision,envelope,manifest,legacy_snapshot) values($1,$2,1,$3,$4,$5)',[row.id,w.user,encoded.envelope,JSON.stringify(encoded.manifest),row.snapshot])
 await db.query('insert into pjsdas_rows_candidate.item select $1,$2,x.collection,x.id,x.ordinal,x.value,1 from jsonb_to_recordset($3) as x(collection text,id text,ordinal bigint,value jsonb)',[row.id,w.user,JSON.stringify(encoded.rows)])
 const staged=await source.read(w.user);equal(staged.snapshot,state.snapshot)
 // Admission before cutover uses its unchanged original contract. The reviewed
 // request is then used to prove old confirmation cannot consume it afterward.
 await db.query("insert into public.pjsdas_ai_capture_policies(user_id,enabled,data_scope_approved,funding_boundary_reference,valid_until,max_request_units,free_units_limit) values($1,true,true,'synthetic-layout',now()+interval '1 hour',1,10)",[w.user])
 const observation={contractVersion:1,inputId:'ai:synthetic-layout-review',statementMode:'current_intent',originalText:'Synthetic task',source:{kind:'web',sourceId:'todayaction-web',sourceRecordId:'synthetic-layout-review',timezone:'UTC',observedAt:checked},candidates:[{id:'ai-capture:1',kind:'manual_action',title:'Synthetic task',objectConfidence:'high',eventConfidence:'high',evidenceRefs:[],sourceVersionRefs:[]}]}
 await db.query('select * from public.pjsdas_admit_ai_capture($1,$2,$3,$4,$5,$6,1,1)',[w.user,'synthetic-layout-review','a'.repeat(64),observation.originalText,'UTC',checked])
 await db.query('select * from public.pjsdas_finish_ai_capture($1,$2,$3,$4,$5,$6)',[w.user,'synthetic-layout-review','a'.repeat(64),'READY',{status:'ready_for_review',statementMode:'current_intent',candidates:observation.candidates},observation])
 // This is a synthetic cutover witness, not a production cutover API: staging
 // equality is checked above, and the final revision/marker changes are locked.
 await db.query('begin');await db.query('select id from public.pjsdas_workspaces where user_id=$1 for update',[w.user])
 await db.query('update public.pjsdas_workspaces set row_candidate_epoch=$2 where user_id=$1 and revision=1',[w.user,staged.epoch]);await db.query('commit')
 const denied=async action=>assert.rejects(action,e=>e.code==='PT409')
 for(const version of [1,2,3,4]) await denied(full(db,version,w,'synthetic-old-v'+version,1,state.snapshot))
 // A replay must be fenced too, not return the stale retained projection.
 await denied(db.query('select * from public.pjsdas_commit_workspace_v2($1,$2,$3,$4,1,$5,4,$6,null,$7,null,null,$8)',[w.user,'gmail:auto:'+checked,'gmail_semantic_intake','a'.repeat(64),state.snapshot,'automation','{}','{}']))
 await denied(checkpoint(db,w,1,new Date().toISOString()))
 await denied(db.query('select * from public.pjsdas_drain_empty_gmail_runs_v1($1,1)',[w.user]))
 await denied(db.query('select public.pjsdas_logical_workspace_snapshot_v1(w) from public.pjsdas_workspaces w where user_id=$1',[w.user]))
 await denied(db.query('select * from public.pjsdas_bootstrap_workspace($1,$2,4,null,null)',[w.user,state.snapshot]))
 const empty=createSnapshot({opportunities:[],processes:[],processEvents:[],actions:[],prep:[],applicationGroups:[],scheduleNodes:[],decisionRequests:[],semanticReceipts:[],reminderIntents:[],reminderOutbox:[],discoveryInbox:[],changeSets:[],timeline:[]},checked)
 await denied(db.query('select * from public.pjsdas_bootstrap_consumer_workspace_v1($1,$2,4,null,$3,true,$4)',[w.user,empty,'explicit-consumer-empty-start','legacy']))
 const clientId=randomUUID(),families=[
  [2,'workspace.manage','pjsdas_commit_management_workspace_v1','business_management'],
  [3,'workspace.opportunity.manage','pjsdas_commit_opportunity_workspace_v1','opportunity_management'],
  [4,'workspace.planning.manage','pjsdas_commit_planning_workspace_v1','planning_management'],
  [5,'workspace.discovery-profile.manage','pjsdas_commit_discovery_profile_workspace_v1','discovery_profile_management'],
  [6,'workspace.reminders.manage','pjsdas_commit_private_reminder_workspace_v1','private_reminder_management'],
  [7,'workspace.business.manage','pjsdas_commit_consumer_business_workspace_v1','business_management']]
 for(const [version,capability,rpc,operation] of families){
  const grantId=randomUUID(),hash=version===7?'22626aea373e4e8eb51a90ee4b548c5f3aeeee4bbe58e77b418a0645138edb34':'a'.repeat(64)
  await db.query('insert into public.pjsdas_business_management_grants(id,user_id,client_id,capability,consent_version,consent_text_hash) values($1,$2,$3,$4,$5,$6)',[grantId,w.user,clientId,capability,version,hash])
  await denied(db.query(`select * from public.${rpc}($1,$2,$3,$4,1,$5,4,$6,$7,$8,$9,null,$10,$11,1)`,[w.user,'synthetic-old-management-'+version,operation,'b'.repeat(64),state.snapshot,'delegated_mcp',clientId,'{}','{}','{}',grantId]))
 }
 await denied(db.query('select * from public.pjsdas_admit_ai_capture($1,$2,$3,$4,$5,$6,1,1)',[w.user,'synthetic-post-layout-review','c'.repeat(64),'Synthetic new review','UTC',checked]))
 await denied(db.query('select * from public.pjsdas_commit_ai_capture($1,$2,$3,$4,1,$5,4,$6,null,$7,null,null,$8,$9,$10)',[w.user,'synthetic-old-capture','ai_capture_confirm','c'.repeat(64),state.snapshot,'first_party_web','{}','{}','synthetic-layout-review',observation]))
 const grant=(await db.query("insert into public.pjsdas_authorization_grants(user_id,client_id,source_id,capability) values($1,$2,'monitor:synthetic-layout','ingest_discovery_run') returning id,revision",[w.user,clientId])).rows[0]
 const proof={kind:'delegated_mcp',userId:w.user,clientId,sourceId:'monitor:synthetic-layout',grantId:grant.id,grantRevision:Number(grant.revision)}
 await denied(db.query('select * from public.pjsdas_commit_discovery_workspace_v1($1,$2,$3,$4,1,$5,4,$6,$7,$8,null,null,$9,$10)',[w.user,'synthetic-old-discovery','ingest_verified_discovery','d'.repeat(64),state.snapshot,'delegated_mcp',clientId,{sourceId:proof.sourceId},'{}',proof]))
 for(const query of ['update public.pjsdas_workspaces set snapshot=snapshot where user_id=$1','update public.pjsdas_workspaces set revision=revision+1 where user_id=$1','update public.pjsdas_workspaces set row_candidate_epoch=null where user_id=$1','delete from public.pjsdas_workspaces where user_id=$1']) await denied(db.query(query,[w.user]))
 assert.equal((await db.query('select count(*)::int n from public.pjsdas_command_ledger where user_id=$1',[w.user])).rows[0].n,1)
 assert.equal((await db.query('select status from public.pjsdas_ai_capture_previews where user_id=$1',[w.user])).rows[0].status,'READY')
 const current=await source.read(w.user);equal(current.snapshot,state.snapshot)
 const core=applyGmailSemanticBatch(current.snapshot,{runId:'synthetic-row-after-layout',sourceId:'gmail:primary',checkedAt:new Date().toISOString(),records:[],authorized:true,workspaceRevision:'txn:1'})
 const command={commandId:'synthetic-row-after-layout',payloadHash:'e'.repeat(64),operation:'gmail_semantic_intake',principal:'automation',sourceId:'gmail:primary',compensation:core.compensation}
 await assert.rejects(source.commit({...current,epoch:randomUUID()},core.snapshot,command),e=>e.code==='CONFLICT')
 const saved=await source.commit(current,core.snapshot,command);assert.equal(saved.outcome,'COMMITTED');equal((await source.read(w.user)).snapshot,core.snapshot)
 equal((await source.read(w.user)).snapshot.data.timeline.find(x=>x.id===pendingRun.id),pendingRun)
 equal((await db.query('select snapshot from public.pjsdas_workspaces where user_id=$1',[w.user])).rows[0].snapshot,row.snapshot)
 assert.equal((await db.query('select count(*)::int n from public.pjsdas_command_ledger where user_id=$1',[w.user])).rows[0].n,1)
 // Actual pre-cutover requests may already be waiting. Test both orders;
 // a stale stage never activates over a winning old commit, and a losing old
 // request cannot write after activation even though it began earlier.
 const oldClient=new pg.Client({connectionString}),activator=new pg.Client({connectionString});await oldClient.connect();await activator.connect();await oldClient.query('set role service_role');await activator.query('set role service_role')
 const stage=async n=>{
  const value=await seed(db,n),raw=(await db.query('select id,snapshot,revision from public.pjsdas_workspaces where user_id=$1',[value.user])).rows[0],e=encodeWorkspaceRows(raw.snapshot)
  const head=(await db.query('insert into pjsdas_rows_candidate.head(id,user_id,revision,envelope,manifest,legacy_snapshot) values($1,$2,$3,$4,$5,$6) returning epoch',[raw.id,value.user,raw.revision,e.envelope,JSON.stringify(e.manifest),raw.snapshot])).rows[0]
  await db.query('insert into pjsdas_rows_candidate.item select $1,$2,x.collection,x.id,x.ordinal,x.value,0 from jsonb_to_recordset($3) as x(collection text,id text,ordinal bigint,value jsonb)',[raw.id,value.user,JSON.stringify(e.rows)])
  return {...value,...raw,epoch:head.epoch}
 }
 const waitLock=async()=>{const until=Date.now()+5000;for(;;){await db.query('select pg_stat_clear_snapshot()');if((await db.query("select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and pid<>pg_backend_pid()")).rows[0].n>0)return;if(Date.now()>until)throw new Error('expected cutover contention absent');await new Promise(r=>setTimeout(r,20))}}
 try {
  for(const [n,kind] of [[9932,'v3'],[9934,'empty-checkpoint']]) {
   const stagedRace=await stage(n)
   await db.query('begin');await db.query('select id from public.pjsdas_workspaces where user_id=$1 for update',[stagedRace.user])
   const request=(kind==='v3'?full(oldClient,3,stagedRace,'synthetic-inflight-legacy',0,stagedRace.snapshot):checkpoint(oldClient,stagedRace,0,new Date().toISOString())).then(value=>({value}),error=>({error}))
   await waitLock();await db.query('update public.pjsdas_workspaces set row_candidate_epoch=$2 where user_id=$1',[stagedRace.user,stagedRace.epoch]);await db.query('commit')
   assert.equal((await request).error?.code,'PT409')
   assert.equal((await db.query('select count(*)::int n from public.pjsdas_command_ledger where user_id=$1',[stagedRace.user])).rows[0].n,0)
  }
  const winning=await stage(9933),changed={...winning.snapshot,exportedAt:'2031-01-01T00:00:00.000Z'}
  await oldClient.query('begin');assert.equal((await full(oldClient,2,winning,'synthetic-old-wins',0,changed)).outcome,'COMMITTED')
  const activation=activator.query('update public.pjsdas_workspaces set row_candidate_epoch=$2 where user_id=$1',[winning.user,winning.epoch]).then(value=>({value}),error=>({error}))
  await waitLock();await oldClient.query('commit');assert.equal((await activation).error?.code,'PT409')
  const preserved=(await db.query('select snapshot,revision,row_candidate_epoch from public.pjsdas_workspaces where user_id=$1',[winning.user])).rows[0]
  equal(preserved.snapshot,changed);assert.equal(Number(preserved.revision),1);assert.equal(preserved.row_candidate_epoch,null)
  // Direct old-table writes need not bump revision. A one-time exact retained
  // base comparison prevents such an edit from being hidden by activation.
  const rawRace=await stage(9935),rawChanged={...rawRace.snapshot,exportedAt:'2032-01-01T00:00:00.000Z'}
  await db.query('update public.pjsdas_workspaces set snapshot=$2 where user_id=$1',[rawRace.user,rawChanged])
  await denied(db.query('update public.pjsdas_workspaces set row_candidate_epoch=$2 where user_id=$1',[rawRace.user,rawRace.epoch]))
  equal((await db.query('select snapshot from public.pjsdas_workspaces where user_id=$1',[rawRace.user])).rows[0].snapshot,rawChanged)
 } finally {await db.query('rollback');await oldClient.query('rollback');await oldClient.end();await activator.end()}
 // Use the actual transactional store over real HTTP. The local rewrite only
 // removes Supabase's gateway prefix and selects public metadata; no DB mock.
 await db.query("notify pgrst, 'reload schema'")
 const publicFetch=async(url,init={})=>{const headers=new Headers(init.headers);headers.set('accept-profile','public');headers.set('content-profile','public');return fetch(String(url).replace('/rest/v1/','/'),{...init,headers})}
 const metaUrl=origin+'/rest/v1/pjsdas_workspaces?select=id,row_candidate_epoch&limit=1'
 let ready=false
 for(let i=0;i<100;i++){const r=await publicFetch(metaUrl,{headers:{authorization:'Bearer '+token}});if(r.ok){ready=true;break}await new Promise(r=>setTimeout(r,30))}
 assert(ready,'reloaded real public metadata schema')
 const store=createTransactionalWorkspaceStore({supabaseUrl:origin,serviceRoleKey:token,fetchImpl:publicFetch,rowLayoutReader:source,emptyGmailCheckpointReads:true,emptyGmailCheckpoints:true})
 const logicalCurrent=await source.read(w.user),routed=await store.readForUser(w.user,{preserveRawData:true,includeStoredSchema:true})
 equal(routed.snapshot,logicalCurrent.snapshot);assert.equal(routed.revision,logicalCurrent.revision);assert.equal(routed.rowEpoch,staged.epoch)
 const identity=await store.readIdentityForUser(w.user);assert.equal(identity.revision,logicalCurrent.revision);assert.equal(identity.rowEpoch,staged.epoch)
 const rowReceipt=await store.readCommandForUser(w.user,command.commandId)
 equal(rowReceipt.receipt,saved.receipt)
 assert.equal(await store.readCommandForUser(w.user,'synthetic-absent-command'),null)
 const history=await store.readCommandsAfterRevision(w.user,0)
 assert.deepEqual(history.map(x=>x.resultingRevision),[1,2])
 assert.deepEqual(history.map(x=>x.commandId),['gmail:auto:'+checked,command.commandId])
 equal((await store.readCommandForUser(w.user,'gmail:auto:'+checked)).receipt,pending.receipt)
 assert.equal(await store.readLatestDiscoveryCommandForUser(w.user,'synthetic-source','a'.repeat(64)),null)
 assert.deepEqual(await store.readDiscoveryScopeRecordsForUser(w.user,'synthetic-source','a'.repeat(64),'b'.repeat(64)),[])
 await assert.rejects(store.commitForUser({userId:w.user,commandId:'synthetic-old-store',operation:'semantic_intake',payloadHash:'c'.repeat(64),expectedRevision:logicalCurrent.revision,snapshot:logicalCurrent.snapshot,schemaVersion:4,principalKind:'first_party_web'}),e=>e.code==='WORKSPACE_CONFLICT')
 const retainedReceipt=(await db.query('select receipt from public.pjsdas_command_ledger where user_id=$1 and command_id=$2',[w.user,'gmail:auto:'+checked])).rows[0].receipt
 const replayRetained=await source.commit(logicalCurrent,logicalCurrent.snapshot,{commandId:'gmail:auto:'+checked,payloadHash:'a'.repeat(64),operation:'gmail_semantic_intake',principal:'automation',sourceId:'gmail:primary',compensation:null})
 assert.equal(replayRetained.outcome,'ALREADY_APPLIED','retained command replay must not create another command after cutover')
 equal(replayRetained.receipt,retainedReceipt)
 assert.equal((await source.read(w.user)).revision,logicalCurrent.revision)
 assert.equal((await db.query('select count(*)::int n from pjsdas_rows_candidate.ledger where user_id=$1 and command_id=$2',[w.user,'gmail:auto:'+checked])).rows[0].n,0)
 await assert.rejects(source.commit(logicalCurrent,logicalCurrent.snapshot,{commandId:'gmail:auto:'+checked,payloadHash:'b'.repeat(64),operation:'gmail_semantic_intake',principal:'automation',sourceId:'gmail:primary',compensation:null}))
 // Storage-only pagination fixture: many valid command records, no claim that
 // these synthetic no-op records represent actual domain transitions.
 await db.query(`insert into pjsdas_rows_candidate.ledger(workspace_id,user_id,command_id,payload_hash,resulting_revision,receipt,compensation,effect_digest,principal_kind,expected_revision)
 select $1,$2,'synthetic-history-'||n,repeat('d',64),n,jsonb_build_object('commandId','synthetic-history-'||n,'operation','gmail_semantic_intake','status','COMMITTED','revision',n,'committedAt',now()),'null'::jsonb,'synthetic','automation',n-1 from generate_series(3,260)n`,[row.id,w.user])
 await db.query('update pjsdas_rows_candidate.head set revision=260 where id=$1',[row.id])
 const paged=await store.readCommandsAfterRevision(w.user,0)
 assert.equal(paged.length,260);assert.deepEqual(paged.map(x=>x.resultingRevision),Array.from({length:260},(_,i)=>i+1))
 const after=await store.readCommandsAfterRevision(w.user,257);assert.deepEqual(after.map(x=>x.resultingRevision),[258,259,260])
 // Duplicate identity with equal payload but conflicting immutable receipt must
 // fail closed both in replay and in history reads; do not prefer either store.
 await db.query(`insert into pjsdas_rows_candidate.ledger(workspace_id,user_id,command_id,payload_hash,resulting_revision,receipt,compensation,effect_digest,principal_kind,client_id,provenance,expected_revision,effective_time)
 select workspace_id,user_id,command_id,payload_hash,resulting_revision,receipt||'{"syntheticContradiction":true}'::jsonb,coalesce(compensation,'null'::jsonb),'synthetic',principal_kind,client_id,provenance,expected_revision,effective_time from public.pjsdas_command_ledger where user_id=$1 and command_id=$2`,[w.user,'gmail:auto:'+checked])
 await assert.rejects(store.readCommandForUser(w.user,'gmail:auto:'+checked))
 await assert.rejects(source.commit({...logicalCurrent,revision:260},logicalCurrent.snapshot,{commandId:'gmail:auto:'+checked,payloadHash:'a'.repeat(64),operation:'gmail_semantic_intake',principal:'automation',sourceId:'gmail:primary',compensation:null}))
 assert.equal((await source.readIdentity(w.user)).revision,260)
 console.log('PASS central command history combines original/new records, paginates without truncation, and rejects conflicting duplicate identities')
 console.log('PASS original pre-cutover command identity/receipt is replayed from retained history without a new row write')
 console.log('PASS actual transactional store over HTTP reads current logical row snapshot/identity and never falls back to retained blob or old write routes')
 console.log('PASS actual cutover races: blocked v3 and 305 cannot cross activation; old commit wins preserves data and rejects stale stage; unversioned raw edit also rejects activation')
 console.log('PASS real legacy v1-v4/replay/all six grants/bootstrap/capture/Discovery/305 drain and checkpoint/raw writes are fenced after generation activation; pending logical run retained by new row commit; original ACL/owner/RLS unchanged')
}
