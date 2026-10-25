// Actual TypeScript store against real PG17 (HTTP adaptation is deliberately
// synthetic here; the separate pinned PostgREST test owns the wire proof).
import assert from 'node:assert/strict'
import {createTransactionalWorkspaceStore} from '../../gateway/transactionalWorkspaceStore.ts'
import {emptyGmailRun,EMPTY_GMAIL_OBSERVATION} from '../../gateway/emptyGmailCheckpoint.ts'
import {applyGmailSemanticBatch} from '../../src/gmailSemanticIntake.ts'
import {summarizeSourceHealth} from '../../src/sourceHealth.ts'
import {hashMutationPayload} from '../../gateway/mutationKernel.ts'
import {seed,raw,logical,full,checkpointQuery} from './gmail-empty-checkpoint-fixture.mjs'
const wire=value=>JSON.parse(JSON.stringify(value))
export async function proveGateway(db){
 await db.query('reset role');const w=await seed(db,50001);await db.query('set role service_role');const original=await raw(db,w.user),at=new Date().toISOString(),id=`gmail:auto:${at}`
 const canonical=(await db.query('select pjsdas_empty_gmail_run_v1($1,$2,$3) r',[id,at,'1234'])).rows[0].r;assert.deepEqual(canonical,wire(emptyGmailRun(id,at,'1234')))
 const payloadHash=await hashMutationPayload('gmail_semantic_intake',{sourceId:'gmail:primary',recordIds:[]})
 let onBaseRead,queries=[]
 const fetchImpl=async(input,init)=>{const u=new URL(String(input));queries.push(u.pathname+u.search)
  if(u.pathname.endsWith('/pjsdas_checkpoint_empty_gmail_poll_v1')){const p=JSON.parse(init.body);const args=['target_user_id','target_execution_token','target_command_id','target_payload_hash','target_expected_revision','target_checked_at','target_history_id','target_observation'].map(k=>p[k]);args[7]=JSON.stringify(args[7]);const result=await db.query(checkpointQuery,args);return Response.json(result.rows.map(r=>({...r,revision:r.revision===null?null:Number(r.revision)})))}
  if(u.pathname.endsWith('/pjsdas_workspaces')){const row=await raw(db,w.user);if(onBaseRead)await onBaseRead();return Response.json([{...row,revision:Number(row.revision),materialized_revision:Number(row.materialized_revision)}])}
  if(u.pathname.endsWith('/pjsdas_command_ledger')){const bounds=/gt\.(\d+),resulting_revision.lte\.(\d+)/.exec(u.searchParams.get('and'));assert.ok(bounds);const rows=(await db.query('select * from pjsdas_command_ledger where user_id=$1 and resulting_revision>$2 and resulting_revision<=$3 and gmail_empty_poll_run is not null order by resulting_revision',[w.user,bounds[1],bounds[2]])).rows;return Response.json(rows.map(r=>({...r,resulting_revision:Number(r.resulting_revision)})))}
  throw Error('Unexpected synthetic endpoint')
 }
 const options={supabaseUrl:'https://synthetic.invalid',serviceRoleKey:'synthetic',fetchImpl,emptyGmailCheckpointReads:true}
 const writer=createTransactionalWorkspaceStore({...options,emptyGmailCheckpoints:true}),reader=createTransactionalWorkspaceStore({...options,emptyGmailCheckpoints:false})
 const input={userId:w.user,executionToken:w.token,commandId:id,payloadHash,expectedRevision:0,checkedAt:at,historyId:'1234',observation:EMPTY_GMAIL_OBSERVATION}
 const committed=await writer.checkpointEmptyGmailPollForUser(input);assert.equal(committed.outcome,'COMMITTED');assert.equal(committed.revision,1)
 const expected=wire(applyGmailSemanticBatch(original.snapshot,{runId:id,checkedAt:at,sourceId:'gmail:primary',cursor:'1234',records:[],authorized:true}).snapshot)
 const read=await reader.readForUser(w.user,{preserveRawData:true});assert.deepEqual(read.snapshot,expected);assert.equal(read.revision,1);assert.deepEqual(summarizeSourceHealth(read.snapshot.data.timeline,new Date(at)),summarizeSourceHealth(expected.data.timeline,new Date(at)))
 // Freeze a raw revision-1 read, absorb it concurrently, then query the original
 // immutable ledger window. The returned snapshot/revision remain paired.
 onBaseRead=async()=>{onBaseRead=undefined;await full(db,3,w,'concurrent-materialize',1,(await logical(db,w.user)).snapshot)}
 const racing=await reader.readForUser(w.user,{preserveRawData:true});assert.equal(racing.revision,1);assert.deepEqual(racing.snapshot,expected);assert.equal(Number((await raw(db,w.user)).revision),2)
 const replay=await writer.checkpointEmptyGmailPollForUser(input);assert.equal(replay.outcome,'ALREADY_APPLIED');assert.equal(replay.revision,2);assert.deepEqual(replay.receipt,committed.receipt)
 const latest=await reader.readForUser(w.user,{preserveRawData:true});assert.equal(latest.revision,2);assert.deepEqual(latest.snapshot,expected)
 assert.equal((await reader.checkpointEmptyGmailPollForUser(input)).outcome,'NOT_ELIGIBLE')
 console.log('PASS actual TS + native PG17: canonical semantic run, immutable receipt/hash, complete source health, frozen read-window absorption race, latest replay read, readers retained with writers disabled.')
}
