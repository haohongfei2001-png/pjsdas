// Real pinned PostgREST v14.5 -> PG17 -> actual TypeScript overlay store.
// Synthetic loopback fixture only; Docker is required (the CI SQL job has it).
import assert from 'node:assert/strict'
import {createHmac,randomUUID} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {request as httpRequest} from 'node:http'
import pg from 'pg'
import {fixtureUrl,migration} from './discovery-authority-fixture.mjs'
import {install,seed,checkpointMigration,raw,logical,observation} from './gmail-empty-checkpoint-fixture.mjs'
import {createTransactionalWorkspaceStore} from '../../gateway/transactionalWorkspaceStore.ts'
import {hashMutationPayload} from '../../gateway/mutationKernel.ts'
const url=fixtureUrl(),docker=promisify(execFile),suffix=randomUUID().replaceAll('-','')
const database=`ta_empty_http_fixture_${suffix}`,container=`ta-empty-postgrest-${suffix}`,origin='http://127.0.0.1:33018'
const secret='synthetic-empty-poll-http-jwt-secret-never-production',encode=v=>Buffer.from(JSON.stringify(v)).toString('base64url')
const token=role=>{const input=`${encode({alg:'HS256',typ:'JWT'})}.${encode({role,exp:Math.floor(Date.now()/1000)+600})}`;return input+'.'+createHmac('sha256',secret).update(input).digest('base64url')}
const headers=role=>({'content-type':'application/json',...(role?{authorization:'Bearer '+token(role)}:{})})
const rpc='/rpc/pjsdas_checkpoint_empty_gmail_poll_v1'
const post=async(body,role='service_role',extra={})=>{const r=await fetch(origin+rpc,{method:'POST',headers:{...headers(role),...extra},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});return{status:r.status,value:await r.json()}}
let admin,db,created=false,dockerAttempted=false
try{
 admin=new pg.Client({connectionString:url.toString(),statement_timeout:30000});await admin.connect();assert.equal(Math.floor(Number((await admin.query('show server_version_num')).rows[0].server_version_num)/10000),17)
 await admin.query(`create database ${database}`);created=true;const local=new URL(url);local.pathname='/'+database;db=new pg.Client({connectionString:local.toString(),statement_timeout:30000});await db.connect();await install(db);await db.query(await migration(checkpointMigration))
 local.search='?options='+encodeURIComponent('-c work_mem=2184kB');dockerAttempted=true
 await docker('docker',['run','--detach','--rm','--name',container,'--network','host','-e',`PGRST_DB_URI=${local}`,'-e','PGRST_DB_SCHEMAS=public','-e','PGRST_DB_ANON_ROLE=anon','-e',`PGRST_JWT_SECRET=${secret}`,'-e','PGRST_SERVER_HOST=127.0.0.1','-e','PGRST_SERVER_PORT=33018','-e','PGRST_DB_POOL=4','-e','PGRST_DB_TX_END=commit-allow-override','postgrest/postgrest:v14.5'],{timeout:120000,maxBuffer:1024*1024})
 let ready=false;const deadline=Date.now()+30000
 while(Date.now()<deadline){try{const r=await fetch(origin+'/',{headers:headers('service_role'),signal:AbortSignal.timeout(1000)});await r.text();if(r.ok){ready=true;break}}catch{}await new Promise(resolve=>setTimeout(resolve,200))}assert.ok(ready,'Pinned PostgREST did not start')
 // The original synthetic lease starts only after image startup: a slow first
 // Docker pull must not consume the fixture's real 120-second authority window.
 const w=await seed(db,60001),base=await raw(db,w.user)
 const hash=await hashMutationPayload('gmail_semantic_intake',{sourceId:'gmail:primary',recordIds:[]})
 const at=new Date().toISOString(),body={target_user_id:w.user,target_execution_token:w.token,target_command_id:`gmail:auto:${at}`,target_payload_hash:hash,target_expected_revision:0,target_checked_at:at,target_history_id:'1234',target_observation:observation}
 for(const role of [null,'anon','authenticated']){const denied=await post(body,role);assert.ok([401,403].includes(denied.status));assert.equal(denied.value.code,'42501')}
 assert.equal(Number((await raw(db,w.user)).revision),0)
 const first=await post(body);assert.equal(first.status,200);assert.equal(first.value[0].outcome,'COMMITTED');assert.ok(Buffer.byteLength(JSON.stringify(body))<2048);assert.ok(Buffer.byteLength(JSON.stringify(first.value))<4096);assert.deepEqual((await raw(db,w.user)).snapshot,base.snapshot)
 assert.deepEqual((await post(body)).value[0].receipt,first.value[0].receipt);assert.equal((await post({...body,target_payload_hash:'b'.repeat(64)})).value.code,'23505')
 const fetchImpl=(input,init)=>fetch(String(input).replace('/rest/v1/','/'),init)
 const store=createTransactionalWorkspaceStore({supabaseUrl:origin,serviceRoleKey:token('service_role'),fetchImpl,emptyGmailCheckpointReads:true,emptyGmailCheckpoints:true,metadataOnlyCommits:false,rawJsonCommits:false})
 const projected=await store.readForUser(w.user,{preserveRawData:true});assert.equal(projected.revision,1);assert.equal(projected.snapshot.data.timeline.length,2);assert.deepEqual(projected.snapshot,(await logical(db,w.user)).snapshot)
 // Actual v2 HTTP select must return the merged snapshot, not echo raw input.
 const merged=await store.commitAuthoritativeForUser({userId:w.user,commandId:'raw-v2-http',operation:'synthetic',payloadHash:'synthetic',expectedRevision:1,snapshot:base.snapshot,schemaVersion:4,principalKind:'first_party_web',receiptContext:{}})
 assert.equal(merged.revision,2);assert.equal(merged.snapshot.data.timeline.length,2);assert.deepEqual(merged.snapshot,(await logical(db,w.user)).snapshot)
 const nextAt=new Date(Date.now()+1).toISOString(),next={...body,target_command_id:`gmail:auto:${nextAt}`,target_checked_at:nextAt,target_expected_revision:2}
 // Discard a real HTTP response after headers, then establish DB outcome before
 // same-command replay. A transport error is never an excuse for a new command.
 await new Promise((resolve,reject)=>{const request=httpRequest(origin+rpc,{method:'POST',headers:headers('service_role')},response=>{response.destroy();request.destroy();resolve()});request.setTimeout(30000,()=>request.destroy(Error('Fixture timeout')));request.on('error',reject);request.end(JSON.stringify(next))})
 const receipt=(await db.query('select receipt from pjsdas_command_ledger where user_id=$1 and command_id=$2',[w.user,next.target_command_id])).rows[0]?.receipt;assert.ok(receipt)
 const replay=await post(next);assert.equal(replay.value[0].outcome,'ALREADY_APPLIED');assert.deepEqual(replay.value[0].receipt,receipt);assert.equal(Number((await raw(db,w.user)).revision),3)
 const rollbackAt=new Date(Date.now()+2).toISOString(),rollback={...body,target_command_id:`gmail:auto:${rollbackAt}`,target_checked_at:rollbackAt,target_expected_revision:3}
 assert.equal((await post(rollback,'service_role',{prefer:'tx=rollback'})).value[0].outcome,'COMMITTED');assert.equal(Number((await raw(db,w.user)).revision),3);assert.equal((await db.query('select count(*)::int n from pjsdas_command_ledger where command_id=$1',[rollback.target_command_id])).rows[0].n,0)
 // Rollback drain fence also applies to a real metadata-only v3 HTTP request.
 const stale=await raw(db,w.user);assert.equal((await db.query('select * from pjsdas_drain_empty_gmail_runs_v1($1,3)',[w.user])).rows[0].outcome,'DRAINED')
 const old={target_user_id:w.user,target_command_id:'pre-drain-v3',target_operation:'synthetic',target_payload_hash:'synthetic',target_expected_revision:3,target_snapshot:stale.snapshot,target_schema_version:4,target_principal_kind:'first_party_web',target_client_id:null,target_provenance:{},target_compensation:null,target_effective_time:null,target_receipt_context:{}}
 const conflict=await fetch(origin+'/rpc/pjsdas_commit_workspace_v3',{method:'POST',headers:headers('service_role'),body:JSON.stringify(old)});assert.equal(conflict.status,200);assert.equal((await conflict.json())[0].outcome,'CONFLICT');assert.equal((await store.readForUser(w.user)).snapshot.data.timeline.length,3)
 console.log('PASS real PostgREST14.5/PG17 empty checkpoint: JWT denials, bounded body/receipt, actual TS read overlay, actual merged v2 response, immutable replay, discarded-response recovery, transaction rollback, stale-reader drain fence.')
}finally{
 if(dockerAttempted)await docker('docker',['rm','--force',container],{timeout:15000,maxBuffer:1024*1024}).catch(()=>{})
 if(db)await db.end();if(admin){try{if(created)await admin.query(`drop database ${database} with (force)`)}finally{await admin.end()}}
}
