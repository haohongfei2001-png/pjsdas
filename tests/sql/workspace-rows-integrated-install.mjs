/** Atomic two-file resource installation REHEARSAL on an empty synthetic scope.
 * Never a production migration: existing original functions are installed by
 * fixture prerequisites, and rpc.sql dynamically patches their catalog bodies.
 */
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
import pg from 'pg'
import {install,checkpointMigration} from './gmail-empty-checkpoint-fixture.mjs'
import {migration} from './discovery-authority-fixture.mjs'

const target=new URL(process.env.TA_ROW_DATABASE_URL)
assert.equal(target.hostname,'127.0.0.1');assert.equal(target.port,'55634');assert.equal(target.pathname,'/postgres')
const name='ta_integrated_install_'+randomUUID().replaceAll('-',''),url=new URL(target);url.pathname='/'+name
const admin=new pg.Client({connectionString:target.href}),db=new pg.Client({connectionString:url.href}),observer=new pg.Client({connectionString:url.href})
const originalFiles=['workspace-rows-stage-a.sql','workspace-rows-authoritative-stage-a.sql','workspace-rows-planning-stage-a.sql','workspace-rows-profile-stage-a.sql','workspace-rows-reminder-stage-a.sql','workspace-rows-opportunity-stage-a.sql','workspace-rows-business-stage-a.sql','workspace-rows-management-v2-stage-a.sql','workspace-rows-ai-capture-stage-a.sql','workspace-rows-discovery-stage-a.sql','workspace-rows-history-stage-a.sql','workspace-rows-bootstrap-stage-a.sql','workspace-rows-public-transport-stage-a.sql','workspace-rows-layout-fence-stage-a.sql','workspace-rows-large-command-prototype.sql','workspace-rows-staged-opportunity-prototype.sql','workspace-rows-staged-documents-prototype.sql','workspace-rows-durable-intent-prototype.sql','workspace-rows-audit-bytes-prototype.sql']
const resourceFiles=['workspace-rows-resource-reservations.sql','workspace-rows-resource-rpc.sql']
const sql=file=>readFileSync(new URL('./candidates/'+file,import.meta.url),'utf8')
const catalog=async client=>(await client.query(`select p.oid::regprocedure::text signature,p.prosrc,p.proacl::text acl,p.proowner::regrole::text owner,p.prosecdef,p.proconfig
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in ('public','pjsdas_rows_candidate','pjsdas_rows_internal') order by 1`)).rows
let created=false
try{
 await admin.connect();await admin.query('create database '+name);created=true
 await db.connect();await observer.connect();await db.query("set statement_timeout='10s'")
 await install(db);await db.query(await migration(checkpointMigration))
 for(const file of originalFiles)await db.query(sql(file))
 const before=await catalog(db)
 // A late failure must restore BOTH the sidecar schema and every original
 // function body/ACL. No temporary successful first half may escape.
 await db.query('begin')
 for(const file of resourceFiles)await db.query(sql(file))
 assert.equal((await observer.query("select to_regnamespace('ta_resource_reservations')::text n")).rows[0].n,null)
 assert.deepEqual(await catalog(observer),before,'another connection cannot see uncommitted patches')
 await assert.rejects(db.query('select 1/0'),error=>error.code==='22012')
 await db.query('rollback')
 assert.equal((await db.query("select to_regnamespace('ta_resource_reservations')::text n")).rows[0].n,null)
 assert.deepEqual(await catalog(db),before,'rollback restores full original function preimages and ACL')
 console.log('PASS_INTEGRATED_INSTALL late failure rolls back both resource files and all patched originals')
 await db.query('begin')
 for(const file of resourceFiles)await db.query(sql(file))
 const after=await catalog(db)
 assert.deepEqual(after.map(({prosrc,...metadata})=>metadata),before.map(({prosrc,...metadata})=>metadata),'same function signatures, owner, ACL, INVOKER status and search paths')
 assert.deepEqual(after.filter(x=>x.signature.startsWith('pjsdas_rows_v1_')||x.signature.startsWith('public.')),before.filter(x=>x.signature.startsWith('pjsdas_rows_v1_')||x.signature.startsWith('public.')),'no public RPC definition changed')
 assert.deepEqual(await catalog(observer),before)
 assert.equal((await db.query('select count(*)::int n from ta_resource_reservations.pool')).rows[0].n,0)
 assert.equal((await db.query('select count(*)::int n from ta_resource_reservations.rpc_scope')).rows[0].n,0)
 assert.equal((await db.query("select count(*)::int n from pg_proc where pronamespace='ta_resource_reservations'::regnamespace and prosecdef")).rows[0].n,0)
 assert.equal((await db.query("select to_regprocedure('ta_resource_reservations.rpc_patch(text,text,text)')::text n")).rows[0].n,null)
 // This is a structural lock-order guard, not a replacement for real races.
 const body=signature=>after.find(x=>x.signature===signature)?.prosrc
 for(const signature of ['pjsdas_rows_candidate.large_intent_read(jsonb,uuid)','pjsdas_rows_candidate.large_intent_admit(jsonb,jsonb,jsonb,bigint,uuid)']){
  const text=body(signature);assert(text,signature)
  const grant=text.indexOf('authorize_intent('),resource=text.indexOf('rpc_lock('),head=text.indexOf('select * into h from pjsdas_rows_candidate.head')
  assert(grant>=0&&resource>grant&&head>resource,signature+' grant -> resource -> head')
 }
 const history=body('pjsdas_rows_candidate.read_history(uuid,uuid,bigint,jsonb)')
 const historyResource=history.indexOf('rpc_history_lock('),historyHead=history.indexOf('select * into h from pjsdas_rows_candidate.head')
 assert(historyResource>=0&&historyHead>historyResource,'history resource hook must exist before head access')
 await db.query('commit')
 assert.deepEqual(await catalog(observer),after)
 console.log('PASS_INTEGRATED_INSTALL atomic commit visible together; default-off empty policy/scope; public/owner/ACL/invoker and read-before-write order preserved')
 console.log('INTEGRATED_INSTALL_PASS',JSON.stringify({fixtureOnly:true,productionMigration:false,originalSqlFiles:originalFiles.length,resourceSqlFiles:resourceFiles.length}))
}finally{
 await db.query('rollback').catch(()=>{});await observer.end().catch(()=>{});await db.end().catch(()=>{})
 if(created)await admin.query('drop database '+name+' with(force)')
 await admin.end().catch(()=>{})
 console.log('CLEANUP integrated atomic install fixture database removed')
}
