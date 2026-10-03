// Native dump/restore of synthetic fixture data only. Production backups never enter CI.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import pg from 'pg'

export async function backupRoundtrip(source, admin, url, inspect) {
 assert.equal(url.pathname,'/ta_chain_fixture')
 assert.ok(['127.0.0.1','localhost'].includes(url.hostname))
 assert.equal(url.password,'fixture-only')
 const target='ta_backup_fixture'
 const invoke=(tool,args,input)=>new Promise((resolve,reject)=>{
  const container=process.env.TA_PG_FIXTURE_CONTAINER
  const command=container?'docker':tool
  const commandArgs=container?['exec','-i','--env','PGPASSWORD=fixture-only',container,tool,...args]:args
  const child=spawn(command,commandArgs,{env:{...process.env,PGPASSWORD:'fixture-only'},stdio:['pipe','pipe','pipe']})
  const chunks=[],errors=[]
  child.stdout.on('data',b=>chunks.push(b));child.stderr.on('data',b=>errors.push(b))
  child.on('error',reject);child.stdin.on('error',e=>{if(e.code!=='EPIPE')reject(e)})
  child.on('close',code=>code===0?resolve(Buffer.concat(chunks)):reject(Error(`${tool} failed (${code}): ${Buffer.concat(errors).toString()}`)))
  child.stdin.end(input)
 })
 await source.query('begin isolation level repeatable read read only')
 let expected,dump
 try{
  expected=await inspect(source)
  const snapshot=(await source.query('select pg_export_snapshot() s')).rows[0].s
  dump=await invoke('pg_dump',['-h',url.hostname,'-p',url.port||'5432','-U','postgres','-d','ta_chain_fixture','--format=custom','--strict-names','--schema=public','--schema=auth','--schema=supabase_migrations',`--snapshot=${snapshot}`,'--lock-wait-timeout=2s'])
 }finally{await source.query('rollback')}
 await admin.query(`create database ${target}`)
 const destination=new URL(url);destination.pathname='/'+target
 const restored=new pg.Client({connectionString:destination.toString()})
 await restored.connect()
 try{
  // pg_dump encodes public ACLs relative to initdb's standard public schema. Keep
  // that empty schema; omit only its duplicate CREATE, retaining ALTER OWNER and
  // every ACL statement. Dropping it would silently lose the default PUBLIC USAGE.
  const count=(await restored.query("select count(*) n from pg_class where relnamespace='public'::regnamespace")).rows[0].n
  assert.equal(Number(count),0)
  const sql=(await invoke('pg_restore',['--file=-'],dump)).toString()
  assert.equal([...sql.matchAll(/^CREATE SCHEMA public;$/gm)].length,1)
  const restoreSql=sql.replace(/^CREATE SCHEMA public;$/m,'-- Empty initdb public schema retained; owner and ACL statements below are unchanged.')
  await invoke('psql',['-X','-w','-h',url.hostname,'-p',url.port||'5432','-U','postgres','-d',target,'--single-transaction','--set','ON_ERROR_STOP=1','--file=-'],restoreSql)
  assert.deepEqual(await inspect(restored),expected,'native restored catalog/ACL/data/history must exactly match the exported snapshot')
 }
 finally{await restored.end()}
 console.log(`PASS native pg_dump/pg_restore: consistent snapshot; exact schema/owner/ACL/rows/history restored, archive SHA256 ${createHash('sha256').update(dump).digest('hex')}`)
}
