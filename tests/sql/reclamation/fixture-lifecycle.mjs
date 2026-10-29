/** Owned-loopback fixture failure paths, NOT extra product reclamation cases. */
import assert from 'node:assert/strict'
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {setTimeout as sleep} from 'node:timers/promises'
import pg from 'pg'
import {fixture} from './native-fixture.mjs'
import {finishReclamationRun} from './finish-run.mjs'
import {verifySource,lock} from './source.mjs'

const evidence=process.env.TA_V2_EVIDENCE;assert(evidence);verifySource()
const report={group:'fixture-lifecycle',source:lock.commit,status:'RUNNING',productAcceptance:false,cases:[]}
const save=()=>writeFileSync(join(evidence,'result.json'),JSON.stringify(report,null,2)+'\n')
const readCleanup=directory=>JSON.parse(readFileSync(join(directory,'cleanup.json'),'utf8'))
const pass=label=>{report.cases.push({label,status:'PASS'});save()}
const directory=label=>{const result=join(evidence,label);mkdirSync(result);return result}
async function catalogEmpty(){
 const admin=new pg.Client({connectionString:process.env.TA_ROW_DATABASE_URL})
 try{
  await admin.connect()
  assert.equal(Number((await admin.query("select count(*) n from pg_database where datname like 'ta_reclaim_accept_%'")).rows[0].n),0)
  assert.equal(Number((await admin.query("select count(*) n from pg_roles where rolname like 'ta_reclaim_http_%' or rolname='pjsdas_workspace_blob_reader'")).rows[0].n),0)
 }finally{await admin.end()}
}
let activeFixture,primaryError,active='setup'
save()
try{
 active='spawn-enoent-still-cleans-owned-resources';{
  const dir=directory(active),binary=process.env.TA_POSTGREST_BIN
  process.env.TA_POSTGREST_BIN=join(dir,'does-not-exist')
  try{await assert.rejects(fixture(dir),error=>error.message==='Owned PostgREST spawn failed')}
  finally{process.env.TA_POSTGREST_BIN=binary}
  const cleanup=readCleanup(dir);assert.equal(cleanup.status,'PASS');assert(cleanup.steps.every(step=>step.status==='PASS'))
  assert(cleanup.databaseCreated&&cleanup.authenticatorCreated&&cleanup.readerCreated)
  await catalogEmpty();pass(active)
 }
 active='diagnostic-write-failure-does-not-skip-cleanup';{
  const dir=directory(active);activeFixture=await fixture(dir)
  // Deterministic owned evidence failure, independent of filesystem permissions.
  mkdirSync(join(dir,'processes.json'))
  const closing=activeFixture;activeFixture=undefined
  await assert.rejects(closing.close(),AggregateError)
  const cleanup=readCleanup(dir);assert.equal(cleanup.status,'FAIL')
  assert.deepEqual(cleanup.steps.filter(step=>step.status==='FAIL').map(step=>step.label),['persist process diagnostics'])
  for(const label of ['verify owned catalog empty','verify owned processes exited'])assert.equal(cleanup.steps.find(step=>step.label===label)?.status,'PASS')
  await catalogEmpty();pass(active)
 }
 active='owned-observer-unlocks-before-draining-waiting-http';{
  const dir=directory(active);activeFixture=await fixture(dir);const h=activeFixture
  const t=await h.make('api')
  h.setDrop({match:path=>path.endsWith('large_v2_intent_admit')})
  assert.equal((await h.invoke(t)).result.status,503);h.assertNoDrop();await h.drain()
  const intent=await h.intent(t);assert(intent?.encoded)
  const observer=await h.observer('lifecycle-lock')
  await observer.query('begin;select * from ta_resource_reservations.pool for update;select pg_advisory_lock(743726,999999)')
  const request=h.rpc('large_v2_intent_cancel',{identity:intent.identity,target_user_id:t.ids.userId}).then(value=>({value}),error=>({error}))
  let waiting=false
  for(let i=0;i<100;i++){
   waiting=Number((await h.scalar("select count(*) n from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock'")).n)>0
   if(waiting)break
   await sleep(20)
  }
  assert(waiting,'The actual public HTTP request must be blocked by the owned observer')
  activeFixture=undefined;await h.close()
  const outcome=await request;assert(!outcome.error);assert.equal(outcome.value.status,200);assert.equal(outcome.value.body.reason,'CANCELLED')
  const cleanup=readCleanup(dir);assert.equal(cleanup.status,'PASS')
  const at=label=>cleanup.steps.findIndex(step=>step.label===label)
  assert(at('rollback owned observer')>=0&&at('rollback owned observer')<at('drain owned HTTP'))
  assert(at('unlock owned observer')>=0&&at('unlock owned observer')<at('drain owned HTTP'))
  await catalogEmpty();pass(active)
 }
}catch(error){primaryError=error;report.failedAt=active;report.errorName=error?.name??'UnknownError'}
await finishReclamationRun({report,primaryError,close:async()=>{if(activeFixture)await activeFixture.close()},verifySource,save})
console.log('PASS_RECLAMATION_FIXTURE_LIFECYCLE',report.cases.length)
