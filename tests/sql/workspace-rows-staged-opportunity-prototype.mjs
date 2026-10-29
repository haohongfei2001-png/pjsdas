/** Disposable loopback-only proof of protected staged v3 archive/Undo. No providers. */
import assert from 'node:assert/strict'
import {randomUUID,randomBytes,createHmac,createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {spawn} from 'node:child_process'
import pg from 'pg'
import {install,checkpointMigration} from './gmail-empty-checkpoint-fixture.mjs'
import {migration} from './discovery-authority-fixture.mjs'
import {createLegacyManagementOracle} from './workspace-rows-legacy-oracle.mjs'
import {stagedOpportunityFixture} from '../fixtures/workspaceRowsStagedOpportunity.ts'
import {prepareStagedEffects,stagedEffectPages} from '../../gateway/workspaceRowsLargeCommandPrototype.ts'
import {encodeWorkspaceRows,decodeWorkspaceRows,diffWorkspaceRows} from '../../gateway/workspaceRowsCodec.ts'
const url=new URL(process.env.TA_ROW_DATABASE_URL);assert(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert(process.env.TA_POSTGREST_BIN)
const admin=new pg.Client({connectionString:url.href}),name='ta_staged_opportunity_'+randomUUID().replaceAll('-','');url.pathname='/'+name
const db=new pg.Client({connectionString:url.href});let created=false,server;const ownedClients=[],pendingOperations=[]
const secret=randomBytes(48).toString('hex'),enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url'),jwt=role=>{const body=enc({alg:'HS256',typ:'JWT'})+'.'+enc({role,exp:Math.floor(Date.now()/1000)+1800});return body+'.'+createHmac('sha256',secret).update(body).digest('base64url')}
const origin='http://127.0.0.1:55444',token=jwt('service_role'),wire=x=>JSON.parse(JSON.stringify(x)),hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex')
const rpc=async(fn,body,roleToken=token)=>{const r=await fetch(origin+'/rpc/'+fn,{method:'POST',signal:AbortSignal.timeout(30000),headers:{authorization:'Bearer '+roleToken,'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()}}
const success=async(fn,body)=>{const r=await rpc(fn,body);assert.equal(r.status,200,JSON.stringify(r));return r.body}
const f=await stagedOpportunityFixture(),p=prepareStagedEffects(f.delta),pages=[...stagedEffectPages(p.parts)]
try {
 await admin.connect();await admin.query('create database '+name);created=true;console.log('OWNED_FIXTURE',name);await db.connect();await install(db);await db.query(await migration(checkpointMigration))
 for(const file of ['workspace-rows-stage-a.sql','workspace-rows-authoritative-stage-a.sql','workspace-rows-opportunity-stage-a.sql','workspace-rows-large-command-prototype.sql','workspace-rows-staged-opportunity-prototype.sql'])await db.query(readFileSync(new URL('./candidates/'+file,import.meta.url),'utf8'))
 server=spawn(process.env.TA_POSTGREST_BIN,[],{env:{...process.env,PGRST_DB_URI:url.href,PGRST_DB_SCHEMAS:'pjsdas_rows_candidate',PGRST_DB_ANON_ROLE:'anon',PGRST_JWT_SECRET:secret,PGRST_SERVER_HOST:'127.0.0.1',PGRST_SERVER_PORT:'55444'},stdio:['ignore','ignore','pipe']})
 let logs='';server.stderr.on('data',x=>logs+=x)
 let ready=false;for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error(logs);try{if((await fetch(origin)).status<500){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,50))}assert(ready)
 const userId=randomUUID(),clientId=randomUUID(),grantId=randomUUID()
 await db.query('insert into auth.users(id) values($1)',[userId])
 const workspaceId=(await db.query('insert into public.pjsdas_workspaces(user_id,snapshot,schema_version) values($1,$2,4) returning id',[userId,f.before])).rows[0].id
 const e=encodeWorkspaceRows(f.before),epoch=(await db.query('insert into pjsdas_rows_candidate.head(id,user_id,envelope,manifest,legacy_snapshot) values($1,$2,$3,$4,$5) returning epoch',[workspaceId,userId,e.envelope,JSON.stringify(e.manifest),f.before])).rows[0].epoch
 await db.query('insert into pjsdas_rows_candidate.item select $1,$2,x.collection,x.id,x.ordinal,x.value,0 from jsonb_to_recordset($3) x(collection text,id text,ordinal bigint,value jsonb)',[workspaceId,userId,JSON.stringify(e.rows)])
 await db.query("insert into public.pjsdas_business_management_grants(id,user_id,client_id,capability,consent_version,consent_text_hash) values($1,$2,$3,'workspace.opportunity.manage',3,$4)",[grantId,userId,clientId,'c'.repeat(64)])
 const auth={target_grant_id:grantId,target_grant_revision:1,target_client_id:clientId}
 const req={...p.metadata,workspaceId,userId,expectedEpoch:epoch,expectedRevision:0,commandId:f.commandId,payloadHash:hash(f.input),operation:'opportunity_management',principal:'delegated_mcp',compensation:f.result.compensation,provenance:{},effectiveTime:f.at,receiptContext:{contractVersion:2,affectedObjects:[{type:'opportunity',id:'synthetic-large-opp'}],managementAuthorization:{grantId:'must-not-survive'}}}
 const begin=(id,r=req,prep=p,authority=auth)=>({stage_id:id,req:r,effect_count:prep.parts.length,final_digest:prep.finalDigest,...authority})
 const finish=id=>({stage_id:id,target_user_id:userId})
 async function upload(r=req,prep=p,authority=auth){const id=randomUUID();await success('large_begin_opportunity',begin(id,r,prep,authority));for(const page of stagedEffectPages(prep.parts))await success('large_append',{stage_id:id,target_user_id:userId,parts:page});return id}
 async function current(){const h=(await db.query('select * from pjsdas_rows_candidate.head where id=$1',[workspaceId])).rows[0],rows=(await db.query('select collection,id,ordinal::integer,value from pjsdas_rows_candidate.item where workspace_id=$1',[workspaceId])).rows;return {revision:Number(h.revision),snapshot:decodeWorkspaceRows({contract:'workspace-rows-v1',envelope:h.envelope,manifest:h.manifest,rows})}}
 const count=async()=>Number((await db.query('select count(*) n from pjsdas_rows_candidate.ledger where user_id=$1',[userId])).rows[0].n)
 const oracle=await createLegacyManagementOracle(db,userId,f.before)
 const legacy=async(r,after)=> (await oracle.query('select * from public.pjsdas_commit_opportunity_workspace_v1($1,$2,$3,$4,$5,$6,4,$7,$8,$9,$10,null,$11,$12,$13)',[userId,r.commandId,r.operation,r.payloadHash,r.expectedRevision,JSON.stringify(after),r.principal,clientId,JSON.stringify(r.provenance),JSON.stringify(r.compensation),'{}',grantId,1])).rows[0]
 const prior=await legacy(req,f.result.snapshot);assert.equal(prior.outcome,'COMMITTED')
 assert.equal((await rpc('commit_opportunity',{req:{...req,changes:f.delta.changes},...auth})).status,400)
 assert.equal((await current()).revision,0);assert.equal(await count(),0)
 console.log('PASS failure-first: real existing v3 core + legacy SQL accepts 2053 effects within original evidence bounds; unchanged row fastpath refuses')
 const stage=randomUUID()
 for(const role of ['anon','authenticated'])assert([401,403].includes((await rpc('large_begin_opportunity',begin(stage),jwt(role))).status))
 assert.equal((await rpc('large_begin_opportunity',begin(stage,{...req,operation:'planning_management'}))).status,400)
 await success('large_begin_opportunity',begin(stage));assert.equal((await rpc('large_finish_opportunity',finish(stage))).status,400)
 assert.equal((await rpc('large_begin_opportunity',begin(stage,req,p,{...auth,target_grant_revision:2}))).status,409)
 assert.equal((await rpc('large_finish',finish(stage))).status,403)
 assert.equal((await rpc('large_finish_opportunity',{...finish(stage),target_user_id:randomUUID()})).status,403)
 for(const page of pages)await success('large_append',{stage_id:stage,target_user_id:userId,parts:page})
 assert.deepEqual((await current()).snapshot,wire(f.before));assert.equal(await count(),0)
 const wrong=await upload(req,p,{...auth,target_grant_revision:99})
 assert.equal((await rpc('large_finish_opportunity',finish(wrong))).status,403)
 const foreign=await upload(req,p,{...auth,target_client_id:randomUUID()})
 assert.equal((await rpc('large_finish_opportunity',finish(foreign))).status,403)
 console.log('PASS staging binds owner/family/grant proof but grants no authority; no business mutation during upload, wrong revision/client denied at finalize')
 // A completed statement followed by real connection loss, without COMMIT.
 const crash=new pg.Client({connectionString:url.href});ownedClients.push(crash);await crash.connect();await crash.query('begin')
 await crash.query('select pjsdas_rows_candidate.large_finish_opportunity($1,$2)',[stage,userId]);await crash.end()
 assert.equal((await current()).revision,0);assert.equal(await count(),0)
 assert.equal((await db.query('select result from pjsdas_rows_candidate.large_stage where id=$1',[stage])).rows[0].result,null)
 const results=await Promise.all([success('large_finish_opportunity',finish(stage)),success('large_finish_opportunity',finish(stage))]);assert.deepEqual(results[0],results[1])
 const saved=results[0];assert.equal(saved.outcome,'COMMITTED');assert.equal((await current()).revision,1);assert.equal(await count(),1)
 assert.deepEqual((await current()).snapshot,wire(prior.snapshot));assert.deepEqual(saved.receipt.managementAuthorization,prior.receipt.managementAuthorization)
 assert.deepEqual((await db.query('select compensation from pjsdas_rows_candidate.ledger where user_id=$1',[userId])).rows[0].compensation,wire(f.result.compensation))
 const newStage=await upload();const replay=await success('large_finish_opportunity',finish(newStage));assert.equal(replay.outcome,'ALREADY_APPLIED');assert.deepEqual(replay.receipt,saved.receipt)
 assert.deepEqual((await success('commit_opportunity',{req:{...req,changes:[]},...auth})).receipt,saved.receipt)
 console.log('PASS original v3 guard commits exact legacy/core output once; disconnect rollback, concurrent finalization, trusted receipt and both staged/fastpath replay agree')
 const up=prepareStagedEffects(f.undoDelta),undoReq={...req,...up.metadata,commandId:'synthetic-staged-undo',payloadHash:hash({undoOf:f.commandId}),expectedRevision:1,operation:'undo_command',provenance:{undoOf:f.commandId},compensation:null}
 const reversed=structuredClone(f.undo);reversed.data.actions.reverse();const reversedPrep=prepareStagedEffects(diffWorkspaceRows(f.result.snapshot,reversed))
 const reversedStage=await upload({...undoReq,...reversedPrep.metadata,commandId:'synthetic-reversed-undo'},reversedPrep)
 assert.equal((await rpc('large_finish_opportunity',finish(reversedStage))).status,403);assert.deepEqual((await current()).snapshot,wire(f.result.snapshot))
 const undoStage=await upload(undoReq,up)
 const oldUndo=await legacy(undoReq,f.undo),undone=await success('large_finish_opportunity',finish(undoStage));assert.equal(undone.outcome,'COMMITTED')
 assert.deepEqual((await current()).snapshot,wire(oldUndo.snapshot));assert.deepEqual((await current()).snapshot,wire(f.undo));assert.equal(await count(),2)
 assert.deepEqual((await success('large_finish_opportunity',finish(stage))).receipt,saved.receipt)
 console.log('PASS actual v3 Undo restores 2052 row effects and exact retained ordering/history; original command receipt remains immutable')
 const stale=await upload({...req,commandId:'synthetic-stale-cas'});assert.equal((await success('large_finish_opportunity',finish(stale))).outcome,'CONFLICT');assert.equal(await count(),2)
 // A grant revocation holds the original authority row first. Observe the real
 // DB lock wait, not a timer-based guess, then revoke before releasing it.
 const revokeStage=await upload({...req,commandId:'synthetic-revoked',expectedRevision:2})
 await db.query('begin');await db.query('select 1 from public.pjsdas_business_management_grants where id=$1 for update',[grantId])
 const revoking=rpc('large_finish_opportunity',finish(revokeStage)).catch(transportError=>({transportError}));pendingOperations.push(revoking);let waited=false
 try {for(let i=0;i<200;i++){await db.query('select pg_stat_clear_snapshot()');const waiting=(await db.query("select count(*)::int n from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock' and query like '%large_finish_opportunity%' ")).rows[0].n;if(waiting){waited=true;break}await new Promise(r=>setTimeout(r,10))}assert(waited,'must observe authority lock wait');await db.query('update public.pjsdas_business_management_grants set revoked_at=clock_timestamp() where id=$1',[grantId]);await db.query('commit')}finally{await db.query('rollback')}
 assert.equal((await revoking).status,403)
 for(const id of [stage,newStage,undoStage])assert.equal((await rpc('large_finish_opportunity',finish(id))).status,403,'completed stage replay must reauthorize')
 assert.equal((await rpc('commit_opportunity',{req:{...req,changes:[]},...auth})).status,403)
 const uploadStatus=await success('large_begin_opportunity',begin(stage));assert.deepEqual(uploadStatus,{nextOrdinal:p.parts.length,completed:true});assert(!('result' in uploadStatus),'begin must not bypass authorized replay')
 assert.equal(await count(),2);assert.deepEqual((await current()).snapshot,wire(f.undo))
 await db.query('update public.pjsdas_business_management_grants set revoked_at=null where id=$1',[grantId])
 auth.target_grant_revision=Number((await db.query('select revision from public.pjsdas_business_management_grants where id=$1',[grantId])).rows[0].revision)
 console.log('PASS real grant-lock wait observes revoke-before-finalize; both completed-stage and legacy-style replay refuse revoked authority without effects')
 // Finalization holds authority until its single business transaction commits.
 assert.equal((await rpc('large_finish_opportunity',finish(stage))).status,403,'regrant does not revive stale staged authority')
 const reauthorized=await upload();assert.deepEqual((await success('large_finish_opportunity',finish(reauthorized))).receipt,saved.receipt)
 const held=new pg.Client({connectionString:url.href});ownedClients.push(held);await held.connect();await held.query('begin');await held.query('select pjsdas_rows_candidate.large_finish_opportunity($1,$2)',[reauthorized,userId])
 let revokeDone=false;const revoke=db.query('update public.pjsdas_business_management_grants set revoked_at=clock_timestamp() where id=$1',[grantId]).then(()=>{revokeDone=true})
 const observer=new pg.Client({connectionString:url.href});ownedClients.push(observer);await observer.connect();let revokeWait=false
 try {for(let i=0;i<200;i++){if((await observer.query("select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'update public.pjsdas_business_management_grants%' ")).rows[0].n){revokeWait=true;break}await new Promise(r=>setTimeout(r,10))}assert(revokeWait);assert(!revokeDone);await held.query('commit');await revoke}finally{await held.end();await observer.end()}
 await db.query('update public.pjsdas_business_management_grants set revoked_at=null where id=$1',[grantId])
 auth.target_grant_revision=Number((await db.query('select revision from public.pjsdas_business_management_grants where id=$1',[grantId])).rows[0].revision)
 // Expiry is checked after a workspace lock wait. It is not extended by upload.
 const expiry=await upload({...req,commandId:'synthetic-expiry-after-wait',expectedRevision:2})
 await db.query('begin');await db.query('select 1 from pjsdas_rows_candidate.head where id=$1 for update',[workspaceId])
 const expiring=rpc('large_finish_opportunity',finish(expiry)).catch(transportError=>({transportError}));pendingOperations.push(expiring);let headWait=false
 try {for(let i=0;i<200;i++){await db.query('select pg_stat_clear_snapshot()');if((await db.query("select count(*)::int n from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock' and query like '%large_finish_opportunity%' ")).rows[0].n){headWait=true;break}await new Promise(r=>setTimeout(r,10))}assert(headWait);await db.query("update pjsdas_rows_candidate.large_stage set expires_at=clock_timestamp()-interval '1 second' where id=$1",[expiry]);await db.query('commit')}finally{await db.query('rollback')}
 assert.equal((await expiring).status,400);assert.equal(await count(),2)
 console.log('PASS finalize retains grant lock through transaction; stage expiry uses wall clock after actual workspace lock wait; no inverted stage->grant lock')
 // Negative semantic guards use real core output, mutating one prohibited part.
 const freshDelta=diffWorkspaceRows(f.undo,f.result.snapshot),fresh=prepareStagedEffects(freshDelta),freshReq={...req,...fresh.metadata,expectedRevision:2}
 for(const variant of ['missing-evidence','unrelated-header','retained-source-fact','retained-order','partial-closure','late-preimage']){
  const after=structuredClone(f.result.snapshot),r={...freshReq,commandId:'synthetic-denied-'+variant,compensation:structuredClone(f.result.compensation)}
  if(variant==='missing-evidence')r.compensation.payload.changes.pop()
  if(variant==='unrelated-header')after.data.decisionRules={unauthorized:true}
  if(variant==='retained-source-fact')after.data.opportunities[0].company='Forbidden source rewrite'
  if(variant==='retained-order'){after.data.actions=f.undo.data.actions.slice(-1);r.compensation.payload.changes=r.compensation.payload.changes.filter(x=>x.id!==after.data.actions[0].id)}
  if(variant==='partial-closure')after.data.actions=f.undo.data.actions.slice(-1)
  let delta=diffWorkspaceRows(f.undo,after)
  if(variant==='late-preimage')delta.changes.at(-1).before={...delta.changes.at(-1).before,value:{id:'invalid-late-preimage'}}
  const prep=prepareStagedEffects(delta);Object.assign(r,prep.metadata)
  const id=await upload(r,prep),denied=await rpc('large_finish_opportunity',finish(id));assert([403,409].includes(denied.status),variant+': '+JSON.stringify(denied))
  assert.equal(await count(),2);assert.deepEqual((await current()).snapshot,wire(f.undo))
 }
 console.log('PASS original evidence closure/source facts/unrelated-header/order checks and late preimage failure roll back all effects and receipt')
 // A successful restage after failures proves the connection/pool was not poisoned.
 const again=await upload({...freshReq,commandId:'synthetic-archive-again'},fresh);assert.equal((await success('large_finish_opportunity',finish(again))).outcome,'COMMITTED');assert.equal(await count(),3)
 const afterAgain=await current()
 // Preserve the original ambiguous-history Undo fence across both ledgers.
 await db.query("insert into public.pjsdas_command_ledger(workspace_id,user_id,command_id,operation,payload_hash,principal_kind,status,resulting_revision,compensation) values($1,$2,$3,'planning_management',$4,'delegated_mcp','COMMITTED',3,$5)",[workspaceId,userId,'synthetic-archive-again','a'.repeat(64),f.result.compensation])
 const againUndo=prepareStagedEffects(diffWorkspaceRows(afterAgain.snapshot,f.undo)),againUndoReq={...undoReq,...againUndo.metadata,expectedRevision:3,commandId:'synthetic-ambiguous-undo',provenance:{undoOf:'synthetic-archive-again'}}
 const ambiguous=await upload(againUndoReq,againUndo);assert.equal((await rpc('large_finish_opportunity',finish(ambiguous))).status,403)
 assert.deepEqual(await current(),afterAgain);assert.equal(await count(),3)
 await db.query('delete from public.pjsdas_command_ledger where user_id=$1 and command_id=$2',[userId,'synthetic-archive-again'])
 await db.query('update pjsdas_rows_candidate.head set epoch=gen_random_uuid() where id=$1',[workspaceId])
 assert.equal((await rpc('large_finish_opportunity',finish(again))).status,409)
 console.log('PASS ambiguous cross-family retained Undo and retired-generation cached replay reject; no fallback to retained blob')
 assert.deepEqual((await db.query('select snapshot from public.pjsdas_workspaces where id=$1',[workspaceId])).rows[0].snapshot,wire(f.before))
 const acl=(await db.query("select p.prosecdef,has_function_privilege('anon',p.oid,'execute') a,has_function_privilege('authenticated',p.oid,'execute') u,has_function_privilege('service_role',p.oid,'execute') s from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname='pjsdas_rows_candidate' and p.proname in ('large_begin_opportunity','large_finish_opportunity')) or (n.nspname='pjsdas_rows_internal' and p.proname in ('staged_changes','commit_opportunity_staged'))")).rows
 assert.equal(acl.length,4);assert(acl.every(x=>!x.prosecdef&&!x.a&&!x.u&&x.s))
 assert.equal((await rpc('commit_opportunity_staged',{})).status,404)
 console.log(JSON.stringify({syntheticOnly:true,effects:p.parts.length,undoEffects:up.parts.length,evidenceBytes:Buffer.byteLength(JSON.stringify(f.result.compensation)),uploadPages:pages.length,workMem:(await db.query('show work_mem')).rows[0].work_mem,productionEstimate:false,productionReady:false}))
}finally{
 await db.query('rollback').catch(()=>{});await Promise.all(ownedClients.map(c=>c.end().catch(()=>{})));await Promise.all(pendingOperations);
 if(server&&server.exitCode===null){const stopped=new Promise(r=>server.once('exit',r));server.kill('SIGTERM');await stopped}
 await db.end().catch(()=>{});if(created)await admin.query('drop database '+name+' with(force)');await admin.end()
}
