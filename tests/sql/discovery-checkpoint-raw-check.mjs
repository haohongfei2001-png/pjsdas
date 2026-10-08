import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { authorityMigration, owner, installBase, seedExistingAuthority, migration, proof, commitQuery, durableState } from './discovery-authority-fixture.mjs'
import { unknownDeadlineWorkspace } from '../fixtures/unknownDeadlineWorkspace.ts'
import { createDefaultDiscoveryProfile } from '../../src/discoveryProfile.ts'
import { discoveryProfileManagementFingerprint } from '../../src/discoveryProfileManagement.ts'
import { createTransactionalWorkspaceSource } from '../../gateway/transactionalWorkspaceSource.ts'
import { batchMetadata, commitDiscoveryCheckpoint } from '../../gateway/discoveryScopeJournal.ts'
import { validateSnapshot } from '../../src/snapshot.ts'
const db=new PGlite()
try {
 await installBase(db,{createRoles:true}); await seedExistingAuthority(db); await db.exec(await migration(authorityMigration))
 const raw=unknownDeadlineWorkspace(1)
 raw.data.actions[0].dueAt='2026-08-27T15:59:59Z'; raw.data.actions[0].timingMode='deadline'
 raw.data.discoveryProfile={...createDefaultDiscoveryProfile('2026-10-07T20:00:00.000Z'),searchScopeVersion:1,targetRoleQueries:['Product Manager']}
 validateSnapshot(raw)
 await db.query('update public.pjsdas_workspaces set snapshot=$1 where user_id=$2',[JSON.stringify(raw),owner])
 const authorization=await proof(db,'automation')
 let sqlError
 const fetchImpl=async (input,init)=>{
  const url=new URL(String(input))
  if (init?.method==='POST'){
   const b=JSON.parse(String(init.body))
   assert.equal(url.pathname,'/rest/v1/rpc/pjsdas_commit_discovery_workspace_v1')
   const args=[b.target_user_id,b.target_command_id,b.target_operation,b.target_payload_hash,b.target_expected_revision,JSON.stringify(b.target_snapshot),b.target_schema_version,b.target_principal_kind,b.target_client_id,JSON.stringify(b.target_provenance),b.target_compensation,b.target_effective_time,JSON.stringify(b.target_receipt_context),JSON.stringify(b.target_discovery_authorization)]
   try { await db.exec('set role service_role'); const result=await db.query(commitQuery,args); return Response.json(result.rows.map(({snapshot,...row})=>row)) }
   catch(e) { sqlError={code:e.code,message:e.message};return Response.json(sqlError,{status:e.code==='42501'?403:500}) }
   finally {await db.exec('reset role')}
  }
  if(url.pathname==='/rest/v1/pjsdas_workspaces')return Response.json((await db.query('select * from public.pjsdas_workspaces where user_id=$1',[owner])).rows)
  if(url.pathname==='/rest/v1/pjsdas_command_ledger')return Response.json((await db.query('select * from public.pjsdas_command_ledger where user_id=$1 and command_id=$2',[owner,url.searchParams.get('command_id')?.slice(3)])).rows)
  throw new Error('unexpected URL')
 }
 const source=createTransactionalWorkspaceSource({userId:owner,supabaseUrl:'https://offline.invalid',serviceRoleKey:'fixture-only',principalKind:'automation',fetchImpl})
 const identity={sourceId:'monitor:key-changes',scopeFingerprint:await discoveryProfileManagementFingerprint(raw.data.discoveryProfile),planFingerprint:'a'.repeat(64),cycleId:'b'.repeat(64),index:0,count:1,queryStart:0,queryCount:1,totalQueryCount:1,queries:[{query:'Product Manager 招聘',coverage:'general_web'}]}
 const before = await durableState(db)
 let result, error
 try {result=await commitDiscoveryCheckpoint({source,identity,batch:batchMetadata(identity),authorize:async()=>{},discoveryAuthorization:authorization})}catch(e){error={code:e.code,message:e.message}}
 assert.equal(error,undefined)
 assert.equal(sqlError,undefined)
 assert.equal(result?.firstCommit,true,'A valid raw v4 snapshot should allow metadata-only checkpoint without changing any raw value')
 const after = await durableState(db)
 assert.deepEqual(after.workspaces.map(row => row.snapshot), before.workspaces.map(row => row.snapshot))
 assert.deepEqual(after.workspaces.find(row => row.user_id === owner).snapshot, JSON.parse(JSON.stringify(raw)))
 assert.equal(after.ledger.length, before.ledger.length + 1)
 assert.equal(after.ledger.at(-1).compensation, null)
 console.log('PASS raw checkpoint gateway plus PGlite: valid legacy dueAt/timingMode and complete raw v4 data unchanged; original schema and authority retained.')
} finally {await db.close()}
