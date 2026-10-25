import assert from 'node:assert/strict'
import {seed,checkpoint,checkpointArgs,checkpointQuery,raw,logical,full,snapshot} from './gmail-empty-checkpoint-fixture.mjs'
export async function proveBoundaries(db){
 const seedAdmin=async(n,state)=>{await db.query('reset role');const w=await seed(db,n,state);await db.query('set role service_role');return w}
 // Two actual ASCII FNV32 collisions, entirely synthetic dates/commands.
 const times=['2026-06-16T05:28:00.600Z','2026-07-21T15:57:24.158Z'],colliding=[]
 for(const at of times)colliding.push((await db.query('select pjsdas_empty_gmail_run_v1($1,$2,$3) r',[`gmail:auto:${at}`,at,'1234'])).rows[0].r)
 assert.equal(colliding[0].id,colliding[1].id);assert.notDeepEqual(colliding[0],colliding[1])
 // SQL independently enforces cursor/continuation/backfill/time proof;
 // a caller cannot merely assert the observation booleans.
 let negativeId=41000
 for(const change of ["gmail_history_id='1235'","gmail_sync_mode='history'","gmail_page_token='fixture-page'","gmail_pending_history_id='1234'","gmail_pending_message_ids=array['fixture-message']"]){const w=await seedAdmin(negativeId++);await db.query(`update google_drive_connections set ${change} where user_id=$1`,[w.user]);await db.query("update gmail_automation_execution_state e set binding_updated_at=c.updated_at,lease_token=$2,lease_expires_at=clock_timestamp()+interval '120 seconds',started_at=clock_timestamp()-interval '1 second' from google_drive_connections c where e.user_id=c.user_id and e.user_id=$1",[w.user,w.token]);assert.equal((await checkpoint(db,w,0)).outcome,'NOT_ELIGIBLE');assert.equal(Number((await raw(db,w.user)).revision),0)}
 const missing=snapshot();missing.data.timeline=[];const noBoundary=await seedAdmin(negativeId++,missing);assert.equal((await checkpoint(db,noBoundary,0)).outcome,'NOT_ELIGIBLE')
 for(const offset of [-60000,60000]){const w=await seedAdmin(negativeId++);await assert.rejects(checkpoint(db,w,0,new Date(Date.now()+offset).toISOString()),e=>e.code==='22023');assert.equal(Number((await raw(db,w.user)).revision),0)}
 for(const [key,value]of Object.entries({mode:'scan',coverageComplete:false,fetchedCount:1,unavailableCount:1,sourceRecordCount:1,hasContinuation:true,hasRecoveryGap:true,backfillComplete:false})){const w=await seedAdmin(negativeId++),args=checkpointArgs(w,0);args[7]=JSON.stringify({...JSON.parse(args[7]),[key]:value});assert.equal((await db.query(checkpointQuery,args)).rows[0].outcome,'NOT_ELIGIBLE');assert.equal(Number((await raw(db,w.user)).revision),0)}
 for(const columnValue of ["started_at=null","started_at='-infinity'::timestamptz","started_at='infinity'::timestamptz","lease_expires_at='infinity'::timestamptz","binding_updated_at=null"]){const w=await seedAdmin(negativeId++);await db.query(`update gmail_automation_execution_state set ${columnValue} where user_id=$1`,[w.user]);await assert.rejects(checkpoint(db,w,0),e=>e.code==='42501');assert.equal(Number((await raw(db,w.user)).revision),0)}
 // Original ID collision, even equal-looking evidence, cannot create duplicate IDs.
 const collision=await seedAdmin(40001),at=new Date().toISOString(),args=checkpointArgs(collision,0,at)
 const run=(await db.query('select pjsdas_empty_gmail_run_v1($1,$2,$3) r',[args[2],at,'1234'])).rows[0].r
 const collisionState=(await raw(db,collision.user)).snapshot;collisionState.data.timeline.push({...run,title:'pre-existing different evidence'})
 await db.query('update pjsdas_workspaces set snapshot=$2 where user_id=$1',[collision.user,JSON.stringify(collisionState)])
 assert.equal((await db.query(checkpointQuery,args)).rows[0].outcome,'NOT_ELIGIBLE');assert.equal(Number((await raw(db,collision.user)).revision),0)
 const tamper=await seedAdmin(40002);await checkpoint(db,tamper,0);const original=(await logical(db,tamper.user)).snapshot;const changed=structuredClone(original);changed.data.timeline.at(-1).title='forged';await assert.rejects(full(db,2,tamper,'bad',1,changed),e=>e.code==='40001');changed.data.timeline=original.data.timeline.concat(original.data.timeline.at(-1));await assert.rejects(full(db,2,tamper,'duplicate',1,changed),e=>e.code==='40001');assert.equal(Number((await raw(db,tamper.user)).revision),1)
 // Missing ledger evidence is not silently treated as an empty overlay.
 await db.query('begin');await db.query('delete from pjsdas_command_ledger where user_id=$1',[tamper.user]);await assert.rejects(logical(db,tamper.user),e=>e.code==='40001');await db.query('rollback')
 // A full bounded window falls back, then an aware full write absorbs all rows.
 const bounded=await seedAdmin(40003),base=(await raw(db,bounded.user)).snapshot,start=Date.now()
 for(let i=0;i<256;i++)assert.equal((await checkpoint(db,bounded,i,new Date(start+i).toISOString())).outcome,'COMMITTED')
 const rejected=await checkpoint(db,bounded,256,new Date(start+256).toISOString());assert.equal(rejected.outcome,'NOT_ELIGIBLE');assert.equal(Number((await raw(db,bounded.user)).revision),256);assert.deepEqual((await raw(db,bounded.user)).snapshot,base)
 const view=await logical(db,bounded.user);assert.equal(view.snapshot.data.timeline.length,257);assert.equal((await full(db,3,bounded,'aware-fallback',256,view.snapshot)).outcome,'COMMITTED');assert.equal(Number((await raw(db,bounded.user)).materialized_revision),257);assert.equal((await db.query('select count(*)::int n from pjsdas_command_ledger where user_id=$1 and gmail_empty_poll_run is not null',[bounded.user])).rows[0].n,256)
 // Real large structured JSON with entropy. No production payloads or shape data.
 const big=snapshot();let random=12345;const word=()=>{random=(Math.imul(random,1664525)+1013904223)>>>0;return random.toString(16).padStart(8,'0')}
 for(let i=0;i<10000;i++)big.data.timeline.push({id:'fixture-history:'+i,kind:'baseline_backfill',category:'data',source:'system',occurredAt:big.exportedAt,recordedAt:big.exportedAt,title:'Synthetic history',detail:'Synthetic history '.repeat(35)+Array.from({length:28},word).join('')})
 assert.ok(Buffer.byteLength(JSON.stringify(big))>10000000);const large=await seedAdmin(40004,big);assert.ok((await db.query('select pg_column_size(snapshot) n from pjsdas_workspaces where user_id=$1',[large.user])).rows[0].n>1000000)
 await db.query('begin');await db.query("set local work_mem='2184kB'");const plan=(await db.query('explain(analyze,buffers,wal,format json) '+checkpointQuery,checkpointArgs(large,0))).rows[0]['QUERY PLAN'][0];await db.query('rollback');assert.equal(plan.Plan['Temp Written Blocks'],0);assert.ok(plan.Plan['WAL Bytes']<100000,JSON.stringify({wal:plan.Plan['WAL Bytes']}));assert.equal(Number((await raw(db,large.user)).revision),0);assert.deepEqual((await raw(db,large.user)).snapshot,big)
 console.log('PASS boundary proofs: base ID collision, tamper/duplicate/gap rejection, 256 pending fallback without truncation, retained audit after absorption; synthetic large checkpoint',JSON.stringify({executionMs:plan['Execution Time'],tempWritten:plan.Plan['Temp Written Blocks'],walBytes:plan.Plan['WAL Bytes']}))
}
