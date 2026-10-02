// Runs only after the existing fresh, synthetic management-grant fixture.
import pg from 'pg'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const url=new URL(process.env.TA_MANAGEMENT_SQL_TEST_URL??'http://missing.invalid')
if(url.protocol!=='postgresql:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/ta_management_fixture'||url.username!=='postgres'||url.password!=='fixture-only'||url.search)throw new Error('Only the isolated loopback fixture database is accepted.')
const connections=Object.fromEntries(['observer','writer','racer'].map(name=>[name,new pg.Client({connectionString:url.toString(),application_name:`ta-consent-${name}`,statement_timeout:15000,connectionTimeoutMillis:5000})]))
const {observer,writer,racer}=connections
const owner='00000000-0000-4000-8000-000000000091',client='00000000-0000-4000-8000-000000000092'
const request=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const query='select * from public.pjsdas_decide_management_consent_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)'
const args=(id,proof=null,decision='approve')=>[owner,client,request(id),String(id).padStart(64,'a'),decision,2,'b'.repeat(64),proof?.grant_id??null,proof?.grant_revision??null,true,true]
const track=promise=>{const status={settled:false};status.result=promise.then(value=>{status.settled=true;return{value}},error=>{status.settled=true;return{error}});return status}
async function waitForLock(name,pending){const deadline=Date.now()+10000;while(Date.now()<deadline){const rows=(await observer.query('select wait_event_type from pg_stat_activity where application_name=$1',[`ta-consent-${name}`])).rows;if(rows.some(row=>row.wait_event_type==='Lock')){assert.equal(pending.settled,false);return}if(pending.settled)throw (await pending.result).error??new Error('Expected a lock wait');await new Promise(resolve=>setTimeout(resolve,20))}throw new Error('Consent fixture did not reach controlled lock boundary')}
try{
 await Promise.all(Object.values(connections).map(c=>c.connect()))
 // CREATE (not IF NOT EXISTS) ensures this runs only once in the isolated job.
 await observer.query(await readFile(new URL('../../supabase/migrations/2026091903_controlled_audience.sql',import.meta.url),'utf8'))
 await observer.query(await readFile(new URL('../../supabase/migrations/20261002143625_owner_management_consent_audit.sql',import.meta.url),'utf8'))
 await observer.query('insert into auth.users(id) values($1)',[owner])
 await observer.query("insert into public.pjsdas_access_grants(user_id,role) values($1,'owner')",[owner])
 await writer.query('set role service_role');await racer.query('set role service_role')
 // Two identical decisions race while the first transaction holds its locks.
 await writer.query('begin');const first=(await writer.query(query,args(101))).rows[0]
 const replay=track(racer.query(query,args(101)));await waitForLock('racer',replay);await writer.query('commit')
 const repeated=await replay.result;assert.ifError(repeated.error);assert.deepEqual(repeated.value.rows[0],first)
 assert.equal(Number((await observer.query('select count(*) n from public.pjsdas_management_consent_events where user_id=$1',[owner])).rows[0].n),1)
 console.log('PASS consent replay race: one grant revision and one immutable decision receipt.')
 // A newer approval wins; an older concurrently waiting revoke cannot overwrite it.
 await writer.query('begin');const newer=(await writer.query(query,args(102,first))).rows[0]
 const stale=track(racer.query(query,args(103,first,'revoke')));await waitForLock('racer',stale);await writer.query('commit')
 assert.equal((await stale.result).error?.code,'40001')
 assert.equal(Number((await observer.query('select revision from public.pjsdas_business_management_grants where user_id=$1',[owner])).rows[0].revision),Number(newer.grant_revision))
 console.log('PASS consent CAS race: stale queued revoke did not override newer explicit approval.')
 // Audience revocation commits first: the queued consent must recheck row state.
 await writer.query('begin');await writer.query('update public.pjsdas_access_grants set revoked_at=now() where user_id=$1',[owner])
 const denied=track(racer.query(query,args(104,newer)));await waitForLock('racer',denied);await writer.query('commit')
 assert.equal((await denied.result).error?.code,'42501')
 assert.equal(Number((await observer.query('select count(*) n from public.pjsdas_management_consent_events where user_id=$1',[owner])).rows[0].n),2)
 console.log('PASS owner revoke race: queued consent rejected without new grant state or audit event.')
}finally{await Promise.allSettled([writer.query('rollback'),racer.query('rollback')]);await Promise.allSettled(Object.values(connections).map(c=>c.end()))}
