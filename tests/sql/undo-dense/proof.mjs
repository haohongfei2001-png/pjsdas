/** Owned-loopback PostgreSQL proof. No production connection or migration.
 * JSONB equality and numerical precision remain inside PostgreSQL. */
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {existsSync,readFileSync,writeFileSync} from 'node:fs'
import {isAbsolute} from 'node:path'
import pg from 'pg'
import {verifySource,sourceImport} from '../workspace-rows-durable-v2-source.mjs'

// Verify the exact frozen allowlist before loading product/fixture modules.
const sourceLock=verifySource()
const {install,checkpointMigration}=await sourceImport('tests/sql/gmail-empty-checkpoint-fixture.mjs')
const {migration}=await sourceImport('tests/sql/discovery-authority-fixture.mjs')
const {stagedOpportunityFixture}=await sourceImport('tests/fixtures/workspaceRowsStagedOpportunity.ts')
const evidencePath=process.env.TA_UNDO_EVIDENCE
assert(evidencePath&&isAbsolute(evidencePath),'An absolute run-exclusive evidence path is required')
assert(!existsSync(evidencePath),'Refuse to overwrite prior evidence')

const sha=s=>createHash('sha256').update(s).digest('hex')
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8')
const original=read('../fixtures/opportunity-guard-pre-scalar.sql')
assert.equal(sha(original),'64f12841423cc3410192e6706a1c4c0c2d848e57cf6da0fe847e61157bec1722')
const narrowSource=read('../candidates/workspace-rows-opportunity-stage-a.sql')
const stagedSource=read('../candidates/workspace-rows-staged-opportunity-prototype.sql')
const begin="    if (target_snapshot - array['data','version','exportedAt'])"
const inner=s=>s.slice(s.indexOf(begin),s.indexOf('\n end if;\n ',s.indexOf(begin)))
const narrow=inner(narrowSource),staged=inner(stagedSource)
assert.equal(staged,narrow,'narrow and staged must retain the same complete inner guard')
const fastMarker='        -- Only the ordinary, identity-preserving integer-index subset uses'
const fallbackMarker='        expected_rows:=old_rows; expected_ids:=old_ids;'
const comparisonMarker='        if expected_rows is distinct from new_rows'
const fastStart=narrow.indexOf(fastMarker),fallbackStart=narrow.indexOf(fallbackMarker,fastStart)
const fastEnd=narrow.indexOf(comparisonMarker,fastStart)
assert(fastStart>0&&fallbackStart>fastStart&&fastEnd>fallbackStart)
const fallback=narrow.slice(fallbackStart,fastEnd).replace(/        end if;\n$/,'')
const scalar=narrow.slice(0,fastStart)+fallback+narrow.slice(fastEnd)
assert.equal(sha(scalar),'87ed9282d81ff2e8ac726be8f24f55ff4ee4d0ac8a0de55f075d413eb3ac7e95','entire pre-dense public-head inner guard')
const loop=body=>{const a=body.includes(fastMarker)?body.indexOf(fastMarker):body.indexOf('        expected_rows:=old_rows;');const b=body.indexOf(comparisonMarker,a);assert(a>0&&b>a);return body.slice(a,b)}
const declarations=`evidence jsonb; changes jsonb; archives jsonb; old_history jsonb; new_history jsonb; old_rows jsonb; new_rows jsonb;
retained_old jsonb; retained_new jsonb; expected_rows jsonb; change jsonb; before_row jsonb; after_row jsonb; current_row jsonb; proposed_row jsonb;
kind text; collection text; row_index integer; old_ids text[]; new_ids text[]; change_ids text[]; expected_ids text[]; insertion_index integer; kind_changes jsonb;
dense_slots integer[]; dense_slot integer; dense_old_count integer;`
const wire=x=>JSON.stringify(x).replaceAll('"@big@"','9007199254740993').replaceAll('"@decimal@"','0.123456789012345678901234567890123456789').replaceAll('"@huge@"','1e100').replaceAll('"@scale@"','1.0')
const url=new URL(process.env.TA_ROW_DATABASE_URL)
assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/postgres');assert.equal(url.username,'postgres');assert.equal(url.search,'');assert.equal(url.hash,'')
assert.equal(process.env.TA_UNDO_VALIDATION_WINDOW,'synthetic-owned-fixture')
const name='ta_undo_dense_'+randomUUID().replaceAll('-',''),admin=new pg.Client({connectionString:url.href})
url.pathname='/'+name;const db=new pg.Client({connectionString:url.href})
const report={contract:'ta-undo-dense-guard-proof-v1',baseline:'5e9be3fe86f549c97776ca0c9afa15032d0bf936',preScalarSha256:sha(original),preDenseInnerSha256:sha(scalar),narrowSha256:sha(narrowSource),stagedSha256:sha(stagedSource),statementTimeout:'10s',workMem:'2184kB',comparisons:[],performance:[],cleanup:'NOT_RUN',status:'RUNNING',source:{commit:sourceLock.commit,tree:sourceLock.tree,prHeadSha:sourceLock.prHeadSha,manifestSha256:process.env.TA_V2_SOURCE_MANIFEST_SHA256,files:Object.keys(sourceLock.sha256).length},sourceBefore:'PASS',sourceAfter:'NOT_RUN'}
let created=false
async function installLoop(label,body,collation){
 let code=loop(body),collate=collation?` collate ${collation}`:''
 if(collation)code=code.replaceAll("r.value->>'id'=change->>'id'",`(r.value->>'id') collate ${collation}=change->>'id'`)
 const args='old_rows jsonb,changes jsonb'
 const declaration=`expected_rows jsonb; change jsonb; row_index integer; kind text:='opportunity'; old_ids text[]${collate}; expected_ids text[]${collate}; insertion_index integer; kind_changes jsonb; dense_slots integer[]; dense_slot integer; dense_old_count integer; dense_hit boolean:=false;`
 const init=`select coalesce(array_agg(r.value->>'id' order by r.n),array[]::text[]) into old_ids from jsonb_array_elements(old_rows) with ordinality r(value,n);
 select coalesce(jsonb_agg(c.value order by c.n),'[]'::jsonb) into kind_changes from jsonb_array_elements(changes) with ordinality c(value,n) where c.value->>'type'=kind;`
 await db.query(`create function pg_temp.${label}(${args}) returns jsonb language plpgsql as $$ declare ${declaration} begin ${init} ${code} return jsonb_build_object('value',expected_rows,'sqlNull',expected_rows is null); end $$`)
 if(body.includes(fastMarker))await db.query(`create function pg_temp.${label}_hit(${args}) returns boolean language plpgsql as $$ declare ${declaration} begin ${init} ${code.replace('dense_old_count:=','dense_hit:=true; dense_old_count:=')} return dense_hit; exception when others then return dense_hit; end $$`)
}
async function compare(label,kind,args,functions,expectedFast){
 const encoded=args.map((x,i)=>kind==='full'&&i===3?x:wire(x))
 const params=encoded.map((_,i)=>'$'+(i+1)).join(',')
 const result=await db.query(`with outcomes as materialized (select ${functions.map((fn,i)=>`pg_temp.capture_${kind}('${fn}',${params}) r${i}`).join(',')}) select ${functions.slice(1).map((_,i)=>`r0 is not distinct from r${i+1}`).join(' and ')} same, r0::text reference from outcomes`,encoded)
 assert.equal(result.rows[0].same,true,label)
 let hit
 if(expectedFast!==undefined){hit=(await db.query(`select pg_temp.${functions.at(-1)}_hit(${params}) hit`,encoded)).rows[0].hit;assert.equal(hit,expectedFast,label+'/fast-path')}
 report.comparisons.push({label,kind,functions: functions.length,exactServerJsonb:true,...(hit!==undefined?{fastPath:hit}:{})})
 return JSON.parse(result.rows[0].reference)
}
try{
 await admin.connect();await admin.query('create database '+name);created=true;await db.connect()
 await db.query("set statement_timeout='10s';set work_mem='2184kB'")
 assert.equal((await db.query('show statement_timeout')).rows[0].statement_timeout,'10s')
 assert.equal((await db.query('show work_mem')).rows[0].work_mem,'2184kB')
 report.postgres=(await db.query('select version() v')).rows[0].v
 await install(db);await db.query(await migration(checkpointMigration))
 for(const [label,body] of [['original',original],['scalar',scalar],['narrow',narrow],['staged',staged]]){
  await installLoop('loop_'+label,body)
  await db.query(`create function pg_temp.full_${label}(old_snapshot jsonb,target_snapshot jsonb,prior_evidence jsonb,target_operation text) returns jsonb language plpgsql as $$ declare ${declarations} begin ${body} return jsonb_build_object('accepted',true); end $$`)
 }
 for(const [kind,args,using] of [['loop','old_rows jsonb,changes jsonb','old_rows,changes'],['full','old_snapshot jsonb,target_snapshot jsonb,prior_evidence jsonb,target_operation text','old_snapshot,target_snapshot,prior_evidence,target_operation']]){
  const placeholders=using.split(',').map((_,i)=>'$'+(i+1)).join(',')
  await db.query(`create function pg_temp.capture_${kind}(fn text,${args}) returns jsonb language plpgsql as $$ declare result jsonb; code text; message text; begin execute format('select pg_temp.%I(${placeholders})',fn) into result using ${using};return jsonb_build_object('value',result);exception when others then get stacked diagnostics code=returned_sqlstate,message=message_text;return jsonb_build_object('code',code,'message',message);end $$`)
 }
 const change=(id,index,before={id})=>({type:'opportunity',id,beforeIndex:index,before,after:null})
 const rows=[{id:'a',unknown:{big:'@big@',decimal:'@decimal@',huge:'@huge@'}},{id:'b'},{id:'c'}]
 const cases=[
  ['empty',[],[],true],['unchanged',rows,[],true],['front',rows,[change('x',0)],true],['end',rows,[change('x',3)],true],['clamp',rows,[change('x',999999999)],true],
  ['all-replace',rows,rows.map((r,i)=>change(r.id,i,{...r,nested:['@big@','@decimal@']})),true],
  ['all-insert',[],Array.from({length:80},(_,i)=>change('x'+i,i,{id:'x'+i,raw:['@big@','@decimal@']})),true],
  ['mixed-replace-insert',rows,[change('x',0),change('a',1,{id:'a',raw:'@decimal@'}),change('y',7)],true],
  ['scale-existing',rows,[change('a','@scale@')],false],['scale-insert',rows,[change('x','@scale@')],false],
  ['huge-clamp',rows,[change('x','@huge@')],false],['ten-digits',rows,[change('x',1000000000)],false],
  ['equal-indices',rows,Array.from({length:80},(_,i)=>change('x'+i,1)),false],
  ['identity-mutation',rows,[change('a',0,{id:'b'}),change('b',1,{id:'b',last:true})],false],
  ['sql-null-before',rows,[{type:'opportunity',id:'x',beforeIndex:0},change('y','@huge@')],false],
  ['json-null-before',rows,[change('a',0,null)],false],
 ]
 for(const [label,before,changes,hit] of cases)await compare(label,'loop',[before,changes],['loop_original','loop_scalar','loop_narrow','loop_staged'],hit)
 for(const before of [null,0,'bad',[],{}, {id:null},{id:2},{id:'b'}])for(const id of ['a','x'])await compare('malformed/'+id+'/'+JSON.stringify(before),'loop',[rows,[change(id,0,before),change('b',1)]],['loop_original','loop_scalar','loop_narrow','loop_staged'])
 for(const index of [null,-1,.5,'@scale@','@huge@','bad',{},[],true])for(const id of ['a','x'])await compare('index/'+id+'/'+JSON.stringify(index),'loop',[rows,[change(id,index)]],['loop_original','loop_scalar','loop_narrow','loop_staged'])
 // Explicit collated replicas isolate lookup semantics; they do not claim the
 // untouched public guard ran under a nondeterministic database default.
 await db.query("create collation und_ci (provider=icu,locale='und-u-ks-level1',deterministic=false)")
 for(const collation of ['"C"','"en-US-x-icu"','und_ci']){
  const suffix=collation==='"C"'?'c':collation==='und_ci'?'ci':'icu'
  for(const [label,body] of [['original',original],['scalar',scalar],['narrow',narrow],['staged',staged]])await installLoop('coll_'+suffix+'_'+label,body,collation)
  for(const [label,before,changes] of [
   ['case',[{id:'A'},{id:'é'}],[change('a',0,{id:'a',raw:'@big@'}),change('É',1,{id:'É',raw:'@decimal@'})]],
   ['combining',[{id:'é'}],[change('e\u0301',0,{id:'e\u0301',raw:'@huge@'})]],
   ['duplicate-first',[{id:'A',first:true},{id:'a',second:true}],[change('a',0)]],
   ['replace-then-lookup',[{id:'A'}],[change('a',0),change('A',1,{id:'A',last:true})]],
   ['malformed-fallback',[{id:'A'}],[change('a',0,{id:'b'}),change('b',1)]],
   ['tie-fallback',[{id:'é'}],[change('É',0),change('e',0)]],
  ])await compare('collation/'+suffix+'/'+label,'loop',[before,changes],['original','scalar','narrow','staged'].map(x=>'coll_'+suffix+'_'+x))
 }
 const f=await stagedOpportunityFixture(6,{compactIds:true})
 for(const [label,before,next,op] of [['archive',f.before,f.result.snapshot,'opportunity_management'],['undo',f.result.snapshot,f.undo,'undo_command']]){
  for(const [mutation,mutate] of [
   ['valid',()=>{}],['precision',x=>{for(const snap of [x.before,x.next])snap.data.opportunities.find(x=>x.id==='r').unknown={big:'@big@',decimal:'@decimal@',huge:'@huge@'}}],
   ['missing-before',x=>{delete x.evidence.payload.changes[0].before}],['scale-index',x=>{x.evidence.payload.changes[0].beforeIndex='@scale@'}],
   ['bad-index',x=>{x.evidence.payload.changes[0].beforeIndex='bad'}],['wrong-before-id',x=>{x.evidence.payload.changes[0].before.id='foreign'}],
   ['duplicate-index',x=>{x.evidence.payload.changes.at(-1).beforeIndex=0}],['retained-mutation',x=>{x.next.data.opportunities.find(x=>x.id==='r').unknown='changed'}],
  ]){const x=structuredClone({before,next,evidence:f.result.compensation});mutate(x);const result=await compare('full/'+label+'/'+mutation,'full',[x.before,x.next,x.evidence,op],['full_original','full_scalar','full_narrow','full_staged']);if(['valid','precision'].includes(mutation))assert.deepEqual(result,{value:{accepted:true}})}
 }
 // Query-local server timing: same synthetic arguments, alternating order,
 // no response serialization in the timed section, unchanged 10s timeout.
 await db.query(`create function pg_temp.measure(fn text,args jsonb,full_guard boolean) returns jsonb language plpgsql as $$ declare started timestamptz;result jsonb;elapsed numeric;begin started:=clock_timestamp();if full_guard then execute format('select pg_temp.%I($1,$2,$3,$4)',fn) into result using args->0,args->1,args->2,args->>3;else execute format('select pg_temp.%I($1,$2)',fn) into result using args->0,args->1;end if;elapsed:=extract(epoch from clock_timestamp()-started)*1000;return jsonb_build_object('elapsedMs',elapsed,'result',result);end $$`)
 for(const [label,args,fullGuard] of [
  ['loop-2050-inserts',[[],Array.from({length:2050},(_,i)=>change('a'+i,i,{id:'a'+i,unknown:'x'.repeat(220),precision:'@decimal@'}))],false],
  ['full-2050-action-undo',await(async()=>{const f=await stagedOpportunityFixture(2050,{compactIds:true});return[f.result.snapshot,f.undo,f.result.compensation,'undo_command']})(),true],
 ]){
  const prefix=fullGuard?'full':'loop'
  await compare('performance/'+label,fullGuard?'full':'loop',args,[prefix+'_original',prefix+'_scalar',prefix+'_narrow',prefix+'_staged'])
  const samples={scalar:[],narrow:[],staged:[]}
  for(let round=0;round<5;round++)for(const variant of round%2?['staged','narrow','scalar']:['scalar','narrow','staged']){
   const r=(await db.query('select pg_temp.measure($1,$2,$3) value',[prefix+'_'+variant,wire(args),fullGuard])).rows[0].value
   samples[variant].push(r.elapsedMs)
  }
  report.performance.push({label,scope:fullGuard?'complete inner guard only, not HTTP/transactions':'Undo reconstruction only',samplesMs:samples,mediansMs:Object.fromEntries(Object.entries(samples).map(([k,v])=>[k,[...v].sort((a,b)=>a-b)[2]])),noTimeoutRelaxation:true})
 }
 report.status='PASS'
}catch(error){report.status='FAIL';report.error={code:error.code,message:error.message};throw error}
finally{
 await db.end().catch(()=>{});if(created)await admin.query('drop database '+name+' with(force)')
 if(created)assert.equal(Number((await admin.query('select count(*) n from pg_database where datname=$1',[name])).rows[0].n),0)
 await admin.end();report.cleanup='PASS'
 try{verifySource();report.sourceAfter='PASS'}catch(error){report.status='FAIL';report.sourceAfter='FAIL';report.sourceError={message:error.message};throw error}
 finally{writeFileSync(evidencePath,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600})}
 console.log('UNDO_DENSE_PROOF',JSON.stringify({status:report.status,cases:report.comparisons.length,performance:report.performance,cleanup:report.cleanup,...(report.error?{error:report.error}:{})}))
}
