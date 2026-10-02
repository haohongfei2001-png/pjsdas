import pg from 'pg'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const url = new URL(process.env.TA_MANAGEMENT_SQL_TEST_URL ?? 'http://missing.invalid')
if (url.protocol !== 'postgresql:' || !['127.0.0.1','localhost'].includes(url.hostname) || url.pathname !== '/ta_management_fixture' || url.username !== 'postgres' || url.password !== 'fixture-only' || url.search) throw new Error('Only the isolated loopback fixture database and synthetic credentials are accepted.')
const clients = Object.fromEntries(['observer','blocker','writer','revoker'].map(name => [name,new pg.Client({connectionString:url.toString(),application_name:`ta-fixture-${name}`,statement_timeout:15000,connectionTimeoutMillis:5000})]))
const {observer,blocker,writer,revoker}=clients
const owner='00000000-0000-4000-8000-000000000001',client='00000000-0000-4000-8000-000000000002',grant='00000000-0000-4000-8000-000000000003'
const state={schema:'pjsdas-local-snapshot',version:4,exportedAt:'2026-10-02T00:00:00Z',data:{opportunities:[],processes:[],processEvents:[],actions:[],prep:[],applicationGroups:[],scheduleNodes:[],decisionRequests:[],semanticReceipts:[],reminderIntents:[],reminderOutbox:[]}}
const query='select * from public.pjsdas_commit_management_workspace_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)'
const args=(command,proof,revision)=>[owner,command,'business_management',`hash:${command}`,revision,JSON.stringify(state),4,'delegated_mcp',client,'{}','{}',null,'{}',grant,proof]
const track=promise=>{const status={settled:false};status.result=promise.then(value=>{status.settled=true;return{value}},error=>{status.settled=true;return{error}});return status}
async function waitForLock(name,pending){
 const deadline=Date.now()+10000
 while(Date.now()<deadline){
  const result=await observer.query("select wait_event_type from pg_stat_activity where application_name=$1",[`ta-fixture-${name}`])
  if(result.rows.some(row=>row.wait_event_type==='Lock')){assert.equal(pending.settled,false);return}
  if(pending.settled){const result=await pending.result;throw result.error??new Error(`${name} completed before the expected row lock`)}
  await new Promise(resolve=>setTimeout(resolve,20))
 }
 throw new Error(`${name} did not reach the controlled row-lock boundary`)
}
async function proof(){return Number((await observer.query('select revision from public.pjsdas_business_management_grants where id=$1',[grant])).rows[0].revision)}
async function assertUnchanged(){
 assert.equal(Number((await observer.query('select revision from public.pjsdas_workspaces where user_id=$1',[owner])).rows[0].revision),1)
 assert.equal(Number((await observer.query('select count(*) from public.pjsdas_command_ledger')).rows[0].count),1)
}
try{
 await Promise.all(Object.values(clients).map(c=>c.connect()))
 // A fresh dedicated database is required; no DROP/reset operation is used.
 await observer.query('create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;')
 for(const name of ['2026091901_ai_operated_mutation_foundation.sql','20260923030000_cgr01_authoritative_commands.sql','20261002123812_consumer_management_atomic_grants.sql']) await observer.query(await readFile(new URL(`../../supabase/migrations/${name}`,import.meta.url),'utf8'))
 await observer.query('insert into auth.users(id) values($1)',[owner])
 await observer.query('insert into public.pjsdas_workspaces(user_id,snapshot,schema_version) values($1,$2,4)',[owner,JSON.stringify(state)])
 await observer.query("insert into public.pjsdas_business_management_grants(id,user_id,client_id,capability,consent_version,consent_text_hash) values($1,$2,$3,'workspace.manage',2,$4)",[grant,owner,client,'a'.repeat(64)])
 await writer.query('set role service_role');await revoker.query('set role service_role')
 // Mutation-first: hold workspace so writer must retain its grant SHARE lock
 // while inside the nested commit. Revocation then waits for that writer.
 await blocker.query('begin');await blocker.query('select id from public.pjsdas_workspaces where user_id=$1 for update',[owner])
 const firstWrite=track(writer.query(query,args('mutation-first',await proof(),0)))
 await waitForLock('writer',firstWrite)
 const firstRevoke=track(revoker.query('update public.pjsdas_business_management_grants set revoked_at=now() where id=$1',[grant]))
 await waitForLock('revoker',firstRevoke)
 await blocker.query('commit')
 const writeResult=await firstWrite.result;assert.ifError(writeResult.error);assert.equal(writeResult.value.rows[0].outcome,'COMMITTED')
 assert.ifError((await firstRevoke.result).error)
 await assertUnchanged()
 console.log('PASS mutation-first: revocation waited behind the grant row lock until the atomic write completed.')
 // Revoke-first: writer waits on an uncommitted revocation. After revoke commits,
 // the SELECT must recheck the changed row and reject, not append a command.
 await observer.query('update public.pjsdas_business_management_grants set revoked_at=null where id=$1',[grant])
 const beforeRevoke=await proof()
 await revoker.query('begin');await revoker.query('update public.pjsdas_business_management_grants set revoked_at=now() where id=$1',[grant])
 const secondWrite=track(writer.query(query,args('revoke-first',beforeRevoke,1)))
 await waitForLock('writer',secondWrite);await revoker.query('commit')
 assert.equal((await secondWrite.result).error?.code,'42501');await assertUnchanged()
 console.log('PASS revoke-first: queued mutation rejected after committed revocation with unchanged workspace and ledger.')
 // Revoke/regrant in one competing transaction ends ACTIVE, but an older proof
 // still must fail rather than adopt the replacement revision.
 await observer.query('update public.pjsdas_business_management_grants set revoked_at=null where id=$1',[grant])
 const beforeRegrant=await proof()
 await revoker.query('begin');await revoker.query('update public.pjsdas_business_management_grants set revoked_at=now() where id=$1',[grant]);await revoker.query('update public.pjsdas_business_management_grants set revoked_at=null where id=$1',[grant])
 const thirdWrite=track(writer.query(query,args('regrant-first',beforeRegrant,1)))
 await waitForLock('writer',thirdWrite);await revoker.query('commit')
 assert.equal((await thirdWrite.result).error?.code,'42501');await assertUnchanged()
 console.log('PASS regrant-first: an active newer grant revision did not revive the old blocked request.')
}finally{
 await Promise.allSettled([blocker.query('rollback'),revoker.query('rollback')])
 await Promise.allSettled(Object.values(clients).map(c=>c.end()))
}
