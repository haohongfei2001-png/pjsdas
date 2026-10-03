// Synthetic-only bidirectional receipt-family and actual row-lock races.
import pg from 'pg'
import assert from 'node:assert/strict'
import { unknownDeadlineWorkspace } from '../fixtures/unknownDeadlineWorkspace.ts'
import { applyBusinessManagement, restoreBusinessManagement } from '../../src/businessManagement.ts'
import { hashMutationPayload } from '../../gateway/mutationKernel.ts'
const url=new URL(process.env.TA_MANAGEMENT_SQL_TEST_URL??'http://missing.invalid')
if(url.protocol!=='postgresql:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/ta_management_fixture'||url.username!=='postgres'||url.password!=='fixture-only'||url.search)throw new Error('Only isolated loopback synthetic fixture is accepted.')
pg.types.setTypeParser(20,Number)
const connections=Object.fromEntries(['observer','blocker','first','second'].map(name=>[name,new pg.Client({connectionString:url.toString(),application_name:`ta-replay-${name}`,statement_timeout:15000})]))
const {observer,blocker,first,second}=connections
const owner='00000000-0000-4000-8000-000000007001',client='00000000-0000-4000-8000-000000007002',grants={2:'00000000-0000-4000-8000-000000007003',7:'00000000-0000-4000-8000-000000007004'}
const fn=version=>version===7?'pjsdas_commit_consumer_business_workspace_v1':'pjsdas_commit_management_workspace_v1'
const state=async()=>(await observer.query('select snapshot,revision from public.pjsdas_workspaces where user_id=$1',[owner])).rows[0]
const proof=async version=>(await observer.query('select revision from public.pjsdas_business_management_grants where id=$1',[grants[version]])).rows[0].revision
async function body(version,id,undoTarget){
 const current=await state(),change={operations:[{kind:'create_prep',value:{title:'Synthetic family proof',estimatedMinutes:30}}]}
 const target=undoTarget?(await observer.query('select compensation from public.pjsdas_command_ledger where user_id=$1 and command_id=$2',[owner,undoTarget])).rows[0]:undefined
 const evaluated=undoTarget?{snapshot:restoreBusinessManagement(current.snapshot,target.compensation),compensation:{}}:applyBusinessManagement(current.snapshot,change,id)
 const operation=undoTarget?'undo_command':'business_management',hashOperation=version===7?(undoTarget?'consumer_business_management_undo_v7':'consumer_business_management_v7'):operation
 return{target_user_id:owner,target_command_id:id,target_operation:operation,target_payload_hash:await hashMutationPayload(hashOperation,undoTarget?{targetCommandId:undoTarget}:{type:'business_management',value:change}),target_expected_revision:current.revision,target_snapshot:evaluated.snapshot,target_schema_version:current.snapshot.version,target_principal_kind:'delegated_mcp',target_client_id:client,target_provenance:undoTarget?{undoOf:undoTarget}:{},target_compensation:evaluated.compensation,target_effective_time:null,target_receipt_context:{},target_grant_id:grants[version],target_grant_revision:await proof(version)}
}
function call(db,version,b){const keys=Object.keys(b);return db.query(`select * from public.${fn(version)}(${keys.map((k,i)=>`${k}=>$${i+1}`).join(',')})`,keys.map(k=>typeof b[k]==='object'&&b[k]!==null?JSON.stringify(b[k]):b[k]))}
const track=p=>{const s={settled:false};s.result=p.then(value=>{s.settled=true;return{value}},error=>{s.settled=true;return{error}});return s}
async function locked(name,pending){const end=Date.now()+10000;while(Date.now()<end){if((await observer.query("select 1 from pg_stat_activity where application_name=$1 and wait_event_type='Lock'",[`ta-replay-${name}`])).rowCount){assert.equal(pending.settled,false);return}if(pending.settled)throw (await pending.result).error??new Error('Expected controlled row lock');await new Promise(r=>setTimeout(r,20))}throw new Error('Controlled lock was not reached')}
try{
 await Promise.all(Object.values(connections).map(c=>c.connect()))
 await observer.query('insert into auth.users(id)values($1)',[owner]);await observer.query('insert into public.pjsdas_workspaces(user_id,snapshot,schema_version)values($1,$2,4)',[owner,JSON.stringify(unknownDeadlineWorkspace(0))])
 for(const version of [2,7])await observer.query('insert into public.pjsdas_business_management_grants(id,user_id,client_id,capability,consent_version,consent_text_hash)values($1,$2,$3,$4,$5,$6)',[grants[version],owner,client,version===7?'workspace.business.manage':'workspace.manage',version,version===7?'22626aea373e4e8eb51a90ee4b548c5f3aeeee4bbe58e77b418a0645138edb34':'b'.repeat(64)])
 await first.query('set role service_role');await second.query('set role service_role')
 const legacy=await body(2,'legacy-family-command');assert.equal((await call(first,2,legacy)).rows[0].outcome,'COMMITTED')
 const consumer=await body(7,'consumer-family-command');assert.equal((await call(first,7,consumer)).rows[0].outcome,'COMMITTED')
 const unchanged=await state()
 for(const [caller,record]of [[7,legacy],[2,consumer]])await assert.rejects(call(second,caller,{...record,target_grant_id:grants[caller],target_grant_revision:await proof(caller)}),e=>e.code==='23505')
 assert.deepEqual(await state(),unchanged)
 assert.equal((await call(first,2,legacy)).rows[0].outcome,'ALREADY_APPLIED');assert.equal((await call(first,7,consumer)).rows[0].outcome,'ALREADY_APPLIED')
 await observer.query('update public.pjsdas_business_management_grants set revoked_at=now() where id=$1',[grants[7]]);await observer.query('update public.pjsdas_business_management_grants set revoked_at=null where id=$1',[grants[7]])
 await assert.rejects(call(first,7,consumer),e=>e.code==='42501');consumer.target_grant_revision=await proof(7)
 assert.equal((await call(first,7,consumer)).rows[0].outcome,'ALREADY_APPLIED')
 console.log('PASS direct RPC family replay: v2/v7 cannot replay each other even with matching supplied hashes; true retry survives fresh explicit regrant, stale proof fails.')
 const legacyUndo=await body(2,'legacy-family-undo',legacy.target_command_id)
 await assert.rejects(call(second,7,{...legacyUndo,target_grant_id:grants[7],target_grant_revision:await proof(7)}),e=>e.code==='42501')
 assert.equal((await call(first,2,legacyUndo)).rows[0].outcome,'COMMITTED')
 const consumerUndo=await body(7,'consumer-family-undo',consumer.target_command_id)
 await assert.rejects(call(second,2,{...consumerUndo,target_grant_id:grants[2],target_grant_revision:await proof(2)}),e=>e.code==='42501')
 assert.equal((await call(first,7,consumerUndo)).rows[0].outcome,'COMMITTED')
 for(const [caller,ownUndo,otherUndo]of [[7,consumerUndo,legacyUndo],[2,legacyUndo,consumerUndo]])await assert.rejects(call(second,caller,{...ownUndo,target_command_id:otherUndo.target_command_id,target_payload_hash:otherUndo.target_payload_hash}),e=>e.code==='23505')
 assert.equal((await call(first,2,legacyUndo)).rows[0].outcome,'ALREADY_APPLIED');assert.equal((await call(first,7,consumerUndo)).rows[0].outcome,'ALREADY_APPLIED')
 console.log('PASS direct undo target and undo-ID collisions are fenced in both directions; valid same-family undo retries remain historical.')
 // Matching scalar text is insufficient: malformed string "7" is not version7.
 await observer.query("update public.pjsdas_command_ledger set receipt=jsonb_set(receipt,'{managementAuthorization,consentVersion}','\"7\"'::jsonb) where user_id=$1 and command_id=$2",[owner,consumer.target_command_id])
 await assert.rejects(call(first,7,consumer),e=>e.code==='23505')
 await observer.query("update public.pjsdas_command_ledger set receipt=jsonb_set(receipt,'{managementAuthorization,consentVersion}','7'::jsonb) where user_id=$1 and command_id=$2",[owner,consumer.target_command_id])
 for(const leading of [2,7]){
  const trailing=leading===2?7:2,id=`inflight-family-race-${leading}`,before=await state(),a=await body(leading,id),b=await body(trailing,id)
  // The RPC must inspect committed family independently of supplied hash text.
  b.target_payload_hash=a.target_payload_hash
  await blocker.query('begin');await blocker.query('select id from public.pjsdas_workspaces where user_id=$1 for update',[owner])
  const pendingFirst=track(call(first,leading,a));await locked('first',pendingFirst)
  const pendingSecond=track(call(second,trailing,b));await locked('second',pendingSecond)
  await blocker.query('commit');const won=await pendingFirst.result;assert.ifError(won.error);assert.equal(won.value.rows[0].outcome,'COMMITTED')
  assert.equal((await pendingSecond.result).error?.code,'23505');assert.equal((await state()).revision,before.revision+1)
  const row=(await observer.query('select receipt from public.pjsdas_command_ledger where user_id=$1 and command_id=$2',[owner,id])).rows
  assert.equal(row.length,1);assert.equal(row[0].receipt.managementAuthorization.consentVersion,leading)
  console.log(`PASS in-flight v${leading}->v${trailing} same-ID race: second transaction conflicts after the first family commits, one ledger entry.`)
 }
}finally{await Promise.allSettled([blocker.query('rollback'),first.query('rollback'),second.query('rollback')]);await Promise.allSettled(Object.values(connections).map(c=>c.end()))}
