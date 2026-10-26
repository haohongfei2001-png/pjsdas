/** Local schema/install guard only, NOT native product acceptance. */
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
import pg from 'pg'
import {install,checkpointMigration} from './gmail-empty-checkpoint-fixture.mjs'
import {migration} from './discovery-authority-fixture.mjs'
const target=new URL(process.env.TA_ROW_DATABASE_URL)
assert.equal(target.hostname,'127.0.0.1');assert.equal(target.port,'55636');assert.equal(target.pathname,'/postgres')
const name='ta_v2_install_'+randomUUID().replaceAll('-',''),url=new URL(target);url.pathname='/'+name
const admin=new pg.Client({connectionString:target.href}),db=new pg.Client({connectionString:url.href});let created=false
const files=['workspace-rows-stage-a.sql','workspace-rows-authoritative-stage-a.sql','workspace-rows-planning-stage-a.sql','workspace-rows-profile-stage-a.sql','workspace-rows-reminder-stage-a.sql','workspace-rows-opportunity-stage-a.sql','workspace-rows-business-stage-a.sql','workspace-rows-management-v2-stage-a.sql','workspace-rows-ai-capture-stage-a.sql','workspace-rows-discovery-stage-a.sql','workspace-rows-history-stage-a.sql','workspace-rows-bootstrap-stage-a.sql','workspace-rows-public-transport-stage-a.sql','workspace-rows-layout-fence-stage-a.sql','workspace-rows-large-command-prototype.sql','workspace-rows-staged-opportunity-prototype.sql','workspace-rows-staged-documents-prototype.sql','workspace-rows-durable-intent-prototype.sql','workspace-rows-audit-bytes-prototype.sql','workspace-rows-resource-reservations.sql','workspace-rows-resource-rpc.sql','workspace-rows-durable-attempts-v2.sql']
try{
 await admin.connect();
 for(const role of ['anon','authenticated','service_role'])if(!(await admin.query('select 1 from pg_roles where rolname=$1',[role])).rowCount)await admin.query('create role '+role+(role==='service_role'?' bypassrls':''));
 await admin.query('create database '+name);created=true
 await db.connect();await db.query("set statement_timeout='10s'")
 await install(db);await db.query(await migration(checkpointMigration))
 for(const file of files){await db.query(readFileSync(new URL('./candidates/'+file,import.meta.url),'utf8'));console.log('INSTALLED',file)}
 assert.equal((await db.query("select count(*)::int n from pjsdas_rows_candidate.large_command_attempt")).rows[0].n,0)
 for(const role of ['anon','authenticated'])assert.equal((await db.query("select has_function_privilege($1,'public.pjsdas_rows_v1_large_v2_intent_cancel(jsonb,uuid)','EXECUTE') ok",[role])).rows[0].ok,false)
 assert.equal((await db.query("select has_table_privilege('service_role','pjsdas_rows_candidate.large_command_intent','UPDATE') ok")).rows[0].ok,false)
 console.log('PASS_V2_INSTALL empty default-off overlay; original immutable intent UPDATE denied; client cancellation EXECUTE denied')
}finally{await db.end().catch(()=>{});if(created)await admin.query('drop database '+name+' with(force)');await admin.end().catch(()=>{});console.log('CLEANUP v2 schema fixture database removed')}
