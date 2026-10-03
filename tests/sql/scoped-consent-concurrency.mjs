import pg from 'pg'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const url=new URL(process.env.TA_MANAGEMENT_SQL_TEST_URL??'http://missing.invalid')
if(url.protocol!=='postgresql:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/ta_management_fixture'||url.username!=='postgres'||url.password!=='fixture-only'||url.search)throw new Error('Only isolated loopback synthetic fixture is accepted.')
const connections=Object.fromEntries(['observer','writer','racer'].map(name=>[name,new pg.Client({connectionString:url.toString(),application_name:`ta-scoped-${name}`,statement_timeout:15000})]))
const {observer,writer,racer}=connections
const owner='00000000-0000-4000-8000-000000000131',client='00000000-0000-4000-8000-000000000132'
const domains={opportunity:[3,'cbd141fb716582ead3b578ab730ce0ac6e72d1dcdd93cb75c9cd0d1b734cc070'],planning:[4,'8d00011548bd7cd023b8993127be68a68b10c148a769b0ce66dc456b02590ee8'],discoveryProfile:[5,'2e101636a8d786162d7dafa04668a130ee2b09fb28e9c7135547faf8437ddcc8'],privateReminder:[6,'da1356a5e74914ccde6244432f6962e061464678bb75547f97d2de804aaddaa9']}
const choice=(domain,proof=null,decision='approve')=>({domain,decision,consentVersion:domains[domain][0],consentTextHash:domains[domain][1],expectedGrant:proof?{id:proof.grant_id,revision:Number(proof.grant_revision)}:null})
const query='select * from public.pjsdas_decide_scoped_management_consent_v1($1,$2,$3,$4,$5,$6,$7,$8,$9)'
const args=(id,choices,verified=true)=>[owner,client,`00000000-0000-4000-8000-${String(id).padStart(12,'0')}`,String(id).padStart(64,'a'),JSON.stringify(choices),true,verified,false,'allowlist']
const call=async(db,id,choices,verified=true)=>(await db.query(query,args(id,choices,verified))).rows[0].receipts
const track=promise=>{const state={settled:false};state.result=promise.then(value=>{state.settled=true;return{value}},error=>{state.settled=true;return{error}});return state}
async function locked(pending){const end=Date.now()+10000;while(Date.now()<end){if((await observer.query("select 1 from pg_stat_activity where application_name='ta-scoped-racer' and wait_event_type='Lock'")).rowCount){assert.equal(pending.settled,false);return}if(pending.settled)throw (await pending.result).error??new Error('No controlled lock wait');await new Promise(r=>setTimeout(r,20))}throw new Error('Lock wait timed out')}
try{
 await Promise.all(Object.values(connections).map(c=>c.connect()))
 await observer.query(await readFile(new URL('../../supabase/migrations/20261003083410_scoped_management_consent_batch.sql',import.meta.url),'utf8'))
 await observer.query('insert into auth.users(id) values($1)',[owner]);await observer.query("insert into public.pjsdas_access_grants(user_id,role) values($1,'owner')",[owner])
 await observer.query("insert into public.pjsdas_business_management_grants(user_id,client_id,capability,consent_version,consent_text_hash) values($1,$2,'workspace.manage',2,$3)",[owner,client,'b'.repeat(64)])
 const v2=(await observer.query("select to_jsonb(g) row from public.pjsdas_business_management_grants g where user_id=$1 and capability='workspace.manage'",[owner])).rows[0].row
 await writer.query('set role service_role');await racer.query('set role service_role')
 for(const malformed of [[],[choice('planning'),choice('planning')],[{...choice('planning'),consentVersion:3}],[{...choice('planning'),consentTextHash:'0'.repeat(64)}],[{...choice('planning'),extra:true}],[choice('planning',null,'revoke')]])await assert.rejects(call(writer,200,malformed))
 let releaseOriginal;const delayedOriginal=track(new Promise(resolve=>{releaseOriginal=resolve}).then(()=>call(writer,201,[choice('planning')],true)))
 assert.equal((await call(racer,201,[choice('planning')],false))[0].outcome,'DENIED')
 releaseOriginal();const delayedResult=await delayedOriginal.result;assert.ifError(delayedResult.error);assert.equal(delayedResult.value[0].outcome,'DENIED')
 assert.equal((await observer.query("select 1 from public.pjsdas_business_management_grants where user_id=$1 and capability='workspace.planning.manage'",[owner])).rowCount,0)
 console.log('PASS terminal denial reserves request ID: a delayed formerly admitted attempt cannot grant it.')
 const firstChoices=[choice('planning'),choice('privateReminder')]
 await writer.query('begin');const first=await call(writer,202,firstChoices)
 const replay=track(call(racer,202,firstChoices));await locked(replay);await writer.query('commit');const replayed=await replay.result;assert.ifError(replayed.error);assert.deepEqual(replayed.value,first)
 const planning=first.find(x=>x.domain==='planning'),reminder=first.find(x=>x.domain==='privateReminder')
 assert.equal(first.length,2)
 console.log('PASS scoped two-domain approval and simultaneous replay: one immutable batch receipt, no other domain grant.')
 // The alphabetically first opportunity insert must roll back when planning CAS later fails.
 await assert.rejects(call(writer,203,[choice('opportunity'),choice('planning')]),e=>e.code==='40001')
 assert.equal((await observer.query("select 1 from public.pjsdas_business_management_grants where user_id=$1 and capability='workspace.opportunity.manage'",[owner])).rowCount,0)
 const mixed=await call(writer,204,[choice('planning',planning,'revoke'),choice('opportunity')])
 assert.equal(mixed.find(x=>x.domain==='planning').outcome,'REVOKED')
 assert.deepEqual(await call(writer,202,firstChoices),first)
 assert.ok((await observer.query("select revoked_at from public.pjsdas_business_management_grants where id=$1",[planning.grant_id])).rows[0].revoked_at)
 await assert.rejects(call(writer,202,[choice('privateReminder')]),e=>e.code==='23505')
 console.log('PASS all-or-nothing stale mixed batch; old approval replay cannot undo newer revocation.')
 // A queued stale revoke must not override a newer explicit approval.
 await writer.query('begin');const newer=(await call(writer,205,[choice('privateReminder',reminder)]))[0]
 const stale=track(call(racer,206,[choice('privateReminder',reminder,'revoke')],false));await locked(stale);await writer.query('commit');assert.equal((await stale.result).error?.code,'40001')
 // Disconnect does not prevent an explicit revocation of the exact owned proof.
 await call(writer,207,[choice('privateReminder',newer,'revoke')],false)
 const afterV2=(await observer.query("select to_jsonb(g) row from public.pjsdas_business_management_grants g where user_id=$1 and capability='workspace.manage'",[owner])).rows[0].row
 assert.deepEqual(afterV2,v2)
 console.log('PASS grant CAS/revoke race, disconnected-client revocation, exact untouched v2 row.')
 await writer.query('begin');await writer.query('update public.pjsdas_access_grants set revoked_at=now() where user_id=$1',[owner])
 const denied=track(call(racer,208,[choice('discoveryProfile')]));await locked(denied);await writer.query('commit');const deniedResult=await denied.result;assert.ifError(deniedResult.error);assert.equal(deniedResult.value[0].outcome,'DENIED')
 assert.equal((await observer.query("select 1 from public.pjsdas_business_management_grants where user_id=$1 and capability='workspace.discovery-profile.manage'",[owner])).rowCount,0)
 assert.deepEqual(await call(writer,202,firstChoices,false),first)
 await writer.query('set role authenticated');await assert.rejects(writer.query(query,args(209,[choice('discoveryProfile')])),e=>e.code==='42501')
 console.log('PASS audience revoke race and authenticated-role RPC denial.')
}finally{await Promise.allSettled([writer.query('rollback'),racer.query('rollback')]);await Promise.allSettled(Object.values(connections).map(c=>c.end()))}
