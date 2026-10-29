/** Owned local-only DB. Large command upload is not a sequence of business commits. */
import assert from 'node:assert/strict'
import {randomUUID,randomBytes,createHmac,createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {mkdtemp,open,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawn} from 'node:child_process'
import pg from 'pg'
import {install,checkpointMigration} from './gmail-empty-checkpoint-fixture.mjs'
import {migration} from './discovery-authority-fixture.mjs'
import {largeAbandonFixture} from '../fixtures/workspaceRowsLargeCommand.ts'
import {prepareStagedEffects,stagedEffectPages,streamVerifiedDocument} from '../../gateway/workspaceRowsLargeCommandPrototype.ts'
import {encodeWorkspaceRows,decodeWorkspaceRows} from '../../gateway/workspaceRowsCodec.ts'
const url=new URL(process.env.TA_ROW_DATABASE_URL);assert(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert(process.env.TA_POSTGREST_BIN)
const admin=new pg.Client({connectionString:url.href}),name='ta_row_candidate_'+randomUUID().replaceAll('-','');url.pathname='/'+name
const db=new pg.Client({connectionString:url.href});let created=false,server
const secret=randomBytes(48).toString('hex'),enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url'),jwt=role=>{const body=enc({alg:'HS256',typ:'JWT'})+'.'+enc({role,exp:Math.floor(Date.now()/1000)+600});return body+'.'+createHmac('sha256',secret).update(body).digest('base64url')}
const port=55444,origin='http://127.0.0.1:'+port,token=jwt('service_role'),wire=x=>JSON.parse(JSON.stringify(x)),hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex')
const rpc=async(fn,body,roleToken=token)=>{const r=await fetch(origin+'/rpc/'+fn,{method:'POST',signal:AbortSignal.timeout(30000),headers:{authorization:'Bearer '+roleToken,'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()}}
const success=async(fn,body)=>{const r=await rpc(fn,body);assert.equal(r.status,200,JSON.stringify(r));return r.body}
const baseSql=readFileSync(new URL('./candidates/workspace-rows-stage-a.sql',import.meta.url),'utf8')
const stagedSql=readFileSync(new URL('./candidates/workspace-rows-large-command-prototype.sql',import.meta.url),'utf8')
const originalApply=baseSql.match(/create function pjsdas_rows_internal\.apply_rows\([\s\S]*?end\$\$;/)[0]
const copiedApply=stagedSql.match(/create function pjsdas_rows_internal\.apply_staged_rows\([\s\S]*?end\$\$;/)[0]
// Every permitted transformation is a unique, literal substitution. In
// particular shape checks, complete preimages, final state, CAS, audit and
// receipt semantics remain byte-for-byte equal to the original apply body.
const replaceOnce=(source,before,after)=>{assert.equal(source.split(before).length,2,'expected exactly one approved apply adaptation: '+before.slice(0,90));return source.replace(before,()=>after)}
const adaptations=[
 ['apply_rows(req jsonb,trusted_receipt_context','apply_staged_rows(req jsonb,target_stage uuid,trusted_receipt_context'],
 [" or octet_length(req::text)>2097152 or jsonb_typeof(req->'changes') is distinct from 'array'\n or jsonb_array_length(req->'changes')>2000",''],
 ["oldrow pjsdas_rows_candidate.item%rowtype;foundrow boolean;","actual_before jsonb;"],
 [" original:=pjsdas_rows_internal.original_command(h.id,h.user_id,req->>'commandId');"," perform pjsdas_rows_internal.verify_staged_effects(target_stage);\n original:=pjsdas_rows_internal.original_command(h.id,h.user_id,req->>'commandId');"],
 ["if exists(select 1 from jsonb_array_elements(req->'changes') x group by x->>'collection',x->>'id' having count(*)>1)","if exists(select 1 from pjsdas_rows_candidate.large_effect where stage_id=target_stage group by effect->>'collection',effect->>'id' having count(*)>1)"],
 [" for c in select value from jsonb_array_elements(req->'changes') loop",` -- One indexed preimage relation, not one SPI SELECT/UPSERT per entity. Keep
 -- every original shape/preimage check before set-based DML; head lock, final
 -- manifest and deferred ordering constraints still protect the one transaction.
 -- Scope both relations once and extract effect keys once. With stale
 -- single-owner statistics, the old join estimated 1 row but scanned 2100
 -- preimages per effect, repeatedly detoasting JSONB until the 10s timeout.
 -- These materialization fences do not change any row/shape/preimage check,
 -- head/stage lock, effect identity, work_mem or request deadline.
 for c,actual_before in
  with effects as materialized (
   select effect,ordinal,effect->>'collection' collection,effect->>'id' id
   from pjsdas_rows_candidate.large_effect where stage_id=target_stage
  ), preimages as materialized (
   select collection,id,ordinal,value from pjsdas_rows_candidate.item where workspace_id=h.id
  )
  select e.effect,case when i.id is null then 'null'::jsonb else jsonb_build_object('collection',i.collection,'id',i.id,'ordinal',i.ordinal,'value',i.value) end
  from effects e left join preimages i on i.collection=e.collection and i.id=e.id order by e.ordinal
 loop`],
 ["  select * into oldrow from pjsdas_rows_candidate.item where workspace_id=h.id and collection=c->>'collection' and id=c->>'id';foundrow:=found;\n",''],
 ["(case when foundrow then jsonb_build_object('collection',oldrow.collection,'id',oldrow.id,'ordinal',oldrow.ordinal,'value',oldrow.value) else 'null'::jsonb end)","actual_before"],
 [`  if c->'after'='null'::jsonb then
   delete from pjsdas_rows_candidate.item where workspace_id=h.id and collection=c->>'collection' and id=c->>'id';
  else`,"  if c->'after'<>'null'::jsonb then"],
 [`   insert into pjsdas_rows_candidate.item(workspace_id,user_id,collection,id,ordinal,value,updated_revision)
    values(h.id,h.user_id,c->>'collection',c->>'id',(c#>>'{after,ordinal}')::bigint,c#>'{after,value}',h.revision+1)
    on conflict(workspace_id,collection,id) do update set ordinal=excluded.ordinal,value=excluded.value,updated_revision=excluded.updated_revision;
`, ''],
 [`  n:=n+1;
 end loop;`,`  n:=n+1;
 end loop;
 -- The deletion relation needs the same scalar-key fence: stale owner
 -- statistics must not repeatedly extract/detoast effect JSONB per target row.
 -- This remains after ALL original preimage checks, with the same key/scope.
 with deletions as materialized (
  select effect->>'collection' collection,effect->>'id' id
  from pjsdas_rows_candidate.large_effect where stage_id=target_stage and effect->'after'='null'::jsonb
 )
 delete from pjsdas_rows_candidate.item i using deletions d
  where i.workspace_id=h.id and i.collection=d.collection and i.id=d.id;
 insert into pjsdas_rows_candidate.item(workspace_id,user_id,collection,id,ordinal,value,updated_revision)
  select h.id,h.user_id,e.effect->>'collection',e.effect->>'id',(e.effect#>>'{after,ordinal}')::bigint,e.effect#>'{after,value}',h.revision+1
  from pjsdas_rows_candidate.large_effect e where e.stage_id=target_stage and e.effect->'after'<>'null'::jsonb order by e.ordinal
  on conflict(workspace_id,collection,id) do update set ordinal=excluded.ordinal,value=excluded.value,updated_revision=excluded.updated_revision;`],
 ["md5((req->'changes')::text)","(select final_digest from pjsdas_rows_candidate.large_stage where id=target_stage)"],
 // The new exact reader capability is the sole audit-eligibility adaptation.
 // Without negotiation the original refusal is byte-for-byte retained; with
 // it, the real public reader must be proven in the same atomic transaction.
 ["  raise exception 'audit record exceeds candidate read eligibility' using errcode='22023';end if;",
  "  if req->>'auditReadProtocol' is distinct from 'workspace-audit-bytes-v1' then raise exception 'audit record exceeds candidate read eligibility' using errcode='22023';end if;\n  perform pjsdas_rows_internal.assert_large_audit_readable(req,h.id,h.user_id);\n end if;"],
]
const expectedApply=adaptations.reduce((source,[before,after])=>replaceOnce(source,before,after),originalApply)
assert.equal(copiedApply,expectedApply,'all original state, schema, owner, CAS, preimage, audit and receipt checks must remain unchanged')
const f=largeAbandonFixture()
try {
 await admin.connect();await admin.query('create database '+name);created=true;await db.connect();await install(db);await db.query(await migration(checkpointMigration))
 for(const file of ['workspace-rows-stage-a.sql','workspace-rows-authoritative-stage-a.sql','workspace-rows-large-command-prototype.sql'])await db.query(readFileSync(new URL('./candidates/'+file,import.meta.url),'utf8'))
 await db.query('grant usage on schema pjsdas_rows_candidate to service_role;grant select,insert,update,delete on all tables in schema pjsdas_rows_candidate to service_role')
 server=spawn(process.env.TA_POSTGREST_BIN,[],{env:{...process.env,PGRST_DB_URI:url.href,PGRST_DB_SCHEMAS:'pjsdas_rows_candidate',PGRST_DB_ANON_ROLE:'anon',PGRST_JWT_SECRET:secret,PGRST_SERVER_HOST:'127.0.0.1',PGRST_SERVER_PORT:String(port)},stdio:['ignore','ignore','pipe']})
 let logs='';server.stderr.on('data',x=>logs+=x)
 let ready=false;for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error(logs);try{if((await fetch(origin)).status<500){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,50))}assert(ready)
 async function seed(){const userId=randomUUID(),workspaceId=randomUUID(),e=encodeWorkspaceRows(f.before);await db.query('insert into auth.users(id) values($1)',[userId]);const h=(await db.query('insert into pjsdas_rows_candidate.head(id,user_id,envelope,manifest,legacy_snapshot) values($1,$2,$3,$4,$5) returning epoch',[workspaceId,userId,e.envelope,JSON.stringify(e.manifest),f.before])).rows[0];await db.query('insert into pjsdas_rows_candidate.item select $1,$2,x.collection,x.id,x.ordinal,x.value,0 from jsonb_to_recordset($3) x(collection text,id text,ordinal bigint,value jsonb)',[workspaceId,userId,JSON.stringify(e.rows)]);return{userId,workspaceId,epoch:h.epoch}}
 const ids=await seed(),p=prepareStagedEffects(f.delta),stage=randomUUID()
 const req={...p.metadata,workspaceId:ids.workspaceId,userId:ids.userId,expectedEpoch:ids.epoch,expectedRevision:0,commandId:f.command.commandId,payloadHash:hash(f.command),operation:'abandon_opportunity',principal:'first_party_web',compensation:f.result.compensation,provenance:{},effectiveTime:f.at,receiptContext:{contractVersion:2,affectedObjects:[{type:'opportunity',id:'synthetic-opp'}]}}
 const begin=(id=stage,r=req,prep=p)=>({stage_id:id,req:r,effect_count:prep.parts.length,final_digest:prep.finalDigest})
 const old=await rpc('commit_authoritative',{req:{...req,changes:f.delta.changes}});assert.equal(old.status,400);console.log('PASS failure-first real core command exceeds unchanged fast-path transport/effect caps')
 assert.equal((await rpc('large_begin',begin(),jwt('authenticated'))).status,403)
 assert.equal((await rpc('large_begin',begin(stage,{...req,principal:'delegated_mcp',clientId:randomUUID()}))).status,400)
 assert.equal((await rpc('large_begin',begin(stage,{...req,operation:'planning_management'}))).status,400)
 await success('large_begin',begin());assert.deepEqual(await success('large_begin',begin()),{nextOrdinal:0,result:null})
 assert.equal((await rpc('large_begin',begin(stage,{...req,payloadHash:'a'.repeat(64)}))).status,409)
 assert.equal((await rpc('large_finish',{stage_id:stage,target_user_id:ids.userId})).status,400)
 assert.equal((await rpc('large_append',{stage_id:stage,target_user_id:randomUUID(),parts:[]})).status,403)
 assert.equal((await rpc('large_append',{stage_id:stage,target_user_id:ids.userId,parts:[p.parts[1]]})).status,400)
 const pages=[...stagedEffectPages(p.parts)];await success('large_append',{stage_id:stage,target_user_id:ids.userId,parts:pages[0]})
 // Lost response: same page is an immutable replay, not a second set of effects.
 await success('large_append',{stage_id:stage,target_user_id:ids.userId,parts:pages[0]})
 assert.equal((await rpc('large_append',{stage_id:stage,target_user_id:ids.userId,parts:[{...pages[0][0],wire:pages[0][0].wire+' '}]})).status,409)
 for(const page of pages.slice(1))await success('large_append',{stage_id:stage,target_user_id:ids.userId,parts:page})
 async function current(){const h=(await db.query('select * from pjsdas_rows_candidate.head where id=$1',[ids.workspaceId])).rows[0];const rows=(await db.query('select collection,id,ordinal::integer,value from pjsdas_rows_candidate.item where workspace_id=$1',[ids.workspaceId])).rows;return{revision:Number(h.revision),snapshot:decodeWorkspaceRows({contract:'workspace-rows-v1',envelope:h.envelope,manifest:h.manifest,rows})}}
 assert.deepEqual((await current()).snapshot,wire(f.before));assert.equal((await current()).revision,0);assert.equal((await db.query('select count(*)::int n from pjsdas_rows_candidate.ledger')).rows[0].n,0)
 console.log('PASS interrupted/repeated/mixed-owner/gapped uploads never alter snapshot, revision or audit')
 const stagingBytes=(await db.query("select pg_total_relation_size('pjsdas_rows_candidate.large_stage')::bigint stage,pg_total_relation_size('pjsdas_rows_candidate.large_effect')::bigint effects")).rows[0];console.log(JSON.stringify({syntheticStagingPhysicalBytes:stagingBytes,includesIndexesAndToast:true,productionEstimate:false}))
 // Disconnect after completed finalize statement but before COMMIT really rolls it all back.
 const crash=new pg.Client({connectionString:url.href});await crash.connect();await crash.query('begin');await crash.query('select pjsdas_rows_candidate.large_finish($1,$2)',[stage,ids.userId]);await crash.end();assert.equal((await current()).revision,0)
 const results=await Promise.all([success('large_finish',{stage_id:stage,target_user_id:ids.userId}),success('large_finish',{stage_id:stage,target_user_id:ids.userId})]);assert.deepEqual(results[0].receipt,results[1].receipt)
 const result=results[0];assert.equal(result.outcome,'COMMITTED');assert.equal((await current()).revision,1);assert.deepEqual((await current()).snapshot,wire(f.result.snapshot));assert.equal((await db.query('select count(*)::int n from pjsdas_rows_candidate.ledger')).rows[0].n,1)
 const audit=(await db.query('select compensation,receipt from pjsdas_rows_candidate.ledger')).rows[0];assert.deepEqual(audit.compensation,wire(f.result.compensation));assert.deepEqual(audit.receipt,result.receipt)
 console.log('PASS 2102 real domain effects + compensation/audit commit once; disconnect rollback and concurrent finalization remain atomic')
 const stale=randomUUID();await success('large_begin',begin(stale));for(const page of pages)await success('large_append',{stage_id:stale,target_user_id:ids.userId,parts:page});const replay=await success('large_finish',{stage_id:stale,target_user_id:ids.userId});assert.equal(replay.outcome,'ALREADY_APPLIED');assert.deepEqual(replay.receipt,result.receipt)
 const up=prepareStagedEffects(f.undoDelta),undoStage=randomUUID(),undoReq={...req,...up.metadata,expectedRevision:1,commandId:'synthetic-large-undo',payloadHash:hash({undoOf:f.command.commandId}),operation:'undo_command',provenance:{undoOf:f.command.commandId},compensation:null}
 await success('large_begin',begin(undoStage,undoReq,up));for(const page of stagedEffectPages(up.parts))await success('large_append',{stage_id:undoStage,target_user_id:ids.userId,parts:page});await success('large_finish',{stage_id:undoStage,target_user_id:ids.userId});assert.deepEqual((await current()).snapshot,wire(f.undo));assert.equal((await current()).revision,2)
 assert.equal((await db.query('select count(*)::int n from pjsdas_rows_candidate.ledger')).rows[0].n,2)
 console.log('PASS actual domain Undo restores all action states and preserves history; original receipt replay stays immutable')
 // Same valid effects, different ID and stale revision: complete upload still cannot overwrite newer state.
 const cas=randomUUID();await success('large_begin',begin(cas,{...req,commandId:'synthetic-stale-other'}));for(const page of pages)await success('large_append',{stage_id:cas,target_user_id:ids.userId,parts:page});assert.equal((await success('large_finish',{stage_id:cas,target_user_id:ids.userId})).outcome,'CONFLICT');assert.equal((await current()).revision,2)
 console.log('PASS finalization rechecks CAS after all upload work; no split business transaction or generic authority bypass')
 // Complete upload is not sufficient: hash, expiry, postimage and owner epoch
 // are checked at finalization, and later-row errors roll back earlier mutations.
 const badDigest=randomUUID();await success('large_begin',{...begin(badDigest,{...req,commandId:'synthetic-bad-digest',expectedRevision:2}),final_digest:'a'.repeat(64)});for(const page of pages)await success('large_append',{stage_id:badDigest,target_user_id:ids.userId,parts:page});assert.equal((await rpc('large_finish',{stage_id:badDigest,target_user_id:ids.userId})).status,400)
 const expired=randomUUID();await success('large_begin',begin(expired,{...req,commandId:'synthetic-expired',expectedRevision:2}));await db.query("update pjsdas_rows_candidate.large_stage set expires_at=clock_timestamp()-interval '1 second' where id=$1",[expired]);assert.equal((await rpc('large_append',{stage_id:expired,target_user_id:ids.userId,parts:pages[0]})).status,400)
 // Build effects against the actual Undo snapshot; corrupt a late preimage only.
 const {diffWorkspaceRows}=await import('../../gateway/workspaceRowsCodec.ts')
 const nextDelta=diffWorkspaceRows(f.undo,f.result.snapshot);nextDelta.changes.at(-1).before={...nextDelta.changes.at(-1).before,value:{id:'synthetic-tamper'}}
 const bad=prepareStagedEffects(nextDelta),badStage=randomUUID(),badReq={...req,...bad.metadata,expectedRevision:2,commandId:'synthetic-late-preimage'}
 await success('large_begin',begin(badStage,badReq,bad));for(const page of stagedEffectPages(bad.parts))await success('large_append',{stage_id:badStage,target_user_id:ids.userId,parts:page})
 assert.equal((await rpc('large_finish',{stage_id:badStage,target_user_id:ids.userId})).status,409);assert.deepEqual((await current()).snapshot,wire(f.undo));assert.equal((await current()).revision,2)
 console.log('PASS wrong final digest, expired staging and late row-preimage corruption cannot publish any partial business effect')
 // Retained large historical document: synthetic seed, not a claim that the
 // current small-path writer can admit this receipt. Byte transport is distinct
 // from domain/history API integration and no production layout is changed.
 const largeReceipt={commandId:'synthetic-retained-large-audit',operation:'abandon_opportunity',status:'COMMITTED',revision:3,notes:'汉字😀 retained audit '.repeat(110000)}
 await db.query('begin');await db.query('update pjsdas_rows_candidate.head set revision=3 where id=$1',[ids.workspaceId]);await db.query("insert into pjsdas_rows_candidate.ledger(workspace_id,user_id,command_id,payload_hash,resulting_revision,receipt,compensation,effect_digest) values($1,$2,$3,$4,3,$5,'null','synthetic')",[ids.workspaceId,ids.userId,largeReceipt.commandId,'a'.repeat(64),largeReceipt]);await db.query('commit')
 const spool=await mkdtemp(join(tmpdir(),'ta-synthetic-audit-'));let file,published=false,peak=0
 try {
  file=await open(join(spool,'provisional'),'wx',0o600)
  const read=async(offset)=>success('large_read_fragment',{req:{workspaceId:ids.workspaceId,userId:ids.userId,epoch:ids.epoch,revision:3,mode:'audit',documentKey:largeReceipt.commandId,offset}})
  const transferred=await streamVerifiedDocument({epoch:ids.epoch,revision:3,documentKey:largeReceipt.commandId,signal:AbortSignal.timeout(120000),read,
   fence:async()=>{const h=await success('read_head',{target_user_id:ids.userId});return h.epoch===ids.epoch&&h.revision===3},
   sink:{write:async(bytes)=>{assert(!published);peak=Math.max(peak,bytes.length);await file.write(bytes)},commit:async()=>{await file.sync();published=true},abort:async()=>{await file.truncate(0)}}})
  assert(transferred.bytes>2097152);assert.equal(peak,65536);assert(published)
  const decoded=JSON.parse(await readFile(join(spool,'provisional'),'utf8'));assert.deepEqual(decoded.receipt,largeReceipt)
  console.log('PASS actual HTTP retained >2MiB audit byte fragments, UTF-8 boundary-safe digest, private provisional disk spool and final revision fence')
  let calls=0,aborted=false;published=false;await file.truncate(0)
  await assert.rejects(streamVerifiedDocument({epoch:ids.epoch,revision:3,documentKey:largeReceipt.commandId,signal:AbortSignal.timeout(120000),
   read:async(offset)=>{if(++calls===2)await db.query('update pjsdas_rows_candidate.head set revision=4 where id=$1',[ids.workspaceId]);return read(offset)},fence:async()=>true,
   sink:{write:async(bytes)=>{await file.write(bytes)},commit:async()=>{published=true},abort:async()=>{aborted=true;await file.truncate(0)}}}))
  assert(aborted);assert(!published);assert.equal((await file.stat()).size,0)
  console.log('PASS actual concurrent revision change during HTTP audit streaming aborts and removes provisional bytes')
  await db.query("update pjsdas_rows_candidate.head set format='unsupported-future-layout' where id=$1",[ids.workspaceId])
  assert.equal((await rpc('large_finish',{stage_id:stage,target_user_id:ids.userId})).status,403)
  await db.query("update pjsdas_rows_candidate.head set format='workspace-rows-v1',epoch=gen_random_uuid() where id=$1",[ids.workspaceId])
  assert.equal((await rpc('large_finish',{stage_id:stage,target_user_id:ids.userId})).status,403)
  console.log('PASS even a completed stage cannot replay through a retired owner epoch')

 }finally{await file?.close();await rm(spool,{recursive:true,force:true})}
 console.log(JSON.stringify({syntheticOnly:true,effects:p.parts.length,effectBytes:p.totalBytes,uploadPages:pages.length,largeCommandAndUndo:true,productionReady:false}))
}finally{if(server&&server.exitCode===null){const stopped=new Promise(r=>server.once('exit',r));server.kill('SIGTERM');await stopped}await db.end().catch(()=>{});if(created)await admin.query('drop database '+name+' with(force)');await admin.end()}
