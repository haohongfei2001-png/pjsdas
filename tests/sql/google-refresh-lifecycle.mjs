// Isolated in-memory PostgreSQL only. All identities/tokens/ciphertexts are fictional.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import pg from 'pg'
const real = process.argv.includes('--postgres')
let db, admin, worker
if (real) {
 const url = new URL(process.env.TA_MANAGEMENT_SQL_TEST_URL ?? 'http://missing.invalid')
 if(url.protocol!=='postgresql:'||!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!=='/ta_management_fixture'||url.username!=='postgres'||url.password!=='fixture-only'||url.search) throw Error('Only isolated CI loopback fixture accepted')
 admin = new pg.Client({connectionString:url.toString(),statement_timeout:15000}); await admin.connect()
 await admin.query('create database ta_google_refresh_fixture')
 url.pathname='/ta_google_refresh_fixture'
 db = new pg.Client({connectionString:url.toString(),statement_timeout:15000}); await db.connect()
 worker = new pg.Client({connectionString:url.toString(),application_name:'ta-google-worker',statement_timeout:15000}); await worker.connect()
} else db = new PGlite()
const exec = sql => real ? db.query(sql) : db.exec(sql)
const user = '00000000-0000-4000-8000-000000000001'
const migration = await readFile(new URL('../../supabase/migrations/20261005211006_google_refresh_lifecycle.sql', import.meta.url), 'utf8')
try {
 if (!real) await exec('create role anon; create role authenticated; create role service_role;')
 await exec(`
 create schema vault; create table vault.decrypted_secrets(name text,decrypted_secret text);
 create view vault.secrets as select name from vault.decrypted_secrets;
 insert into vault.decrypted_secrets values ('pjsdas_gmail_automation_worker_token','fictional-gmail'),('pjsdas_discovery_automation_worker_token','fictional-discovery');
 create table public.google_drive_connections (user_id uuid primary key,google_subject text,google_email text,
   refresh_token_ciphertext text,granted_scopes text[],revoked_at timestamptz,updated_at timestamptz default now());
 `)
 // Apply the actual ordered binding-domain migrations. Only pg_cron/pg_net
 // installation and the final scheduler-only block are excluded from this local
 // in-memory fixture: neither affects binding tables, functions, ACLs or triggers.
 const chain = [
  '2026091501_gmail_automation_worker.sql','2026091502_discovery_automation_worker.sql',
  '2026091503_tighten_discovery_worker_rpc_grants.sql','2026091504_discovery_automation_opt_in.sql',
  '2026091902_gmail_complete_consumption.sql','2026091904_activate_automation_scheduler.sql','20260921040454_gmail_uu06_explicit_consent.sql',
  '20260921045732_gmail_execution_controls.sql','20260921114500_gmail_push_watch_state.sql',
  '20260925131500_gmail_failure_telemetry.sql','20260926180000_gmail_reconciliation_continuation.sql',
 ]
 for (const name of chain) {
   let sql = await readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8')
   if(name==='2026091904_activate_automation_scheduler.sql') sql=sql.slice(sql.indexOf('-- Gmail v1 scheduler RPCs'),sql.indexOf('do $$\ndeclare'))
   sql=sql.replace(/^create extension if not exists pg_(cron|net)( with schema extensions)?;$/gm,'')
   if(name==='20260926180000_gmail_reconciliation_continuation.sql') sql=sql.slice(0,sql.indexOf('do $migration$'))
   await exec(sql)
 }
 await exec(migration)
 assert.deepEqual((await db.query("select tgname from pg_trigger where tgrelid='google_drive_connections'::regclass and not tgisinternal order by tgname")).rows.map(x=>x.tgname),
   ['pjsdas_guard_gmail_intake_consent','pjsdas_invalidate_gmail_execution','pjsdas_reset_changed_google_subject'])
 await db.query(`insert into google_drive_connections(user_id,google_subject,refresh_token_ciphertext,gmail_history_id,gmail_sync_mode,gmail_page_token,gmail_pending_history_id,gmail_pending_message_ids,gmail_intake_consent_version,gmail_last_success_at,gmail_automation_enabled,granted_scopes)
 values ($1,'fictional-subject','v1.initial','durable','history','page','pending-history','{pending-message}','uu06-v1','2026-10-04T12:30:00Z',true,'{https://www.googleapis.com/auth/gmail.readonly}')`,[user])
 await db.query(`insert into gmail_automation_execution_state(user_id,lease_token,lease_expires_at,gmail_reconciliation_requested_at,gmail_reconciliation_state)
 values ($1,$1,now()+interval '1 hour',now(),' {"fictional":"pending"}')`,[user])
 const row=async()=> (await db.query('select * from google_drive_connections')).rows[0]
 const state=async()=> (await db.query('select * from gmail_automation_execution_state')).rows[0]
 const update=async(token,expected,next=null,reconnect=false)=>(await db.query('select pjsdas_update_google_refresh_state($1,$2,$3,$4,$5) updated',[token,user,expected,next,reconnect])).rows[0].updated
 assert.equal((await db.query("select has_function_privilege('authenticated','pjsdas_update_google_refresh_state(text,uuid,text,text,boolean,uuid)','execute') allowed")).rows[0].allowed,false)
 assert.equal((await db.query("select has_function_privilege('anon','pjsdas_update_google_refresh_state(text,uuid,text,text,boolean,uuid)','execute') allowed")).rows[0].allowed,true)
 await assert.rejects(()=>update('wrong','v1.initial','v1.bad'),/Invalid automation worker authorization/)
 assert.equal(await update('fictional-discovery','v1.initial','v1.bad'),false,'disabled worker cannot mutate another worker scope')
 assert.equal(await update('fictional-gmail','v1.initial','v1.rotated'),true)
 assert.equal((await row()).gmail_history_id,'durable');assert.deepEqual((await row()).gmail_pending_message_ids,['pending-message'])
 assert.equal((await state()).lease_token,null,'rotation invalidates old execution')
 assert.deepEqual((await state()).gmail_reconciliation_state,{fictional:'pending'},'rotation preserves same-account catch-up')
 assert.equal(await update('fictional-gmail','v1.initial',null,true),false,'late invalid_grant cannot expire rotated generation')
 assert.equal(await update('fictional-gmail','v1.initial','v1.stale'),false,'late rotation cannot overwrite newer generation')
 assert.equal(await update('fictional-gmail','v1.rotated',null,true),true)
 assert.equal((await row()).gmail_last_error,'GOOGLE_AUTH_EXPIRED: Reconnect Google to resume.')
 assert.equal((await db.query("select * from pjsdas_claim_gmail_automation_bindings_v5('fictional-gmail')")).rows.length,0,'invalid grant suppresses repeated refresh')
 assert.equal((await row()).gmail_last_success_at.toISOString(),'2026-10-04T12:30:00.000Z')
 // A late same-ciphertext success must never erase sticky revocation.
 for (const operation of ['pjsdas_update_gmail_automation_state_v2','pjsdas_update_gmail_watch_state']) {
  assert.equal((await db.query("select pjsdas_update_google_automation_state('fictional-gmail',$1,'v1.rotated',$2,'{\"set_last_error\":true}') updated",[user,operation])).rows[0].updated,false)
 }
 await db.query('update google_drive_connections set discovery_automation_enabled=true where user_id=$1',[user])
 assert.equal((await db.query("select pjsdas_update_google_automation_state('fictional-discovery',$1,'v1.rotated','pjsdas_update_discovery_automation_state','{\"set_last_error\":true}') updated",[user])).rows[0].updated,false)
 assert.equal((await row()).gmail_intake_consent_version,'uu06-v1','invalid_grant does not erase separately gated app consent')
 assert.deepEqual((await row()).gmail_pending_message_ids,['pending-message'])
 assert.deepEqual((await state()).gmail_reconciliation_state,{fictional:'pending'})
 // Reconnect writes a fresh encrypted generation and clears the marker, with the same subject.
 await db.query("update google_drive_connections set refresh_token_ciphertext='v1.reconnected',gmail_last_error=null,discovery_last_error=null where user_id=$1",[user])
 assert.equal((await row()).gmail_history_id,'durable');assert.equal((await row()).gmail_page_token,'page')
 assert.deepEqual((await state()).gmail_reconciliation_state,{fictional:'pending'})
 assert.equal((await db.query("select * from pjsdas_claim_gmail_automation_bindings_v5('fictional-gmail')")).rows.length,1)
 for (const operation of ['pjsdas_update_gmail_automation_state_v2','pjsdas_update_gmail_watch_state']) {
  assert.equal((await db.query("select pjsdas_update_google_automation_state('fictional-gmail',$1,'v1.rotated',$2,'{\"set_last_error\":true,\"last_error\":\"GOOGLE_AUTH_EXPIRED\"}') updated",[user,operation])).rows[0].updated,false)
 }
 assert.equal((await db.query("select pjsdas_update_google_automation_state('fictional-discovery',$1,'v1.rotated','pjsdas_update_discovery_automation_state','{\"set_last_error\":true}') updated",[user])).rows[0].updated,false)
 assert.equal((await db.query("select pjsdas_update_google_automation_state('fictional-discovery',$1,'v1.reconnected','pjsdas_update_discovery_automation_state','{\"set_last_error\":true}') updated",[user])).rows[0].updated,true)
 // Owner-controlled rotation keeps only its existing lease, never extends it,
 // and can complete the same run. No indefinite rotate/restart loop.
 await db.query('update gmail_automation_execution_state set lease_token=$1,lease_expires_at=now()+interval \'1 hour\',binding_updated_at=(select updated_at from google_drive_connections),started_at=now()',[user])
 const expiry=(await state()).lease_expires_at.toISOString()
 assert.equal((await db.query("select pjsdas_update_google_refresh_state('fictional-gmail',$1,'v1.reconnected','v1.wrong-owner',false,'00000000-0000-4000-8000-000000000099') updated",[user])).rows[0].updated,false)
 await db.query("update gmail_automation_execution_state set lease_expires_at=now()-interval '1 second'")
 assert.equal((await db.query("select pjsdas_update_google_refresh_state('fictional-gmail',$1,'v1.reconnected','v1.expired',false,$1) updated",[user])).rows[0].updated,false)
 await db.query('update gmail_automation_execution_state set lease_expires_at=$1',[expiry])

 assert.equal((await db.query("select pjsdas_update_google_refresh_state('fictional-gmail',$1,'v1.reconnected','v1.owned',false,$1) updated",[user])).rows[0].updated,true)
 assert.equal((await state()).lease_expires_at.toISOString(),expiry)
 assert.equal((await db.query("select pjsdas_assert_gmail_execution('fictional-gmail',$1,$1) valid",[user])).rows[0].valid,true)
 assert.equal((await db.query("select pjsdas_finish_gmail_execution('fictional-gmail',$1,$1,'{}','{\"status\":\"completed\",\"mode\":\"history\"}') finished",[user])).rows[0].finished,true)
 assert.equal((await row()).gmail_history_id,'durable')
 assert.deepEqual((await row()).gmail_pending_message_ids,['pending-message'])
 await db.query("update google_drive_connections set gmail_last_error='GOOGLE_DRIVE_UNAVAILABLE: transient' where user_id=$1",[user])
 assert.equal((await db.query("select * from pjsdas_claim_gmail_automation_bindings_v5('fictional-gmail')")).rows.length,1,'transient failures remain eligible')
 await db.query("update google_drive_connections set granted_scopes='{scope-b,scope-a,https://www.googleapis.com/auth/gmail.readonly}' where user_id=$1",[user])
 await db.query("update gmail_automation_execution_state set gmail_reconciliation_state='{\"fictional\":\"reordered\"}' where user_id=$1",[user])
 await db.query("update google_drive_connections set granted_scopes='{scope-a,scope-b,scope-a,https://www.googleapis.com/auth/gmail.readonly}',refresh_token_ciphertext='v1.reordered' where user_id=$1",[user])
 assert.deepEqual((await state()).gmail_reconciliation_state,{fictional:'reordered'},'equivalent scope sets preserve catch-up')
 for(const error of ['GOOGLE_AUTH_EXPIRED','GOOGLE_AUTH_EXPIRED [profile] HTTP 401','GOOGLE_AUTH_EXPIRED: reconnect']) {
   await db.query('update google_drive_connections set gmail_last_error=$1',[error])
   assert.equal((await db.query("select * from pjsdas_claim_gmail_automation_bindings_v5('fictional-gmail')")).rows.length,0)
 }
 for(const error of ['GOOGLE_AUTH_EXPIRED_NOT','GOOGLE_ACCESS_REJECTED','GOOGLE_AUTH_CONFIG_INVALID']) {
   await db.query('update google_drive_connections set gmail_last_error=$1',[error])
   assert.equal((await db.query("select * from pjsdas_claim_gmail_automation_bindings_v5('fictional-gmail')")).rows.length,1)
 }
 // Actual finalizer persists a configuration diagnostic without advancing success.
 await db.query('update gmail_automation_execution_state set lease_token=$1,lease_expires_at=now()+interval \'1 hour\',binding_updated_at=(select updated_at from google_drive_connections),started_at=now()',[user])
 assert.equal((await db.query("select pjsdas_finish_gmail_execution('fictional-gmail',$1,$1,'{}','{\"status\":\"error\",\"errorCode\":\"GOOGLE_AUTH_CONFIG_INVALID\"}') finished",[user])).rows[0].finished,true)
 assert.equal((await row()).gmail_last_error,'GOOGLE_AUTH_CONFIG_INVALID')
 assert.equal((await row()).gmail_last_success_at.toISOString(),'2026-10-04T12:30:00.000Z')
 await db.query("update google_drive_connections set google_subject='different-subject',refresh_token_ciphertext='v1.different' where user_id=$1",[user])
 const changed=await row();assert.equal(changed.gmail_history_id,null);assert.equal(changed.gmail_page_token,null);assert.deepEqual(changed.gmail_pending_message_ids,[])
 assert.equal(changed.gmail_automation_enabled,false);assert.equal(changed.gmail_intake_consent_version,null);assert.equal(changed.gmail_last_success_at,null)
 assert.equal((await state()).gmail_reconciliation_state,null,'different mailbox cannot inherit reconciliation')
 assert.equal(await update('fictional-gmail','v1.reconnected',null,true),false)
 // All original fail-closed consent transitions still apply under every guard.
 for (const change of ["gmail_automation_enabled=false", "revoked_at=now()", "granted_scopes='{}'", "gmail_intake_consent_version=null"]) {
  await db.query("update google_drive_connections set revoked_at=null,granted_scopes='{https://www.googleapis.com/auth/gmail.readonly}',gmail_automation_enabled=true,gmail_intake_consent_version='uu06-v1',gmail_sync_mode='history',gmail_page_token='page',gmail_pending_history_id='pending-history',gmail_pending_message_ids='{pending-message}',gmail_last_error=null where user_id=$1",[user])
  await db.query(`update google_drive_connections set ${change} where user_id=$1`,[user])
  assert.equal((await row()).gmail_intake_consent_version,null)
  assert.equal((await row()).gmail_page_token,null)
  assert.deepEqual((await row()).gmail_pending_message_ids,[])
 }
 if (real) {
  await worker.query('set role anon')
  const waitLocked = async () => {
   const deadline=Date.now()+10000
   while(Date.now()<deadline) {
    if((await db.query("select 1 from pg_stat_activity where application_name='ta-google-worker' and wait_event_type='Lock'")).rows.length) return
    await new Promise(resolve=>setTimeout(resolve,20))
   }
   throw Error('Synthetic worker did not reach row-lock boundary')
  }
  for (const mode of ['late-revocation','late-success','sticky-revocation']) {
   await db.query("update google_drive_connections set revoked_at=null,granted_scopes='{https://www.googleapis.com/auth/gmail.readonly}',gmail_automation_enabled=true,discovery_automation_enabled=true,gmail_intake_consent_version='uu06-v1',gmail_last_error=null,discovery_last_error=null,refresh_token_ciphertext='v1.race' where user_id=$1",[user])
   await db.query('begin')
   if(mode==='sticky-revocation') await db.query("update google_drive_connections set gmail_last_error='GOOGLE_AUTH_EXPIRED' where user_id=$1",[user])
   else await db.query("update google_drive_connections set refresh_token_ciphertext='v1.newer-reconnect' where user_id=$1",[user])
   const pending=mode==='late-revocation'
    ? worker.query("select pjsdas_update_google_refresh_state('fictional-gmail',$1,'v1.race',null,true) updated",[user])
    : worker.query("select pjsdas_update_google_automation_state('fictional-discovery',$1,'v1.race','pjsdas_update_discovery_automation_state','{\"set_last_error\":true}') updated",[user])
   await waitLocked(); await db.query('commit')
   assert.equal((await pending).rows[0].updated,false,mode+' must lose the generation/blocked-state race')
  }
  console.log('PASS real multi-session Google refresh/finalization/reconnect row-lock races.')
 }
 console.log('PASS Google refresh CAS, scope/ACL, stale rotation/revocation, lease invalidation, same-subject catch-up, suppression, and atomic subject reset (synthetic PGlite).')
} finally {
 if(real) { await db.query('rollback'); await worker.end(); await db.end(); await admin.query('drop database ta_google_refresh_fixture'); await admin.end() }
 else await db.close()
}
