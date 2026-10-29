/** Fresh owned DB and public-only PostgREST. Imports only frozen source fixtures. */
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {randomUUID,randomBytes,createHmac,timingSafeEqual} from 'node:crypto'
import {spawn} from 'node:child_process'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {createRequire} from 'node:module'
import {join} from 'node:path'
import {setTimeout as sleep} from 'node:timers/promises'
import {root,source,sourceImport,sha,verifySource} from './source.mjs'
verifySource()
const require=createRequire(join(process.env.TA_V2_SQL_DEPS??join(source,'tests/sql/node_modules'),'package.json'))
const pg=require('pg')
const {install,checkpointMigration}=await sourceImport('tests/sql/gmail-empty-checkpoint-fixture.mjs')
const {migration}=await sourceImport('tests/sql/discovery-authority-fixture.mjs')
const {installLegacyReadFenceFixture}=await sourceImport('tests/sql/workspace-rows-legacy-read-fence-fixture.mjs')
const {encodeWorkspaceRows,decodeWorkspaceRows}=await sourceImport('gateway/workspaceRowsCodec.ts')
const {largeAbandonFixture}=await sourceImport('tests/fixtures/workspaceRowsLargeCommand.ts')
const {stagedOpportunityFixture}=await sourceImport('tests/fixtures/workspaceRowsStagedOpportunity.ts')
const {scopedManagementConsentHash}=await sourceImport('gateway/scopedManagementConsent.ts')
const {stagedCommandStageId}=await sourceImport('gateway/workspaceRowsStagedBridge.ts')
const {decodePreparedIntent}=await sourceImport('gateway/workspaceRowsDurableIntent.ts')
export const sqlFiles=['workspace-rows-stage-a.sql','workspace-rows-authoritative-stage-a.sql','workspace-rows-planning-stage-a.sql','workspace-rows-profile-stage-a.sql','workspace-rows-reminder-stage-a.sql','workspace-rows-opportunity-stage-a.sql','workspace-rows-business-stage-a.sql','workspace-rows-management-v2-stage-a.sql','workspace-rows-ai-capture-stage-a.sql','workspace-rows-discovery-stage-a.sql','workspace-rows-history-stage-a.sql','workspace-rows-bootstrap-stage-a.sql','workspace-rows-public-transport-stage-a.sql','workspace-rows-layout-fence-stage-a.sql','workspace-rows-large-command-prototype.sql','workspace-rows-staged-opportunity-prototype.sql','workspace-rows-staged-documents-prototype.sql','workspace-rows-durable-intent-prototype.sql','workspace-rows-audit-bytes-prototype.sql','workspace-rows-resource-reservations.sql','workspace-rows-resource-rpc.sql','workspace-rows-durable-attempts-v2.sql','workspace-rows-resource-reclamation.sql']
const readBody=async req=>{const chunks=[];for await(const c of req)chunks.push(c);return Buffer.concat(chunks)}
const listen=server=>new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',()=>ok('http://127.0.0.1:'+server.address().port))})
export async function fixture(evidence){
 const url=new URL(process.env.TA_ROW_DATABASE_URL)
 assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/postgres');assert.equal(url.username,'postgres')
 assert.equal(process.env.TA_RECLAIM_VALIDATION_WINDOW,'authorized-by-parent')
 const name='ta_reclaim_accept_'+randomUUID().replaceAll('-',''),auth='ta_reclaim_http_'+randomUUID().replaceAll('-','')
 const admin=new pg.Client({connectionString:url.href});url.pathname='/'+name
 const db=new pg.Client({connectionString:url.href}),nativeFetch=globalThis.fetch
 const secret=randomBytes(48).toString('hex'),webOrigin='https://synthetic.invalid'
 const jwt=claims=>{const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url'),value=enc({alg:'HS256',typ:'JWT'})+'.'+enc({...claims,exp:Math.floor(Date.now()/1000)+3600});return value+'.'+createHmac('sha256',secret).update(value).digest('base64url')}
 const serviceToken=jwt({role:'service_role'})
 let created=false,authCreated=false,readerCreated=false,postgrest,postgrestDone,postgrestSettled=false,postgrestSpawnError,proxy,proxyOrigin,drop,offline=false
 const calls=[],children=[],inflight=new Set(),snapshots=[],faults=[],observers=[]
 const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0]
 const own=async promise=>{inflight.add(promise);try{return await promise}finally{inflight.delete(promise)}}
 const drain=async()=>{while(inflight.size)await Promise.allSettled([...inflight])}
 const port=Number(process.env.TA_V2_POSTGREST_PORT);assert(Number.isSafeInteger(port)&&port>1024)
 const origin='http://127.0.0.1:'+port
 const rpc=(name,args)=>own((async()=>{const response=await nativeFetch(origin+'/rpc/pjsdas_rows_v1_'+name,{method:'POST',headers:{authorization:'Bearer '+serviceToken,'content-type':'application/json'},body:JSON.stringify(args)});return{status:response.status,body:await response.json()}})())
 // Keep all per-request hashes/times/statuses, not all prior cases' duplicate
 // multi-MiB diagnostic payloads. Product requests and accumulated DB state are
 // unchanged. Only completed calls are eligible; active fault hooks retain data.
 const checkpoints=[]
 function checkpoint(label){
  mkdirSync(join(evidence,'http-payloads'),{recursive:true})
  for(const [index,c] of calls.entries())if((c.endedAt||c.droppedBefore)&&!c.diagnosticPayloadSha256){
   const raw=JSON.stringify({input:c.input,output:c.output})+'\n',file=index+'.json'
   writeFileSync(join(evidence,'http-payloads',file),raw)
   c.diagnosticPayloadSha256=sha(raw);c.diagnosticPayloadFile='http-payloads/'+file
   delete c.input;delete c.output
  }
  checkpoints.push({label,at:Date.now(),memory:process.memoryUsage(),calls:calls.length,activeRequests:inflight.size})
  writeFileSync(join(evidence,'http.json'),JSON.stringify(calls.map(({input,output,...c})=>c),null,2)+'\n')
  writeFileSync(join(evidence,'memory-checkpoints.json'),JSON.stringify(checkpoints,null,2)+'\n')
 }
 async function close(){
  const errors=[],steps=[]
  const attempt=async(label,action)=>{try{await action();steps.push({label,status:'PASS'})}catch(error){errors.push(new Error(label,{cause:error}));steps.push({label,status:'FAIL',errorName:error?.name??'UnknownError'})}}
  // Failed assertions can leave these owned locks held. Release both kinds
  // before draining requests which may be waiting on this very fixture.
  for(const client of observers){
   await attempt('rollback owned observer',()=>client.query('rollback'))
   await attempt('unlock owned observer',()=>client.query('select pg_advisory_unlock_all()'))
  }
  await attempt('drain owned HTTP',()=>drain())
  for(const c of children)if(c.child.exitCode===null&&!c.child.signalCode)await attempt('stop worker '+c.pid,async()=>{c.child.kill('SIGTERM');try{await c.done}catch(error){if(!c.child.signalCode)throw error}})
  await attempt('close owned proxy',async()=>{if(proxy?.listening){proxy.closeAllConnections();await new Promise((ok,no)=>proxy.close(error=>error?no(error):ok()))}})
  await attempt('stop owned PostgREST',async()=>{if(postgrest){if(!postgrestSettled&&postgrest.pid)postgrest.kill('SIGTERM');await postgrestDone}})
  await attempt('persist DB diagnostics',async()=>{
   const value={intents:(await db.query("select user_id,command_id,stage_id,protocol,deadline_at,encoded->>'sha256' prepared_sha256,binding from pjsdas_rows_candidate.large_command_intent")).rows,attempts:(await db.query('select * from pjsdas_rows_candidate.large_command_attempt')).rows,ledger:(await db.query('select user_id,command_id,resulting_revision from pjsdas_rows_candidate.ledger')).rows,pool:(await db.query('select * from ta_resource_reservations.pool')).rows}
   writeFileSync(join(evidence,'db-terminal.json'),JSON.stringify(value,null,2)+'\n')
  })
  await attempt('checkpoint final diagnostics',()=>checkpoint('fixture-close'))
  await attempt('persist HTTP diagnostics',()=>writeFileSync(join(evidence,'http.json'),JSON.stringify(calls.map(({input,output,...c})=>c),null,2)+'\n'))
  await attempt('persist process diagnostics',()=>writeFileSync(join(evidence,'processes.json'),JSON.stringify(children.map(({child,done,...c})=>c),null,2)+'\n'))
  for(const client of observers)await attempt('close owned observer',()=>client.end())
  // Evidence I/O failure must never skip any owned cleanup step.
  await attempt('end owned DB client',()=>db.end())
  if(created)await attempt('drop owned database',()=>admin.query('drop database '+name+' with(force)'))
  if(readerCreated)await attempt('drop owned reader role',()=>admin.query('drop role pjsdas_workspace_blob_reader'))
  if(authCreated)await attempt('drop owned authenticator',()=>admin.query('drop role '+auth))
  if(created||authCreated)await attempt('verify owned catalog empty',async()=>{
   assert.equal(Number((await admin.query('select count(*) n from pg_database where datname=$1',[name])).rows[0].n),0)
   assert.equal(Number((await admin.query('select count(*) n from pg_roles where rolname=$1 or ($2 and rolname=$3)',[auth,readerCreated,'pjsdas_workspace_blob_reader'])).rows[0].n),0)
  })
  await attempt('end admin client',()=>admin.end())
  await attempt('verify owned processes exited',async()=>{
   assert(children.every(c=>c.child.exitCode!==null||c.child.signalCode))
   assert(!postgrest||postgrestSettled)
   assert(!proxy?.listening)
  })
  const summary={contract:'ta-reclamation-owned-cleanup-v1',status:errors.length?'FAIL':'PASS',databaseCreated:created,authenticatorCreated:authCreated,readerCreated,workerCount:children.length,observerCount:observers.length,steps}
  try{writeFileSync(join(evidence,'cleanup.json'),JSON.stringify(summary,null,2)+'\n')}catch(error){errors.push(error)}
  if(errors.length)throw new AggregateError(errors,'Owned fixture cleanup or evidence persistence failed')
 }

 try{
  await admin.connect();assert.equal(Number((await admin.query("select count(*) n from pg_roles where rolname='pjsdas_workspace_blob_reader'")).rows[0].n),0,'No existing fixture takeover')
  await admin.query('create database '+name);created=true
  await admin.query(`create role ${auth} login noinherit;grant anon,authenticated,service_role to ${auth}`);authCreated=true
  await db.connect();await db.query("set work_mem='2184kB';set statement_timeout='10s';set timezone='UTC'")
  await admin.query(`alter database ${name} set work_mem='2184kB';alter database ${name} set statement_timeout='10s'`)
  await install(db);await db.query(await migration(checkpointMigration))
  for(const file of sqlFiles)await db.query(readFileSync(join(source,'tests/sql/candidates',file),'utf8'))
  await installLegacyReadFenceFixture(db);readerCreated=true
  // Original synthetic local fixture pool, not production policy or expansion.
  await db.query(`insert into ta_resource_reservations.pool(singleton,enabled,command_limit,owner_limit,global_limit,generation,inventory_verified,inventory_revision) values(true,true,16777216,33554432,276824064,'rpc-local-v1',true,0)`)
  for(const privilege of ['UPDATE','DELETE','TRUNCATE'])assert.equal((await scalar("select has_table_privilege('service_role','pjsdas_rows_candidate.large_command_intent',$1) ok",[privilege])).ok,false)
  const httpUrl=new URL(url);httpUrl.username=auth
  postgrest=spawn(process.env.TA_POSTGREST_BIN,[],{env:{...process.env,PGRST_DB_URI:httpUrl.href,PGRST_DB_SCHEMAS:'public',PGRST_DB_ANON_ROLE:'anon',PGRST_JWT_SECRET:secret,PGRST_SERVER_HOST:'127.0.0.1',PGRST_SERVER_PORT:String(port),PGRST_DB_POOL:'2',PGRST_DB_MAX_ROWS:'1000'},stdio:['ignore','ignore','pipe']})
  // Spawn failure has no successful pid and need not emit exit. close always
  // emits after error; cleanup awaits this terminal promise without a hang.
  postgrestDone=new Promise(resolve=>postgrest.once('close',()=>{postgrestSettled=true;resolve()}))
  postgrest.on('error',error=>{postgrestSpawnError=error})
  let logs='';postgrest.stderr.on('data',d=>{logs+=d});let ready=false
  for(let i=0;i<100;i++){assert(!postgrestSpawnError,'Owned PostgREST spawn failed');assert.equal(postgrest.exitCode,null,logs);try{if((await nativeFetch(origin)).status<500){ready=true;break}}catch{}await sleep(50)}assert(ready,logs)
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
   Object.assign(log,{status:result.status,endedAt:Date.now(),responseSha256:sha(body),responseBytes:body.length});try{log.output=JSON.parse(body);log.errorCode=log.output.code;if(!result.ok)console.log('RPC_FAILURE',path,JSON.stringify(log.output))}catch{}
   if(faults[0]?.match(path,input)){const hook=faults.shift();await hook.run(log)}
   if(drop?.match(path,input)){drop=undefined;log.droppedAfter=true;res.destroy();return}
   if(!res.destroyed){res.writeHead(result.status,Object.fromEntries(result.headers));res.end(body)}
  })().catch(error=>{if(!res.destroyed){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({fixtureError:String(error)}))}});void own(job)})
  proxyOrigin=await listen(proxy)
 }catch(error){try{await close()}catch(cleanupError){throw new AggregateError([error,cleanupError],'Fixture setup and cleanup failed')}throw error}
 async function reserve(ids,commandId,family,{lifetimeMs=30*60*1000}={}){
  const stage=stagedCommandStageId({userId:ids.userId,workspaceId:ids.workspaceId,expectedEpoch:ids.epoch,commandId},family)
  // Explicit PRE-admission local synthetic authority; never updates after admit.
  await db.query("insert into pjsdas_rows_candidate.large_document_reservation values($1,$2,$3,16777216,clock_timestamp()+$4*interval '1 millisecond')",[stage,ids.userId,ids.workspaceId,lifetimeMs]);return stage
 }
 async function seed(snapshot,enroll=true){
  const userId=randomUUID();await db.query('insert into auth.users values($1)',[userId]);await db.query("insert into pjsdas_access_grants(user_id,email,role) values($1,'synthetic@example.invalid','owner')",[userId])
  const workspaceId=(await scalar('insert into pjsdas_workspaces(user_id,snapshot,schema_version) values($1,$2,4) returning id',[userId,JSON.stringify(snapshot)])).id
  const encoded=encodeWorkspaceRows(snapshot),epoch=(await scalar('insert into pjsdas_rows_candidate.head(id,user_id,envelope,manifest,legacy_snapshot) values($1,$2,$3,$4,$5) returning epoch',[workspaceId,userId,encoded.envelope,JSON.stringify(encoded.manifest),JSON.stringify(snapshot)])).epoch
  await db.query('insert into pjsdas_rows_candidate.item select $1,$2,x.collection,x.id,x.ordinal,x.value,0 from jsonb_to_recordset($3) x(collection text,id text,ordinal bigint,value jsonb)',[workspaceId,userId,JSON.stringify(encoded.rows)])
  await db.query('update pjsdas_workspaces set row_candidate_epoch=$2 where id=$1',[workspaceId,epoch]);if(enroll)await db.query('insert into ta_resource_reservations.rpc_scope values($1)',[userId])
  snapshots.push({userId,snapshotSha256:sha(snapshot)});return{userId,workspaceId,epoch}
 }
 async function make(family='api',options={}){
  const f=family==='api'?largeAbandonFixture():await stagedOpportunityFixture(2050,{compactIds:options.compactIds??false})
  f.before.futureHeader={utf8:'未来😀',nested:{preserve:['x',null,1]}};f.before.data.futureData={preserve:true}
  const ids=await seed(f.before,options.resource!==false),commandId='v2-independent-'+randomUUID(),t={ids,family,commandId,f}
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
  const child=spawn(process.execPath,['--import',process.env.TA_V2_TSX??join(source,'node_modules/tsx/dist/loader.mjs'),overrides.TA_RECLAIM_HISTORICAL_WORKER??join(root,'cold-worker.mjs')],{cwd:root,env:{...process.env,...env,...overrides,TA_INTENT_PROXY:proxyOrigin},stdio:['pipe','pipe','pipe']})
  const info={child,pid:child.pid,startedAt:Date.now(),commandId:input.body?.commandId,mode:input.mode??'api'};children.push(info)
  let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d)
  info.done=new Promise((ok,no)=>{child.once('error',no);child.once('exit',(code,signal)=>{Object.assign(info,{exitAt:Date.now(),code,signal,stderr:err});code===0?ok():no(Error(`Cold worker ${child.pid} exited ${code}/${signal}: ${err} ${out}`))})})
  child.stdin.end(JSON.stringify(input));await info.done;const result=JSON.parse(out)
  child.stdout.removeAllListeners('data');child.stderr.removeAllListeners('data');out='';err=''
  return{result,process:info}
 }
 const invoke=(t,overrides={})=>cold(t.family==='api'?{body:t.input,headers:{origin:webOrigin,authorization:'Bearer '+jwt({role:'authenticated',sub:t.ids.userId}),'content-type':'application/json'}}:{mode:'scoped',userId:t.ids.userId,clientId:t.clientId,tool:t.undo?'restore_opportunity_management':'execute_opportunity_management',body:t.input},overrides)
 const current=async t=>{const h=await scalar('select * from pjsdas_rows_candidate.head where id=$1',[t.ids.workspaceId]),rows=(await db.query('select collection,id,ordinal::integer,value from pjsdas_rows_candidate.item where workspace_id=$1',[t.ids.workspaceId])).rows;return{revision:Number(h.revision),snapshot:decodeWorkspaceRows({contract:'workspace-rows-v1',envelope:h.envelope,manifest:h.manifest,rows})}}
 const ledger=async t=>(await db.query('select command_id,receipt,compensation,resulting_revision from pjsdas_rows_candidate.ledger where user_id=$1 order by resulting_revision',[t.ids.userId])).rows
 const intent=async t=>scalar('select * from pjsdas_rows_candidate.large_command_intent where stage_id=$1',[t.stage])
 const reservation=async t=>scalar('select * from pjsdas_rows_candidate.large_document_reservation where stage_id=$1',[t.stage])
 const decoded=t=>decodePreparedIntent(t.encoded,16777216)
 async function observer(label){const c=new pg.Client({connectionString:url.href,application_name:'reclaim-observer-'+label});await c.connect();observers.push(c);return c}
 return{db,scalar,rpc,make,reserve,cold,invoke,current,ledger,intent,reservation,decoded,close,calls,children,faults,drain,snapshots,observer,checkpoint,
  setDrop(rule){assert.equal(drop,undefined);drop=rule},assertNoDrop(){assert.equal(drop,undefined)},setOffline(value){offline=value},isOffline:()=>offline,
  identity:t=>({identity:t.identity,target_user_id:t.ids.userId}),env,
  async probeDisconnected(){assert(offline);await assert.rejects(nativeFetch(proxyOrigin+'/rest/v1/',{signal:AbortSignal.timeout(1000)}));return Date.now()}}
}
