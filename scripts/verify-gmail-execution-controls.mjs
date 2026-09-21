// Run with pinned PGlite 0.3.14 in an isolated tool environment. No production DB.
const { PGlite } = await import(process.env.PJSDAS_PGLITE_MODULE ?? '@electric-sql/pglite')
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
const db = new PGlite()
await db.exec(`create role anon; create role authenticated; create role service_role;
create schema vault;
create table vault.decrypted_secrets(name text, decrypted_secret text);
insert into vault.decrypted_secrets values ('pjsdas_gmail_automation_worker_token', 'synthetic-worker');
create table public.google_drive_connections (
 user_id uuid primary key, google_subject text, google_email text, refresh_token_ciphertext text,
 granted_scopes text[], gmail_automation_enabled boolean, gmail_history_id text,
 gmail_last_checked_at timestamptz,gmail_last_success_at timestamptz, gmail_sync_mode text, gmail_page_token text,
 gmail_pending_history_id text, gmail_pending_message_ids text[], revoked_at timestamptz,
 gmail_last_error text, updated_at timestamptz default now()
);
insert into public.google_drive_connections(user_id,google_subject,refresh_token_ciphertext,granted_scopes,gmail_automation_enabled,gmail_history_id)
 values ('00000000-0000-0000-0000-000000000001','synthetic','ciphertext',ARRAY['https://www.googleapis.com/auth/gmail.readonly'],true,'old-cursor');`)
await db.exec(await readFile('supabase/migrations/20260921040454_gmail_uu06_explicit_consent.sql','utf8'))

// Model the live pre-deployment ACL, which is stricter than the old repository
// migration: v1 remains owner/service_role only. Do not apply cron/Vault setup.
const v1Signature = 'public.pjsdas_update_gmail_automation_state(text,uuid,text,timestamptz,timestamptz,text,boolean,boolean)'
const originalWorker = await readFile('supabase/migrations/2026091501_gmail_automation_worker.sql','utf8')
await db.exec(originalWorker.slice(originalWorker.indexOf('create or replace function public.pjsdas_update_gmail_automation_state(')))
await db.exec(`revoke all on function ${v1Signature} from public,anon,authenticated;
grant execute on function ${v1Signature} to service_role;`)
const assertV1Restricted = async () => {
  const acl = (await db.query(`select
    has_function_privilege('anon',$1,'EXECUTE') as anon,
    has_function_privilege('authenticated',$1,'EXECUTE') as authenticated,
    has_function_privilege('service_role',$1,'EXECUTE') as service_role,
    exists(select 1 from pg_proc p, lateral aclexplode(p.proacl) acl
      where p.oid=$1::regprocedure and acl.grantee=0 and acl.privilege_type='EXECUTE') as public`, [v1Signature])).rows[0]
  assert.deepEqual(acl, {anon:false,authenticated:false,service_role:true,public:false})
}
await assertV1Restricted()
await db.exec(await readFile('supabase/migrations/20260921045732_gmail_execution_controls.sql','utf8'))
await assertV1Restricted()
const v2Acl = (await db.query(`select
  has_function_privilege('anon','public.pjsdas_update_gmail_automation_state_v2(text,uuid,text,text,text,text,text[],timestamptz,timestamptz,text,boolean,boolean,boolean,boolean)','EXECUTE') as anon,
  has_function_privilege('authenticated','public.pjsdas_update_gmail_automation_state_v2(text,uuid,text,text,text,text,text[],timestamptz,timestamptz,text,boolean,boolean,boolean,boolean)','EXECUTE') as authenticated`)).rows[0]
assert.deepEqual(v2Acl, {anon:true,authenticated:false})
const user = '00000000-0000-0000-0000-000000000001'
const a = '00000000-0000-0000-0000-000000000002'
const b = '00000000-0000-0000-0000-000000000003'
const begin = (token,lease) => db.query('select pjsdas_begin_gmail_execution($1,$2,$3,60) as result',[token,user,lease])
const finish = (lease,patch,metrics) => db.query('select pjsdas_finish_gmail_execution($1,$2,$3,$4,$5) as result',['synthetic-worker',user,lease,patch,metrics])
const row = async () => (await db.query('select * from google_drive_connections')).rows[0]
await assert.rejects(begin('',a), /Invalid PJSDAS/)
await assert.rejects(begin('wrong',a), /Invalid PJSDAS/)
await assert.rejects(db.query('select pjsdas_assert_gmail_execution($1,$2,$3)',['',user,a]), /Invalid PJSDAS/)
await assert.rejects(db.query('select pjsdas_finish_gmail_execution($1,$2,$3,$4,$5)',['wrong',user,a,{},{}]), /Invalid PJSDAS/)
await assert.rejects(db.query('select pjsdas_begin_gmail_execution($1,$2,$3,null)',['synthetic-worker',user,a]), /Invalid execution/)
await db.query('select pjsdas_update_gmail_automation_state_v2($1,$2)',['synthetic-worker',user])
await db.exec('set role service_role')
await db.query('select pjsdas_update_gmail_automation_state($1,$2)',['synthetic-worker',user])
await db.exec('reset role')
for (const role of ['anon','authenticated']) {
  await db.exec(`set role ${role}`)
  await assert.rejects(db.query('select pjsdas_update_gmail_automation_state($1,$2)',['synthetic-worker',user]), /permission denied for function/)
  await db.exec('reset role')
}
await db.exec('set role anon')
await assert.rejects(db.query('select * from gmail_automation_execution_state'), /permission denied/)
await db.exec('reset role')
assert.equal((await db.query('select count(*)::integer as count from gmail_automation_execution_state')).rows[0].count,0)
const claimed = (await begin('synthetic-worker',a)).rows[0].result
assert.equal(claimed.gmail_history_id,'old-cursor')
assert.equal((await begin('synthetic-worker',b)).rows[0].result,null)
await assert.rejects(db.query('select pjsdas_update_gmail_automation_state_v2($1,$2)', ['synthetic-worker',user]), /controlled Gmail/)
await db.exec("update gmail_automation_execution_state set lease_expires_at=now()-interval '1 second'")
await assert.rejects(db.query('select pjsdas_update_gmail_automation_state_v2($1,$2,next_history_id=>$3,set_history_id=>true)', ['synthetic-worker',user,'EXPIRED-LATE']), /controlled Gmail/)
assert.ok((await begin('synthetic-worker',b)).rows[0].result)
assert.equal((await finish(a,{historyId:'stale'},{status:'completed',mode:'history'})).rows[0].result,false)
assert.equal((await row()).gmail_history_id,'old-cursor')
assert.equal((await finish(b,{historyId:'900',continuation:null,successAt:'ignored'}, {status:'completed',mode:'history',receivedCount:2,accountedCount:2,historyLag:{count:2,sumMs:200000,maxMs:150000,under2m:1,under15m:1,over15m:0},body:'PRIVATE MUST NOT STORE',address:'private@example.invalid'})).rows[0].result,true)
assert.equal((await row()).gmail_history_id,'900')
await assert.rejects(db.query('select pjsdas_update_gmail_automation_state_v2($1,$2,next_history_id=>$3,set_history_id=>true)', ['synthetic-worker',user,'LATE']), /controlled Gmail/)
assert.equal((await row()).gmail_history_id,'900')
await db.exec('set role service_role')
await assert.rejects(db.query('select pjsdas_update_gmail_automation_state($1,$2,next_history_id=>$3,set_history_id=>true)', ['synthetic-worker',user,'V1-LATE']), /controlled Gmail/)
await db.exec('reset role')
assert.equal((await row()).gmail_history_id,'900')
const metrics = (await db.query('select last_metrics,coalesced_runs from gmail_automation_execution_state')).rows[0]
assert.equal(metrics.coalesced_runs,1)
assert.equal(JSON.stringify(metrics).includes('PRIVATE'),false)
assert.equal(JSON.stringify(metrics).includes('private@example'),false)
assert.equal(metrics.last_metrics.historyLag.count,2)
assert.equal((await finish(b,{historyId:'REPLAY'},{status:'completed',mode:'history'})).rows[0].result,false)
assert.ok((await begin('synthetic-worker',a)).rows[0].result)
assert.equal((await finish(a,{historyId:'MUST_NOT_ADVANCE'}, {status:'error',mode:'history_recovery',errorCode:'BUDGET_EXHAUSTED',historyLag:{count:5}})).rows[0].result,true)
assert.equal((await row()).gmail_history_id,'900')
assert.equal((await db.query('select last_metrics from gmail_automation_execution_state')).rows[0].last_metrics.historyLag,undefined)
assert.ok((await begin('synthetic-worker',a)).rows[0].result)
await db.exec("update google_drive_connections set granted_scopes=ARRAY[]::text[]")
assert.equal((await db.query('select pjsdas_assert_gmail_execution($1,$2,$3) as valid',['synthetic-worker',user,a])).rows[0].valid,false)
assert.equal((await finish(a,{historyId:'SCOPE-CHANGED'},{status:'completed',mode:'history'})).rows[0].result,false)
await db.exec("update google_drive_connections set granted_scopes=ARRAY['https://www.googleapis.com/auth/gmail.readonly']")
assert.ok((await begin('synthetic-worker',a)).rows[0].result)
await db.exec('update google_drive_connections set gmail_automation_enabled=false')
assert.equal((await finish(a,{historyId:'REVOKED'},{status:'completed',mode:'history'})).rows[0].result,false)
assert.equal((await row()).gmail_history_id,'900')
await db.close()
console.log('PASS actual PostgreSQL: dormant/denied table; token rejection; lease coalescing/expiry/takeover; stale/duplicate/disabled finish fencing; restricted v1 ACL/service_role fence; legacy v2 ACL/fence; error preserves cursor; whitelist metrics and backfill separation.')
