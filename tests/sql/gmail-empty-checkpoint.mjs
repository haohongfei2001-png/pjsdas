// Native PostgreSQL only: real transactional state, privileges and later races.
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import pg from 'pg'
import {fixtureUrl,migration} from './discovery-authority-fixture.mjs'
import {install,seed,checkpoint,checkpointArgs,checkpointQuery,checkpointMigration,raw,logical,full,snapshot,observation,uid} from './gmail-empty-checkpoint-fixture.mjs'
import {proveConcurrency} from './gmail-empty-checkpoint-concurrency.mjs'
import {proveBoundaries} from './gmail-empty-checkpoint-boundaries.mjs'
import {proveGateway} from './gmail-empty-checkpoint-gateway.mjs'
import {proveGuards} from './gmail-empty-checkpoint-guards.mjs'
const url=fixtureUrl(),name=`ta_empty_fixture_${randomUUID().replaceAll('-','')}`
const admin=new pg.Client({connectionString:url.toString(),statement_timeout:30000});let db,created=false
const seedAdmin=async(n)=>{await db.query('reset role');const w=await seed(db,n);await db.query('set role service_role');return w}
const catalog=async()=>({tables:(await db.query("select oid::regclass::text name,relacl::text,relrowsecurity,relforcerowsecurity from pg_class where relnamespace='public'::regnamespace and relkind in ('r','S') order by name")).rows,functions:(await db.query("select oid::regprocedure::text signature,proacl::text,prosecdef,proconfig,pg_get_userbyid(proowner) owner from pg_proc where pronamespace='public'::regnamespace order by signature")).rows,policies:(await db.query("select * from pg_policies where schemaname='public' order by tablename,policyname")).rows})
try{
 await admin.connect();assert.equal(Math.floor(Number((await admin.query('show server_version_num')).rows[0].server_version_num)/10000),17)
 await admin.query(`create database ${name}`);created=true;const local=new URL(url);local.pathname='/'+name;db=new pg.Client({connectionString:local.toString(),statement_timeout:30000});await db.connect();await install(db)
 const before=await catalog(),w=await seed(db),original=await raw(db,w.user),sql=await migration(checkpointMigration)
 await db.query('begin');await db.query(sql);await db.query('rollback');assert.deepEqual(await catalog(),before);assert.deepEqual(await raw(db,w.user),original)
 await db.query(sql);const after=await catalog();assert.deepEqual(after.tables,before.tables);assert.deepEqual(after.policies,before.policies)
 for(const fn of before.functions)assert.deepEqual(after.functions.find(f=>f.signature===fn.signature),fn)
 for(const fn of after.functions.filter(f=>!before.functions.some(o=>o.signature===f.signature))){assert.equal(fn.prosecdef,false);for(const role of ['anon','authenticated','service_role'])assert.equal((await db.query('select has_function_privilege($1,$2,\'EXECUTE\') allowed',[role,fn.signature])).rows[0].allowed,role==='service_role');assert.equal((await db.query("select count(*)::int n from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=$1::regprocedure and a.grantee=0",[fn.signature])).rows[0].n,0)}
 for(const role of ['anon','authenticated']){await db.query('set role '+role);await assert.rejects(checkpoint(db,w,0),e=>e.code==='42501');await db.query('reset role')}
 await db.query('set role service_role')
 const args=checkpointArgs(w,0);const first=(await db.query(checkpointQuery,args)).rows[0];assert.equal(first.outcome,'COMMITTED');assert.equal(Number(first.revision),1)
 const persisted=await raw(db,w.user);assert.deepEqual(persisted.snapshot,original.snapshot);assert.equal(Number(persisted.materialized_revision),0);const read=await logical(db,w.user);assert.equal(read.snapshot.data.timeline.length,2);assert.equal(read.snapshot.data.timeline.at(-1).ingestionRun.receivedCount,0)
 assert.deepEqual((await db.query(checkpointQuery,args)).rows[0].receipt,first.receipt);assert.equal((await db.query('select count(*)::int n from pjsdas_command_ledger')).rows[0].n,1)
 await assert.rejects(db.query(checkpointQuery,args.map((v,i)=>i===3?'b'.repeat(64):v)),e=>e.code==='23505')
 for(const version of [3,4])await assert.rejects(full(db,version,w,`unaware-${version}`,1,original.snapshot),e=>e.code==='40001')
 const accepted=await full(db,2,w,'legacy-absorb',1,original.snapshot);assert.equal(accepted.outcome,'COMMITTED');assert.deepEqual(accepted.snapshot,read.snapshot);assert.equal(Number((await raw(db,w.user)).materialized_revision),2)
 assert.deepEqual((await db.query(checkpointQuery,args)).rows[0].receipt,first.receipt);assert.deepEqual((await logical(db,w.user)).snapshot,accepted.snapshot)
 for(const version of [1,2,3,4]){const other=await seedAdmin(10000+version);const base=await raw(db,other.user);await checkpoint(db,other,0);const view=await logical(db,other.user);const result=await full(db,version,other,`full-${version}`,1,version<=2?base.snapshot:view.snapshot);assert.equal(result.outcome,'COMMITTED');assert.deepEqual((await raw(db,other.user)).snapshot,view.snapshot);if(version<=2)assert.deepEqual(result.snapshot,view.snapshot);assert.equal(Number((await raw(db,other.user)).materialized_revision),2)}
 const drain=await seedAdmin(11000);await checkpoint(db,drain,0);const logicalBefore=await logical(db,drain.user);await db.query('begin');await db.query('select * from pjsdas_drain_empty_gmail_runs_v1($1,1)',[drain.user]);await db.query('rollback');assert.equal(Number((await raw(db,drain.user)).materialized_revision),0);assert.equal((await db.query('select * from pjsdas_drain_empty_gmail_runs_v1($1,0)',[drain.user])).rows[0].outcome,'CONFLICT');assert.equal((await db.query('select * from pjsdas_drain_empty_gmail_runs_v1($1,1)',[drain.user])).rows[0].outcome,'DRAINED');assert.deepEqual((await raw(db,drain.user)).snapshot,logicalBefore.snapshot);assert.equal(Number((await raw(db,drain.user)).revision),2)
 // An unaware reader may already hold the pre-drain raw snapshot/revision.
 // Draining MUST fence that request even though no business object changed.
 for(const version of [1,2,3,4]){const stale=await seedAdmin(11500+version);await checkpoint(db,stale,0);const old=await raw(db,stale.user),view=await logical(db,stale.user);const fenced=(await db.query('select * from pjsdas_drain_empty_gmail_runs_v1($1,1)',[stale.user])).rows[0];assert.equal(Number(fenced.revision),2);assert.equal((await full(db,version,stale,'pre-drain-reader',1,old.snapshot)).outcome,'CONFLICT');assert.deepEqual((await logical(db,stale.user)).snapshot,view.snapshot)}
 assert.equal((await db.query('select * from pjsdas_drain_empty_gmail_runs_v1($1,2)',[drain.user])).rows[0].outcome,'ALREADY_DRAINED');assert.equal(Number((await raw(db,drain.user)).revision),2)
 // A maintenance-only revision has no command row, but later pending windows
 // remain contiguous above the new marker and original receipts are untouched.
 assert.equal((await checkpoint(db,drain,2)).outcome,'COMMITTED');assert.equal((await logical(db,drain.user)).snapshot.data.timeline.length,3);assert.equal((await full(db,3,drain,'after-drain',3,(await logical(db,drain.user)).snapshot)).outcome,'COMMITTED')
 const denied=await seedAdmin(12000);const beforeDenied=await raw(db,denied.user);assert.equal((await checkpoint(db,denied,0,new Date().toISOString(),{7:JSON.stringify({...observation,fetchedCount:1})})).outcome,'NOT_ELIGIBLE');assert.deepEqual(await raw(db,denied.user),beforeDenied)
 await proveGateway(db)
 await proveBoundaries(db)
 await proveGuards(db)
 await proveConcurrency(db,local.toString())
 console.log('PASS native PG17 empty-checkpoint: atomic DDL rollback, unchanged old ACL/RLS/security, service-only entry, no snapshot write, overlay, replay/hash/CAS, v1/v2 absorption, v3/v4 unaware rejection, aware writes, drain rollback and strict-subset fallback.')
}finally{if(db)await db.end();if(created)await admin.query(`drop database ${name} with (force)`);await admin.end()}
