// Native dump/restore of synthetic fixture data only. Production backups never enter CI.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { sealBackup, openBackup } from './backup-archive.mjs'
import { backupInventory } from './backup-inventory.mjs'
import pg from 'pg'

export async function backupRoundtrip(source, admin, url, inspect) {
 assert.equal(url.pathname,'/ta_chain_fixture')
 assert.ok(['127.0.0.1','localhost'].includes(url.hostname))
 assert.equal(url.password,'fixture-only')
 const destination=new URL(process.env.TA_PG_RESTORE_TEST_URL??'http://missing.invalid')
 assert.equal(destination.protocol,'postgresql:')
 assert.ok(['127.0.0.1','localhost'].includes(destination.hostname))
 assert.equal(destination.pathname,'/ta_backup_fixture')
 assert.equal(destination.username,'postgres');assert.equal(destination.password,'fixture-only');assert.equal(destination.search,'')
 const sourceContainer=process.env.TA_PG_FIXTURE_CONTAINER,restoreContainer=process.env.TA_PG_RESTORE_CONTAINER
 const connectionArgs=(connection,container,user='postgres')=>['-h',connection.hostname,'-p',container?'5432':connection.port||'5432','-U',user]
 const invoke=(tool,args,input,container=sourceContainer)=>new Promise((resolve,reject)=>{
  const command=container?'docker':tool
  const commandArgs=container?['exec','-i','--env','PGPASSWORD=fixture-only',container,tool,...args]:args
  const child=spawn(command,commandArgs,{env:{...process.env,PGPASSWORD:'fixture-only'},stdio:['pipe','pipe','pipe']})
  const chunks=[],errors=[]
  child.stdout.on('data',b=>chunks.push(b));child.stderr.on('data',b=>errors.push(b))
  child.on('error',reject);child.stdin.on('error',e=>{if(e.code!=='EPIPE')reject(e)})
  child.on('close',code=>code===0?resolve(Buffer.concat(chunks)):reject(Error(`${tool} failed (${code}): ${Buffer.concat(errors).toString()}`)))
  child.stdin.end(input)
 })
 // Model the official short-lived native login without changing the source owner
 // password. This fixture is loopback-only; never create a login on production.
 const login='cli_login_postgres'
 assert.equal((await admin.query('select 1 from pg_roles where rolname=$1',[login])).rowCount,0)
 await admin.query(`create role ${login} login noinherit password 'fixture-only'; grant postgres to ${login}`)
 const temporaryUrl=new URL(url);temporaryUrl.username=login
 const temporarySource=new pg.Client({connectionString:temporaryUrl.toString()})
 try{
 await temporarySource.connect()
 await assert.rejects(temporarySource.query('select * from auth.users'),e=>e.code==='42501')
 await temporarySource.query('set role postgres')
 assert.deepEqual((await temporarySource.query('select current_user,session_user')).rows[0],{current_user:'postgres',session_user:login})
 await temporarySource.query('begin isolation level repeatable read read only')
 let expected,dump,globals
 try{
  expected={catalog:await inspect(temporarySource),inventory:await backupInventory(temporarySource)}
  const snapshot=(await temporarySource.query('select pg_export_snapshot() s')).rows[0].s
  dump=await invoke('pg_dump',[...connectionArgs(url,sourceContainer,login),'--role=postgres','-d','ta_chain_fixture','--format=custom','--strict-names','--schema=public','--schema=auth','--schema=supabase_migrations',`--snapshot=${snapshot}`,'--lock-wait-timeout=2s'])
  // pg_dump excludes cluster-global roles. Capture their definitions and memberships
  // separately without passwords. This is synthetic fixture material, never production.
  globals=await invoke('pg_dumpall',[...connectionArgs(url,sourceContainer,login),'--role=postgres','--roles-only','--no-role-passwords'])
 }finally{await temporarySource.query('rollback')}
 const key=randomBytes(32),encrypted=sealBackup(dump,key)
 assert.deepEqual(openBackup(encrypted,key),dump)
 const corrupted=Buffer.from(encrypted);corrupted[corrupted.length-1]^=1
 assert.throws(()=>openBackup(corrupted,key),'tampered archive must be rejected')
 assert.throws(()=>openBackup(encrypted,randomBytes(32)),'wrong key must be rejected')
 dump=openBackup(encrypted,key);key.fill(0)
 const restored=new pg.Client({connectionString:destination.toString()})
 await restored.connect()
 try{
  const systemId=async c=>(await c.query('select system_identifier::text id from pg_control_system()')).rows[0].id
  assert.notEqual(await systemId(restored),await systemId(admin),'restore must use a separately initialized PostgreSQL cluster')
  assert.deepEqual((await restored.query("select rolname from pg_roles where rolname not like 'pg_%' order by rolname")).rows,[{rolname:'postgres'}],'restore cluster must start without source roles')
  // pg_dump encodes public ACLs relative to initdb's standard public schema. Keep
  // that empty schema; omit only its duplicate CREATE, retaining ALTER OWNER and
  // every ACL statement. Dropping it would silently lose the default PUBLIC USAGE.
  const count=(await restored.query("select count(*) n from pg_class where relnamespace='public'::regnamespace")).rows[0].n
  assert.equal(Number(count),0)
  const sql=(await invoke('pg_restore',['--file=-'],dump)).toString()
  assert.equal([...sql.matchAll(/^CREATE SCHEMA public;$/gm)].length,1)
  const restoreSql=sql.replace(/^CREATE SCHEMA public;$/m,'-- Empty initdb public schema retained; owner and ACL statements below are unchanged.')
  const restoreArgs=['-X','-w',...connectionArgs(destination,restoreContainer),'-d','ta_backup_fixture','--single-transaction','--set','ON_ERROR_STOP=1','--file=-']
  // Prove the negative case: a database-only archive cannot recover absent roles.
  await assert.rejects(invoke('psql',restoreArgs,restoreSql,restoreContainer),/role .* does not exist/)
  assert.equal(Number((await restored.query("select count(*) n from pg_class where relnamespace='public'::regnamespace")).rows[0].n),0,'failed restore must roll back completely')
  const globalsSql=globals.toString()
  assert.equal([...globalsSql.matchAll(/^CREATE ROLE postgres;$/gm)].length,1)
  assert.doesNotMatch(globalsSql,/\bPASSWORD\s/i,'role passwords must never enter the recovery proof')
  // Only initdb's proven-existing bootstrap role is omitted; its ALTER statement
  // and every membership/grantor are replayed and compared below.
  await invoke('psql',restoreArgs,globalsSql.replace(/^CREATE ROLE postgres;$/m,'-- Existing initdb bootstrap role; retain its attributes below.'),restoreContainer)
  await invoke('psql',restoreArgs,restoreSql,restoreContainer)
  assert.deepEqual({catalog:await inspect(restored),inventory:await backupInventory(restored)},expected,'native restored catalog/ACL/data/history must exactly match the exported snapshot')
  // Detect both changed role attributes and a missing membership in the new cluster.
  await restored.query('begin; alter role anon createrole')
  assert.notDeepEqual((await backupInventory(restored)).roles,expected.inventory.roles)
  await restored.query('rollback; begin; revoke postgres from cli_login_postgres')
  assert.notDeepEqual((await backupInventory(restored)).memberships,expected.inventory.memberships)
  await restored.query('rollback')
 }
 finally{await restored.end()}
 console.log(`PASS fresh-cluster recovery: different system identifier; database-only restore rejected; password-free roles/memberships restored; exact schema/owner/ACL/rows/history; role and membership drift detected; archive SHA256 ${createHash('sha256').update(dump).digest('hex')}`)
 }finally{
  await temporarySource.end()
  await admin.query(`drop role ${login}`)
 }
 assert.equal((await admin.query('select 1 from pg_roles where rolname=$1',[login])).rowCount,0,'temporary fixture login must be removed')
}
