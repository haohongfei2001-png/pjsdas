import pg from 'pg'
import assert from 'node:assert/strict'
import { createEmptyConsumerWorkspace } from '../../src/consumerWorkspaceBootstrap.ts'
const url=new URL(process.env.TA_MANAGEMENT_SQL_TEST_URL??'http://missing.invalid')
if(url.protocol!=='postgresql:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/ta_management_fixture'||url.username!=='postgres'||url.password!=='fixture-only'||url.search)throw new Error('Only isolated loopback synthetic fixture is accepted.')
const connections=Object.fromEntries(['observer','writer','racer'].map(name=>[name,new pg.Client({connectionString:url.toString(),application_name:`ta-bootstrap-${name}`,statement_timeout:15000})]))
const {observer,writer,racer}=connections
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const query='select * from public.pjsdas_bootstrap_consumer_workspace_v1($1,$2,4,$3,$4,true,$5)'
const args=(owner,mode='allowlist')=>[owner,JSON.stringify(createEmptyConsumerWorkspace({action:'initialize_empty',expectedAccountId:owner,commandId:'bootstrap-race-'+owner,timezone:'UTC',confirmStartEmpty:true})),'synthetic-fingerprint','explicit-consumer-empty-start',mode]
const track=promise=>{const state={settled:false};state.result=promise.then(value=>{state.settled=true;return{value}},error=>{state.settled=true;return{error}});return state}
async function locked(name,pending){const end=Date.now()+10000;while(Date.now()<end){if((await observer.query('select 1 from pg_stat_activity where application_name=$1 and wait_event_type=\'Lock\'',[`ta-bootstrap-${name}`])).rowCount){assert.equal(pending.settled,false);return}if(pending.settled)throw (await pending.result).error??new Error('No lock wait');await new Promise(r=>setTimeout(r,20))}throw new Error('Lock wait timed out')}
try{
 await Promise.all(Object.values(connections).map(c=>c.connect()))
 for(const n of [161,162,163]){await observer.query('insert into auth.users(id) values($1)',[id(n)]);if(n!==163)await observer.query("insert into public.pjsdas_access_grants(user_id,role) values($1,'beta')",[id(n)])}
 await writer.query('set role service_role');await racer.query('set role service_role')
 await writer.query('begin');await writer.query('update public.pjsdas_access_grants set revoked_at=now() where user_id=$1',[id(161)])
 const denied=track(racer.query(query,args(id(161))));await locked('racer',denied);await writer.query('commit');assert.equal((await denied.result).error?.code,'42501')
 assert.equal((await observer.query('select 1 from public.pjsdas_workspaces where user_id=$1',[id(161)])).rowCount,0)
 console.log('PASS empty bootstrap revoke-first: queued initialization rejected with no workspace.')
 await observer.query('begin');await observer.query('select 1 from auth.users where id=$1 for update',[id(162)])
 const start=track(writer.query(query,args(id(162))));await locked('writer',start)
 const revoke=track(racer.query('update public.pjsdas_access_grants set revoked_at=now() where user_id=$1',[id(162)]));await locked('racer',revoke)
 await observer.query('commit');assert.ifError((await start.result).error);assert.ifError((await revoke.result).error)
 const before=(await observer.query('select to_jsonb(w) row from public.pjsdas_workspaces w where user_id=$1',[id(162)])).rows[0].row
 await assert.rejects(writer.query(query,args(id(162))),e=>e.code==='42501')
 assert.deepEqual((await observer.query('select to_jsonb(w) row from public.pjsdas_workspaces w where user_id=$1',[id(162)])).rows[0].row,before)
 console.log('PASS empty bootstrap initialization-first: revoke waits; later denied initialization cannot reset existing state.')
 await assert.rejects(writer.query(query,args(id(163))),e=>e.code==='42501')
 assert.equal((await writer.query(query,args(id(163),'legacy'))).rows[0].outcome,'CREATED_OR_MATCHED')
 console.log('PASS consumer source audience modes: absent allowlist denied; explicit legacy mode admits only verified account-bound empty bootstrap.')
}finally{await Promise.allSettled(Object.values(connections).map(c=>c.query('rollback')));await Promise.allSettled(Object.values(connections).map(c=>c.end()))}
