/** Independent integration harness. Original baseline assertions retained.
 * Additive R0p cold worker and resource-ON three-mode recovery proof only.
 * The frozen original resource RPC suite remains a separate mandatory gate. */
/** Synthetic loopback real api/workspace.ts + runtime factory + PostgreSQL /
 * public-only PostgREST. No dependency-injected row adapter and no provider. */
import assert from 'node:assert/strict'
import {resolveHistoricalSource,assertHistoricalSource} from './workspace-rows-historical-sources.mjs'
import {recordAuditColdMetrics} from './workspace-rows-audit-measure.mjs'
import { readFileSync, unlinkSync, readdirSync, statSync } from 'node:fs'
import { randomUUID, randomBytes, createHmac, timingSafeEqual } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { resolve, join } from 'node:path'
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
const parsed=new URL(connection);assert(['127.0.0.1','localhost','[::1]'].includes(parsed.hostname),'remote database forbidden')
assert(process.env.TA_POSTGREST_BIN)
const name='ta_staged_docs_'+randomUUID().replaceAll('-',''),authenticator='ta_docs_http_'+randomUUID().replaceAll('-','')
const admin=new pg.Client({connectionString:connection}),url=new URL(connection);url.pathname='/'+name
const db=new pg.Client({connectionString:url.href}),origin='http://127.0.0.1:55445',webOrigin='https://synthetic.invalid'
const nativeFetch=globalThis.fetch,secret=randomBytes(48).toString('hex'),enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url')
const jwt=claims=>{const value=enc({alg:'HS256',typ:'JWT'})+'.'+enc({...claims,exp:Math.floor(Date.now()/1000)+3600});return value+'.'+createHmac('sha256',secret).update(value).digest('base64url')}
const serviceToken=jwt({role:'service_role'}),wire=x=>JSON.parse(JSON.stringify(x))
let created=false,authCreated=false,readerCreated=false,postgrest,proxy,gateway,entry
let dropNextFinish=false,dropNextDocument=false
const coldFile=resolve('tests/sql/.intent-cold-'+randomUUID()+'.mjs')
const r0pSource=resolveHistoricalSource('r0p'),r0pRoot=r0pSource.root,r0pSha=r0pSource.sourceCommit
const r0pColdFile=resolve('tests/sql/.integration-r0p-cold-'+randomUUID()+'.mjs')
let r0pBuilt=false
let coldBuilt=false
let dropRule
let cancelOnNextDocument
const auditHooks=[]
const pending=[],ownedClients=[],calls=[],fullBodies=[],configBefore={...process.env}
const listen=async server=>{await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok)});return 'http://127.0.0.1:'+server.address().port}
const readBody=async req=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);return Buffer.concat(chunks)}
const count=async user=>Number((await db.query('select count(*) n from pjsdas_rows_candidate.ledger where user_id=$1',[user])).rows[0].n)
async function current(ids){const h=(await db.query('select * from pjsdas_rows_candidate.head where id=$1',[ids.workspaceId])).rows[0],rows=(await db.query('select collection,id,ordinal::integer,value from pjsdas_rows_candidate.item where workspace_id=$1',[ids.workspaceId])).rows;return{revision:Number(h.revision),snapshot:decodeWorkspaceRows({contract:'workspace-rows-v1',envelope:h.envelope,manifest:h.manifest,rows})}}
async function seed(state,active){
 const userId=randomUUID();await db.query('insert into auth.users values($1)',[userId]);await db.query("insert into pjsdas_access_grants(user_id,email,role) values($1,'synthetic@example.invalid','owner')",[userId])
 const workspaceId=(await db.query('insert into pjsdas_workspaces(user_id,snapshot,schema_version) values($1,$2,4) returning id',[userId,JSON.stringify(state)])).rows[0].id
 let epoch;if(active){const encoded=encodeWorkspaceRows(state);epoch=(await db.query('insert into pjsdas_rows_candidate.head(id,user_id,envelope,manifest,legacy_snapshot) values($1,$2,$3,$4,$5) returning epoch',[workspaceId,userId,encoded.envelope,JSON.stringify(encoded.manifest),JSON.stringify(state)])).rows[0].epoch;await db.query('insert into pjsdas_rows_candidate.item select $1,$2,x.collection,x.id,x.ordinal,x.value,0 from jsonb_to_recordset($3) x(collection text,id text,ordinal bigint,value jsonb)',[workspaceId,userId,JSON.stringify(encoded.rows)]);await db.query('update pjsdas_workspaces set row_candidate_epoch=$2 where id=$1',[workspaceId,epoch])}
 return {userId,workspaceId,epoch}
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
 const {integrationRelease='integrated',integrationEnv,...payload}=input
 assert(['integrated','r0p'].includes(integrationRelease))
 const childEnv={...process.env,TA_INTENT_PROXY:proxy.origin}
 if(integrationEnv){
  for(const key of ['PJSDAS_WORKSPACE_ROWS_RELEASE_PROFILE','PJSDAS_WORKSPACE_ROWS_DURABLE_INTENT_ADMISSION','PJSDAS_WORKSPACE_ROWS_AUDIT_ADMISSION_MODE'])delete childEnv[key]
  Object.assign(childEnv,integrationEnv)
 }
 const child=spawn(process.execPath,[integrationRelease==='r0p'?r0pColdFile:coldFile],{cwd:resolve(new URL('../..',import.meta.url).pathname),env:childEnv,stdio:['pipe','pipe','pipe']})
 let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);child.stdin.end(JSON.stringify(payload))
 await new Promise((ok,no)=>{child.on('error',no);child.on('exit',code=>code===0?ok():no(Error(err||out)))})
 for(const line of err.split('\n'))if(line.startsWith('AUDIT_COLD_RESOURCE '))recordAuditColdMetrics(JSON.parse(line.slice('AUDIT_COLD_RESOURCE '.length)))
 return JSON.parse(out)
}
async function coldPost(ids,body){return cold({body,headers:{origin:webOrigin,authorization:'Bearer '+jwt({role:'authenticated',sub:ids.userId}),'content-type':'application/json'}})}
async function rpc(name,body,token=serviceToken){const r=await nativeFetch(origin+'/rpc/'+name,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});return{status:r.status,body:await r.json()}}

try {
 assert.equal(assertHistoricalSource('r0p',r0pRoot,{gitCheckout:r0pSource.gitCheckout}).sourceCommit,r0pSha)
 execFileSync(resolve('node_modules/esbuild/bin/esbuild'),[resolve(r0pRoot,'tests/sql/workspace-rows-intent-cold-worker.mjs'),'--bundle','--platform=node','--packages=external','--format=esm','--outfile='+r0pColdFile],{stdio:'pipe'});r0pBuilt=true
 execFileSync(resolve('node_modules/esbuild/bin/esbuild'),['tests/sql/workspace-rows-intent-cold-worker.mjs','--bundle','--platform=node','--packages=external','--format=esm','--outfile='+coldFile],{stdio:'pipe'});coldBuilt=true
 await admin.connect();assert.equal((await admin.query("select count(*)::int n from pg_roles where rolname='pjsdas_workspace_blob_reader'")).rows[0].n,0,'do not take over another reader fixture')
 await admin.query('create database '+name);created=true;await admin.query(`create role ${authenticator} login noinherit;grant anon,authenticated,service_role to ${authenticator}`);authCreated=true
 await db.connect();await db.query("set work_mem='2184kB'");await admin.query(`alter database ${name} set work_mem='2184kB';alter database ${name} set statement_timeout='10s'`)
 await install(db);await db.query(await migration(checkpointMigration))
 for(const file of ['workspace-rows-stage-a.sql','workspace-rows-authoritative-stage-a.sql','workspace-rows-planning-stage-a.sql','workspace-rows-profile-stage-a.sql','workspace-rows-reminder-stage-a.sql','workspace-rows-opportunity-stage-a.sql','workspace-rows-business-stage-a.sql','workspace-rows-management-v2-stage-a.sql','workspace-rows-ai-capture-stage-a.sql','workspace-rows-discovery-stage-a.sql','workspace-rows-history-stage-a.sql','workspace-rows-bootstrap-stage-a.sql','workspace-rows-public-transport-stage-a.sql','workspace-rows-layout-fence-stage-a.sql','workspace-rows-large-command-prototype.sql','workspace-rows-staged-opportunity-prototype.sql','workspace-rows-staged-documents-prototype.sql','workspace-rows-durable-intent-prototype.sql','workspace-rows-audit-bytes-prototype.sql','workspace-rows-resource-reservations.sql','workspace-rows-resource-rpc.sql'])await db.query(readFileSync(new URL('./candidates/'+file,import.meta.url),'utf8'))
 for(const privilege of ['UPDATE','DELETE','TRUNCATE'])assert.equal((await db.query("select has_table_privilege('service_role','pjsdas_rows_candidate.large_command_intent',$1) ok",[privilege])).rows[0].ok,false)
 if(process.env.TA_AUDIT_PROFILE_ONLY==='1')for(const {name} of (await db.query("select quote_ident(n.nspname)||'.'||quote_ident(c.relname) name from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','pjsdas_rows_candidate') and c.relkind='r'")).rows)await db.query('alter table '+name+' set(autovacuum_enabled=false)')
 await installLegacyReadFenceFixture(db);readerCreated=true
 assert.equal((await db.query("select has_column_privilege('service_role','pjsdas_workspaces','snapshot','SELECT') ok")).rows[0].ok,false)
 const httpUrl=new URL(url);httpUrl.username=authenticator
 postgrest=spawn(process.env.TA_POSTGREST_BIN,[],{env:{...process.env,PGRST_DB_URI:httpUrl.href,PGRST_DB_SCHEMAS:'public',PGRST_DB_ANON_ROLE:'anon',PGRST_JWT_SECRET:secret,PGRST_SERVER_HOST:'127.0.0.1',PGRST_SERVER_PORT:'55445',PGRST_DB_POOL:'2',PGRST_DB_MAX_ROWS:'1000'},stdio:['ignore','ignore','pipe']})
 let logs='';postgrest.stderr.on('data',x=>logs+=x);let ready=false
 for(let i=0;i<100;i++){if(postgrest.exitCode!==null)throw Error(logs);try{if((await nativeFetch(origin)).status<500){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,50))}assert(ready,logs)
 proxy=createServer(async(req,res)=>{try{
  if(req.url==='/auth/v1/user'){
   const token=String(req.headers.authorization??'').replace(/^Bearer /,''),[a,b,c]=token.split('.');assert(a&&b&&c)
   const signature=createHmac('sha256',secret).update(a+'.'+b).digest();assert(timingSafeEqual(signature,Buffer.from(c,'base64url')))
   const claims=JSON.parse(Buffer.from(b,'base64url').toString());assert.equal(claims.role,'authenticated');assert(claims.sub&&claims.exp>Date.now()/1000)
   res.setHeader('content-type','application/json');res.end(JSON.stringify({id:claims.sub,email:'synthetic@example.invalid'}));return
  }
  assert(req.url.startsWith('/rest/v1/'),'only local Supabase REST simulation allowed');const raw=await readBody(req),path=req.url.replace('/rest/v1/','/')
  if(path.startsWith('/rpc/pjsdas_commit_workspace_v4'))fullBodies.push(JSON.parse(raw.toString()))
  if(dropRule?.before && path.endsWith(dropRule.path)){dropRule=undefined;res.destroy();return}
  const start=performance.now(),result=await nativeFetch(origin+path,{method:req.method,headers:req.headers,...(raw.length?{body:raw}:{})});let body=await result.arrayBuffer()
  if(auditHooks[0]?.match(path,raw.length?JSON.parse(raw.toString()):null)){const hook=auditHooks.shift();const replacement=await hook.run({path,raw,body,result});if(replacement==='disconnect'){res.destroy();return}if(replacement)body=replacement}
  if((path.includes('read_audit')||path.includes('read_history'))&&!result.ok)console.log('AUDIT_RPC_FAILURE',JSON.stringify({path,status:result.status,elapsedMs:performance.now()-start,body:Buffer.from(body).toString(),hostLoad:readFileSync('/proc/loadavg','utf8').trim()}))
  if(path.includes('commit_')&&!result.ok)console.log('COMMIT_RPC_FAILURE',path,Buffer.from(body).toString())
  if(path.includes('large_intent_')&&!result.ok)console.log('INTENT_RPC_FAILURE',path,Buffer.from(body).toString())
  const ms=performance.now()-start
  let provisionalDiskBytes=0
  if(process.env.TA_ROW_AUDIT_MEASURE==='1')for(const directory of readdirSync(tmpdir()).filter(x=>x.startsWith('ta-audit-read-'))){try{provisionalDiskBytes+=statSync(join(tmpdir(),directory,'provisional')).size}catch{}}
  calls.push({path:new URL(origin+path).pathname,status:result.status,bytes:raw.length,responseBytes:body.byteLength,ms,provisionalDiskBytes})
  if(dropRule && path.endsWith(dropRule.path) && (!dropRule.document || JSON.parse(raw).part?.document===dropRule.document)){dropRule=undefined;res.destroy();return}
  if(dropNextFinish&&path.startsWith('/rpc/pjsdas_rows_v1_large_documents_finish')){dropNextFinish=false;res.destroy();return}
  if(dropNextDocument&&path.startsWith('/rpc/pjsdas_rows_v1_large_documents_append')){dropNextDocument=false;res.destroy();return}
  if(cancelOnNextDocument&&path.startsWith('/rpc/pjsdas_rows_v1_large_documents_append')){cancelOnNextDocument.abort(new Error('SYNTHETIC_ORIGINAL_CALLER_CANCELLED'));cancelOnNextDocument=undefined}
  res.writeHead(result.status,Object.fromEntries(result.headers));res.end(Buffer.from(body))
 }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({syntheticProxyError:String(error)}))}})
 proxy.origin=await listen(proxy)
 // True api/workspace entry keeps its normal source configuration. This strict
 // test-only network trampoline reroutes that ONE origin to loopback BEFORE
 // importing the entry, and refuses every other outbound origin. No production
 // request is sent and no adapter is injected into the application.
 globalThis.fetch=async(input,init)=>{const u=new URL(String(input));assert.equal(u.origin,PJSDAS_SUPABASE_URL,'unexpected nonlocal egress');return nativeFetch(proxy.origin+u.pathname+u.search,init)}
 Object.assign(process.env,{PJSDAS_SUPABASE_SERVICE_ROLE_KEY:serviceToken,PJSDAS_ALLOWED_WEB_ORIGINS:webOrigin,PJSDAS_AUDIENCE_MODE:'allowlist',PJSDAS_AI_CAPTURE:'disabled',PJSDAS_WORKSPACE_ROWS_READS:'1',PJSDAS_WORKSPACE_ROWS_WRITES:'1',PJSDAS_WORKSPACE_ROWS_READ_CONCURRENCY:'1',PJSDAS_WORKSPACE_ROWS_STAGED_DOCUMENTS:'0',PJSDAS_WORKSPACE_ROWS_DURABLE_INTENT:'0',PJSDAS_WORKSPACE_ROWS_AUDIT_BYTES:'0',PJSDAS_WORKSPACE_ROWS_AUDIT_PAGES:'0',PJSDAS_WORKSPACE_COMMIT_METADATA_ONLY:'1',PJSDAS_WORKSPACE_COMMIT_RAW_JSON:'1',PJSDAS_GMAIL_EMPTY_CHECKPOINTS:'0',PJSDAS_GMAIL_EMPTY_CHECKPOINT_READS:'0'})
 entry=(await import('../../api/workspace.ts')).default
 gateway=createServer(async(req,res)=>{try{const raw=await readBody(req),response=await entry.fetch(new Request(gateway.origin+req.url,{method:req.method,headers:req.headers,...(raw.length?{body:raw}:{})}));res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()))}catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({syntheticGatewayError:String(error)}))}});gateway.origin=await listen(gateway)
 console.log('CONFIG',JSON.stringify({database:name,postgrestSchemas:'public',postgrestPool:2,workMemKiB:2184,statementTimeoutMs:10000,stagedCommitTotalBudgetMs:10000,realApiEntry:true,adapterInjection:false,externalNetwork:false}))
 const f=largeAbandonFixture();f.before.futureHeader={utf8:'未来😀',unknown:{preserve:['x',null,1]}};f.before.data.futureData={preserve:true};const commandId='synthetic-real-entry-large-v5',incoming={action:'command',projection:'delta-v1',commandId,baseRevision:0,command:{type:'domain',value:{...f.command,commandId}}}
 const legacy=await seed(f.before,false),old=await post(legacy,incoming);assert.equal(old.status,200,JSON.stringify(old.body));assert.equal(old.body.outcome,'COMMITTED')
 const full=fullBodies.at(-1);assert(full);assert.equal(full.target_receipt_context.contractVersion,5)
 const oldLedger=(await db.query('select receipt,compensation from pjsdas_command_ledger where user_id=$1',[legacy.userId])).rows[0]
 for(const[key,value]of Object.entries(full.target_receipt_context))assert.deepEqual(oldLedger.receipt[key],value)
 assert.deepEqual(oldLedger.compensation,full.target_compensation)
 console.log('PASS actual api entry inactive bridge + ACL-narrowed original full-v4 commits complete V5; no raw blob read')
 const ids=await seed(f.before,true),failure=await post(ids,incoming);assert.equal(failure.status,400,JSON.stringify(failure.body));assert.equal(failure.body.code,'WORKSPACE_INVALID');assert.equal(await count(ids.userId),0);assert.deepEqual((await current(ids)).snapshot,wire(f.before))
 process.env.PJSDAS_WORKSPACE_ROWS_STAGED_DOCUMENTS='1'
 const missing=await post(ids,incoming);assert.equal(missing.status,403,JSON.stringify(missing.body));assert.equal(await count(ids.userId),0)
 const stage=await reserve(ids,commandId),saveOffset=calls.length,saveStart=performance.now(),saved=await post(ids,incoming);
 reportTransport('first-party-abandon',saveOffset,performance.now()-saveStart,saved.body);assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.outcome,'COMMITTED');assert.equal(await count(ids.userId),1)
 const actual=await current(ids),stageRow=(await db.query('select * from pjsdas_rows_candidate.large_stage where id=$1',[stage])).rows[0]
 assert.equal(actual.revision,1);assert.deepEqual(actual.snapshot,wire(applyUserDomainCommand(f.before,incoming.command.value,new Date(actual.snapshot.exportedAt)).snapshot))
 assert.equal(diffWorkspaceRows(f.before,actual.snapshot).changes.length,2102)
 assert.equal(stageRow.request.receiptContext.contractVersion,5);assert(Buffer.byteLength(JSON.stringify(stageRow.request))>1048576)
 const ledger=(await db.query('select * from pjsdas_rows_candidate.ledger where user_id=$1',[ids.userId])).rows[0]
 for(const[key,value]of Object.entries(stageRow.request.receiptContext))assert.deepEqual(ledger.receipt[key],value)
 assert.deepEqual(ledger.compensation,stageRow.request.compensation)
 assert.deepEqual(ledger.compensation,wire(applyUserDomainCommand(f.before,incoming.command.value,new Date(actual.snapshot.exportedAt)).compensation))
 for(const[key,value]of Object.entries(stageRow.request.receiptContext))assert.deepEqual(key==='projectionDelta'?saved.body.delta:saved.body.receipt[key],value)
 assert(calls.some(x=>x.path==='/rpc/pjsdas_rows_v1_large_documents_finish'&&x.status===200))
 console.log('PASS actual api entry -> real runtime selection -> complete V5 documents/effects -> original atomic finalizer; 2102 effects, exact receipt/compensation, one revision/ledger')
 const replay=await post(ids,incoming);assert.equal(replay.status,200,JSON.stringify(replay.body));assert.equal(replay.body.outcome,'ALREADY_APPLIED');assert.deepEqual(replay.body.receipt,saved.body.receipt);assert.deepEqual(replay.body.delta,saved.body.delta);assert.equal(await count(ids.userId),1)
 const undoCommandId='synthetic-real-entry-undo-v5';await reserve(ids,undoCommandId)
 const undoOffset=calls.length,undoStart=performance.now();const undone=await post(ids,{action:'undo',projection:'delta-v1',commandId:undoCommandId,targetCommandId:commandId});assert.equal(undone.status,200,JSON.stringify(undone.body));assert.equal(undone.body.outcome,'COMMITTED')
 reportTransport('first-party-undo',undoOffset,performance.now()-undoStart,undone.body);
 const restored=await current(ids);assert.equal(restored.revision,2);assert.deepEqual(restored.snapshot,wire(applyDomainCompensation(actual.snapshot,ledger.compensation,new Date(restored.snapshot.exportedAt))));assert.equal(await count(ids.userId),2)
 const afterUndoReplay=await post(ids,incoming);assert.equal(afterUndoReplay.status,200);assert.deepEqual(afterUndoReplay.body.receipt,saved.body.receipt);assert.equal(await count(ids.userId),2)
 console.log('PASS actual handler original immutable V5 replay, staged original Undo, retained history and replay after newer revision')
 if(process.env.TA_ROW_READER_CHECKOUT||process.env.TA_ROW_READER_FIXTURE==='1'){
  const readerSource=resolveHistoricalSource('reader',{checkout:process.env.TA_ROW_READER_CHECKOUT}),directory=readerSource.root,expected=readerSource.sourceCommit
  if(process.env.TA_ROW_READER_COMMIT)assert.equal(expected,process.env.TA_ROW_READER_COMMIT,'reader provenance must remain the frozen historical source')
  const priorEntry=(await import(pathToFileURL(join(directory,'api/workspace.ts')).href)).default
  const priorPost=async(owner,body)=>{const response=await priorEntry.fetch(new Request('https://synthetic.invalid/api/workspace',{method:'POST',headers:{origin:webOrigin,authorization:'Bearer '+jwt({role:'authenticated',sub:owner}),'content-type':'application/json'},body:JSON.stringify(body)}));return{status:response.status,body:await response.json()}}
  const priorInactive=await seed(f.before,false),priorSaved=await priorPost(priorInactive.userId,incoming)
  assert.equal(priorSaved.status,200,JSON.stringify(priorSaved));assert.equal(priorSaved.body.outcome,'COMMITTED')
  const priorRead=await priorPost(ids.userId,{action:'read'});assert.equal(priorRead.status,200,JSON.stringify(priorRead));assert.deepEqual(priorRead.body.snapshot,restored.snapshot)
  const priorReplay=await priorPost(ids.userId,incoming);assert.equal(priorReplay.status,200,JSON.stringify(priorReplay));assert.equal(priorReplay.body.outcome,'ALREADY_APPLIED');assert.deepEqual(priorReplay.body.receipt,saved.body.receipt)
  console.log('PASS separate compiled A-prime actual API entry uses inactive reader bridge, reads B-prime staged state and replays its original V5 receipt',JSON.stringify({readerCommit:expected,sourceKind:readerSource.sourceKind,manifestSha256:readerSource.manifestSha256,hostedRollbackPair:false,stagedWriterInAPrime:false}))
 }else console.log('OPEN separate compiled A-prime native entry requires explicit checkout/SHA; not counted as passed')
 const lostIds=await seed(f.before,true),lostCommand='synthetic-entry-lost-final-response';await reserve(lostIds,lostCommand);dropNextFinish=true
 const lostInput={...incoming,commandId:lostCommand,command:{type:'domain',value:{...incoming.command.value,commandId:lostCommand}}}
 const lost=await post(lostIds,lostInput);assert.equal(lost.status,503,JSON.stringify(lost.body));assert.equal(lost.body.code,'WORKSPACE_UNAVAILABLE');assert.equal(await count(lostIds.userId),1,'response loss must not be described as rollback')
 const resolved=await post(lostIds,lostInput);assert.equal(resolved.status,200,JSON.stringify(resolved.body));assert.equal(resolved.body.outcome,'ALREADY_APPLIED');assert.equal(await count(lostIds.userId),1)
 console.log('PASS real entry lost final HTTP response is UNKNOWN outcome; original command replay resolves one committed V5 receipt without a second write')
 const partialIds=await seed(f.before,true),partialCommand='synthetic-entry-partial-upload';const partialStage=await reserve(partialIds,partialCommand);dropNextDocument=true
 const partialInput={...incoming,commandId:partialCommand,command:{type:'domain',value:{...incoming.command.value,commandId:partialCommand}}}
 const partial=await post(partialIds,partialInput);assert.equal(partial.status,503,JSON.stringify(partial.body));assert.equal(await count(partialIds.userId),0);assert.deepEqual((await current(partialIds)).snapshot,wire(f.before))
 assert.equal((await db.query('select count(*)::int n from pjsdas_rows_candidate.large_document_fragment where stage_id=$1',[partialStage])).rows[0].n,1)
 const changedDraft=await post(partialIds,partialInput);assert.equal(changedDraft.status,409,JSON.stringify(changedDraft.body));assert.equal(changedDraft.body.code,'WORKSPACE_CONFLICT');assert.equal(await count(partialIds.userId),0)
 console.log('PASS partial upload has no business mutation; changed re-evaluated draft fails closed, accurately retaining the durable pinned-intent migration stop')
 const cancelledIds=await seed(f.before,true),cancelledCommand='synthetic-original-caller-cancel';await reserve(cancelledIds,cancelledCommand)
 const cancelController=new AbortController();cancelOnNextDocument=cancelController
 const cancelledResponse=await entry.fetch(new Request('https://synthetic.invalid/api/workspace',{method:'POST',signal:cancelController.signal,headers:{origin:webOrigin,authorization:'Bearer '+jwt({role:'authenticated',sub:cancelledIds.userId}),'content-type':'application/json'},body:JSON.stringify({...incoming,commandId:cancelledCommand,command:{type:'domain',value:{...incoming.command.value,commandId:cancelledCommand}}})}))
 assert.equal(cancelledResponse.status,503,JSON.stringify(await cancelledResponse.json()));assert.equal(await count(cancelledIds.userId),0);assert.deepEqual((await current(cancelledIds)).snapshot,wire(f.before))
 console.log('PASS actual entry original caller cancellation propagates into upload; no business rows, receipt or revision published')
 // Reuse the exact earlier real-core/V5 image for a new synthetic owner. The
 // business command and evidence are unchanged, only owner/generation differ.
 const atomicIds=await seed(f.before,true),atomicStage=await reserve(atomicIds,commandId)
 const exactEffects=prepareStagedEffects(diffWorkspaceRows(f.before,actual.snapshot)),atomicReq={...stageRow.request,userId:atomicIds.userId,workspaceId:atomicIds.workspaceId,expectedEpoch:atomicIds.epoch}
 const binding={stageId:atomicStage,family:'first_party_abandon',userId:atomicIds.userId,workspaceId:atomicIds.workspaceId,expectedEpoch:atomicIds.epoch,expectedRevision:0,commandId,payloadHash:atomicReq.payloadHash,operation:atomicReq.operation,principal:'first_party_web',authority:{}}
 const documents=prepareStagedRequestDocuments(atomicReq,binding,{protocol:'workspace-effect-chain-v1',count:exactEffects.parts.length,sha256:exactEffects.finalDigest})
 const begun=await rpc('pjsdas_rows_v1_large_documents_begin',{manifest_wire:documents.manifestWire,manifest_sha256:documents.manifest.sha256,target_user_id:atomicIds.userId});assert.equal(begun.status,200,JSON.stringify(begun))
 const finishAtomic={stage_id:atomicStage,target_user_id:atomicIds.userId,manifest_sha256:documents.manifest.sha256}
 assert.equal((await rpc('pjsdas_rows_v1_large_documents_finish',finishAtomic)).status,400)
 const fragments=[...documents.fragments()],largeDocument=fragments.filter(p=>p.document==='metadata')
 assert.equal((await rpc('pjsdas_rows_v1_large_documents_append',{part:largeDocument[1],target_user_id:atomicIds.userId})).status,400)
 assert.equal((await rpc('pjsdas_rows_v1_large_documents_append',{part:fragments[0],target_user_id:ids.userId})).status,403)
 for(const part of fragments)assert.equal((await rpc('pjsdas_rows_v1_large_documents_append',{part,target_user_id:atomicIds.userId})).status,200)
 assert.equal((await rpc('pjsdas_rows_v1_large_documents_append',{part:fragments[0],target_user_id:atomicIds.userId})).status,200)
 const changed=Buffer.from(fragments[0].base64,'base64');changed[0]^=1
 assert.equal((await rpc('pjsdas_rows_v1_large_documents_append',{part:{...fragments[0],base64:changed.toString('base64')},target_user_id:atomicIds.userId})).status,409)
 for(const parts of stagedEffectPages(exactEffects.parts))assert.equal((await rpc('pjsdas_rows_v1_large_append',{stage_id:atomicStage,target_user_id:atomicIds.userId,parts})).status,200)
 await db.query("update pjsdas_rows_candidate.large_document_fragment set bytes=$2 where stage_id=$1 and document_name='metadata' and byte_offset=0",[atomicStage,changed])
 assert.equal((await rpc('pjsdas_rows_v1_large_documents_finish',finishAtomic)).status,400);assert.equal(await count(atomicIds.userId),0);assert.deepEqual((await current(atomicIds)).snapshot,wire(f.before))
 await db.query("update pjsdas_rows_candidate.large_document_fragment set bytes=$2 where stage_id=$1 and document_name='metadata' and byte_offset=0",[atomicStage,Buffer.from(fragments[0].base64,'base64')])
 await db.query("update pjsdas_rows_candidate.large_effect set effect=jsonb_set(effect,'{after,value,updatedAt}',to_jsonb('2030-01-02T00:00:00Z'::text)) where stage_id=$1 and ordinal=0",[atomicStage])
 assert.equal((await rpc('pjsdas_rows_v1_large_documents_finish',finishAtomic)).status,400);assert.equal(await count(atomicIds.userId),0)
 await db.query("update pjsdas_rows_candidate.large_effect set wire=effect::text,digest=encode(sha256(convert_to(effect::text,'UTF8')),'hex') where stage_id=$1 and ordinal=0",[atomicStage])
 assert.equal((await rpc('pjsdas_rows_v1_large_documents_finish',finishAtomic)).status,400);assert.equal(await count(atomicIds.userId),0)
 await db.query("update pjsdas_rows_candidate.large_effect set wire=$2::text,effect=($2::text)::jsonb,digest=encode(sha256(convert_to($2::text,'UTF8')),'hex') where stage_id=$1 and ordinal=0",[atomicStage,exactEffects.parts[0].wire])
 const disconnected=new pg.Client({connectionString:url.href});ownedClients.push(disconnected);await disconnected.connect();await disconnected.query('begin');await disconnected.query("set local role service_role")
 await disconnected.query('select public.pjsdas_rows_v1_large_documents_finish($1,$2,$3)',[atomicStage,atomicIds.userId,documents.manifest.sha256]);await disconnected.end()
 assert.equal(await count(atomicIds.userId),0);assert.equal((await current(atomicIds)).revision,0)
 await db.query('begin');await db.query('select 1 from pjsdas_rows_candidate.head where id=$1 for update',[atomicIds.workspaceId])
 const finishOne=rpc('pjsdas_rows_v1_large_documents_finish',finishAtomic),finishTwo=rpc('pjsdas_rows_v1_large_documents_finish',finishAtomic);pending.push(finishOne,finishTwo)
 let waited=false
 try{for(let i=0;i<200;i++){await db.query('select pg_stat_clear_snapshot()');if((await db.query("select count(*)::int n from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock' and query like '%pjsdas_rows_v1_large_documents_finish%' ")).rows[0].n===2){waited=true;break}await new Promise(r=>setTimeout(r,10))}assert(waited,'both finalizers must really wait on original head');await db.query('commit')}finally{await db.query('rollback')}
 const one=await finishOne,two=await finishTwo;assert.equal(one.status,200,JSON.stringify(one));assert.deepEqual(two,one);assert.equal(await count(atomicIds.userId),1);assert.deepEqual((await current(atomicIds)).snapshot,actual.snapshot)
 console.log('PASS native document and persisted effect/wire/chain integrity refused tampering; disconnect-before-COMMIT rollback and observed two-finalizer lock wait produce one complete original V5 receipt')
 for(const [label,patch] of [['client',{clientId:'synthetic-unexpected-client'}],['authority',{receiptContext:{...atomicReq.receiptContext,managementAuthorization:{consentVersion:3}}}]]){
  const invalidCommand='synthetic-invalid-first-party-'+label,badStage=await reserve(atomicIds,invalidCommand),badReq={...atomicReq,...patch,commandId:invalidCommand},badBinding={...binding,stageId:badStage,commandId:invalidCommand}
  const badDocuments=prepareStagedRequestDocuments(badReq,badBinding,{protocol:'workspace-effect-chain-v1',count:exactEffects.parts.length,sha256:exactEffects.finalDigest})
  assert.equal((await rpc('pjsdas_rows_v1_large_documents_begin',{manifest_wire:badDocuments.manifestWire,manifest_sha256:badDocuments.manifest.sha256,target_user_id:atomicIds.userId})).status,200)
  for(const part of badDocuments.fragments())assert.equal((await rpc('pjsdas_rows_v1_large_documents_append',{part,target_user_id:atomicIds.userId})).status,200)
  assert.equal((await rpc('pjsdas_rows_v1_large_documents_finish',{stage_id:badStage,target_user_id:atomicIds.userId,manifest_sha256:badDocuments.manifest.sha256})).status,403)
  // Cached completion is not an authority shortcut either. This fault is
  // fixture-admin-only; the runtime has no interface to mutate an intent.
  await db.query('update pjsdas_rows_candidate.large_stage set request=$2 where id=$1',[atomicStage,{...atomicReq,...patch}])
  assert.equal((await rpc('pjsdas_rows_v1_large_documents_finish',finishAtomic)).status,403)
  await db.query('update pjsdas_rows_candidate.large_stage set request=$2 where id=$1',[atomicStage,atomicReq])
 }
 assert.equal(await count(atomicIds.userId),1);assert.deepEqual((await current(atomicIds)).snapshot,actual.snapshot)
 console.log('PASS original first-party authority refuses clientId and forged receipt management authority before new or cached finalization')
 // The original scoped runtime factory reads the REAL current grant over HTTP,
 // produces the original complete V5 core receipt, and selects the same staged
 // runtime. No grant resolver or row adapter is injected.
 async function scopedFixture(actions,compactIds=false,sourceFixture){
  const vf=sourceFixture??await stagedOpportunityFixture(actions,{compactIds}),vIds=await seed(vf.before,true),clientId=randomUUID(),grantId=randomUUID()
  await db.query("insert into pjsdas_business_management_grants(id,user_id,client_id,capability,consent_version,consent_text_hash) values($1,$2,$3,'workspace.opportunity.manage',3,$4)",[grantId,vIds.userId,clientId,await scopedManagementConsentHash('opportunity')])
  const scoped=createOwnerScopedManagementRuntime({supabaseUrl:PJSDAS_SUPABASE_URL,serviceRoleKey:serviceToken,enabled:'enabled',transactional:true,identity:{userId:vIds.userId,oauthClientId:clientId},audience:{allowed:true,mode:'allowlist',role:'owner'}})
  assert(scoped?.opportunity);return {vf,vIds,clientId,grantId,scoped,vStage:await reserve(vIds,vf.commandId,'opportunity_v3')}
 }
 const oversized=await scopedFixture(2050),tooLarge=await oversized.scoped.opportunity.invoke('execute_opportunity_management',{commandId:oversized.vf.commandId,baseRevision:0,change:oversized.vf.input})
 assert.equal(tooLarge.isError,true);assert.equal(tooLarge.structuredContent.code,'WORKSPACE_INVALID');assert.equal(await count(oversized.vIds.userId),0);assert.deepEqual((await current(oversized.vIds)).snapshot,wire(oversized.vf.before))
 const retainedRequest=(await db.query('select pjsdas_rows_internal.large_documents_request($1,$2) req',[oversized.vStage,oversized.vIds.userId])).rows[0].req
 const minimumAuditSqlBytes=Number((await db.query("select octet_length(jsonb_build_object('receipt',$1::jsonb,'compensation',$2::jsonb)::text) n",[JSON.stringify(retainedRequest.receiptContext),JSON.stringify(retainedRequest.compensation)])).rows[0].n)
 assert(minimumAuditSqlBytes>2097150)
 console.log('PASS preserved migration stop: actual V5 2053-effect archive has unreadable audit and rolls back atomically',JSON.stringify({minimumAuditSqlBytes,contractVersion:retainedRequest.receiptContext.contractVersion,stillUnsupported:true}))
 if(process.env.TA_ROW_AUDIT_PROOF==='1') {
  const { runAuditByteProof } = await import('./workspace-rows-audit-byte-proof.mjs')
  await runAuditByteProof({ db, connectionString:url.href, seed, scopedFixture, reserve, current, count, cold, coldPost, post, rpc, serviceToken, jwt, calls, reportTransport, oversized, retainedRequest, auditHooks, entry, webOrigin })
 } else {
 const {vf,vIds,grantId,scoped,vStage}=await scopedFixture(1800)
 const vOffset=calls.length,vStart=performance.now();const vSaved=await scoped.opportunity.invoke('execute_opportunity_management',{commandId:vf.commandId,baseRevision:0,change:vf.input});assert.equal(vSaved.isError,undefined,JSON.stringify(vSaved));assert.equal(vSaved.structuredContent.outcome,'COMMITTED')
 reportTransport('opportunity-v3-archive',vOffset,performance.now()-vStart,vSaved);
 const committedV3Request=(await db.query('select request from pjsdas_rows_candidate.large_stage where id=$1',[vStage])).rows[0].request
 assert(Buffer.byteLength(JSON.stringify({...committedV3Request,changes:diffWorkspaceRows(vf.before,(await current(vIds)).snapshot).changes}))>2097152)
 const vActual=await current(vIds),vLedger=(await db.query('select receipt,compensation from pjsdas_rows_candidate.ledger where user_id=$1',[vIds.userId])).rows[0]
 assert.equal(vLedger.receipt.contractVersion,5);assert.equal(vLedger.receipt.managementAuthorization.grantId,grantId);assert.equal(diffWorkspaceRows(vf.before,vActual.snapshot).changes.length,1803)
 const vUndo='synthetic-runtime-v3-undo';await reserve(vIds,vUndo,'opportunity_v3')
 const vuOffset=calls.length,vuStart=performance.now();const vUndone=await scoped.opportunity.invoke('restore_opportunity_management',{commandId:vUndo,targetCommandId:vf.commandId,expectedCompensationFingerprint:vLedger.receipt.result.compensationFingerprint});assert.equal(vUndone.isError,undefined,JSON.stringify(vUndone));assert.equal(vUndone.structuredContent.outcome,'COMMITTED')
 reportTransport('opportunity-v3-undo',vuOffset,performance.now()-vuStart,vUndone);
 const vRestored=await current(vIds);assert.deepEqual(vRestored.snapshot,wire(restoreOpportunityManagement(vActual.snapshot,vLedger.compensation,new Date(vRestored.snapshot.exportedAt))));assert.equal(await count(vIds.userId),2)
 await db.query('update pjsdas_business_management_grants set revoked_at=clock_timestamp() where id=$1',[grantId])
 const manifest=(await db.query('select manifest_sha256 from pjsdas_rows_candidate.large_document_bundle where stage_id=$1',[vStage])).rows[0].manifest_sha256
 assert.equal((await rpc('pjsdas_rows_v1_large_documents_finish',{stage_id:vStage,target_user_id:vIds.userId,manifest_sha256:manifest})).status,403,'cached completion must reauthorize original grant')
 assert.equal((await scoped.opportunity.invoke('execute_opportunity_management',{commandId:vf.commandId,baseRevision:0,change:vf.input})).isError,true)
 console.log('PASS original scoped runtime + real grant reader -> complete V5 v3 staged archive / original fastpath Undo, 1803/1802 effects; revoked cached finalize and application replay denied')
 // A separate legitimate compact-ID fixture forces BOTH directions above the
 // unchanged 2000-effect cap. Preserve every V5 field; do not replace or hide
 // the original long-ID audit-read counterexample tested above.
 const compact=await scopedFixture(2050,true),compactOffset=calls.length,compactStart=performance.now()
 const compactSaved=await compact.scoped.opportunity.invoke('execute_opportunity_management',{commandId:compact.vf.commandId,baseRevision:0,change:compact.vf.input})
 assert.equal(compactSaved.isError,undefined,JSON.stringify(compactSaved));reportTransport('compact-id-v3-staged-archive',compactOffset,performance.now()-compactStart,compactSaved)
 assert(calls.slice(compactOffset).some(x=>x.path.endsWith('large_documents_finish')))
 const compactAfter=await current(compact.vIds),compactLedger=(await db.query('select receipt,compensation from pjsdas_rows_candidate.ledger where user_id=$1',[compact.vIds.userId])).rows[0]
 assert.equal(compactLedger.receipt.contractVersion,5);assert.equal(diffWorkspaceRows(compact.vf.before,compactAfter.snapshot).changes.length,2053)
 const compactRequest=(await db.query('select request from pjsdas_rows_candidate.large_stage where id=$1',[compact.vStage])).rows[0].request
 for(const[key,value]of Object.entries(compactRequest.receiptContext))assert.deepEqual(compactLedger.receipt[key],value)
 assert.deepEqual(compactLedger.compensation,compactRequest.compensation)
 const compactUndo='synthetic-compact-id-staged-undo';await reserve(compact.vIds,compactUndo,'opportunity_v3')
 const compactUndoOffset=calls.length,compactUndoStart=performance.now(),compactRestored=await compact.scoped.opportunity.invoke('restore_opportunity_management',{commandId:compactUndo,targetCommandId:compact.vf.commandId,expectedCompensationFingerprint:compactLedger.receipt.result.compensationFingerprint})
 assert.equal(compactRestored.isError,undefined,JSON.stringify(compactRestored));reportTransport('compact-id-v3-staged-undo',compactUndoOffset,performance.now()-compactUndoStart,compactRestored)
 assert(calls.slice(compactUndoOffset).some(x=>x.path.endsWith('large_documents_finish')))
 const compactFinal=await current(compact.vIds)
 assert.deepEqual(compactFinal.snapshot,wire(restoreOpportunityManagement(compactAfter.snapshot,compactLedger.compensation,new Date(compactFinal.snapshot.exportedAt))))
 assert.equal(diffWorkspaceRows(compactAfter.snapshot,compactFinal.snapshot).changes.length,2052);assert.equal(await count(compact.vIds.userId),2)
 console.log('PASS separate complete V5 compact-ID v3 core fixture stages BOTH archive2053 and original Undo2052 through the actual scoped runtime factory')
 // New capability: the COMPLETE prepared input is atomically durable before
 // the first document byte. Keep the earlier flag-off 409 counterexample above.
 process.env.PJSDAS_WORKSPACE_ROWS_DURABLE_INTENT='1'
 const legacyPartial=await post(partialIds,partialInput);assert.equal(legacyPartial.status,409);assert.equal((await db.query('select count(*)::int n from pjsdas_rows_candidate.large_command_intent where user_id=$1',[partialIds.userId])).rows[0].n,0)
 console.log('PASS legacy partial pre-admission counterexample retained; enabling durable capability does not invent a replacement intent')
 for(const point of [{path:'large_intent_admit'},{path:'large_documents_begin'},
  ...['metadata','beforeEnvelope','afterEnvelope','compensation'].map(document=>({path:'large_documents_append',document})),
  {path:'large_append'},{path:'large_documents_finish'}]){
  const dIds=await seed(f.before,true),dCommand='synthetic-durable-'+point.path+'-'+(point.document??'boundary'),dStage=await reserve(dIds,dCommand)
  const dInput={...incoming,commandId:dCommand,command:{type:'domain',value:{...incoming.command.value,commandId:dCommand}}}
  dropRule={...point};const failed=await post(dIds,dInput);assert.equal(failed.status,503,JSON.stringify(failed));assert.equal(dropRule,undefined)
  const intentRow=(await db.query('select encoded,deadline_at from pjsdas_rows_candidate.large_command_intent where stage_id=$1',[dStage])).rows[0];assert(intentRow)
  const prepared=decodePreparedIntent(intentRow.encoded,8388608),beforeResume=calls.length
  assert.equal(await count(dIds.userId),point.path==='large_documents_finish'?1:0)
  if(point.path==='large_documents_finish')await db.query('update pjsdas_rows_candidate.large_command_intent set deadline_at=1 where stage_id=$1',[dStage])
  const resumed=await coldPost(dIds,dInput);assert.equal(resumed.status,200,JSON.stringify(resumed))
  assert.equal(resumed.body.outcome,point.path==='large_documents_finish'?'ALREADY_APPLIED':'COMMITTED');assert.equal(await count(dIds.userId),1)
  assert.deepEqual((await current(dIds)).snapshot,prepared.input.snapshot)
  const audit=(await db.query('select receipt,compensation from pjsdas_rows_candidate.ledger where user_id=$1',[dIds.userId])).rows[0]
  for(const[key,value]of Object.entries(prepared.input.receiptContext))assert.deepEqual(audit.receipt[key],value)
  assert.deepEqual(audit.compensation,prepared.input.compensation??null)
  assert.equal((await db.query('select count(*)::int n from pjsdas_rows_candidate.large_command_intent where user_id=$1',[dIds.userId])).rows[0].n,1)
  assert(!calls.slice(beforeResume).some(x=>x.path.endsWith('large_intent_admit')),'cold recovery cannot admit a replacement intent')
  console.log('PASS COLD_DURABLE_API',JSON.stringify({point,oneCommit:true,originalDeadline:Number(intentRow.deadline_at),completeOriginalV5:true}))
  if(point.path==='large_intent_admit'){
   const undoCommand='synthetic-durable-api-undo',undoInput={action:'undo',projection:'delta-v1',commandId:undoCommand,targetCommandId:dCommand}
   const undoStage=await reserve(dIds,undoCommand);dropRule={path:'large_documents_append',document:'metadata'};assert.equal((await post(dIds,undoInput)).status,503)
   const undoIntent=(await db.query('select encoded from pjsdas_rows_candidate.large_command_intent where stage_id=$1',[undoStage])).rows[0]
   const undone=await coldPost(dIds,undoInput);assert.equal(undone.status,200,JSON.stringify(undone));assert.equal(await count(dIds.userId),2)
   assert.deepEqual((await current(dIds)).snapshot,decodePreparedIntent(undoIntent.encoded,8388608).input.snapshot)
   console.log('PASS COLD_DURABLE_API_UNDO original complete V5 compensation resumes without re-evaluation')
  }
 }
 for(const point of [{path:'large_intent_admit'},{path:'large_documents_begin'},
  ...['metadata','beforeEnvelope','afterEnvelope','compensation'].map(document=>({path:'large_documents_append',document})),{path:'large_append'},{path:'large_documents_finish'}]){
  const dv=await scopedFixture(2050,true),dvInput={commandId:dv.vf.commandId,baseRevision:0,change:dv.vf.input}
  dropRule={...point};const dvFailed=await dv.scoped.opportunity.invoke('execute_opportunity_management',dvInput);assert.equal(dvFailed.isError,true,JSON.stringify(dvFailed))
  const dvResumed=await cold({mode:'scoped',userId:dv.vIds.userId,clientId:dv.clientId,tool:'execute_opportunity_management',body:dvInput})
  assert.equal(dvResumed.isError,undefined,JSON.stringify(dvResumed));assert.equal(await count(dv.vIds.userId),1)
  const dvIntent=(await db.query('select encoded from pjsdas_rows_candidate.large_command_intent where stage_id=$1',[dv.vStage])).rows[0]
  assert.deepEqual((await current(dv.vIds)).snapshot,decodePreparedIntent(dvIntent.encoded,8388608).input.snapshot)
  console.log('PASS COLD_DURABLE_SCOPED',JSON.stringify({point,oneCommit:true,completeOriginalV5:true}))
  if(point.path==='large_intent_admit'){
   const dvLedger=(await db.query('select receipt from pjsdas_rows_candidate.ledger where user_id=$1',[dv.vIds.userId])).rows[0],undoCommand='synthetic-durable-scoped-undo'
   await reserve(dv.vIds,undoCommand,'opportunity_v3');const undoInput={commandId:undoCommand,targetCommandId:dv.vf.commandId,expectedCompensationFingerprint:dvLedger.receipt.result.compensationFingerprint}
   dropRule={path:'large_documents_append',document:'metadata'};assert.equal((await dv.scoped.opportunity.invoke('restore_opportunity_management',undoInput)).isError,true)
   const undoRestored=await cold({mode:'scoped',userId:dv.vIds.userId,clientId:dv.clientId,tool:'restore_opportunity_management',body:undoInput})
   assert.equal(undoRestored.isError,undefined,JSON.stringify(undoRestored));assert.equal(await count(dv.vIds.userId),2)
   console.log('PASS COLD_DURABLE_SCOPED_UNDO original complete V5 Undo restores pinned admitted intent')
  }
 }
 async function pendingIntent(label,point={path:'large_documents_begin'}){
  const dIds=await seed(f.before,true),dCommand='synthetic-intent-'+label,dStage=await reserve(dIds,dCommand),dInput={...incoming,commandId:dCommand,command:{type:'domain',value:{...incoming.command.value,commandId:dCommand}}}
  dropRule={...point};assert.equal((await post(dIds,dInput)).status,503)
  const row=(await db.query('select * from pjsdas_rows_candidate.large_command_intent where stage_id=$1',[dStage])).rows[0]
  assert(row);return{dIds,dCommand,dStage,dInput,row}
 }
 const denied=await scopedFixture(2050,true),deniedInput={commandId:denied.vf.commandId,baseRevision:0,change:denied.vf.input}
 dropRule={path:'large_documents_append',document:'metadata'}
 assert.equal((await denied.scoped.opportunity.invoke('execute_opportunity_management',deniedInput)).isError,true)
 const deniedRow=(await db.query('select * from pjsdas_rows_candidate.large_command_intent where stage_id=$1',[denied.vStage])).rows[0]
 await db.query('update pjsdas_business_management_grants set revoked_at=clock_timestamp() where id=$1',[denied.grantId])
 const revoked=await rpc('pjsdas_rows_v1_large_intent_read',{identity:deniedRow.identity,target_user_id:denied.vIds.userId});assert.equal(revoked.status,403);assert(!revoked.body.encoded)
 await db.query('update pjsdas_business_management_grants set revoked_at=null where id=$1',[denied.grantId])
 const regranted=await cold({mode:'scoped',userId:denied.vIds.userId,clientId:denied.clientId,tool:'execute_opportunity_management',body:deniedInput});assert.equal(regranted.isError,true);assert.equal(regranted.structuredContent.code,'AUTH_FORBIDDEN')
 await db.query('delete from pjsdas_business_management_grants where id=$1',[denied.grantId])
 const replacement=randomUUID();await db.query("insert into pjsdas_business_management_grants(id,user_id,client_id,capability,consent_version,consent_text_hash) values($1,$2,$3,'workspace.opportunity.manage',3,$4)",[replacement,denied.vIds.userId,denied.clientId,await scopedManagementConsentHash('opportunity')])
 const replaced=await cold({mode:'scoped',userId:denied.vIds.userId,clientId:denied.clientId,tool:'execute_opportunity_management',body:deniedInput});assert.equal(replaced.isError,true);assert.equal(replaced.structuredContent.code,'AUTH_FORBIDDEN')
 assert.equal(await count(denied.vIds.userId),0)
 console.log('PASS DURABLE_CURRENT_AUTH original revoked/replacement/regrant identities refused before prepared bytes release')
 const cancelScoped=await scopedFixture(2050,true),caller=new AbortController()
 const cancelRuntime=createOwnerScopedManagementRuntime({supabaseUrl:PJSDAS_SUPABASE_URL,serviceRoleKey:serviceToken,enabled:'enabled',transactional:true,signal:caller.signal,identity:{userId:cancelScoped.vIds.userId,oauthClientId:cancelScoped.clientId},audience:{allowed:true,mode:'allowlist',role:'owner'}})
 cancelOnNextDocument=caller
 const cancelledScoped=await cancelRuntime.opportunity.invoke('execute_opportunity_management',{commandId:cancelScoped.vf.commandId,baseRevision:0,change:cancelScoped.vf.input})
 assert.equal(cancelledScoped.isError,true);assert.equal(await count(cancelScoped.vIds.userId),0);assert(caller.signal.aborted)
 console.log('PASS DURABLE_SCOPED_CANCEL original factory signal reaches staged transport and leaves no business write')
 for(const fault of ['revision','epoch','compressed-hash','manifest-fastpath']){
  const t=await pendingIntent(fault),offset=calls.length
  if(fault==='revision')await db.query('update pjsdas_rows_candidate.head set revision=revision+1 where id=$1',[t.dIds.workspaceId])
  else if(fault==='epoch')await db.query('update pjsdas_rows_candidate.head set epoch=$2 where id=$1',[t.dIds.workspaceId,randomUUID()])
  else if(fault==='compressed-hash')await db.query("update pjsdas_rows_candidate.large_command_intent set encoded=jsonb_set(encoded,'{compressedSha256}',to_jsonb(repeat('0',64))) where stage_id=$1",[t.dStage])
  else {
   const value=decodePreparedIntent(t.row.encoded,8388608);value.input.snapshot=value.before.snapshot
   await db.query('update pjsdas_rows_candidate.large_command_intent set encoded=$2 where stage_id=$1',[t.dStage,encodePreparedIntent(value)])
  }
  const refused=await coldPost(t.dIds,t.dInput);assert([400,409].includes(refused.status),JSON.stringify(refused));assert.equal(await count(t.dIds.userId),0)
  assert(!calls.slice(offset).some(x=>x.path.endsWith('large_documents_finish')||x.path.endsWith('commit_rows')))
 }
 console.log('PASS DURABLE_INTEGRITY stored compressed/hash/manifest tamper and original revision/epoch fail closed without alternate fastpath')
 const raceIds=await seed(f.before,true),raceCommand='synthetic-first-admit-race',raceStage=await reserve(raceIds,raceCommand),raceInput={...incoming,commandId:raceCommand,command:{type:'domain',value:{...incoming.command.value,commandId:raceCommand}}}
 const raceResults=await Promise.all([coldPost(raceIds,raceInput),coldPost(raceIds,raceInput)]);assert(raceResults.some(r=>r.status===200),JSON.stringify(raceResults));assert.equal(await count(raceIds.userId),1)
 const raceIntent=(await db.query('select encoded from pjsdas_rows_candidate.large_command_intent where stage_id=$1',[raceStage])).rows[0]
 assert.deepEqual((await current(raceIds)).snapshot,decodePreparedIntent(raceIntent.encoded,8388608).input.snapshot)
 assert.equal((await db.query('select count(*)::int n from pjsdas_rows_candidate.large_command_intent where user_id=$1',[raceIds.userId])).rows[0].n,1)
 console.log('PASS DURABLE_FIRST_ADMISSION_RACE original winning evaluated time and complete bundle owns one commit')
 const concurrent=await pendingIntent('concurrent'),twoCold=await Promise.all([coldPost(concurrent.dIds,concurrent.dInput),coldPost(concurrent.dIds,concurrent.dInput)])
 assert(twoCold.some(r=>r.status===200),JSON.stringify(twoCold));assert.equal(await count(concurrent.dIds.userId),1)
 assert.equal((await db.query('select count(*)::int n from pjsdas_rows_candidate.large_command_intent where user_id=$1',[concurrent.dIds.userId])).rows[0].n,1)
 const finalReplay=await coldPost(concurrent.dIds,concurrent.dInput);assert.equal(finalReplay.body.outcome,'ALREADY_APPLIED')
 console.log('PASS DURABLE_CONCURRENT cold recovery finalizers resolve one immutable intent and one business receipt')
 const late=await pendingIntent('lock-deadline',{path:'large_documents_finish',before:true})
 await db.query('update pjsdas_rows_candidate.large_command_intent set deadline_at=$2 where stage_id=$1',[late.dStage,Date.now()+1000])
 await db.query('begin');await db.query('select 1 from pjsdas_rows_candidate.head where id=$1 for update',[late.dIds.workspaceId])
 const waitFinish=rpc('pjsdas_rows_v1_large_documents_finish',{stage_id:late.dStage,target_user_id:late.dIds.userId,manifest_sha256:decodePreparedIntent(late.row.encoded,8388608).manifestSha256});pending.push(waitFinish)
 let observed=false;for(let n=0;n<80;n++){await db.query('select pg_stat_clear_snapshot()');if((await db.query("select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%large_documents_finish%' ")).rows[0].n){observed=true;break}await new Promise(r=>setTimeout(r,5))}
 assert(observed,'finalizer must really wait before deadline');await new Promise(r=>setTimeout(r,1050));await db.query('commit')
 assert.equal((await waitFinish).status,503);assert.equal(await count(late.dIds.userId),0);assert.equal((await current(late.dIds)).revision,0)
 const expired=await coldPost(late.dIds,late.dInput);assert.equal(expired.status,503);assert.equal(await count(late.dIds.userId),0)
 console.log('PASS DURABLE_ABSOLUTE_DEADLINE lock-wait crossing rolls back inside original transaction; fresh process cannot reset expired budget')
 process.env.PJSDAS_WORKSPACE_ROWS_DURABLE_INTENT='0'
 const deniedRaw=await nativeFetch(origin+'/pjsdas_workspaces?select=snapshot',{headers:{authorization:'Bearer '+serviceToken}});assert.equal(deniedRaw.status,403)
 const deniedActive=await nativeFetch(origin+'/rpc/pjsdas_read_legacy_workspace_v1?target_user_id='+ids.userId,{headers:{authorization:'Bearer '+serviceToken}});assert.equal(deniedActive.status,409)
 for(const role of['anon','authenticated'])assert([401,403].includes((await rpc('pjsdas_rows_v1_large_documents_finish',{stage_id:stage,target_user_id:ids.userId,manifest_sha256:'a'.repeat(64)},jwt({role}))).status))
 for(const role of ['anon','authenticated'])assert([401,403].includes((await rpc('pjsdas_rows_v1_large_intent_read',{identity:{userId:ids.userId,commandId},target_user_id:ids.userId},jwt({role}))).status))
 console.log('PASS public-only PostgREST, active blob read fence, anon/authenticated stage denial; no new exposed schema')
 }
 const { runIntegratedResourceRecoveryProof:runResourceRpcProof } = await import('./workspace-rows-integrated-resource-recovery-proof.mjs')
 await runResourceRpcProof({db, connectionString:url.href, seed, scopedFixture, reserve, current, count, cold, coldPost, post, rpc, serviceToken, jwt, calls, reportTransport, f, incoming, pending, ownedClients, entry, webOrigin, setDrop:rule=>{dropRule=rule}, getDrop:()=>dropRule, setCancel:controller=>{cancelOnNextDocument=controller}})
 console.log('NARROW_REAL_ENTRY_PASS',JSON.stringify({effects:2102,receiptContract:5,applicationCommit:true,applicationUndo:true,applicationReplay:true,productionEligibility:false}))
} finally {
 if(coldBuilt)unlinkSync(coldFile)
 if(r0pBuilt)unlinkSync(r0pColdFile)

 console.log('HTTP_COUNTS',JSON.stringify(Object.groupBy(calls.map(x=>({path:x.path,status:x.status,bytes:x.bytes,responseBytes:x.responseBytes,ms:Math.round(x.ms)})),x=>x.path)))
 globalThis.fetch=nativeFetch
 for(const key of Object.keys(process.env))if(!(key in configBefore))delete process.env[key]
 Object.assign(process.env,configBefore)
 await Promise.allSettled(pending)
 for(const client of ownedClients)await client.end().catch(()=>{})
 for(const server of[gateway,proxy])if(server?.listening)await new Promise(resolve=>server.close(resolve))
 if(postgrest&&postgrest.exitCode===null){const done=new Promise(resolve=>postgrest.once('exit',resolve));postgrest.kill('SIGTERM');await done}
 await db.end().catch(()=>{})
 if(created)await admin.query('drop database '+name+' with(force)')
 if(readerCreated)await admin.query('drop role pjsdas_workspace_blob_reader')
 if(authCreated)await admin.query('drop role '+authenticator)
 await admin.end().catch(()=>{})
 console.log('CLEANUP owned database/reader/authenticator/proxy/gateway/PostgREST removed')
 assert.equal(assertHistoricalSource('r0p',r0pRoot,{gitCheckout:r0pSource.gitCheckout}).sourceCommit,r0pSha)
}
