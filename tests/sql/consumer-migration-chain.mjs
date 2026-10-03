// Whole-chain preservation proof. PGlite by default; --postgres accepts ONLY the CI loopback fixture.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import pg from 'pg'
const real=process.argv.includes('--postgres')
let db, admin
if(real){
 const url=new URL(process.env.TA_MANAGEMENT_SQL_TEST_URL??'http://missing.invalid')
 if(url.protocol!=='postgresql:'||!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!=='/ta_management_fixture'||url.username!=='postgres'||url.password!=='fixture-only'||url.search)throw Error('Only isolated CI fixture accepted')
 admin=new pg.Client({connectionString:url.toString()});await admin.connect()
 await admin.query('create database ta_chain_fixture');url.pathname='/ta_chain_fixture'
 db=new pg.Client({connectionString:url.toString(),statement_timeout:15000});await db.connect()
}else db=new PGlite()
const exec=sql=>real?db.query(sql):db.exec(sql), sql=async name=>readFile(new URL(`../../supabase/migrations/${name}`,import.meta.url),'utf8')
const manifest=JSON.parse(await readFile(new URL('../../docs/consumer-management/pending-migration-checksums.json',import.meta.url),'utf8'))
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const [a,b,c,client]=[81,82,83,84].map(id)
const state=who=>({schema:'pjsdas-local-snapshot',version:4,exportedAt:'2026-10-03T00:00:00Z',future:{who,raw:['second','first']},data:{opportunities:[],processes:[],processEvents:[],actions:[],prep:[],applicationGroups:[],scheduleNodes:[],decisionRequests:[],semanticReceipts:[],reminderIntents:[],reminderOutbox:[],unknown:{who,legacy:'preserve'}}})
const tables=['pjsdas_access_grants','pjsdas_business_management_grants','pjsdas_workspaces','pjsdas_command_ledger','pjsdas_management_consent_events']
const allRows=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>[table,(await db.query(`select to_jsonb(t)::text v from public.${table} t order by to_jsonb(t)::text`)).rows])))
const commit=async(user,command,revision,grant=id(91),v7=false,next=state(user),comp={},operation='business_management',provenance={})=>(await db.query(`select * from public.${v7?'pjsdas_commit_consumer_business_workspace_v1':'pjsdas_commit_management_workspace_v1'}($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[user,command,operation,'hash:'+command,revision,JSON.stringify(next),4,'delegated_mcp',client,JSON.stringify(provenance),JSON.stringify(comp),null,'{}',grant,1])).rows[0]
try{
 if(!real)await exec('create role anon;create role authenticated;create role service_role bypassrls;')
 // Roles already exist in the parent CI fixture, while this database is new.
 await exec('create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;')
 for(const file of ['2026091901_ai_operated_mutation_foundation.sql','2026091903_controlled_audience.sql','20260923030000_cgr01_authoritative_commands.sql','20261002123812_consumer_management_atomic_grants.sql','20261002143625_owner_management_consent_audit.sql'])await exec(await sql(file))
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
 for(const entry of manifest.migrations){
  const text=await sql(entry.file);for(const match of text.matchAll(/create (?:or replace )?function public\.(\w+)/g))reviewedFunctions.add(match[1]);assert.equal(createHash('sha256').update(text).digest('hex'),entry.sha256)
  await exec('begin');try{await exec("set local lock_timeout='2s';set local statement_timeout='15s'");await exec(text);await exec('commit')}catch(e){await exec('rollback');throw e}
  assert.deepEqual(await allRows(),before,`${entry.file} must not rewrite existing rows`)
  console.log('PASS whole-chain unchanged rows + SHA256:',entry.file)
 }
 assert.equal(Number((await db.query('select count(*) n from pjsdas_scoped_management_consent_events')).rows[0].n),0)
 const functions=(await db.query("select p.oid::regprocedure::text signature,p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any($1::text[])",[[...reviewedFunctions]])).rows
 assert.equal(functions.length,reviewedFunctions.size)
 for(const f of functions){assert.equal(f.prosecdef,false);for(const role of ['anon','authenticated'])assert.equal((await db.query("select has_function_privilege($1,$2,'EXECUTE') allowed",[role,f.signature])).rows[0].allowed,false,f.signature)}
 assert.equal((await db.query("select relrowsecurity from pg_class where oid='pjsdas_scoped_management_consent_events'::regclass")).rows[0].relrowsecurity,true)
 for(const role of ['anon','authenticated'])for(const permission of ['SELECT','INSERT','UPDATE','DELETE'])assert.equal((await db.query("select has_table_privilege($1,'pjsdas_scoped_management_consent_events',$2) allowed",[role,permission])).rows[0].allowed,false)
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
}finally{if(real){await db.end();await admin.end()}else await db.close()}
