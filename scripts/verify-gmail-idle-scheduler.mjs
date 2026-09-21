// Actual PostgreSQL execution in isolated PGlite 0.3.14; synthetic cron/net/Vault only.
// This does not install pg_cron/pg_net, connect to production, or send HTTP requests.
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
const { PGlite } = await import(process.env.PJSDAS_PGLITE_MODULE ?? '@electric-sql/pglite')
const db = new PGlite()
const activation = await readFile('supabase/migrations/2026091904_activate_automation_scheduler.sql', 'utf8')
const oldGmail = activation.split('$cron$')[1]
const oldDiscovery = activation.split('$cron$')[3]
const migration = await readFile('supabase/migrations/20260921062843_gmail_scheduler_skip_idle.sql', 'utf8')
assert.equal(createHash('md5').update(oldGmail).digest('hex'), 'e50ce09a4cfa70b7424aa46d65268c46')
assert.equal(createHash('md5').update(oldDiscovery).digest('hex'), '1245da13ee3902ae7fc10e0b8ffef78d')
await db.exec(`
create schema cron; create schema net; create schema vault;
create role migration_runner noinherit nosuperuser;
create table cron.job(jobid bigint primary key, jobname text unique, schedule text,
 command text, active boolean, database text, username text, nodename text, nodeport integer);
create table public.http_calls(id bigserial primary key, url text, headers jsonb, body jsonb, timeout_ms integer);
create function net.http_post(url text, body jsonb default '{}'::jsonb,
 params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb,
 timeout_milliseconds integer default 1000) returns bigint language plpgsql as $f$
declare result bigint;
begin
 insert into public.http_calls(url,headers,body,timeout_ms)
 values(url,headers,body,timeout_milliseconds) returning id into result;
 return result;
end $f$;
create function cron.alter_job(job_id bigint, schedule text default null,
 command text default null, database text default null, username text default null,
 active boolean default null) returns void language plpgsql
 security definer set search_path=pg_catalog,cron as $f$
begin
 update cron.job j set schedule=coalesce(alter_job.schedule,j.schedule),
 command=coalesce(alter_job.command,j.command), database=coalesce(alter_job.database,j.database),
 username=coalesce(alter_job.username,j.username), active=coalesce(alter_job.active,j.active)
 where jobid=job_id;
end $f$;
-- Synthetic stand-in for pg_cron's C API, whose internal write path is usable
-- with EXECUTE despite SELECT-only catalog rights. Production alter_job is NOT
-- SECURITY DEFINER; this fixture models the permitted API, not C implementation.
revoke all on function cron.alter_job(bigint,text,text,text,text,boolean) from public;
grant usage on schema cron to migration_runner;
grant select on cron.job to migration_runner;
grant execute on function cron.alter_job(bigint,text,text,text,text,boolean) to migration_runner;
create table vault.decrypted_secrets(name text, decrypted_secret text);
insert into vault.decrypted_secrets values
 ('pjsdas_automation_backend_origin','https://scheduler.example.invalid/'),
 ('pjsdas_gmail_automation_worker_token','synthetic-not-a-real-secret');
create table public.google_drive_connections(id integer primary key,
 gmail_automation_enabled boolean, revoked_at timestamptz, gmail_intake_consent_version text);
`)
for (const [id,name,schedule,command] of [
  [15,'pjsdas-gmail-automation-hourly','5 * * * *',oldGmail],
  [16,'pjsdas-discovery-automation-hourly','15 * * * *',oldDiscovery],
]) await db.query("insert into cron.job values($1,$2,$3,$4,true,'postgres','postgres','localhost',5432)",[id,name,schedule,command])
const jobs = async () => (await db.query('select * from cron.job order by jobid')).rows
const before = await jobs()
const asMigrationRole = async (sql) => {
 await db.exec('set role migration_runner')
 try { return await db.exec(sql) } finally { await db.exec('reset role') }
}
const permissions = (await db.query(`select
 has_table_privilege('migration_runner','cron.job','SELECT') as can_select,
 has_table_privilege('migration_runner','cron.job','UPDATE') as can_update,
 has_function_privilege('migration_runner','cron.alter_job(bigint,text,text,text,text,boolean)','EXECUTE') as can_alter,
 (select rolsuper from pg_roles where rolname='migration_runner') as superuser`)).rows[0]
assert.deepEqual(permissions,{can_select:true,can_update:false,can_alter:true,superuser:false})
const lockedMigration = migration.replace(
 "where jobname = 'pjsdas-gmail-automation-hourly';",
 "where jobname = 'pjsdas-gmail-automation-hourly' for update;")
await assert.rejects(asMigrationRole(lockedMigration), /permission denied for table job/)
assert.deepEqual(await jobs(),before,'The original row-lock attempt changes no job')
await asMigrationRole(migration)
const after = await jobs()
assert.deepEqual(after[1],before[1], 'Discovery remains byte-for-byte unchanged')
assert.deepEqual({...after[0],command:before[0].command},before[0], 'Gmail metadata unchanged')
const command = after[0].command
assert.equal(command.replace(/\n  where exists \([\s\S]*?\n  \);/, ';'),oldGmail,
 'Only EXISTS is added to the original HTTP request; endpoint/auth/body/timeout preserved')
assert.equal((await db.query('select count(*)::integer as n from http_calls')).rows[0].n,0,
 'Applying migration enqueues nothing')
const run = async (expected) => {
 await db.exec('truncate http_calls')
 const result = await db.query(command)
 const calls = (await db.query('select url,headers,body,timeout_ms from http_calls')).rows
 assert.equal(calls.length,expected)
 assert.equal(result.rows.length,expected)
 if (expected) assert.deepEqual(calls[0],{url:'https://scheduler.example.invalid/api/automation-gmail',
  headers:{'Content-Type':'application/json',Authorization:'Bearer synthetic-not-a-real-secret'},
  body:{},timeout_ms:20000})
}
await run(0) // Empty workspace: no net.http_post call.
await db.exec(`insert into google_drive_connections values
 (1,false,null,null),(2,true,now(),null),(3,null,null,'uu06-v1')`)
await run(0) // Disabled, revoked and NULL-enabled rows are not eligible.
await db.exec('insert into google_drive_connections values(4,true,null,null)')
await run(1) // Legacy NULL-consent enabled binding is NOT silently excluded.
await db.exec("insert into google_drive_connections values(5,true,null,'uu06-v1'),(6,true,null,null)")
await run(1) // Multiple eligible rows still cause exactly one HTTP enqueue.
await db.exec('update google_drive_connections set revoked_at=now() where id in (4,5,6)')
await run(0)
await db.exec('update cron.job set active=false where jobid=15')
await asMigrationRole(migration)
assert.equal((await jobs())[0].active,false, 'Applying again does not reactivate a paused job')
assert.equal((await jobs())[0].command,command)
assert.deepEqual((await jobs())[1],before[1])
await db.exec("update cron.job set schedule='*/2 * * * *' where jobid=15")
await assert.rejects(asMigrationRole(migration), /Unexpected Gmail scheduler cadence/)
assert.equal((await jobs())[0].schedule,'*/2 * * * *')
await db.exec('delete from cron.job where jobid=15')
await assert.rejects(asMigrationRole(migration), /query returned no rows/)
assert.equal((await jobs()).length,1, 'Missing Gmail job is not recreated or activated')
await db.close()
console.log('PASS actual PostgreSQL: SELECT-only non-superuser migration role, original FOR UPDATE denied without changes, API-only correction succeeds; 0 eligible -> 0 HTTP calls; legacy NULL consent and multiple eligible -> 1; disabled/revoked -> 0; only command changes; cadence/job metadata/Discovery preserved; paused/missing/drifted jobs fail safely. Synthetic cron/net/Vault only.')
