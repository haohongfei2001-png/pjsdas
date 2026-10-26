/** Fresh owned DB and public-only PostgREST. Imports only frozen source fixtures. */
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {randomUUID,randomBytes,createHmac,timingSafeEqual} from 'node:crypto'
import {spawn} from 'node:child_process'
import {readFileSync,writeFileSync} from 'node:fs'
import pg from 'pg'
import {join} from 'node:path'
import {setTimeout as sleep} from 'node:timers/promises'
import {root,source,sourceImport,sha,safeError,verifySource} from './workspace-rows-durable-v2-source.mjs'
// Verify the frozen checkout before loading any product source.
verifySource()
const {install,checkpointMigration}=await sourceImport('tests/sql/gmail-empty-checkpoint-fixture.mjs')
const {migration}=await sourceImport('tests/sql/discovery-authority-fixture.mjs')
const {installLegacyReadFenceFixture}=await sourceImport('tests/sql/workspace-rows-legacy-read-fence-fixture.mjs')
const {encodeWorkspaceRows,decodeWorkspaceRows}=await sourceImport('gateway/workspaceRowsCodec.ts')
const {largeAbandonFixture}=await sourceImport('tests/fixtures/workspaceRowsLargeCommand.ts')
const {stagedOpportunityFixture}=await sourceImport('tests/fixtures/workspaceRowsStagedOpportunity.ts')
const {scopedManagementConsentHash}=await sourceImport('gateway/scopedManagementConsent.ts')
const {stagedCommandStageId}=await sourceImport('gateway/workspaceRowsStagedBridge.ts')
const {decodePreparedIntent}=await sourceImport('gateway/workspaceRowsDurableIntent.ts')
export const sqlFiles=['workspace-rows-stage-a.sql','workspace-rows-authoritative-stage-a.sql','workspace-rows-planning-stage-a.sql','workspace-rows-profile-stage-a.sql','workspace-rows-reminder-stage-a.sql','workspace-rows-opportunity-stage-a.sql','workspace-rows-business-stage-a.sql','workspace-rows-management-v2-stage-a.sql','workspace-rows-ai-capture-stage-a.sql','workspace-rows-discovery-stage-a.sql','workspace-rows-history-stage-a.sql','workspace-rows-bootstrap-stage-a.sql','workspace-rows-public-transport-stage-a.sql','workspace-rows-layout-fence-stage-a.sql','workspace-rows-large-command-prototype.sql','workspace-rows-staged-opportunity-prototype.sql','workspace-rows-staged-documents-prototype.sql','workspace-rows-durable-intent-prototype.sql','workspace-rows-audit-bytes-prototype.sql','workspace-rows-resource-reservations.sql','workspace-rows-resource-rpc.sql','workspace-rows-durable-attempts-v2.sql']
const readBody=async req=>{const chunks=[];for await(const c of req)chunks.push(c);return Buffer.concat(chunks)}
const listen=server=>new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',()=>ok('http://127.0.0.1:'+server.address().port))})
export async function fixture(evidence){
 const url=new URL(process.env.TA_ROW_DATABASE_URL)
 assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/postgres');assert.equal(url.username,'postgres')
 assert.equal(process.env.TA_V2_VALIDATION_WINDOW,'synthetic-owned-fixture')
 assert.equal(url.search,'');assert.equal(url.hash,'')
 const name='ta_v2_accept_'+randomUUID().replaceAll('-',''),auth='ta_v2_http_'+randomUUID().replaceAll('-','')
 const admin=new pg.Client({connectionString:url.href});url.pathname='/'+name
 const db=new pg.Client({connectionString:url.href}),nativeFetch=globalThis.fetch
 const authenticatorPassword=randomBytes(32).toString('hex')
 const secret=randomBytes(48).toString('hex'),webOrigin='https://synthetic.invalid'
 const jwt=claims=>{const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url'),value=enc({alg:'HS256',typ:'JWT'})+'.'+enc({...claims,exp:Math.floor(Date.now()/1000)+3600});return value+'.'+createHmac('sha256',secret).update(value).digest('base64url')}
 const serviceToken=jwt({role:'service_role'})
 let created=false,authCreated=false,readerCreated=false,postgrest,proxy,proxyOrigin,drop,offline=false
 const calls=[],children=[],inflight=new Set(),snapshots=[],faults=[],ownedClients=[]
 const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0]
 const own=async promise=>{inflight.add(promise);try{return await promise}finally{inflight.delete(promise)}}
 const drain=async()=>{while(inflight.size)await Promise.allSettled([...inflight])}
 const port=Number(process.env.TA_V2_POSTGREST_PORT??55765);assert(Number.isSafeInteger(port)&&port>1024&&port<65536)
 const origin='http://127.0.0.1:'+port
 const rpc=async(name,args)=>{const log={path:'/rpc/pjsdas_rows_v1_'+name,receivedAt:Date.now(),input:args,directPublicHttp:true};calls.push(log);const response=await nativeFetch(origin+log.path,{method:'POST',headers:{authorization:'Bearer '+serviceToken,'content-type':'application/json'},body:JSON.stringify(args)});const body=await response.json();Object.assign(log,{status:response.status,endedAt:Date.now(),output:body,errorCode:body?.code});return{status:response.status,body}}
 async function close(){
  const errors=[],steps=[]
  const attempt=async(label,action)=>{try{await action();steps.push({label,status:'PASS'})}catch(error){errors.push(error);steps.push({label,status:'FAIL',error:safeError(error)})}}
  for(const c of ownedClients)await attempt('release-owned-observer',async()=>{await c.query('rollback');await c.query('select pg_advisory_unlock_all()')})
  await attempt('drain-owned-http',()=>drain())
  for(const c of children)if(c.child.exitCode===null&&!c.child.signalCode)await attempt('stop-owned-worker',async()=>{c.child.kill('SIGTERM');try{await c.done}catch(error){if(!c.child.signalCode)throw error}})
  await attempt('close-owned-proxy',async()=>{if(proxy?.listening){proxy.closeAllConnections();await new Promise((ok,no)=>proxy.close(error=>error?no(error):ok()))}})
  await attempt('stop-owned-postgrest',async()=>{if(postgrest&&postgrest.exitCode===null&&!postgrest.signalCode){const done=new Promise(r=>postgrest.once('exit',r));postgrest.kill('SIGTERM');await done}})
  // No original request, prepared bytes, JWT, password or child stderr is written.
  for(const c of ownedClients)await attempt('end-owned-observer',()=>c.end())
  await attempt('end-owned-db-client',()=>db.end())
  if(created)await attempt('drop-owned-database',()=>admin.query('drop database '+name+' with(force)'))
  if(readerCreated)await attempt('drop-owned-reader-role',()=>admin.query('drop role pjsdas_workspace_blob_reader'))
  if(authCreated)await attempt('drop-owned-authenticator',()=>admin.query('drop role '+auth))
  if(created||authCreated)await attempt('verify-owned-catalog-empty',async()=>{
   assert.equal(Number((await admin.query('select count(*) n from pg_database where datname=$1',[name])).rows[0].n),0)
   assert.equal(Number((await admin.query('select count(*) n from pg_roles where rolname=$1 or ($2 and rolname=$3)',[auth,readerCreated,'pjsdas_workspace_blob_reader'])).rows[0].n),0)
  })
  await attempt('end-admin-client',()=>admin.end())
  await attempt('verify-owned-processes-exited',async()=>{
   assert(children.every(c=>c.child.exitCode!==null||c.child.signalCode))
   assert(!postgrest||postgrest.exitCode!==null||postgrest.signalCode)
   assert(!proxy?.listening)
  })
  const summary={contract:'ta-native-owned-cleanup-v1',status:errors.length?'FAIL':'PASS',databaseCreated:created,authenticatorCreated:authCreated,readerCreated,workerCount:children.length,observerCount:ownedClients.length,steps}
  try{writeFileSync(join(evidence,'cleanup.json'),JSON.stringify(summary,null,2)+'\n')}catch(error){errors.push(error)}
  if(errors.length)throw new AggregateError(errors,'Owned fixture cleanup failed')
 }

 try{
  await admin.connect();assert.equal(Number((await admin.query("select count(*) n from pg_roles where rolname='pjsdas_workspace_blob_reader'")).rows[0].n),0,'No existing fixture takeover')
  await admin.query('create database '+name);created=true
  await admin.query(`create role ${auth} login noinherit password '${authenticatorPassword}'`);authCreated=true
  await admin.query(`grant anon,authenticated,service_role to ${auth}`)
  const authFlags=(await admin.query('select rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls from pg_roles where rolname=$1',[auth])).rows[0]
  assert.deepEqual(authFlags,{rolcanlogin:true,rolinherit:false,rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolreplication:false,rolbypassrls:false})
  await db.connect();await db.query("set work_mem='2184kB';set statement_timeout='10s'")
  await admin.query(`alter database ${name} set work_mem='2184kB';alter database ${name} set statement_timeout='10s'`)
  assert.equal((await scalar('show work_mem')).work_mem,'2184kB');assert.equal((await scalar('show statement_timeout')).statement_timeout,'10s')
  await install(db);await db.query(await migration(checkpointMigration))
  for(const file of sqlFiles)await db.query(readFileSync(join(source,'tests/sql/candidates',file),'utf8'))
  await installLegacyReadFenceFixture(db);readerCreated=true
  // Original synthetic local fixture pool, not production policy or expansion.
  await db.query(`insert into ta_resource_reservations.pool(singleton,enabled,command_limit,owner_limit,global_limit,generation,inventory_verified,inventory_revision) values(true,true,16777216,33554432,276824064,'rpc-local-v1',true,0)`)
  for(const privilege of ['UPDATE','DELETE','TRUNCATE'])assert.equal((await scalar("select has_table_privilege('service_role','pjsdas_rows_candidate.large_command_intent',$1) ok",[privilege])).ok,false)
  const httpUrl=new URL(url);httpUrl.username=auth;httpUrl.password=authenticatorPassword
  postgrest=spawn(process.env.TA_POSTGREST_BIN,[],{env:{...process.env,PGRST_DB_URI:httpUrl.href,PGRST_DB_SCHEMAS:'public',PGRST_DB_ANON_ROLE:'anon',PGRST_JWT_SECRET:secret,PGRST_SERVER_HOST:'127.0.0.1',PGRST_SERVER_PORT:String(port),PGRST_DB_POOL:'2',PGRST_DB_MAX_ROWS:'1000'},stdio:['ignore','ignore','pipe']})
  let spawnError;postgrest.on('error',error=>{spawnError=error});postgrest.stderr.resume();let ready=false
  for(let i=0;i<100;i++){assert(!spawnError,'Owned PostgREST failed to start');assert.equal(postgrest.exitCode,null,'Owned PostgREST exited before ready');try{if((await nativeFetch(origin)).status<500){ready=true;break}}catch{}await sleep(50)}assert(ready,'Owned PostgREST readiness failed')
  proxy=createServer((req,res)=>{const job=(async()=>{
   const receivedAt=Date.now()
   if(offline){calls.push({path:req.url,receivedAt,offlineRefused:true});res.destroy();return}
   if(req.url==='/auth/v1/user'){
    const[a,b,c]=String(req.headers.authorization??'').replace(/^Bearer /,'').split('.');assert(a&&b&&c);assert(timingSafeEqual(createHmac('sha256',secret).update(a+'.'+b).digest(),Buffer.from(c,'base64url')))
    const claims=JSON.parse(Buffer.from(b,'base64url'));assert.equal(claims.role,'authenticated');assert(claims.exp>Date.now()/1000)
    res.setHeader('content-type','application/json');res.end(JSON.stringify({id:claims.sub,email:'synthetic@example.invalid'}));return
   }
   assert(req.url.startsWith('/rest/v1/'),'nonlocal egress forbidden');const raw=await readBody(req),path=req.url.replace('/rest/v1/','/'),input=raw.length?JSON.parse(raw):undefined
   const log={path,receivedAt,input,requestSha256:sha(raw),bytes:raw.length};calls.push(log)
   if(drop?.before&&drop.match(path,input)){drop=undefined;log.droppedBefore=true;res.destroy();return}
   const result=await nativeFetch(origin+path,{method:req.method,headers:req.headers,...(raw.length?{body:raw}:{})}),body=Buffer.from(await result.arrayBuffer())
   Object.assign(log,{status:result.status,endedAt:Date.now(),responseSha256:sha(body),responseBytes:body.length});try{log.output=JSON.parse(body);log.errorCode=log.output.code}catch{}
   if(faults[0]?.match(path,input)){const hook=faults.shift();await hook.run(log)}
   if(drop?.match(path,input)){drop=undefined;log.droppedAfter=true;res.destroy();return}
   if(!res.destroyed){res.writeHead(result.status,Object.fromEntries(result.headers));res.end(body)}
  })().catch(error=>{if(!res.destroyed){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({fixtureError:'synthetic proxy failure'}))}});void own(job)})
  proxyOrigin=await listen(proxy)
 }catch(error){try{await close()}catch(cleanupError){throw new AggregateError([error,cleanupError],'Fixture setup and cleanup failed')}throw error}
 async function reserve(ids,commandId,family,{lifetimeMs=30*60*1000,reservedBytes=16777216}={}){
  assert([8388608,16777216].includes(reservedBytes),'Only original explicit synthetic 8/16MiB reservations')
  const stage=stagedCommandStageId({userId:ids.userId,workspaceId:ids.workspaceId,expectedEpoch:ids.epoch,commandId},family)
  // Explicit PRE-admission local synthetic authority; never updates after admit.
  await db.query("insert into pjsdas_rows_candidate.large_document_reservation values($1,$2,$3,$5,clock_timestamp()+$4*interval '1 millisecond')",[stage,ids.userId,ids.workspaceId,lifetimeMs,reservedBytes]);return stage
 }
 async function seed(snapshot,{enroll=true}={}){
  const userId=randomUUID();await db.query('insert into auth.users values($1)',[userId]);await db.query("insert into pjsdas_access_grants(user_id,email,role) values($1,'synthetic@example.invalid','owner')",[userId])
  const workspaceId=(await scalar('insert into pjsdas_workspaces(user_id,snapshot,schema_version) values($1,$2,4) returning id',[userId,JSON.stringify(snapshot)])).id
  const encoded=encodeWorkspaceRows(snapshot),epoch=(await scalar('insert into pjsdas_rows_candidate.head(id,user_id,envelope,manifest,legacy_snapshot) values($1,$2,$3,$4,$5) returning epoch',[workspaceId,userId,encoded.envelope,JSON.stringify(encoded.manifest),JSON.stringify(snapshot)])).epoch
  await db.query('insert into pjsdas_rows_candidate.item select $1,$2,x.collection,x.id,x.ordinal,x.value,0 from jsonb_to_recordset($3) x(collection text,id text,ordinal bigint,value jsonb)',[workspaceId,userId,JSON.stringify(encoded.rows)])
  await db.query('update pjsdas_workspaces set row_candidate_epoch=$2 where id=$1',[workspaceId,epoch]);if(enroll)await db.query('insert into ta_resource_reservations.rpc_scope values($1)',[userId])
  snapshots.push({userId,snapshot:structuredClone(snapshot)});return{userId,workspaceId,epoch}
 }
 async function make(family='api',options={}){
  const f=family==='api'?largeAbandonFixture():await stagedOpportunityFixture(2050,{compactIds:false})
  f.before.futureHeader={utf8:'未来😀',nested:{preserve:['x',null,1]}};f.before.data.futureData={preserve:true}
  const ids=await seed(f.before,{enroll:options.enroll!==false}),commandId='v2-independent-'+randomUUID(),t={ids,family,commandId,f}
  if(family==='scoped'){
   t.clientId=randomUUID();t.grantId=randomUUID()
   await db.query("insert into pjsdas_business_management_grants(id,user_id,client_id,capability,consent_version,consent_text_hash) values($1,$2,$3,'workspace.opportunity.manage',3,$4)",[t.grantId,ids.userId,t.clientId,await scopedManagementConsentHash('opportunity')])
  }
  t.input=family==='api'?{action:'command',projection:'delta-v1',commandId,baseRevision:0,command:{type:'domain',value:{...f.command,commandId}}}:{commandId,baseRevision:0,change:f.input}
  t.stage=await reserve(ids,commandId,family==='api'?'first_party_abandon':'opportunity_v3',options)
  return t
 }
 const env={PJSDAS_SUPABASE_SERVICE_ROLE_KEY:serviceToken,PJSDAS_ALLOWED_WEB_ORIGINS:webOrigin,PJSDAS_AUDIENCE_MODE:'allowlist',PJSDAS_AI_CAPTURE:'disabled',PJSDAS_WORKSPACE_ROWS_READS:'1',PJSDAS_WORKSPACE_ROWS_WRITES:'1',PJSDAS_WORKSPACE_ROWS_READ_CONCURRENCY:'1',PJSDAS_WORKSPACE_ROWS_STAGED_DOCUMENTS:'1',PJSDAS_WORKSPACE_ROWS_DURABLE_INTENT:'1',PJSDAS_WORKSPACE_ROWS_DURABLE_ATTEMPTS_V2:'1',PJSDAS_WORKSPACE_ROWS_DURABLE_INTENT_ADMISSION:'1',PJSDAS_WORKSPACE_ROWS_AUDIT_BYTES:'1',PJSDAS_WORKSPACE_ROWS_AUDIT_PAGES:'1',PJSDAS_WORKSPACE_ROWS_RELEASE_PROFILE:'compatible-pages-v1',PJSDAS_WORKSPACE_COMMIT_METADATA_ONLY:'1',PJSDAS_WORKSPACE_COMMIT_RAW_JSON:'1',PJSDAS_GMAIL_EMPTY_CHECKPOINTS:'0',PJSDAS_GMAIL_EMPTY_CHECKPOINT_READS:'0'}
 async function cold(input,overrides={}){
  const child=spawn(process.execPath,['--import','tsx',join(root,'tests/sql/workspace-rows-durable-v2-cold-worker.mjs')],{cwd:root,env:{...process.env,...env,...overrides,TA_INTENT_PROXY:proxyOrigin},stdio:['pipe','pipe','pipe']})
  const info={child,pid:child.pid,startedAt:Date.now(),commandId:input.body?.commandId,mode:input.mode??'api'};children.push(info)
  let out='';child.stdout.on('data',d=>out+=d);child.stderr.resume()
  info.done=new Promise((ok,no)=>{child.once('error',no);child.once('exit',(code,signal)=>{Object.assign(info,{exitAt:Date.now(),code,signal});code===0?ok():no(Error(`Cold worker exited unsuccessfully`))})})
  child.stdin.end(JSON.stringify(input));await info.done;return{result:JSON.parse(out),process:info}
 }
 const invoke=(t,overrides={})=>cold(t.family==='api'?{body:t.input,headers:{origin:webOrigin,authorization:'Bearer '+jwt({role:'authenticated',sub:t.ids.userId}),'content-type':'application/json'}}:{mode:'scoped',userId:t.ids.userId,clientId:t.clientId,tool:t.undo?'restore_opportunity_management':'execute_opportunity_management',body:t.input},overrides)
 const current=async t=>{const h=await scalar('select * from pjsdas_rows_candidate.head where id=$1',[t.ids.workspaceId]),rows=(await db.query('select collection,id,ordinal::integer,value from pjsdas_rows_candidate.item where workspace_id=$1',[t.ids.workspaceId])).rows;return{revision:Number(h.revision),snapshot:decodeWorkspaceRows({contract:'workspace-rows-v1',envelope:h.envelope,manifest:h.manifest,rows})}}
 const ledger=async t=>(await db.query('select command_id,receipt,compensation,resulting_revision from pjsdas_rows_candidate.ledger where user_id=$1 order by resulting_revision',[t.ids.userId])).rows
 const intent=async t=>scalar('select * from pjsdas_rows_candidate.large_command_intent where stage_id=$1',[t.stage])
 const reservation=async t=>scalar('select * from pjsdas_rows_candidate.large_document_reservation where stage_id=$1',[t.stage])
 const decoded=(t,reservedBytes=16777216)=>decodePreparedIntent(t.encoded,reservedBytes)
 const observer=async(label)=>{assert(/^[a-z0-9_-]+$/.test(label));const client=new pg.Client({connectionString:url.href,application_name:'ta_v2_barrier_'+label});ownedClients.push(client);await client.connect();await client.query("set statement_timeout='10s'");return client}
 return{db,scalar,rpc,make,reserve,cold,invoke,current,ledger,intent,reservation,decoded,observer,close,calls,children,faults,drain,snapshots,
  setDrop(rule){assert.equal(drop,undefined);drop=rule},assertNoDrop(){assert.equal(drop,undefined)},setOffline(value){offline=value},isOffline:()=>offline,
  identity:t=>({identity:t.identity,target_user_id:t.ids.userId}),env,
  async probeDisconnected(){assert(offline);await assert.rejects(nativeFetch(proxyOrigin+'/rest/v1/',{signal:AbortSignal.timeout(1000)}));return Date.now()}}
}
