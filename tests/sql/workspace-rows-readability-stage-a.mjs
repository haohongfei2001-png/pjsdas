// Synthetic failure-first safety probe: an accepted write must stay readable.
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createSnapshot} from '../../src/snapshot.ts'
import {encodeWorkspaceRows,diffWorkspaceRows} from '../../gateway/workspaceRowsCodec.ts'
import {createWorkspaceRowsCandidate} from '../../gateway/workspaceRowsCandidate.ts'
export async function testAcceptedReadability({db,origin,token}) {
 const failures=[]
 for(const kind of ['header','single-row','page']) {
  const snapshot=createSnapshot({opportunities:[],processes:[],processEvents:[],actions:[],prep:[],applicationGroups:[],timeline:[]},'2030-01-01T00:00:00.000Z')
  const userId=randomUUID(),encoded=encodeWorkspaceRows(snapshot)
  await db.query('insert into auth.users(id) values($1)',[userId])
  const workspaceId=(await db.query('insert into public.pjsdas_workspaces(user_id,snapshot,schema_version) values($1,$2,4) returning id',[userId,snapshot])).rows[0].id
  const epoch=(await db.query('insert into pjsdas_rows_candidate.head(id,user_id,envelope,manifest,legacy_snapshot) values($1,$2,$3,$4,$5) returning epoch',[workspaceId,userId,encoded.envelope,JSON.stringify(encoded.manifest),snapshot])).rows[0].epoch
  await db.query('update public.pjsdas_workspaces set row_candidate_epoch=$2 where id=$1',[workspaceId,epoch])
  const source=createWorkspaceRowsCandidate({supabaseUrl:origin,serviceRoleKey:token,readsEnabled:true,writesEnabled:true,rpcTransport:'public-v1',fetchImpl:(url,init)=>fetch(String(url).replace('/rest/v1/','/'),init)})
  const before=await source.read(userId),after=structuredClone(snapshot)
  if(kind==='header')after.syntheticPadding='x'.repeat(1_100_000)
  else after.data.timeline=Array.from({length:kind==='page'?120:1},(_,i)=>({id:'synthetic-read-bound:'+i,kind:'baseline_backfill',category:'data',source:'system',occurredAt:snapshot.exportedAt,recordedAt:snapshot.exportedAt,title:'Synthetic bound',detail:'x'.repeat(kind==='page'?10_000:1_100_000)}))
  let accepted=false
  try { const result=await source.commitAuthoritative(before,after,{commandId:'synthetic-read-bound:'+kind,payloadHash:'b'.repeat(64),operation:'synthetic_trusted_core',principal:'first_party_web',compensation:null});accepted=result.outcome==='COMMITTED' } catch(error) {if(error.code!=='INVALID'&&error.code!=='UNSUPPORTED')throw error}
  if(kind==='page')assert.equal(accepted,true,'ordinary bounded rows must split pages, not be rejected as one large page')
  if(!accepted) {
   const req={...diffWorkspaceRows(snapshot,after),workspaceId,userId,expectedEpoch:epoch,expectedRevision:0,commandId:'synthetic-direct-bound:'+kind,payloadHash:'c'.repeat(64),operation:'synthetic_trusted_core',principal:'first_party_web',compensation:null}
   const response=await fetch(origin+'/rpc/pjsdas_rows_v1_commit_authoritative',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({req})})
   assert.equal(response.status,400,'SQL must independently reject an unreadable postimage atomically')
   assert.equal((await db.query('select count(*)::int n from pjsdas_rows_candidate.ledger where user_id=$1',[userId])).rows[0].n,0)
  }
  try {const current=await source.read(userId);assert.deepEqual(current.snapshot,accepted?after:snapshot)}catch(error){failures.push({kind,accepted,error:error.code??error.message})}
 }
 assert.deepEqual(failures,[],'accepted candidate writes must not create unreadable states')
 console.log('PASS candidate read bounds: accepted headers/entities/pages remain readable; rejected writes leave exact state')
}

export async function testHistoryReadability({db,origin,token}) {
 const failures=[]
 for(const kind of ['single-history','history-page','cycle-history']) {
  const snapshot=createSnapshot({opportunities:[],processes:[],processEvents:[],actions:[],prep:[],applicationGroups:[],timeline:[]},'2030-01-01T00:00:00.000Z')
  const userId=randomUUID(),encoded=encodeWorkspaceRows(snapshot)
  await db.query('insert into auth.users(id) values($1)',[userId])
  const workspaceId=(await db.query('insert into public.pjsdas_workspaces(user_id,snapshot,schema_version) values($1,$2,4) returning id',[userId,snapshot])).rows[0].id
  const epoch=(await db.query('insert into pjsdas_rows_candidate.head(id,user_id,envelope,manifest,legacy_snapshot) values($1,$2,$3,$4,$5) returning epoch',[workspaceId,userId,encoded.envelope,JSON.stringify(encoded.manifest),snapshot])).rows[0].epoch
  await db.query('update public.pjsdas_workspaces set row_candidate_epoch=$2 where id=$1',[workspaceId,epoch])
  const source=createWorkspaceRowsCandidate({supabaseUrl:origin,serviceRoleKey:token,readsEnabled:true,writesEnabled:true,rpcTransport:'public-v1',fetchImpl:(url,init)=>fetch(String(url).replace('/rest/v1/','/'),init)})
  const count=kind==='single-history'?1:40
  for(let i=0;i<count;i++){
   const before=await source.read(userId)
   await source.commitAuthoritative(before,snapshot,{commandId:'synthetic-history-bound:'+i,payloadHash:'d'.repeat(64),operation:'synthetic_trusted_core',principal:kind==='cycle-history'?'automation':'first_party_web',compensation:null,provenance:kind==='cycle-history'?{sourceId:'synthetic-source',scopeFingerprint:'a'.repeat(64),searchPlanFingerprint:'b'.repeat(64),searchCycleId:'c'.repeat(64),producer:'server_scheduler'}:{},receiptContext:{syntheticPadding:'x'.repeat(kind==='single-history'?1_100_000:70_000)}})
  }
  await db.query("set work_mem='2MB'")
  const query=kind==='single-history'?{mode:'command',commandId:'synthetic-history-bound:0'}:kind==='cycle-history'?{mode:'discovery_scope',sourceId:'synthetic-source',scopeFingerprint:'a'.repeat(64),planFingerprint:'b'.repeat(64),cycleId:'c'.repeat(64)}:{mode:'after',afterRevision:0,cursorRevision:0,cursorCommand:''}
  const plan=(await db.query('explain (analyze,buffers,format json) select public.pjsdas_rows_v1_read_history($1,$2,$3,$4)',[userId,epoch,count,query])).rows[0]['QUERY PLAN'][0]
  console.log(JSON.stringify({syntheticHistoryRead:{kind,executionMs:plan['Execution Time'],tempRead:plan.Plan['Temp Read Blocks'],tempWritten:plan.Plan['Temp Written Blocks'],workMem:'2MB'},productionEstimate:false}))
  if(kind==='single-history') {
   const before=await source.read(userId)
   await assert.rejects(source.commitAuthoritative(before,snapshot,{commandId:'synthetic-oversized-history',payloadHash:'e'.repeat(64),operation:'synthetic_'.repeat(25_000),principal:'first_party_web',compensation:null,receiptContext:{syntheticPadding:'x'.repeat(1_700_000)}}),error=>error.code==='INVALID')
   assert.equal((await source.read(userId)).revision,count,'oversized audit refusal rolls back revision and effects')
   assert.equal((await db.query('select count(*)::int n from pjsdas_rows_candidate.ledger where user_id=$1',[userId])).rows[0].n,count)
  }
  try {const history=await source.readHistory(userId,epoch,kind==='single-history'?{mode:'command',commandId:'synthetic-history-bound:0'}:kind==='cycle-history'?{mode:'discovery_scope',sourceId:'synthetic-source',scopeFingerprint:'a'.repeat(64),planFingerprint:'b'.repeat(64),cycleId:'c'.repeat(64)}:{mode:'after',afterRevision:0});assert.equal(history.rows.length,count);if(kind==='cycle-history')assert.deepEqual(history.rows.map(x=>x.resulting_revision),Array.from({length:count},(_,i)=>count-i))}catch(error){failures.push({kind,error:error.code??error.message})}
 }
 assert.deepEqual(failures,[],'accepted audit records must remain available to command lookup and Undo history')
 console.log('PASS actual bounded history: large individual immutable receipt and byte-paged Undo history retain every accepted command')
}
