// In-memory PostgreSQL fixture only. This runner has no production connection URL.
import { PGlite } from '@electric-sql/pglite'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const db = new PGlite()
const sql = async name => readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8')
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;`)
  await db.exec(await sql('2026091901_ai_operated_mutation_foundation.sql'))
  await db.exec(await sql('20260923030000_cgr01_authoritative_commands.sql'))
  await db.exec(await sql('20261002123812_consumer_management_atomic_grants.sql'))
  await db.exec(await sql('20261002175431_opportunity_management_v3.sql'))
  await db.exec(await sql('20261002195807_planning_management_v4.sql'))
  await db.exec(await sql('20261002211312_discovery_profile_management_v5.sql'))
  const owner = '00000000-0000-4000-8000-000000000001'
  const other = '00000000-0000-4000-8000-000000000002'
  const client = '00000000-0000-4000-8000-000000000003'
  const grantId = '00000000-0000-4000-8000-000000000004'
  const state = { schema: 'pjsdas-local-snapshot', version: 4, exportedAt: '2026-10-02T00:00:00Z', data: { opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], scheduleNodes: [], decisionRequests: [], semanticReceipts: [], reminderIntents: [], reminderOutbox: [] } }
  await db.query('insert into auth.users(id) values ($1),($2)', [owner, other])
  await db.query('insert into public.pjsdas_workspaces(user_id,snapshot,schema_version) values ($1,$2,4)', [owner, JSON.stringify(state)])
  await db.query(`insert into public.pjsdas_business_management_grants(id,user_id,client_id,capability,consent_version,consent_text_hash) values($1,$2,$3,'workspace.discovery-profile.manage',5,$4)`, [grantId, owner, client, 'a'.repeat(64)])
  const invoke = async ({command='command-1',user=owner,clientId=client,id=grantId,grantRevision=1,revision=0,operation='discovery_profile_management',provenance={},principal='delegated_mcp',rpc='pjsdas_commit_discovery_profile_workspace_v1',snapshot=state}={}) => db.query(
    `select * from public.${rpc}($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [user,command,operation,`hash:${command}`,revision,JSON.stringify(snapshot),4,principal,clientId,JSON.stringify(provenance),'{}',null,'{}',id,grantRevision])
  const denied = async options => assert.rejects(invoke(options), error => error.code === '42501')
  // Public/ordinary identities cannot invoke the service-only mutation RPC.
  await db.exec('set role authenticated')
  await denied()
  await assert.rejects(db.query('select * from public.pjsdas_business_management_grants'), error=>error.code==='42501')
  await db.exec('reset role; set role service_role')
  await denied({user:other}); await denied({clientId:other}); await denied({grantRevision:99}); await denied({operation:'arbitrary_override'}); await denied({principal:'first_party_web'})
  const v2Id = '00000000-0000-4000-8000-000000000009'
  await db.query(`insert into public.pjsdas_business_management_grants(id,user_id,client_id,capability,consent_version,consent_text_hash) values($1,$2,$3,'workspace.manage',2,$4)`, [v2Id, owner, client, 'b'.repeat(64)])
  await denied({id:v2Id})
  await denied({rpc:'pjsdas_commit_management_workspace_v1',operation:'business_management'})
  await denied({operation:'business_management'})
  await assert.rejects(db.query(`insert into public.pjsdas_business_management_grants(user_id,client_id,capability,consent_version,consent_text_hash) values($1,$2,'workspace.manage',3,$3)`,[other,client,'a'.repeat(64)]),error=>error.code==='23514')
  // Scope enforcement compares protected raw data, not normalized projections.
  for (const key of ['opportunities','processes','processEvents','actions','scheduleNodes','reminderIntents','decisionRules','timePlanning']) {
    const changed=structuredClone(state);changed.data[key]=[{id:'unauthorized-other-domain'}]
    await denied({command:`bad-${key}`,snapshot:changed})
  }
  state.data.timeline=[{id:'existing-audit',title:'Original history'}]
  await db.query('update public.pjsdas_workspaces set snapshot=$1 where user_id=$2',[JSON.stringify(state),owner])
  const tampered=structuredClone(state);tampered.data.timeline[0].title='rewritten'
  await denied({command:'audit-tamper',snapshot:tampered})
  const removed=structuredClone(state);removed.data.timeline=[]
  await denied({command:'audit-remove',snapshot:removed})
  assert.equal((await db.query('select count(*)::int n from public.pjsdas_command_ledger')).rows[0].n,0)
  state.data.discoveryProfile={key:'current',version:1,fixture:'validated-by-app-reducer'}
  state.data.timeline.push({id:'planning-audit',title:'Explicit planning change'})
  const v3Id = '00000000-0000-4000-8000-000000000019'
  await db.query("insert into public.pjsdas_business_management_grants(id,user_id,client_id,capability,consent_version,consent_text_hash) values($1,$2,$3,'workspace.opportunity.manage',3,$4)",[v3Id,owner,client,'c'.repeat(64)])
  await denied({id:v3Id});await denied({rpc:'pjsdas_commit_opportunity_workspace_v1',operation:'opportunity_management'})
  const v4Id='00000000-0000-4000-8000-000000000029'
  await db.query("insert into public.pjsdas_business_management_grants(id,user_id,client_id,capability,consent_version,consent_text_hash) values($1,$2,$3,'workspace.planning.manage',4,$4)",[v4Id,owner,client,'d'.repeat(64)])
  await denied({id:v4Id});await denied({rpc:'pjsdas_commit_planning_workspace_v1',operation:'planning_management'})
  const committed = await invoke()
  assert.equal(committed.rows[0].outcome,'COMMITTED')
  assert.equal(committed.rows[0].receipt.managementAuthorization.grantId,grantId)
  assert.equal(committed.rows[0].receipt.managementAuthorization.grantRevision,1)
  assert.equal((await invoke()).rows[0].outcome,'ALREADY_APPLIED')
  assert.equal((await invoke({command:'stale-cas',snapshot:tampered})).rows[0].outcome,'CONFLICT')
  // Real table UPDATE increments the revision even when caller supplies another.
  await db.query('update public.pjsdas_business_management_grants set revoked_at=now(), revision=999 where id=$1',[grantId])
  assert.equal((await db.query('select revision from public.pjsdas_business_management_grants where id=$1',[grantId])).rows[0].revision,2)
  await denied({command:'revoked-old',revision:1}); await denied({command:'revoked-fresh',revision:1,grantRevision:2})
  assert.equal((await db.query('select count(*)::int as count from public.pjsdas_command_ledger')).rows[0].count,1)
  await db.query('update public.pjsdas_business_management_grants set revoked_at=null where id=$1',[grantId])
  await denied({command:'stale-regrant',revision:1})
  await denied({command:'wrong-undo',revision:1,grantRevision:3,operation:'undo_command',provenance:{undoOf:'another-account-command'}})
  const undo = await invoke({command:'valid-undo',revision:1,grantRevision:3,operation:'undo_command',provenance:{undoOf:'command-1'}})
  assert.equal(undo.rows[0].outcome,'COMMITTED')
  // A delete/recreate cannot reuse the old grant's identity (ABA protection).
  await db.query('delete from public.pjsdas_business_management_grants where id=$1',[grantId])
  await db.query(`insert into public.pjsdas_business_management_grants(user_id,client_id,capability,consent_version,consent_text_hash) values($1,$2,'workspace.discovery-profile.manage',5,$3)`,[owner,client,'a'.repeat(64)])
  await denied({command:'replaced-grant',revision:2})
  assert.equal((await db.query('select revision from public.pjsdas_workspaces where user_id=$1',[owner])).rows[0].revision,2)
  const oldStillWorks = await invoke({rpc:'pjsdas_commit_management_workspace_v1',operation:'business_management',id:v2Id,command:'v2-still-bounded',revision:2})
  assert.equal(oldStillWorks.rows[0].outcome,'COMMITTED')
  assert.equal(oldStillWorks.rows[0].receipt.managementAuthorization.consentVersion,2)
  const v3StillWorks=await invoke({rpc:'pjsdas_commit_opportunity_workspace_v1',operation:'opportunity_management',id:v3Id,command:'v3-still-bounded',revision:3})
  assert.equal(v3StillWorks.rows[0].outcome,'COMMITTED');assert.equal(v3StillWorks.rows[0].receipt.managementAuthorization.consentVersion,3)
  const v4StillWorks=await invoke({rpc:'pjsdas_commit_planning_workspace_v1',operation:'planning_management',id:v4Id,command:'v4-still-bounded',revision:4});assert.equal(v4StillWorks.rows[0].outcome,'COMMITTED')
  console.log('PASS: version-5 PostgreSQL migration, privileges, owner/client binding, version lock checks, revocation, regrant, undo binding and replacement-grant rejection.')
  console.log('LIMIT: PGlite is one backend; real concurrent multi-session lock scheduling still needs a dedicated Postgres concurrency test before activation.')
} finally { await db.close() }
