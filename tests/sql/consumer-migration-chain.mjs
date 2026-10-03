// Whole-chain preservation proof. PGlite by default; --postgres accepts ONLY the CI loopback fixture.
import assert from 'node:assert/strict'
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrationEnvelope } from './migration-envelope.mjs'
import { backupRoundtrip } from './backup-roundtrip.mjs'
import { PGlite } from '@electric-sql/pglite'
import pg from 'pg'
const real=process.argv.includes('--postgres')
let db, admin, fixtureUrl, scratch
const run=promisify(execFile)
if(real){
 const url=new URL(process.env.TA_MANAGEMENT_SQL_TEST_URL??'http://missing.invalid')
 if(url.protocol!=='postgresql:'||!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!=='/ta_management_fixture'||url.username!=='postgres'||url.password!=='fixture-only'||url.search)throw Error('Only isolated CI fixture accepted')
 admin=new pg.Client({connectionString:url.toString()});await admin.connect()
 await admin.query('create database ta_chain_fixture');url.pathname='/ta_chain_fixture'
 fixtureUrl=url
 scratch=await mkdtemp(join(tmpdir(),'ta-migration-proof-'))
 db=new pg.Client({connectionString:url.toString(),statement_timeout:15000});await db.connect()
}else db=new PGlite()
const exec=sql=>real?db.query(sql):db.exec(sql), sql=async name=>readFile(new URL(`../../supabase/migrations/${name}`,import.meta.url),'utf8')
const manifest=JSON.parse(await readFile(new URL('../../docs/consumer-management/pending-migration-checksums.json',import.meta.url),'utf8'))
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const [a,b,c,client]=[81,82,83,84].map(id)
const state=who=>({schema:'pjsdas-local-snapshot',version:4,exportedAt:'2026-10-03T00:00:00Z',future:{who,raw:['second','first']},data:{opportunities:[],processes:[],processEvents:[],actions:[],prep:[],applicationGroups:[],scheduleNodes:[],decisionRequests:[],semanticReceipts:[],reminderIntents:[],reminderOutbox:[],unknown:{who,legacy:'preserve'}}})
const tables=['pjsdas_access_grants','pjsdas_business_management_grants','pjsdas_workspaces','pjsdas_command_ledger','pjsdas_management_consent_events']
const allRows=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>[table,(await db.query(`select to_jsonb(t)::text v from public.${table} t order by to_jsonb(t)::text`)).rows])))
// Compare semantic catalogs within the same engine; never compare unstable object OIDs.
const catalog=async()=>({
 schemas:(await db.query("select nspname,pg_get_userbyid(nspowner) owner,nspacl::text from pg_namespace where nspname in ('public','auth','supabase_migrations') order by nspname")).rows,
 tables:(await db.query(`select n.nspname,c.relname,pg_get_userbyid(c.relowner) owner,c.relrowsecurity,c.relforcerowsecurity,c.relacl::text,
  (select jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid),a.attacl::text) order by a.attnum)
   from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped) columns,
  (select jsonb_agg(jsonb_build_array(k.conname,pg_get_constraintdef(k.oid),k.convalidated) order by k.conname) from pg_constraint k where k.conrelid=c.oid) constraints,
  (select jsonb_agg(jsonb_build_array(t.tgname,pg_get_triggerdef(t.oid),t.tgenabled) order by t.tgname) from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal) triggers
  from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','auth','supabase_migrations') and c.relkind='r' order by n.nspname,c.relname`)).rows,
 functions:(await db.query(`select p.oid::regprocedure::text signature,pg_get_userbyid(p.proowner) owner,pg_get_functiondef(p.oid) definition,p.proacl::text
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','auth','supabase_migrations') and p.prokind='f' order by signature`)).rows,
 policies:(await db.query("select * from pg_policies where schemaname in ('public','auth','supabase_migrations') order by schemaname,tablename,policyname")).rows,
 indexes:(await db.query("select schemaname,tablename,indexname,indexdef from pg_indexes where schemaname in ('public','auth','supabase_migrations') order by schemaname,tablename,indexname")).rows,
 history:(await db.query('select * from supabase_migrations.schema_migrations order by version')).rows,
 defaults:(await db.query(`select pg_get_userbyid(d.defaclrole) owner,n.nspname,d.defaclobjtype,d.defaclacl::text from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace order by owner,n.nspname,d.defaclobjtype`)).rows,
})
const tablePrivileges=async(table)=>(await db.query(`select r.role,p.permission,has_table_privilege(r.role,$1,p.permission) allowed
 from unnest(array['anon','authenticated','service_role']) r(role)
 cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p(permission)
 order by r.role,p.permission`,[table])).rows
const commit=async(user,command,revision,grant=id(91),v7=false,next=state(user),comp={},operation='business_management',provenance={})=>(await db.query(`select * from public.${v7?'pjsdas_commit_consumer_business_workspace_v1':'pjsdas_commit_management_workspace_v1'}($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[user,command,operation,'hash:'+command,revision,JSON.stringify(next),4,'delegated_mcp',client,JSON.stringify(provenance),JSON.stringify(comp),null,'{}',grant,1])).rows[0]
try{
 if(!real)await exec('create role anon;create role authenticated;create role service_role bypassrls;')
 // Roles already exist in the parent CI fixture, while this database is new.
 await exec('create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;')
 for(const file of ['2026091901_ai_operated_mutation_foundation.sql','2026091903_controlled_audience.sql','20260923030000_cgr01_authoritative_commands.sql'])await exec(await sql(file))
 // Reproduce observed platform defaults before the two already-installed management migrations.
 // Their explicit REVOKEs must close ordinary-role access even under these broad defaults.
 await exec(`alter default privileges for role postgres in schema public grant all on tables to anon,authenticated,service_role;
  alter default privileges for role postgres in schema public grant all on functions to anon,authenticated,service_role;
  alter default privileges for role postgres in schema public grant all on sequences to anon,authenticated,service_role;`)
 for(const file of ['20261002123812_consumer_management_atomic_grants.sql','20261002143625_owner_management_consent_audit.sql'])await exec(await sql(file))
 // Isolated fixture history, not an implementation claim about the hosted migration endpoint.
 await exec('create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key,name text,statements text[]);')
 for(const [i,user] of [a,b,c].entries()){
  await db.query('insert into auth.users(id) values($1)',[user]);await db.query("insert into pjsdas_access_grants(user_id,role) values($1,$2)",[user,i===0?'owner':'beta'])
  await db.query('insert into pjsdas_workspaces(user_id,snapshot,schema_version) values($1,$2,4)',[user,JSON.stringify(state(user))])
  await db.query("insert into pjsdas_business_management_grants(id,user_id,client_id,capability,consent_version,consent_text_hash,revoked_at) values($1,$2,$3,'workspace.manage',2,$4,$5)",[id(91+i),user,client,'a'.repeat(64),i===2?'2026-10-02T00:00:00Z':null])
 }
 await exec('set role service_role')
 const historical=await commit(a,'old-v2-command',0);assert.equal(historical.outcome,'COMMITTED')
 // Seed a real old owner decision/audit without replacing the already existing owner grant.
 const oldDecision=[a,client,id(97),'b'.repeat(64),'approve',2,'c'.repeat(64),id(91),1,true,true]
 await db.query('select * from pjsdas_decide_management_consent_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',oldDecision)
 await exec('reset role')
 const before=await allRows(), reviewedFunctions=new Set()
 const oldTablePrivileges=Object.fromEntries(await Promise.all(['pjsdas_business_management_grants','pjsdas_management_consent_events'].map(async t=>[t,await tablePrivileges(t)])))
 for(const [table,privileges] of Object.entries(oldTablePrivileges))for(const p of privileges){
  assert.equal(p.allowed,p.role==='service_role'&&(table==='pjsdas_business_management_grants'||['SELECT','INSERT'].includes(p.permission)),`${table} ${p.role} ${p.permission} baseline`)
 }
 if(real)await backupRoundtrip(db,admin,fixtureUrl,async connection=>{
  const original=db;db=connection
  try{return {catalog:await catalog(),rows:await allRows(),auth:(await db.query('select * from auth.users order by id')).rows}}
  finally{db=original}
 })
 for(const entry of manifest.migrations){
  const text=await sql(entry.file);for(const match of text.matchAll(/create (?:or replace )?function public\.(\w+)/g))reviewedFunctions.add(match[1]);assert.equal(createHash('sha256').update(text).digest('hex'),entry.sha256)
  const previous=await catalog(),version=entry.file.split('_')[0],name=entry.file.slice(version.length+1,-4)
  const nativeEnvelope=async(fault='')=>{
   const file=join(scratch,'envelope.sql')
   await writeFile(file,migrationEnvelope(entry,text)+'\n'+fault,{mode:0o600})
   return run('psql',['-X','-w','--single-transaction','--set','ON_ERROR_STOP=1','--set','VERBOSITY=sqlstate','--file',file],{
    env:{...process.env,PGHOST:fixtureUrl.hostname,PGPORT:fixtureUrl.port,PGDATABASE:fixtureUrl.pathname.slice(1),PGUSER:fixtureUrl.username,PGPASSWORD:fixtureUrl.password},maxBuffer:1024*1024,timeout:25000,
   })
  }
  const stage=async()=>{
   await exec('begin')
   await exec("set local lock_timeout='2s';set local statement_timeout='15s'")
   assert.deepEqual((await db.query("select current_setting('lock_timeout') l,current_setting('statement_timeout') s")).rows[0],{l:'2s',s:'15s'})
   await exec(text)
   await db.query('insert into supabase_migrations.schema_migrations(version,name,statements) values($1,$2,$3)',[version,name,[text]])
   assert.deepEqual((await db.query('select * from supabase_migrations.schema_migrations where version=$1',[version])).rows,[{version,name,statements:[text]}])
  }
  // Failure after both DDL and history insertion must roll everything back. This is deliberate
  // fault injection in disposable data, not a production retry policy or a timeout simulation.
  if(real&&entry.order===1){
   const blocker=new pg.Client({connectionString:fixtureUrl.toString()});await blocker.connect()
   try{
    await blocker.query('begin');await blocker.query('lock table public.pjsdas_business_management_grants in access exclusive mode')
    await assert.rejects(nativeEnvelope(),e=>e.code===3&&e.stderr.includes('55P03'))
   }finally{await blocker.query('rollback');await blocker.end()}
   assert.deepEqual(await catalog(),previous,'actual 2s lock timeout must leave schema/history unchanged')
   await assert.rejects(nativeEnvelope('SELECT pg_sleep(20);'),e=>e.code===3&&e.stderr.includes('57014'))
   assert.deepEqual(await catalog(),previous,'actual 15s statement timeout after history insert must roll back everything')
   assert.deepEqual(await allRows(),before)
   console.log('PASS native psql actual lock_timeout=2s and statement_timeout=15s; no partial schema/history/data commits.')
  }
  if(real)await assert.rejects(nativeEnvelope('SELECT 1/0;'),e=>e.code===3&&e.stderr.includes('22012'))
  else try{await stage();await assert.rejects(db.query('select 1/0'),e=>e.code==='22012')}finally{await exec('rollback')}
  assert.deepEqual(await catalog(),previous,`${entry.file}: failure must roll back schema, functions, permissions and history`)
  assert.deepEqual(await allRows(),before,`${entry.file}: failure must preserve existing rows`)
  if(real)await nativeEnvelope()
  else try{await stage();await exec('commit')}catch(e){await exec('rollback');throw e}
  const committed=await catalog()
  assert.deepEqual(committed.history,[...previous.history,{version,name,statements:[text]}],`${entry.file}: exactly one committed history row`)
  for(const [table,privileges] of Object.entries(oldTablePrivileges)){
   assert.deepEqual(await tablePrivileges(table),privileges,`${entry.file}: preserve ${table} privileges`)
   assert.equal(committed.tables.find(t=>t.relname===table).relacl,previous.tables.find(t=>t.relname===table).relacl)
  }
  assert.deepEqual(await allRows(),before,`${entry.file} must not rewrite existing rows`)
  if(real){
   await assert.rejects(nativeEnvelope(),e=>e.code===3&&e.stderr.includes('P0001'))
   assert.deepEqual(await catalog(),committed,'completed migration must stop instead of being replayed')
  }
  console.log('PASS whole-chain failure rollback + committed history + preserved rows/ACL + SHA256:',entry.file)
 }
 assert.equal(Number((await db.query('select count(*) n from pjsdas_scoped_management_consent_events')).rows[0].n),0)
 const functions=(await db.query("select p.oid::regprocedure::text signature,p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any($1::text[])",[[...reviewedFunctions]])).rows
 assert.equal(functions.length,reviewedFunctions.size)
 for(const f of functions){assert.equal(f.prosecdef,false);for(const role of ['anon','authenticated'])assert.equal((await db.query("select has_function_privilege($1,$2,'EXECUTE') allowed",[role,f.signature])).rows[0].allowed,false,f.signature)}
 assert.equal((await db.query("select relrowsecurity from pg_class where oid='pjsdas_scoped_management_consent_events'::regclass")).rows[0].relrowsecurity,true)
 for(const p of await tablePrivileges('pjsdas_scoped_management_consent_events'))assert.equal(p.allowed,p.role==='service_role'&&['SELECT','INSERT'].includes(p.permission),`scoped audit ${p.role} ${p.permission}`)
 await exec('set role service_role')
 // Consent bumps owner grant to revision 2. Use its current exact proof for old replay/new v2 write.
 await db.query('update pjsdas_business_management_grants set revoked_at=null where id=$1',[id(91)])
 const invokeV2=async(command,revision,operation='business_management',provenance={})=>(await db.query('select * from pjsdas_commit_management_workspace_v1($1,$2,$3,$4,$5,$6,4,$7,$8,$9,$10,null,$11,$12,$13)',[a,command,operation,'hash:'+command,revision,JSON.stringify(state(a)),'delegated_mcp',client,JSON.stringify(provenance),'{}','{}',id(91),Number((await db.query('select revision from pjsdas_business_management_grants where id=$1',[id(91)])).rows[0].revision)])).rows[0]
 assert.equal((await invokeV2('old-v2-command',0)).outcome,'ALREADY_APPLIED')
 assert.equal((await invokeV2('new-v2-command',1)).outcome,'COMMITTED')
 assert.equal((await invokeV2('undo-v2-command',2,'undo_command',{undoOf:'new-v2-command'})).outcome,'COMMITTED')
 const protectedRows=async()=>(await db.query("select jsonb_build_object('workspaces',(select jsonb_agg(to_jsonb(w) order by user_id) from pjsdas_workspaces w where user_id<>$1),'grants',(select jsonb_agg(to_jsonb(g) order by id) from pjsdas_business_management_grants g where user_id<>$1),'ledger',(select jsonb_agg(to_jsonb(l) order by command_id) from pjsdas_command_ledger l where user_id<>$1)) v",[a])).rows[0].v
 for(const [i,user] of [a,b].entries())await db.query("insert into pjsdas_business_management_grants(id,user_id,client_id,capability,consent_version,consent_text_hash) values($1,$2,$3,'workspace.business.manage',7,$4)",[id(101+i),user,client,'22626aea373e4e8eb51a90ee4b548c5f3aeeee4bbe58e77b418a0645138edb34'])
 const untouched=await protectedRows()
 // B cannot borrow A's grant (or vice versa), including matching command IDs.
 await assert.rejects(commit(b,'shared-command',0,id(101),true),e=>e.code==='42501')
 await assert.rejects(commit(a,'shared-command',3,id(102),true),e=>e.code==='42501')
 await assert.rejects(commit(c,'shared-command',0,id(101),true),e=>e.code==='42501')
 const prep={id:'managed:prep:shared-command:0',title:'A synthetic only',estimatedMinutes:30,createdAt:state(a).exportedAt,updatedAt:state(a).exportedAt},next=state(a);next.data.prep=[prep]
 const comp={operation:'business_management_restore',payload:{changes:[{type:'prep',id:prep.id,before:null,after:prep,beforeIndex:-1}]}}
 assert.equal((await commit(a,'shared-command',3,id(101),true,next,comp)).outcome,'COMMITTED')
 await assert.rejects(commit(b,'cross-undo',0,id(102),true,state(b),{},'undo_command',{undoOf:'shared-command'}),e=>e.code==='42501')
 assert.deepEqual(await protectedRows(),untouched)
 await db.query('update pjsdas_business_management_grants set revoked_at=now() where id=$1',[id(101)])
 await assert.rejects(commit(a,'after-revoke',4,id(101),true,next,comp),e=>e.code==='42501')
 assert.deepEqual(await protectedRows(),untouched)
 console.log(`PASS ${real?'PostgreSQL':'PGlite'}: eight complete migrations preserve every existing fixture row; v2 history/new write/undo; RLS/privileges; A/B cross-proof & cross-undo denial; A write/revoke leaves B/C workspace, grant and ledger unchanged.`)
}finally{if(real){await db.end();await admin.end();await rm(scratch,{recursive:true,force:true})}else await db.close()}
