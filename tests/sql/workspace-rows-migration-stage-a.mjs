// Local-only transaction/capacity experiment. This is NOT a production migration
// runner or a new API. A real deployment needs a separately reviewed transport,
// exact DDL/ACL/lock/capacity plan, compatible releases and explicit approval.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { upgradeSnapshotToLatest } from '../../src/snapshot.ts'
import { encodeWorkspaceRows,decodeWorkspaceRows,diffWorkspaceRows } from '../../gateway/workspaceRowsCodec.ts'
const wire=value=>JSON.parse(JSON.stringify(value))
const equal=(a,b)=>assert(isDeepStrictEqual(wire(a),wire(b)),'migration complete JSON-wire equality')

async function migrateAtomic(client,userId,expectedRevision,hook=async()=>{}) {
 const identity=(await client.query('select current_database() db,host(inet_server_addr()) host')).rows[0]
 assert(/^ta_row_candidate_[0-9a-f]{32}$/.test(identity.db)&&['127.0.0.1','::1'].includes(identity.host),'only owned isolated loopback fixture allowed')
 await client.query('begin')
 try {
  const old=(await client.query('select * from public.pjsdas_workspaces where user_id=$1 for update',[userId])).rows[0]
  assert(old,'workspace required')
  if(old.row_candidate_epoch) {
   const head=(await client.query('select id,user_id,epoch,revision from pjsdas_rows_candidate.head where user_id=$1',[userId])).rows[0]
   assert(head&&head.id===old.id&&head.epoch===old.row_candidate_epoch)
   await client.query('commit');return {outcome:'ALREADY_ACTIVE',epoch:head.epoch,revision:Number(head.revision)}
  }
  assert.equal(Number(old.revision),expectedRevision,'migration revision CAS')
  assert.equal(old.schema_version,4,'only current schema eligible')
  const logical=(await client.query('select public.pjsdas_logical_workspace_snapshot_v1(w) snapshot from public.pjsdas_workspaces w where user_id=$1',[userId])).rows[0].snapshot
  equal(logical,upgradeSnapshotToLatest(logical)) // Never silently normalize raw facts at cutover.
  assert.equal((await client.query('select coalesce(max(octet_length(to_jsonb(l)::text)),0)<=2097150 eligible from public.pjsdas_command_ledger l where user_id=$1 and workspace_id=$2',[userId,old.id])).rows[0].eligible,true,'retained audit row eligibility')
  assert(Buffer.byteLength(JSON.stringify(logical))<=33_554_432,'bounded candidate eligibility')
  const encoded=encodeWorkspaceRows(logical)
  assert(Buffer.byteLength(JSON.stringify(encoded.envelope))<=1_048_576,'bounded candidate header')
  await hook('before_head',client)
  const head=(await client.query('insert into pjsdas_rows_candidate.head(id,user_id,revision,envelope,manifest,legacy_snapshot,schema_version) values($1,$2,$3,$4,$5,$6,$7) returning epoch',[old.id,userId,old.revision,encoded.envelope,JSON.stringify(encoded.manifest),old.snapshot,old.schema_version])).rows[0]
  await hook('after_head',client)
  let chunk=[],chunkBytes=2,firstPage=true
  const flush=async()=>{
   if(!chunk.length)return
   await client.query('insert into pjsdas_rows_candidate.item select $1,$2,x.collection,x.id,x.ordinal,x.value,$4 from jsonb_to_recordset($3) as x(collection text,id text,ordinal bigint,value jsonb)',[old.id,userId,JSON.stringify(chunk),old.revision])
   if(firstPage){firstPage=false;await hook('after_first_page',client)}
   chunk=[];chunkBytes=2
  }
  for(const row of encoded.rows){
   const bytes=Buffer.byteLength(JSON.stringify(row));assert(bytes<=1_048_574,'bounded candidate entity')
   if(chunk.length===127||chunkBytes+bytes+1>1_048_576)await flush()
   chunk.push(row);chunkBytes+=bytes+1
  }
  await flush();await hook('after_rows',client)
  const copied=[];let collection=null,ordinal=null,ended=false
  for(let page=0;page<1024;page++){
   const value=(await client.query('select pjsdas_rows_candidate.read_page($1,$2,$3,$4,$5,$6) page',[userId,old.id,head.epoch,old.revision,collection,ordinal])).rows[0].page
   assert.equal(value.outcome,'PAGE');copied.push(...value.rows)
   if(value.end){ended=true;break}
   assert(value.rows.length>0);collection=value.rows.at(-1).collection;ordinal=value.rows.at(-1).ordinal
  }
  assert(ended,'bounded readback must complete before activation')
  const saved=(await client.query('select envelope,manifest from pjsdas_rows_candidate.head where id=$1',[old.id])).rows[0]
  equal(decodeWorkspaceRows({contract:'workspace-rows-v1',...saved,rows:copied}),logical)
  assert.equal((await client.query('select pjsdas_rows_candidate.valid_state($1) valid',[old.id])).rows[0].valid,true)
  await hook('after_verify',client)
  assert.equal((await client.query('update public.pjsdas_workspaces set row_candidate_epoch=$2 where id=$1 and revision=$3 and row_candidate_epoch is null returning id',[old.id,head.epoch,old.revision])).rowCount,1)
  await hook('after_marker',client)
  await client.query('commit')
  await hook('after_commit',client)
  return {outcome:'ACTIVATED',epoch:head.epoch,revision:Number(old.revision)}
 } catch(error) {await client.query('rollback').catch(()=>{});throw error}
}

export async function testAtomicMigrationAndCapacity({db,connectionString,initial}) {
 const seed=async(snapshot=initial)=>{const userId=randomUUID();await db.query('insert into auth.users(id) values($1)',[userId]);await db.query('insert into public.pjsdas_workspaces(user_id,snapshot,schema_version) values($1,$2,4)',[userId,snapshot]);return userId}
 const unchanged=async userId=>{
  const old=(await db.query('select row_candidate_epoch,revision,snapshot from public.pjsdas_workspaces where user_id=$1 for update',[userId])).rows[0]
  assert.equal(old.row_candidate_epoch,null);assert.equal(Number(old.revision),0);equal(old.snapshot,initial)
  assert.equal((await db.query('select count(*)::int n from pjsdas_rows_candidate.head where user_id=$1',[userId])).rows[0].n,0)
  assert.equal((await db.query('select count(*)::int n from pjsdas_rows_candidate.item where user_id=$1',[userId])).rows[0].n,0)
 }
 // Transaction failures and actual connection loss at every durable boundary.
 for(const point of ['before_head','after_head','after_first_page','after_rows','after_verify','after_marker']) {
  const userId=await seed(),client=new pg.Client({connectionString});await client.connect();let closed=false,reached=false,failure
  try {
   await assert.rejects(migrateAtomic(client,userId,0,async phase=>{if(phase===point){reached=true;await client.end();closed=true;throw new Error('Synthetic migration connection loss')}}),error=>{failure=error;return true})
   if(!reached)throw failure
   assert(reached,'intended migration disconnect boundary must actually be reached: '+point)
   await unchanged(userId)
  } finally {if(!closed)await client.end()}
 }
 const owner=await seed(),client=new pg.Client({connectionString});await client.connect()
 try {
  await assert.rejects(migrateAtomic(client,owner,0,async phase=>{if(phase==='after_commit')throw new Error('Synthetic lost activation acknowledgement')}))
  const recovered=await migrateAtomic(client,owner,0);assert.equal(recovered.outcome,'ALREADY_ACTIVE')
  const rows=(await db.query('select collection,id,ordinal::int ordinal,value from pjsdas_rows_candidate.item where user_id=$1 order by collection,ordinal',[owner])).rows
  const head=(await db.query('select envelope,manifest from pjsdas_rows_candidate.head where user_id=$1',[owner])).rows[0]
  equal(decodeWorkspaceRows({contract:'workspace-rows-v1',...head,rows}),initial)
  assert.equal((await db.query('select count(*)::int n from public.pjsdas_command_ledger where user_id=$1',[owner])).rows[0].n,0)
 } finally {await client.end()}
 // Existing writers that win before admission cannot be erased by a stale stage.
 const stale=await seed();await db.query('update public.pjsdas_workspaces set revision=1 where user_id=$1',[stale])
 await assert.rejects(migrateAtomic(db,stale,0),/revision CAS/)
 assert.equal((await db.query('select row_candidate_epoch from public.pjsdas_workspaces where user_id=$1',[stale])).rows[0].row_candidate_epoch,null)
 const oversized=await seed(),oversizedWorkspace=(await db.query('select id from public.pjsdas_workspaces where user_id=$1',[oversized])).rows[0].id
 await db.query("insert into public.pjsdas_command_ledger(workspace_id,user_id,command_id,operation,payload_hash,principal_kind,status,resulting_revision,receipt) values($1,$2,'synthetic-oversize-audit','synthetic_core',$3,'first_party_web','COMMITTED',0,$4)",[oversizedWorkspace,oversized,'e'.repeat(64),{syntheticPadding:'x'.repeat(2_100_000)}])
 await assert.rejects(migrateAtomic(db,oversized,0),/retained audit row eligibility/);await unchanged(oversized)
 console.log('PASS atomic local migration: exact readback before cutover, six real disconnect boundaries roll back all rows/marker, lost acknowledgement resumes without reimport, stale revision refuses')
 // Fresh physical clones avoid attributing shared-table free space to one owner.
 // LIKE copies the indexes/storage/column constraints; it does not model FK
 // query overhead, runtime load, future ledger growth, or production headroom.
 await db.query('create schema pjsdas_rows_resource_fixture')
 for(const [name,source] of [['blob','public.pjsdas_workspaces'],['head','pjsdas_rows_candidate.head'],['item','pjsdas_rows_candidate.item'],['ledger','pjsdas_rows_candidate.ledger']])await db.query(`create table pjsdas_rows_resource_fixture.${name}(like ${source} including all)`)
 const userId=randomUUID(),workspaceId=randomUUID(),encoded=encodeWorkspaceRows(initial)
 await db.query('insert into pjsdas_rows_resource_fixture.blob(id,user_id,snapshot,schema_version) values($1,$2,$3,4)',[workspaceId,userId,initial])
 await db.query('insert into pjsdas_rows_resource_fixture.head(id,user_id,envelope,manifest,legacy_snapshot) values($1,$2,$3,$4,$5)',[workspaceId,userId,encoded.envelope,JSON.stringify(encoded.manifest),initial])
 for(let i=0;i<encoded.rows.length;i+=127)await db.query('insert into pjsdas_rows_resource_fixture.item select $1,$2,x.collection,x.id,x.ordinal,x.value,0 from jsonb_to_recordset($3) as x(collection text,id text,ordinal bigint,value jsonb)',[workspaceId,userId,JSON.stringify(encoded.rows.slice(i,i+127))])
 const sizes=(await db.query("select c.relname name,pg_total_relation_size(c.oid)::text bytes from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='pjsdas_rows_resource_fixture' and c.relkind='r' order by c.relname")).rows
 const values=Object.fromEntries(sizes.map(x=>[x.name,Number(x.bytes)]))
 assert(values.blob>0&&values.head>0&&values.item>0)
 console.log(JSON.stringify({syntheticCapacity:{jsonBytes:Buffer.byteLength(JSON.stringify(initial)),rows:encoded.rows.length,tableToastIndexBytes:values,totalRetainedLayoutBytes:Object.values(values).reduce((a,b)=>a+b,0),includesBothOriginalBlobAndHeadLegacyCopy:true,productionEstimate:false}}))
 // Measure the actual candidate with its new safety scans; do not reuse an
 // earlier primitive-only WAL result as if it covered the complete contract.
 const current=(await db.query('select id,epoch,revision from pjsdas_rows_candidate.head where user_id=$1',[owner])).rows[0]
 const after=structuredClone(initial);after.data.timeline[0].detail+=' Synthetic bounded update.'
 const req={...diffWorkspaceRows(initial,after),workspaceId:current.id,userId:owner,expectedEpoch:current.epoch,expectedRevision:Number(current.revision),commandId:'synthetic-resource-update',payloadHash:'f'.repeat(64),operation:'synthetic_trusted_core',principal:'first_party_web',compensation:null,schemaVersion:4}
 const measure=async(sql,params)=>{await db.query('begin');await db.query("set local work_mem='2MB'");try{const plan=(await db.query('explain (analyze,buffers,wal,format json) '+sql,params)).rows[0]['QUERY PLAN'][0];return {executionMs:plan['Execution Time'],tempRead:plan.Plan['Temp Read Blocks'],tempWritten:plan.Plan['Temp Written Blocks'],walBytes:plan.Plan['WAL Bytes']}}finally{await db.query('rollback')}}
 console.log(JSON.stringify({syntheticCompleteCandidateUpdate:await measure('select public.pjsdas_rows_v1_commit_authoritative($1)',[req]),syntheticRetainedBlobUpdate:await measure('update pjsdas_rows_resource_fixture.blob set snapshot=$1 where id=$2',[after,workspaceId]),productionEstimate:false}))

}
