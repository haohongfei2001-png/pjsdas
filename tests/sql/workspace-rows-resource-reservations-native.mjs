/** Real PostgreSQL multisession proof, independent synthetic fixture ONLY.
 * No HTTP/product runtime, filesystem writer, provider or role/ACL operations. */
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
import pg from 'pg'
import {PgResourceReservations} from '../../gateway/workspaceRowsResourceReservationsPg.ts'
import {createResourceLedger,transitionResourceLedger,resourceTotals} from '../../gateway/workspaceRowsResourceAccounting.ts'
import {installResourceAuthorityFixture,resourceAuthorityFixture,seedResource,originalFixtureFinalize,sha} from './workspace-rows-resource-reservations-fixture.mjs'
const connection=process.env.TA_ROW_DATABASE_URL;assert(connection)
const target=new URL(connection);assert(['127.0.0.1','localhost','[::1]'].includes(target.hostname),'REMOTE_DATABASE_FORBIDDEN')
assert.equal(target.port,'55439','only the pre-existing owned local PG fixture is allowed')
const name='ta_resource_'+randomUUID().replaceAll('-',''),url=new URL(target);url.pathname='/'+name
const admin=new pg.Client({connectionString:target.href}),clients=[]
const authority=resourceAuthorityFixture(),schema=readFileSync(new URL('./candidates/workspace-rows-resource-reservations.sql',import.meta.url),'utf8')
const config={enabled:true,limits:{commandBytes:100,ownerBytes:150,globalBytes:200}}
let created=false,passed=0
async function client(label){const c=new pg.Client({connectionString:url.href,application_name:'ta-resource-'+label});c.on('error',()=>{});await c.connect();await c.query("set statement_timeout='8s';set lock_timeout='6s'");clients.push(c);return c}
const row=async(db,b)=>(await db.query('select * from ta_resource_reservations.reservation where stage_id=$1',[b.stageId])).rows[0]
const pool=async db=>(await db.query('select * from ta_resource_reservations.pool')).rows[0]
const usage=async db=>{const p=await pool(db);return [Number(p.held),Number(p.occupied),Number(p.present)]}
const revision=async(db,b)=>Number((await row(db,b)).revision)
const report=(name,details={})=>{passed++;console.log('PASS_RESOURCE_PG',JSON.stringify({name,...details}))}
async function waitBlocked(observer,pids){
 for(let n=0;n<400;n++){
  await observer.query('select pg_stat_clear_snapshot()')
  const rows=(await observer.query("select pid,wait_event_type,wait_event,query from pg_stat_activity where pid=any($1::int[]) and wait_event_type='Lock'",[pids])).rows
  if(rows.length===pids.length)return rows
  await new Promise(r=>setTimeout(r,5))
 }
 throw Error('expected real PostgreSQL lock wait not observed')
}
async function rejected(promise,code){await assert.rejects(promise,e=>String(e.message).includes(code),code)}
async function reclaim(adapter,db,b,id='reclaim'){
 await adapter.resolve(db,b,await revision(db,b))
 await adapter.beginReclaim(db,b,id,await revision(db,b))
 const allocations=(await db.query('select allocation_id from ta_resource_reservations.allocation where stage_id=$1',[b.stageId])).rows
 for(const a of allocations)await adapter.removeAllocation(db,b,id,a.allocation_id)
 await adapter.release(db,b,id)
}
try{
 await admin.connect();await admin.query('create database '+name);created=true
 const db=await client('main'),a=await client('a'),b=await client('b'),observer=await client('observer')
 await installResourceAuthorityFixture(db);await db.query(schema)
 const off=await PgResourceReservations.start(db,authority)
 const disabledSeed=await seedResource(db)
 assert.deepEqual(await off.admit(db,disabledSeed.binding),{disposition:'disabled'})
 assert.deepEqual(await usage(db),[0,0,0]);await rejected(PgResourceReservations.start(db,authority,config),'RESOURCE_CONFIGURATION_CHANGED')
 report('default-off; explicit immutable limits; no implicit reservations')
 // Schema recreation is limited to this unique owned synthetic database.
 await db.query('drop schema ta_resource_reservations cascade');await db.query(schema)
 let adapter=await PgResourceReservations.start(db,authority,config)
 const first=await seedResource(db,{userId:'owner-a'})
 await rejected(adapter.admit(db,first.binding),'RESOURCE_RECONCILIATION_REQUIRED')
 assert.equal((await adapter.reconcile(db)).verified,true)
 await a.query('begin');await a.query("insert into ta_resource_fixture.original_head values('nested-transaction-sentinel')")
 await rejected(adapter.admit(a,first.binding),'RESOURCE_TRANSACTION_ALREADY_OPEN')
 assert.equal((await a.query("select count(*)::int n from ta_resource_fixture.original_head where workspace_id='nested-transaction-sentinel'")).rows[0].n,1)
 await a.query('rollback');assert.equal((await db.query("select count(*)::int n from ta_resource_fixture.original_head where workspace_id='nested-transaction-sentinel'")).rows[0].n,0)
 report('existing caller transaction rejected without implicit commit or rollback')
 const tooBig=await seedResource(db,{bytes:101});await rejected(adapter.admit(db,tooBig.binding),'COMMAND_LIMIT_EXCEEDED')
 assert.deepEqual(await usage(db),[0,0,0]);report('startup freeze and command limit reject atomically')
 const second=await seedResource(db,{userId:'owner-a'})
 await db.query('begin');await db.query('select 1 from ta_resource_reservations.pool for update')
 const contenders=[adapter.admit(a,first.binding),adapter.admit(b,second.binding)].map(p=>p.then(value=>({value}),error=>({error:error.message})))
 const ownerWait=await waitBlocked(observer,[a.processID,b.processID]);await db.query('commit')
 const admitted=await Promise.all(contenders);assert.equal(admitted.filter(x=>x.value).length,1);assert(admitted.find(x=>x.error).error.includes('OWNER_LIMIT_EXCEEDED'))
 const winner=admitted[0].value?first.binding:second.binding
 assert.deepEqual(await usage(db),[80,0,0]);report('real owner admission race serialized; only one 80 of owner150 wins',{blocked:ownerWait.map(x=>x.wait_event)})
 const other=await seedResource(db,{userId:'owner-b'}),third=await seedResource(db,{userId:'owner-c'})
 await db.query('begin');await db.query('select 1 from ta_resource_reservations.pool for update')
 const globalRace=[adapter.admit(a,other.binding),adapter.admit(b,third.binding)].map(p=>p.then(value=>({value}),error=>({error:error.message})))
 await waitBlocked(observer,[a.processID,b.processID]);await db.query('commit')
 const globals=await Promise.all(globalRace);assert.equal(globals.filter(x=>x.value).length,1);assert(globals.find(x=>x.error).error.includes('GLOBAL_LIMIT_EXCEEDED'))
 const otherWinner=globals[0].value?other.binding:third.binding
 assert.deepEqual(await usage(db),[160,0,0]);report('real cross-owner global race; full reservation charge cumulative')
 const dup=await Promise.all([adapter.admit(a,winner),adapter.admit(b,winner)]);assert(dup.every(x=>x.disposition==='replayed'));assert.deepEqual(await usage(db),[160,0,0])
 const sameCommand=await seedResource(db,{userId:winner.userId,commandId:winner.commandId,bytes:1});await rejected(adapter.admit(db,sameCommand.binding),'COMMAND_ID_REUSED')
 report('exact admission replay and owner-command tombstone uniqueness')
 const input=Buffer.from('0123456789')
 const appends=await Promise.all([adapter.append(a,winner,'document','document-fragments',0,input),adapter.append(b,winner,'document','document-fragments',0,input)])
 assert.equal(appends.filter(x=>x.disposition==='applied').length,1);assert.deepEqual(await usage(db),[160,10,10])
 await rejected(adapter.append(db,winner,'document','document-fragments',0,Buffer.from('012345678X')),'APPEND_IDENTITY_REUSED')
 await rejected(adapter.append(db,winner,'document','document-fragments',11,input),'APPEND_GAP_OR_OVERLAP')
 await adapter.precharge(db,winner,{allocationId:'pending',kind:'intent-encoded',offset:0,bytes:10,sha256:sha(input)})
 assert.deepEqual(await usage(db),[160,20,10]);assert.equal((await db.query("select count(*)::int n from ta_resource_reservations.temporary_bytes where allocation_id='pending'")).rows[0].n,0)
 await adapter.materialize(db,winner,'pending',0,input);await adapter.materialize(db,winner,'pending',0,input)
 assert.deepEqual(await usage(db),[160,20,20]);report('precharge precedes materialization; concurrent exact byte replay charged once')
 await adapter.precharge(db,winner,{allocationId:'different-representation',kind:'effect-jsonb',offset:0,bytes:60,sha256:sha(Buffer.alloc(60,1))})
 await rejected(adapter.append(db,winner,'too-much','effect-wire',0,Buffer.from('x')),'RESERVATION_EXCEEDED')
 assert.deepEqual(await usage(db),[160,80,20]);report('all independently live representations cumulatively fit command reservation')
 await adapter.stop(db,winner,'cancelled');await rejected(adapter.materialize(db,winner,'different-representation',0,Buffer.alloc(60,1)),'RESOURCE_WRITES_CLOSED')
 await rejected(adapter.release(db,winner,'not-fenced'),'RECLAIM_FENCE_REQUIRED');assert.deepEqual(await usage(db),[160,80,20])
 await adapter.beginFinalize(db,otherWinner,'original-attempt');await adapter.markUnknown(db,otherWinner,'original-attempt');await adapter.markUnknown(db,otherWinner,'original-attempt');await adapter.stop(db,otherWinner,'cancelled')
 assert.equal((await row(db,otherWinner)).phase,'unknown');await rejected(adapter.beginReclaim(db,otherWinner,'cleanup',await revision(db,otherWinner)),'ORIGINAL_OUTCOME_UNRESOLVED')
 assert.equal((await adapter.beginFinalize(db,otherWinner,'original-attempt')).phase,'unknown');assert.deepEqual(await usage(db),[160,80,20]);report('cancel and unknown-finalize keep full capacity; no replay dispatch permit')
 await reclaim(adapter,db,winner);assert.deepEqual(await usage(db),[80,0,0]);await adapter.release(db,winner,'reclaim');await adapter.admit(db,winner)
 await rejected(adapter.append(db,winner,'document','document-fragments',0,input),'RESOURCE_WRITES_CLOSED')
 assert.deepEqual(await usage(db),[80,0,0]);report('real terminal absence fence, physical DB fence, complete inventory, idempotent release and tombstone')
 await reclaim(adapter,db,otherWinner);assert.deepEqual(await usage(db),[0,0,0])
 const expiring=await seedResource(db,{lifetime:1200});await adapter.admit(db,expiring.binding)
 await db.query('select pg_sleep(1.3)');await adapter.stop(db,expiring.binding,'expired');assert.deepEqual(await usage(db),[80,0,0]);await rejected(adapter.append(db,expiring.binding,'late','effect-wire',0,input),'RESOURCE_WRITES_CLOSED')
 await reclaim(adapter,db,expiring.binding);report('actual server deadline expiry pins capacity; never invents a refreshed deadline')
 const committed=await seedResource(db);await adapter.admit(db,committed.binding);await adapter.append(db,committed.binding,'temporary-copy','effect-wire',0,input)
 await adapter.beginFinalize(db,committed.binding,'commit-attempt');await originalFixtureFinalize(a,adapter,committed.binding,{hold:true})
 const resolve=adapter.resolve(b,committed.binding,await revision(observer,committed.binding));await waitBlocked(observer,[b.processID])
 await a.query('commit');await resolve
 const resolution=await row(db,committed.binding);assert.equal(resolution.outcome.outcome,'committed');assert.equal(resolution.outcome.resultingRevision,37)
 const original=(await db.query('select to_jsonb(c) value from ta_resource_fixture.original_command c where user_id=$1',[committed.binding.userId])).rows[0].value
 await reclaim(adapter,db,committed.binding)
 assert.deepEqual((await db.query('select to_jsonb(c) value from ta_resource_fixture.original_command c where user_id=$1',[committed.binding.userId])).rows[0].value,original)
 await rejected(originalFixtureFinalize(db,adapter,committed.binding),'FINALIZE_NOT_DISPATCHED')
 report('in-flight original commit drains before authoritative lookup; resultingRevision37 and original receipt/projection/Undo survive')
 const missing=await seedResource(db);await adapter.admit(db,missing.binding);await adapter.beginFinalize(db,missing.binding,'missing-audit');await originalFixtureFinalize(db,adapter,missing.binding,{missingAudit:true})
 await rejected(adapter.resolve(db,missing.binding,await revision(db,missing.binding)),'ORIGINAL_AUDIT_RETENTION_REQUIRED')
 assert.equal((await row(db,missing.binding)).outcome,null);assert.equal((await db.query('select finalizer_fence from ta_resource_fixture.original_stage where stage_id=$1',[missing.binding.stageId])).rows[0].finalizer_fence,null)
 // Fixture-only repair restores retained evidence; never deletes an audit row.
 await db.query('update ta_resource_fixture.original_command set projection=receipt where user_id=$1',[missing.binding.userId]);await reclaim(adapter,db,missing.binding)
 report('missing original audit evidence rolls back terminal fence and does not release')
 const crash=await seedResource(db);await adapter.admit(db,crash.binding);await adapter.precharge(db,crash.binding,{allocationId:'crash-cut',kind:'document-fragments',offset:0,bytes:10,sha256:sha(input)})
 const previous=adapter;adapter=await PgResourceReservations.start(db,authority,config)
 await rejected(previous.materialize(db,crash.binding,'crash-cut',0,input),'STALE_RESOURCE_GENERATION')
 await rejected(adapter.materialize(db,crash.binding,'crash-cut',0,input),'RESOURCE_RECONCILIATION_REQUIRED')
 assert.deepEqual(await usage(db),[80,10,0]);assert.equal((await adapter.reconcile(db)).verified,true);assert.deepEqual(await usage(db),[80,10,0])
 await adapter.materialize(db,crash.binding,'crash-cut',0,input)
 await db.query('insert into ta_resource_reservations.temporary_bytes values($1,$2,0,$3)',[crash.binding.stageId,'orphan',input])
 assert.equal((await adapter.reconcile(db)).verified,false);await rejected(adapter.append(db,crash.binding,'denied','effect-wire',0,input),'RESOURCE_RECONCILIATION_REQUIRED')
 await adapter.resolve(db,crash.binding,await revision(db,crash.binding));await rejected(adapter.beginReclaim(db,crash.binding,'unsafe',await revision(db,crash.binding)),'RESOURCE_INVENTORY_INCONSISTENT')
 await db.query('delete from ta_resource_reservations.temporary_bytes where stage_id=$1 and allocation_id=$2',[crash.binding.stageId,'orphan'])
 assert.equal((await adapter.reconcile(db)).verified,true)
 await db.query('update ta_resource_reservations.temporary_bytes set data=$2 where stage_id=$1',[crash.binding.stageId,Buffer.from('corruption')]);assert.equal((await adapter.reconcile(db)).issues[0].code,'mismatch')
 await db.query('delete from ta_resource_reservations.temporary_bytes where stage_id=$1',[crash.binding.stageId]);assert.equal((await adapter.reconcile(db)).issues[0].code,'missing-confirmed')
 // Restore exact fixture bytes, not a speculative ledger uncharge.
 await db.query('insert into ta_resource_reservations.temporary_bytes values($1,$2,0,$3)',[crash.binding.stageId,'crash-cut',input]);assert.equal((await adapter.reconcile(db)).verified,true)
 await db.query('update ta_resource_reservations.chunk set byte_offset=100 where stage_id=$1',[crash.binding.stageId]);await db.query('update ta_resource_reservations.temporary_bytes set byte_offset=100 where stage_id=$1',[crash.binding.stageId])
 assert((await adapter.reconcile(db)).issues.some(x=>x.code==='noncontiguous-chunk'));assert.equal((await pool(db)).inventory_verified,false)
 await db.query('update ta_resource_reservations.chunk set byte_offset=0 where stage_id=$1',[crash.binding.stageId]);await db.query('update ta_resource_reservations.temporary_bytes set byte_offset=0 where stage_id=$1',[crash.binding.stageId]);assert.equal((await adapter.reconcile(db)).verified,true)
 let failedScan=false;const brokenScan={async query(sql,p){if(!failedScan&&sql.includes('with expected as')){failedScan=true;throw Error('SYNTHETIC_SCAN_FAILURE')}return db.query(sql,p)}}
 await rejected(adapter.reconcile(brokenScan),'SYNTHETIC_SCAN_FAILURE');assert.equal((await pool(db)).inventory_verified,false);assert.equal((await adapter.reconcile(db)).verified,true)
 await reclaim(adapter,db,crash.binding);report('restart freezes new bytes; stale generation denied; complete actual-byte inventory detects orphan/corruption/missing-confirmed without uncharge')
 // Disconnect mid-transaction AFTER precharge SQL and physical byte insert.
 const disconnect=await seedResource(db);await adapter.admit(db,disconnect.binding)
 const victim=await client('disconnect'),victimPid=victim.processID;let killed=false
 const dropped={async query(sql,parameters){const res=await victim.query(sql,parameters);if(!killed&&sql.startsWith('insert into ta_resource_reservations.temporary_bytes')){killed=true;await observer.query('select pg_terminate_backend($1)',[victimPid]);await new Promise(r=>setTimeout(r,10));throw Error('SYNTHETIC_CONNECTION_LOST_AFTER_BYTES')}return res}}
 await rejected(adapter.append(dropped,disconnect.binding,'rollback','effect-wire',0,input),'SYNTHETIC_CONNECTION_LOST_AFTER_BYTES')
 assert.deepEqual(await usage(db),[80,0,0]);assert.equal((await db.query('select count(*)::int n from ta_resource_reservations.chunk where stage_id=$1',[disconnect.binding.stageId])).rows[0].n,0)
 await adapter.append(db,disconnect.binding,'rollback','effect-wire',0,input);assert.deepEqual(await usage(db),[80,10,10])
 // ACK lost after actual COMMIT: caller must exact-retry, not mint capacity.
 const ack=await client('lost-commit-ack');let droppedAck=false
 const uncertain={async query(sql,parameters){const out=await ack.query(sql,parameters);if(sql==='commit'&&!droppedAck){droppedAck=true;throw Error('SYNTHETIC_COMMIT_ACK_LOST')}return out}}
 await rejected(adapter.append(uncertain,disconnect.binding,'ack-lost','effect-jsonb',0,input),'SYNTHETIC_COMMIT_ACK_LOST')
 assert.deepEqual(await usage(db),[80,20,20]);assert.equal((await adapter.append(db,disconnect.binding,'ack-lost','effect-jsonb',0,input)).disposition,'replayed');assert.deepEqual(await usage(db),[80,20,20])
 await reclaim(adapter,db,disconnect.binding);report('real terminated backend rolls back precharge+bytes; committed lost-ACK exact retry charges once')
 // Revocation holds ORIGINAL grant first: queued resource request must not own
 // global/head/stage while waiting, and gets no bytes when revocation wins.
 const revoked=await seedResource(db);await adapter.admit(db,revoked.binding)
 await a.query('begin');await a.query('select 1 from ta_resource_fixture.original_grant where user_id=$1 for update',[revoked.binding.userId])
 const denied=adapter.append(b,revoked.binding,'revoked','effect-wire',0,input).then(()=>null,e=>e)
 await waitBlocked(observer,[b.processID]);await observer.query('begin');await observer.query('select 1 from ta_resource_reservations.pool for update nowait');await observer.query('select 1 from ta_resource_fixture.original_head where workspace_id=$1 for update nowait',[revoked.binding.workspaceId]);await observer.query('commit')
 await a.query('update ta_resource_fixture.original_grant set active=false where user_id=$1',[revoked.binding.userId]);await a.query('commit');assert((await denied).message.includes('ORIGINAL_AUTHORITY_DENIED'));assert.deepEqual(await usage(db),[80,0,0])
 await db.query('update ta_resource_fixture.original_grant set active=true where user_id=$1',[revoked.binding.userId]);await reclaim(adapter,db,revoked.binding)
 report('original grant-before-global-before-head verified with actual waiting revoke and NOWAIT lock probes')
 // Copy immutable binding/part before an actual authority lock wait.
 const mutable=await seedResource(db);await adapter.admit(db,mutable.binding)
 await a.query('begin');await a.query('select 1 from ta_resource_fixture.original_grant where user_id=$1 for update',[mutable.binding.userId])
 const mutableBinding=structuredClone(mutable.binding),part={allocationId:'immutable',kind:'effect-wire',offset:0,bytes:10,sha256:sha(input)}
 const copied=adapter.precharge(b,mutableBinding,part);await waitBlocked(observer,[b.processID]);mutableBinding.userId='foreign';mutableBinding.stageId='foreign';part.bytes=99;part.allocationId='changed'
 await a.query('commit');await copied;assert.equal(Number((await row(db,mutable.binding)).occupied),10)
 assert.equal((await db.query('select allocation_id from ta_resource_reservations.allocation where stage_id=$1',[mutable.binding.stageId])).rows[0].allocation_id,'immutable')
 await reclaim(adapter,db,mutable.binding);report('binding and append metadata snapshot remain exact across actual authority wait')
 const waitExpiry=await seedResource(db,{lifetime:600});await adapter.admit(db,waitExpiry.binding)
 await a.query('begin');await a.query('select 1 from ta_resource_reservations.pool for update')
 const late=adapter.append(b,waitExpiry.binding,'late-wait','effect-wire',0,input).then(()=>null,e=>e);await waitBlocked(observer,[b.processID]);await a.query('select pg_sleep(0.7)');await a.query('commit');assert((await late).message.includes('RESOURCE_WRITES_CLOSED'))
 assert.deepEqual(await usage(db),[80,0,0]);await reclaim(adapter,db,waitExpiry.binding);report('server clock rechecked after global lock wait crosses original deadline')
 // Reclaimer/resolver wins first: a previously dispatched finalizer cannot
 // publish after the permanent original terminal fence.
 const reverse=await seedResource(db);await adapter.admit(db,reverse.binding);await adapter.beginFinalize(db,reverse.binding,'reverse')
 await adapter.resolve(db,reverse.binding,await revision(db,reverse.binding))
 await rejected(originalFixtureFinalize(a,adapter,reverse.binding),'FINALIZE_NOT_DISPATCHED')
 assert.equal((await db.query('select count(*)::int n from ta_resource_fixture.original_command where user_id=$1',[reverse.binding.userId])).rows[0].n,0)
 const reclaimRevision=await revision(db,reverse.binding)
 const reclamations=await Promise.all([adapter.beginReclaim(a,reverse.binding,'concurrent-clean',reclaimRevision),adapter.beginReclaim(b,reverse.binding,'concurrent-clean',reclaimRevision)])
 assert.equal(reclamations.filter(x=>x.disposition==='applied').length,1)
 const releases=await Promise.all([adapter.release(a,reverse.binding,'concurrent-clean'),adapter.release(b,reverse.binding,'concurrent-clean')])
 assert.equal(releases.filter(x=>x.disposition==='applied').length,1);assert.deepEqual(await usage(db),[0,0,0])
 report('resolver-first denies original finalizer; concurrent begin-reclaim/release adjusts capacity once')

 // Stale writer queued while reclamation commits observes permanent fence.
 const stale=await seedResource(db);await adapter.admit(db,stale.binding);await adapter.precharge(db,stale.binding,{allocationId:'stale',kind:'effect-wire',offset:0,bytes:10,sha256:sha(input)})
 await adapter.resolve(db,stale.binding,await revision(db,stale.binding));await adapter.beginReclaim(db,stale.binding,'stale-clean',await revision(db,stale.binding))
 await db.query('begin');await db.query('select 1 from ta_resource_reservations.pool for update')
 const staleWrite=adapter.materialize(b,stale.binding,'stale',0,input).then(()=>null,e=>e);await waitBlocked(observer,[b.processID]);await db.query('commit');assert((await staleWrite).message.includes('RESOURCE_WRITES_CLOSED'))
 await adapter.removeAllocation(db,stale.binding,'stale-clean','stale');await adapter.release(db,stale.binding,'stale-clean');assert.deepEqual(await usage(db),[0,0,0]);report('DB stale writer cannot recreate fenced/reclaimed temporary namespace; physical FS claim intentionally absent')
 // Differential normalized SQL counters vs the independent pure oracle.
 let oracle=createResourceLedger(config);const step=(action,now=Date.now())=>oracle=transitionResourceLedger(oracle,oracle.revision,action,now).state
 step({type:'inventory',observedRevision:oracle.revision,complete:true,entries:[]})
 for(let i=0;i<12;i++){
  const f=await seedResource(db,{bytes:20});await adapter.admit(db,f.binding);step({type:'admit',admission:f.admission})
  for(let j=0;j<3;j++){const data=Buffer.alloc(j+1,i),allocationId='copy-'+j;await adapter.append(db,f.binding,allocationId,'effect-wire',0,data);step({type:'append',binding:f.binding,allocationId,kind:'effect-wire',offset:0,bytes:data.length,sha256:sha(data)});step({type:'confirm-append',binding:f.binding,allocationId,offset:0,bytes:data.length,sha256:sha(data)})}
  const totals=resourceTotals(oracle).global;assert.deepEqual(await usage(db),[totals.heldBytes,totals.occupiedUpperBoundBytes,totals.confirmedPresentBytes])
  await reclaim(adapter,db,f.binding,'oracle-'+i)
  let r=oracle.reservations.find(r=>r.binding.stageId===f.binding.stageId)
  step({type:'resolve',binding:f.binding,reservationRevision:r.revision,evidence:{outcome:'not-committed',fenceId:'oracle-fence'}});r=oracle.reservations.find(r=>r.binding.stageId===f.binding.stageId)
  step({type:'begin-reclaim',binding:f.binding,reclaimId:'oracle-'+i,writerFenceId:'oracle-writer',reservationRevision:r.revision})
  for(const allocation of r.allocations)step({type:'confirm-removed',binding:f.binding,reclaimId:'oracle-'+i,allocationId:allocation.allocationId})
  step({type:'release',binding:f.binding,reclaimId:'oracle-'+i});assert.deepEqual(await usage(db),[0,0,0])
 }
 assert.equal((await adapter.reconcile(db)).verified,true);report('12-command independent pure-oracle arithmetic differential; normalized counters reconcile after all retries')
 console.log('RESOURCE_PG_RESULT',JSON.stringify({status:'PASS_LOCAL_REAL_PG_SYNTHETIC_ONLY',passed,database:name,runtimeConnected:false,filesystemFencingProven:false,productionEligible:false}))
}finally{
 for(const c of clients)await c.end().catch(()=>{})
 if(created)await admin.query('drop database '+name+' with(force)')
 await admin.end()
}
