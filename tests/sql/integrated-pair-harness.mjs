/** Synthetic loopback real api/workspace.ts + runtime factory + PostgreSQL /
 * public-only PostgREST. No dependency-injected row adapter and no provider. */
import assert from 'node:assert/strict'
import {repositoryRoot,sourceTrees,source,sourceChecks,reportFile,reportDirectory,assertFrozenSources} from './integrated-pair-source-contract.mjs'
import {recordAuditColdMetrics} from './workspace-rows-audit-measure.mjs'
import { readFileSync, unlinkSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { randomUUID, randomBytes, createHmac, timingSafeEqual } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { resolve, join, dirname } from 'node:path'
import { createServer } from 'node:http'
import pg from 'pg'
import { install, checkpointMigration } from './gmail-empty-checkpoint-fixture.mjs'
import { migration } from './discovery-authority-fixture.mjs'
import { installLegacyReadFenceFixture } from './workspace-rows-legacy-read-fence-fixture.mjs'
import { largeAbandonFixture } from '../fixtures/workspaceRowsLargeCommand.ts'
import { applyUserDomainCommand, applyDomainCompensation } from '../../src/domainCommands.ts'
import { encodeWorkspaceRows, decodeWorkspaceRows, diffWorkspaceRows } from '../../gateway/workspaceRowsCodec.ts'
import { stagedCommandStageId } from '../../gateway/workspaceRowsStagedBridge.ts'
import { PJSDAS_SUPABASE_URL } from '../../gateway/supabaseProject.ts'
import { stagedOpportunityFixture } from '../fixtures/workspaceRowsStagedOpportunity.ts'
import { createOwnerScopedManagementRuntime } from '../../gateway/scopedManagementRuntime.ts'
import { scopedManagementConsentHash } from '../../gateway/scopedManagementConsent.ts'
import { restoreOpportunityManagement } from '../../src/opportunityManagement.ts'
import { prepareStagedEffects, stagedEffectPages } from '../../gateway/workspaceRowsLargeCommandPrototype.ts'
import { encodePreparedIntent, decodePreparedIntent } from '../../gateway/workspaceRowsDurableIntent.ts'
import { prepareStagedRequestDocuments } from '../../gateway/workspaceRowsStagedDocumentsPrototype.ts'

const connection=process.env.TA_ROW_DATABASE_URL;assert(connection)
const parsed=new URL(connection);assert(['127.0.0.1','localhost','[::1]'].includes(parsed.hostname),'remote database forbidden');assert.equal(parsed.port,'55634','integrated pair owns only PostgreSQL port 55634')
assert(process.env.TA_POSTGREST_BIN)
const name='ta_integrated_pair_'+randomUUID().replaceAll('-',''),authenticator='ta_integrated_pair_http_'+randomUUID().replaceAll('-','')
const admin=new pg.Client({connectionString:connection}),url=new URL(connection);url.pathname='/'+name
const db=new pg.Client({connectionString:url.href}),origin='http://127.0.0.1:55635',webOrigin='https://synthetic.invalid'
const nativeFetch=globalThis.fetch,secret=randomBytes(48).toString('hex'),enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url')
const jwt=claims=>{const value=enc({alg:'HS256',typ:'JWT'})+'.'+enc({...claims,exp:Math.floor(Date.now()/1000)+3600});return value+'.'+createHmac('sha256',secret).update(value).digest('base64url')}
const serviceToken=jwt({role:'service_role'}),wire=x=>JSON.parse(JSON.stringify(x))
let created=false,authCreated=false,readerCreated=false,postgrest,proxy,gateway,entry,runError,cleanupComplete=false,adminConnected=false,dbConnected=false
let dropNextFinish=false,dropNextDocument=false
const coldFiles=Object.fromEntries(['a','b','legacy'].map(v=>[v,join(repositoryRoot,'tests/sql/integrated-pair-tmp-'+v+'-'+randomUUID()+'.mjs')]))
let proxyInFlight=0
const assertProxyQuiescent=()=>assert.equal(proxyInFlight,0,'no unsettled proxy request may cross independent cases or global capability fault')
const assertOnlySettledHookRequest=()=>assert.equal(proxyInFlight,1,'global page fault may run only after the sole current upstream response has fully settled; no other request may be outstanding')
const seededSnapshots=[]
let dropRule
async function assertResourceDefaultOff(){
 for(const table of ['pool','rpc_scope','owner','reservation','allocation','chunk','temporary_bytes'])assert.equal((await db.query('select count(*)::int n from ta_resource_reservations.'+table)).rows[0].n,0,'resource installation must stay default-off/empty: '+table)
}
let cancelOnNextDocument
const auditHooks=[]
const pending=[],ownedClients=[],calls=[],fullBodies=[],configBefore={...process.env},coldTimeline=[],admittedDeadlines=new Map()
const listen=async server=>{await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok)});return 'http://127.0.0.1:'+server.address().port}
const readBody=async req=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);return Buffer.concat(chunks)}
const count=async user=>Number((await db.query('select count(*) n from pjsdas_rows_candidate.ledger where user_id=$1',[user])).rows[0].n)
async function current(ids){const h=(await db.query('select * from pjsdas_rows_candidate.head where id=$1',[ids.workspaceId])).rows[0],rows=(await db.query('select collection,id,ordinal::integer,value from pjsdas_rows_candidate.item where workspace_id=$1',[ids.workspaceId])).rows;return{revision:Number(h.revision),snapshot:decodeWorkspaceRows({contract:'workspace-rows-v1',envelope:h.envelope,manifest:h.manifest,rows})}}
async function seed(state,active){
 const userId=randomUUID();await db.query('insert into auth.users values($1)',[userId]);await db.query("insert into pjsdas_access_grants(user_id,email,role) values($1,'synthetic@example.invalid','owner')",[userId])
 const workspaceId=(await db.query('insert into pjsdas_workspaces(user_id,snapshot,schema_version) values($1,$2,4) returning id',[userId,JSON.stringify(state)])).rows[0].id
 let epoch;if(active){const encoded=encodeWorkspaceRows(state);epoch=(await db.query('insert into pjsdas_rows_candidate.head(id,user_id,envelope,manifest,legacy_snapshot) values($1,$2,$3,$4,$5) returning epoch',[workspaceId,userId,encoded.envelope,JSON.stringify(encoded.manifest),JSON.stringify(state)])).rows[0].epoch;await db.query('insert into pjsdas_rows_candidate.item select $1,$2,x.collection,x.id,x.ordinal,x.value,0 from jsonb_to_recordset($3) x(collection text,id text,ordinal bigint,value jsonb)',[workspaceId,userId,JSON.stringify(encoded.rows)]);await db.query('update pjsdas_workspaces set row_candidate_epoch=$2 where id=$1',[workspaceId,epoch])}
 seededSnapshots.push({userId,active,snapshot:wire(state)});return {userId,workspaceId,epoch}
}
async function reserve(ids,commandId,family='first_party_abandon'){
 const stageId=stagedCommandStageId({userId:ids.userId,workspaceId:ids.workspaceId,expectedEpoch:ids.epoch,commandId},family)
 // A pre-authorized synthetic reservation, NOT a product limit or a runtime
 // ability to mint resources. Missing reservation must fail closed.
 await db.query("insert into pjsdas_rows_candidate.large_document_reservation values($1,$2,$3,8388608,clock_timestamp()+interval '30 minutes')",[stageId,ids.userId,ids.workspaceId]);return stageId
}
function reportTransport(label,offset,elapsedMs,response){
 const all=calls.slice(offset),stage=all.filter(x=>x.path.includes('/pjsdas_rows_v1_large_'))
 const sum=values=>({requests:values.length,requestBytes:values.reduce((n,x)=>n+x.bytes,0),responseBytes:values.reduce((n,x)=>n+x.responseBytes,0)})
 console.log('LOCAL_TRANSPORT',JSON.stringify({label,loopbackOnly:true,productionBudgetProof:false,elapsedMs:Math.round(elapsedMs),allRest:sum(all),staging:sum(stage),clientResponseBytes:Buffer.byteLength(JSON.stringify(response))}))
}
async function post(ids,body){const r=await nativeFetch(gateway.origin+'/api/workspace',{method:'POST',headers:{origin:webOrigin,authorization:'Bearer '+jwt({role:'authenticated',sub:ids.userId}),'content-type':'application/json'},body:JSON.stringify(body)});return{status:r.status,body:await r.json()}}
async function cold(input){
 const {release='b',pages=release==='b',durable=true,audit=true,profile='default',admission=true,auditMode,...payload}=input;assert(['a','b','legacy'].includes(release));
 const childEnv={...process.env,TA_ROW_AUDIT_MEASURE:'1',TA_INTENT_PROXY:proxy.origin,PJSDAS_WORKSPACE_ROWS_AUDIT_PAGES:pages?'1':'0',PJSDAS_WORKSPACE_ROWS_DURABLE_INTENT:durable?'1':'0',PJSDAS_WORKSPACE_ROWS_AUDIT_BYTES:audit?'1':'0'}
 for(const key of ['PJSDAS_WORKSPACE_ROWS_RELEASE_PROFILE','PJSDAS_WORKSPACE_ROWS_DURABLE_INTENT_ADMISSION','PJSDAS_WORKSPACE_ROWS_AUDIT_ADMISSION_MODE'])delete childEnv[key]
 if(profile!==null&&release!=='legacy')childEnv.PJSDAS_WORKSPACE_ROWS_RELEASE_PROFILE=profile==='default'?(release==='a'?'compatible-fragments-v1':'compatible-pages-v1'):profile
 if(durable)childEnv.PJSDAS_WORKSPACE_ROWS_DURABLE_INTENT_ADMISSION=admission?'1':'0'
 if(auditMode!==undefined)childEnv.PJSDAS_WORKSPACE_ROWS_AUDIT_ADMISSION_MODE=auditMode
 let diagnosticUserId=payload.userId;try{if(!diagnosticUserId)diagnosticUserId=JSON.parse(Buffer.from(payload.headers.authorization.split(' ')[1].split('.')[1],'base64url').toString()).sub}catch{}
 const diagnosticKey=diagnosticUserId+'|'+payload.body?.commandId,startedAtMs=Date.now(),harnessCpuBefore=process.cpuUsage(),deadlineAtStart=admittedDeadlines.get(diagnosticKey)
 const invocationStart=performance.now(),callOffset=calls.length
 const child=spawn(process.execPath,[coldFiles[release]],{cwd:resolve(new URL('../..',import.meta.url).pathname),env:childEnv,stdio:['pipe','pipe','pipe']})
 let out='',err='',firstStdoutAtMs,lastStdoutAtMs,exitAtMs;child.stdout.on('data',d=>{firstStdoutAtMs??=Date.now();lastStdoutAtMs=Date.now();out+=d});child.stderr.on('data',d=>err+=d);child.once('exit',()=>{exitAtMs=Date.now()});child.stdin.end(JSON.stringify(payload))
 try{await new Promise((ok,no)=>{child.on('error',no);child.on('exit',code=>code===0?ok():no(Error(err||out)))})}catch(error){console.log('COLD_INVOCATION_FAILURE',JSON.stringify({release,pages,audit,durable,profile,admission,mode:payload.mode??'api',action:payload.body?.action,tool:payload.tool,commandId:payload.body?.commandId,elapsedMs:performance.now()-invocationStart,calls:calls.slice(callOffset)}));throw error}
 let coldResources;for(const line of err.split('\n'))if(line.startsWith('AUDIT_COLD_RESOURCE ')){coldResources=JSON.parse(line.slice('AUDIT_COLD_RESOURCE '.length));recordAuditColdMetrics(coldResources)}
 const parsed=JSON.parse(out),endedAtMs=Date.now(),harnessCpu=process.cpuUsage(harnessCpuBefore),deadlineAtEnd=admittedDeadlines.get(diagnosticKey)
 const observation={release,pages,audit,durable,profile,admission,mode:payload.mode??'api',action:payload.body?.action,tool:payload.tool,userId:diagnosticUserId,commandId:payload.body?.commandId,startedAtMs,firstStdoutAtMs,lastStdoutAtMs,exitAtMs,endedAtMs,elapsedMs:performance.now()-invocationStart,callOffset,callEnd:calls.length,deadlineAtStart,deadlineAtEnd,remainingAtStartMs:deadlineAtStart===undefined?undefined:deadlineAtStart-startedAtMs,remainingAtEndMs:deadlineAtEnd===undefined?undefined:deadlineAtEnd-endedAtMs,harnessCpuUs:harnessCpu,coldResources,resultCode:parsed.structuredContent?.code??parsed.body?.code,resultOutcome:parsed.structuredContent?.outcome??parsed.body?.outcome}
 coldTimeline.push(observation);console.log('COLD_PHASE',JSON.stringify(observation));return parsed
}
async function coldPost(ids,body){return cold({body,headers:{origin:webOrigin,authorization:'Bearer '+jwt({role:'authenticated',sub:ids.userId}),'content-type':'application/json'}})}
async function rpc(name,body,token=serviceToken){const r=await nativeFetch(origin+'/rpc/'+name,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});return{status:r.status,body:await r.json()}}

try {
 assertFrozenSources('before')
 const {buildSync}=await import('esbuild'),workerSource=readFileSync(new URL('./integrated-pair-cold-worker.mjs',import.meta.url),'utf8')
 // The identical original worker template resolves actual application imports
 // from each frozen source tree, but every bundle is owned by this new tree.
 for(const release of ['a','b','legacy'])buildSync({stdin:{contents:workerSource,resolveDir:join(sourceTrees[release],'tests/sql'),sourcefile:'page-ready-cold-worker.mjs',loader:'js'},bundle:true,platform:'node',packages:'external',format:'esm',outfile:coldFiles[release],logLevel:'silent'})
 await admin.connect();adminConnected=true;assert.equal((await admin.query("select count(*)::int n from pg_roles where rolname='pjsdas_workspace_blob_reader'")).rows[0].n,0,'do not take over another reader fixture')
 await admin.query('create database '+name);created=true;await admin.query(`create role ${authenticator} login noinherit;grant anon,authenticated,service_role to ${authenticator}`);authCreated=true
 await db.connect();dbConnected=true;await db.query("set work_mem='2184kB'");await admin.query(`alter database ${name} set work_mem='2184kB';alter database ${name} set statement_timeout='10s'`)
 await install(db);await db.query(await migration(checkpointMigration))
 for(const file of ['workspace-rows-stage-a.sql','workspace-rows-authoritative-stage-a.sql','workspace-rows-planning-stage-a.sql','workspace-rows-profile-stage-a.sql','workspace-rows-reminder-stage-a.sql','workspace-rows-opportunity-stage-a.sql','workspace-rows-business-stage-a.sql','workspace-rows-management-v2-stage-a.sql','workspace-rows-ai-capture-stage-a.sql','workspace-rows-discovery-stage-a.sql','workspace-rows-history-stage-a.sql','workspace-rows-bootstrap-stage-a.sql','workspace-rows-public-transport-stage-a.sql','workspace-rows-layout-fence-stage-a.sql','workspace-rows-large-command-prototype.sql','workspace-rows-staged-opportunity-prototype.sql','workspace-rows-staged-documents-prototype.sql','workspace-rows-durable-intent-prototype.sql','workspace-rows-audit-bytes-prototype.sql','workspace-rows-resource-reservations.sql','workspace-rows-resource-rpc.sql'])await db.query(readFileSync(new URL('./candidates/'+file,import.meta.url),'utf8'))
 await assertResourceDefaultOff()
 for(const privilege of ['UPDATE','DELETE','TRUNCATE'])assert.equal((await db.query("select has_table_privilege('service_role','pjsdas_rows_candidate.large_command_intent',$1) ok",[privilege])).rows[0].ok,false)
 if(process.env.TA_AUDIT_PROFILE_ONLY==='1')for(const {name} of (await db.query("select quote_ident(n.nspname)||'.'||quote_ident(c.relname) name from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','pjsdas_rows_candidate') and c.relkind='r'")).rows)await db.query('alter table '+name+' set(autovacuum_enabled=false)')
 await installLegacyReadFenceFixture(db);readerCreated=true
 assert.equal((await db.query("select has_column_privilege('service_role','pjsdas_workspaces','snapshot','SELECT') ok")).rows[0].ok,false)
 const httpUrl=new URL(url);httpUrl.username=authenticator
 postgrest=spawn(process.env.TA_POSTGREST_BIN,[],{env:{...process.env,PGRST_DB_URI:httpUrl.href,PGRST_DB_SCHEMAS:'public',PGRST_DB_ANON_ROLE:'anon',PGRST_JWT_SECRET:secret,PGRST_SERVER_HOST:'127.0.0.1',PGRST_SERVER_PORT:'55635',PGRST_DB_POOL:'2',PGRST_DB_MAX_ROWS:'1000'},stdio:['ignore','ignore','pipe']})
 let logs='';postgrest.stderr.on('data',x=>logs+=x);let ready=false
 for(let i=0;i<100;i++){if(postgrest.exitCode!==null)throw Error(logs);try{if((await nativeFetch(origin)).status<500){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,50))}assert(ready,logs)
 proxy=createServer(async(req,res)=>{proxyInFlight++;const receivedAtMs=Date.now();try{
  if(req.url==='/auth/v1/user'){
   const token=String(req.headers.authorization??'').replace(/^Bearer /,''),[a,b,c]=token.split('.');assert(a&&b&&c)
   const signature=createHmac('sha256',secret).update(a+'.'+b).digest();assert(timingSafeEqual(signature,Buffer.from(c,'base64url')))
   const claims=JSON.parse(Buffer.from(b,'base64url').toString());assert.equal(claims.role,'authenticated');assert(claims.sub&&claims.exp>Date.now()/1000)
   res.setHeader('content-type','application/json');res.end(JSON.stringify({id:claims.sub,email:'synthetic@example.invalid'}));return
  }
  assert(req.url.startsWith('/rest/v1/'),'only local Supabase REST simulation allowed');const raw=await readBody(req),path=req.url.replace('/rest/v1/','/')
  if(path.startsWith('/rpc/pjsdas_commit_workspace_v4'))fullBodies.push(JSON.parse(raw.toString()))
  if(dropRule?.before && path.endsWith(dropRule.path)){dropRule=undefined;res.destroy();return}
  const startedAtMs=Date.now(),start=performance.now(),result=await nativeFetch(origin+path,{method:req.method,headers:req.headers,...(raw.length?{body:raw}:{})});let body=await result.arrayBuffer()
  if(auditHooks[0]?.match(path,raw.length?JSON.parse(raw.toString()):null)){const hook=auditHooks.shift();const replacement=await hook.run({path,raw,body,result});if(replacement==='disconnect'){res.destroy();return}if(replacement)body=replacement}
  if((path.includes('read_audit')||path.includes('read_history'))&&!result.ok)console.log('AUDIT_RPC_FAILURE',JSON.stringify({path,status:result.status,elapsedMs:performance.now()-start,body:Buffer.from(body).toString(),hostLoad:readFileSync('/proc/loadavg','utf8').trim()}))
  if(path.includes('commit_')&&!result.ok)console.log('COMMIT_RPC_FAILURE',path,Buffer.from(body).toString())
  if(path.includes('large_intent_')&&!result.ok)console.log('INTENT_RPC_FAILURE',path,Buffer.from(body).toString())
  const ms=performance.now()-start
  let provisionalDiskBytes=0
  if(process.env.TA_ROW_AUDIT_MEASURE==='1')for(const directory of readdirSync(tmpdir()).filter(x=>x.startsWith('ta-audit-read-'))){try{provisionalDiskBytes+=statSync(join(tmpdir(),directory,'provisional')).size}catch{}}
  let errorCode,rpcInput,rpcOutput;try{rpcInput=raw.length?JSON.parse(raw.toString()):undefined;rpcOutput=JSON.parse(Buffer.from(body).toString());if(!result.ok)errorCode=rpcOutput.code}catch{}
  const requestDeadlineAt=rpcInput?.deadline_at,responseDeadlineAt=rpcOutput?.deadlineAt,commandId=rpcInput?.identity?.commandId??rpcInput?.binding?.commandId,owner=rpcInput?.target_user_id??rpcInput?.identity?.userId
  if(path.endsWith('large_intent_admit')&&result.ok&&owner&&commandId)admittedDeadlines.set(owner+'|'+commandId,responseDeadlineAt??requestDeadlineAt)
  calls.push({receivedAtMs,startedAtMs,endedAtMs:Date.now(),requestDeadlineAt,responseDeadlineAt,stageId:rpcInput?.stage_id??rpcInput?.binding?.stageId??rpcInput?.part?.stageId,commandId,owner,errorCode,errorMessage:result.ok?undefined:rpcOutput?.message,errorDetails:result.ok?undefined:rpcOutput?.details,fullPath:path,path:new URL(origin+path).pathname,status:result.status,bytes:raw.length,responseBytes:body.byteLength,ms,provisionalDiskBytes})
  if(dropRule && path.endsWith(dropRule.path) && (!dropRule.document || JSON.parse(raw).part?.document===dropRule.document)){dropRule=undefined;res.destroy();return}
  if(dropNextFinish&&path.startsWith('/rpc/pjsdas_rows_v1_large_documents_finish')){dropNextFinish=false;res.destroy();return}
  if(dropNextDocument&&path.startsWith('/rpc/pjsdas_rows_v1_large_documents_append')){dropNextDocument=false;res.destroy();return}
  if(cancelOnNextDocument&&path.startsWith('/rpc/pjsdas_rows_v1_large_documents_append')){cancelOnNextDocument.abort(new Error('SYNTHETIC_ORIGINAL_CALLER_CANCELLED'));cancelOnNextDocument=undefined}
  res.writeHead(result.status,Object.fromEntries(result.headers));res.end(Buffer.from(body))
 }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({syntheticProxyError:String(error)}))}finally{proxyInFlight--}})
 proxy.origin=await listen(proxy)
 // True api/workspace entry keeps its normal source configuration. This strict
 // test-only network trampoline reroutes that ONE origin to loopback BEFORE
 // importing the entry, and refuses every other outbound origin. No production
 // request is sent and no adapter is injected into the application.
 globalThis.fetch=async(input,init)=>{const u=new URL(String(input));assert.equal(u.origin,PJSDAS_SUPABASE_URL,'unexpected nonlocal egress');return nativeFetch(proxy.origin+u.pathname+u.search,init)}
 Object.assign(process.env,{PJSDAS_SUPABASE_SERVICE_ROLE_KEY:serviceToken,PJSDAS_ALLOWED_WEB_ORIGINS:webOrigin,PJSDAS_AUDIENCE_MODE:'allowlist',PJSDAS_AI_CAPTURE:'disabled',PJSDAS_WORKSPACE_ROWS_READS:'1',PJSDAS_WORKSPACE_ROWS_WRITES:'1',PJSDAS_WORKSPACE_ROWS_READ_CONCURRENCY:'1',PJSDAS_WORKSPACE_ROWS_STAGED_DOCUMENTS:'1',PJSDAS_WORKSPACE_ROWS_DURABLE_INTENT:'1',PJSDAS_WORKSPACE_ROWS_AUDIT_BYTES:'1',PJSDAS_WORKSPACE_ROWS_AUDIT_PAGES:'0',PJSDAS_WORKSPACE_COMMIT_METADATA_ONLY:'1',PJSDAS_WORKSPACE_COMMIT_RAW_JSON:'1',PJSDAS_GMAIL_EMPTY_CHECKPOINTS:'0',PJSDAS_GMAIL_EMPTY_CHECKPOINT_READS:'0'})
 entry=(await import('../../api/workspace.ts')).default
 gateway=createServer(async(req,res)=>{try{const raw=await readBody(req),response=await entry.fetch(new Request(gateway.origin+req.url,{method:req.method,headers:req.headers,...(raw.length?{body:raw}:{})}));res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()))}catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({syntheticGatewayError:String(error)}))}});gateway.origin=await listen(gateway)
 console.log('CONFIG',JSON.stringify({database:name,postgresPort:55634,httpPort:55635,resourceInstallation:'same-original-public-routes-default-off',resourceActivationMatrix:false,source,postgrestSchemas:'public',postgrestPool:2,workMemKiB:2184,statementTimeoutMs:10000,stagedCommitTotalBudgetMs:10000,realApiEntry:true,adapterInjection:false,externalNetwork:false}))
 async function scopedFixture(actions,compactIds=false,sourceFixture){
  const vf=sourceFixture??await stagedOpportunityFixture(actions,{compactIds}),vIds=await seed(vf.before,true),clientId=randomUUID(),grantId=randomUUID()
  await db.query("insert into pjsdas_business_management_grants(id,user_id,client_id,capability,consent_version,consent_text_hash) values($1,$2,$3,'workspace.opportunity.manage',3,$4)",[grantId,vIds.userId,clientId,await scopedManagementConsentHash('opportunity')])
  const scoped=createOwnerScopedManagementRuntime({supabaseUrl:PJSDAS_SUPABASE_URL,serviceRoleKey:serviceToken,enabled:'enabled',transactional:true,identity:{userId:vIds.userId,oauthClientId:clientId},audience:{allowed:true,mode:'allowlist',role:'owner'}})
  assert(scoped?.opportunity);return {vf,vIds,clientId,grantId,scoped,vStage:await reserve(vIds,vf.commandId,'opportunity_v3')}
 }

 const {runRollbackPair}=await import('./integrated-pair-scenarios.mjs')
 await runRollbackPair({assertProxyQuiescent,assertOnlySettledHookRequest,assertResourceDefaultOff,assertFrozenSources,db,seed,reserve,current,count,cold,rpc,jwt,serviceToken,calls,auditHooks,fullBodies,scopedFixture,setDrop:rule=>{assert.equal(dropRule,undefined);dropRule=rule},getDrop:()=>dropRule,webOrigin,seededSnapshots})
} catch(error){runError=error;throw error} finally {
 try{
 const cleanupErrors=[]
 const cleanupStep=async(label,operation)=>{try{await operation()}catch(error){cleanupErrors.push({label,error});console.error('CLEANUP_STEP_FAILURE',label,String(error))}}
 // Evidence IO must never skip actual owned-resource cleanup. Attempt every
 // cleanup even if earlier unlink, diagnostic write, close or drop fails.
 for(const file of Object.values(coldFiles))await cleanupStep('unlink-cold-worker',()=>{if(existsSync(file))unlinkSync(file)})
 await cleanupStep('cold-timeline',()=>writeFileSync(join(reportDirectory,'cold-timeline.json'),JSON.stringify(coldTimeline,null,2)+'\n'))
 await cleanupStep('http-timeline',()=>writeFileSync(join(reportDirectory,'http-timeline.json'),JSON.stringify(calls,null,2)+'\n'))
 await cleanupStep('http-summary',()=>console.log('HTTP_COUNTS',JSON.stringify(Object.fromEntries(Object.entries(Object.groupBy(calls,x=>x.path)).map(([path,rows])=>[path,{requests:rows.length,requestBytes:rows.reduce((n,x)=>n+x.bytes,0),responseBytes:rows.reduce((n,x)=>n+x.responseBytes,0)}])))))
 globalThis.fetch=nativeFetch
 for(const key of Object.keys(process.env))if(!(key in configBefore))delete process.env[key]
 Object.assign(process.env,configBefore)
 await cleanupStep('pending-requests',()=>Promise.allSettled(pending))
 for(const client of ownedClients)await cleanupStep('owned-client',()=>client.end())
 for(const server of[gateway,proxy])await cleanupStep('http-server',async()=>{if(server?.listening)await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))})
 await cleanupStep('postgrest',async()=>{if(postgrest&&postgrest.exitCode===null){const done=new Promise(resolve=>postgrest.once('exit',resolve));postgrest.kill('SIGTERM');await done}})
 if(dbConnected)await cleanupStep('terminal-command-state',async()=>{
  const intents=(await db.query("select user_id,command_id,stage_id,deadline_at,encoded->>'sha256' prepared_sha256,binding->>'manifestSha256' manifest_sha256 from pjsdas_rows_candidate.large_command_intent order by user_id,command_id")).rows
  const ledgers=(await db.query("select user_id,command_id,resulting_revision,receipt->>'operation' operation from pjsdas_rows_candidate.ledger order by user_id,resulting_revision")).rows
  writeFileSync(join(reportDirectory,'terminal-command-state.json'),JSON.stringify({intents,ledgers},null,2)+'\n')
 })
 await cleanupStep('fixture-client',async()=>{if(dbConnected)await db.end()})
 await cleanupStep('fixture-database',async()=>{if(created)await admin.query('drop database '+name+' with(force)')})
 await cleanupStep('reader-role',async()=>{if(readerCreated)await admin.query('drop role pjsdas_workspace_blob_reader')})
 await cleanupStep('authenticator-role',async()=>{if(authCreated)await admin.query('drop role '+authenticator)})
 await cleanupStep('admin-client',async()=>{if(adminConnected)await admin.end()})
 await cleanupStep('proxy-quiescent',()=>assertProxyQuiescent())
 cleanupComplete=cleanupErrors.length===0
 if(!cleanupComplete)throw new AggregateError(cleanupErrors.map(x=>x.error),'Owned cleanup/evidence failures: '+cleanupErrors.map(x=>x.label).join(','))
 console.log('CLEANUP owned database/reader/authenticator/proxy/gateway/PostgREST removed')
 }catch(error){runError??=error;throw error}finally{
  try{assertFrozenSources('after-cleanup')}catch(error){runError??=error;throw error}finally{
   writeFileSync(join(reportDirectory,'source-checks.json'),JSON.stringify({source,sourceChecks},null,2)+'\n')
   writeFileSync(join(reportDirectory,'runner-state.json'),JSON.stringify({status:runError?'FAIL':'PASS',cleanupComplete,proxyInFlight,source,error:runError?String(runError):undefined},null,2)+'\n')
   if(existsSync(reportFile)){
    const report=JSON.parse(readFileSync(reportFile,'utf8'));report.sourceChecks=sourceChecks;report.cleanupComplete=cleanupComplete
    if(runError){report.status='FAIL_LOCAL_INTEGRATED_PAIR';report.pageReadyPair='FAILED_INCOMPLETE';report.pagePendingRollback='FAILED_INCOMPLETE';report.runnerFailure=String(runError)}
    writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n')
   }
  }
 }
}
