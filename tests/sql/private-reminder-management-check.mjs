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
  await db.exec(await sql('20261002220516_private_reminder_management_v6.sql'))
  const owner = '00000000-0000-4000-8000-000000000001'
  const other = '00000000-0000-4000-8000-000000000002'
  const client = '00000000-0000-4000-8000-000000000003'
  const grantId = '00000000-0000-4000-8000-000000000004'
  const state = { schema: 'pjsdas-local-snapshot', version: 4, exportedAt: '2026-10-02T00:00:00Z', data: { opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], scheduleNodes: [], decisionRequests: [], semanticReceipts: [], reminderIntents: [], reminderOutbox: [] } }
  state.data.scheduleNodes=[{id:'node-a',occurrenceId:'occurrence-a',version:1,state:'scheduled'}]
  await db.query('insert into auth.users(id) values ($1),($2)', [owner, other])
  await db.query('insert into public.pjsdas_workspaces(user_id,snapshot,schema_version) values ($1,$2,4)', [owner, JSON.stringify(state)])
  await db.query(`insert into public.pjsdas_business_management_grants(id,user_id,client_id,capability,consent_version,consent_text_hash) values($1,$2,$3,'workspace.reminders.manage',6,$4)`, [grantId, owner, client, 'a'.repeat(64)])
  const invoke = async ({command='command-1',user=owner,clientId=client,id=grantId,grantRevision=1,revision=0,operation='private_reminder_management',provenance={},principal='delegated_mcp',rpc='pjsdas_commit_private_reminder_workspace_v1',snapshot=state}={}) => db.query(
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
  state.data.reminderIntents=[{id:'private-fixture',scheduleNodeId:'node-a',scheduleNodeVersion:1,purpose:'custom',triggerAt:'2026-10-03T01:00:00Z',deliveryOwner:'pjsdas',channel:'in_product',state:'active',dedupeKey:'node-a@1|custom',createdAt:'2026-10-02T00:00:00Z',updatedAt:'2026-10-02T00:00:00Z'}]
  state.data.timeline.push({id:'planning-audit',title:'Explicit planning change'})
  const v3Id = '00000000-0000-4000-8000-000000000019'
  await db.query("insert into public.pjsdas_business_management_grants(id,user_id,client_id,capability,consent_version,consent_text_hash) values($1,$2,$3,'workspace.opportunity.manage',3,$4)",[v3Id,owner,client,'c'.repeat(64)])
  await denied({id:v3Id});await denied({rpc:'pjsdas_commit_opportunity_workspace_v1',operation:'opportunity_management'})
  const v4Id='00000000-0000-4000-8000-000000000029'
  await db.query("insert into public.pjsdas_business_management_grants(id,user_id,client_id,capability,consent_version,consent_text_hash) values($1,$2,$3,'workspace.planning.manage',4,$4)",[v4Id,owner,client,'d'.repeat(64)])
  await denied({id:v4Id});await denied({rpc:'pjsdas_commit_planning_workspace_v1',operation:'planning_management'})
  const v5Id='00000000-0000-4000-8000-000000000039'
  await db.query("insert into public.pjsdas_business_management_grants(id,user_id,client_id,capability,consent_version,consent_text_hash) values($1,$2,$3,'workspace.discovery-profile.manage',5,$4)",[v5Id,owner,client,'e'.repeat(64)])
  await denied({id:v5Id});await denied({rpc:'pjsdas_commit_discovery_profile_workspace_v1',operation:'discovery_profile_management'})
  const committed = await invoke()
  assert.equal(committed.rows[0].outcome,'COMMITTED')
  assert.equal(committed.rows[0].receipt.managementAuthorization.grantId,grantId)
  assert.equal(committed.rows[0].receipt.managementAuthorization.grantRevision,1)
  assert.equal((await invoke()).rows[0].outcome,'ALREADY_APPLIED')
  assert.equal((await invoke({command:'stale-cas',snapshot:tampered})).rows[0].outcome,'CONFLICT')
  for (const [name,change] of [
    ['external-owner',row=>({...row,deliveryOwner:'external_task',channel:'task',capability:'chatgpt_tasks'})],
    ['null-capability',row=>({...row,capability:null})], ['null-external-link',row=>({...row,externalLink:null})],
    ['wrong-node-version',row=>({...row,scheduleNodeVersion:9})], ['wrong-dedupe',row=>({...row,dedupeKey:'wrong'})],
  ]) {const next=structuredClone(state);next.data.reminderIntents[0]=change(next.data.reminderIntents[0]);await denied({command:name,revision:1,snapshot:next})}
  const collision=structuredClone(state);collision.data.reminderIntents.push({...collision.data.reminderIntents[0],id:'second-private'})
  await denied({command:'duplicate-purpose',revision:1,snapshot:collision})
  const outbox=structuredClone(state);outbox.data.reminderOutbox.push({id:'external-outbox',reminderIntentId:'private-fixture'})
  await denied({command:'outbox-write',revision:1,snapshot:outbox})
  const externalState=structuredClone(state)
  const privateRow=externalState.data.reminderIntents[0]
  externalState.data.reminderIntents.push({...privateRow,id:'external-a',purpose:'prep',dedupeKey:'node-a@1|prep',deliveryOwner:'external_task',channel:'task',capability:'chatgpt_tasks'}, {...privateRow,id:'external-b',purpose:'follow_up',dedupeKey:'node-a@1|follow_up',deliveryOwner:'external_calendar',channel:'calendar',capability:'google_calendar'})
  externalState.data.reminderOutbox=[{id:'protected-outbox',reminderIntentId:'external-a',operation:'upsert',capability:'chatgpt_tasks',state:'pending',attemptCount:0}]
  await db.query('update public.pjsdas_workspaces set snapshot=$1 where user_id=$2',[JSON.stringify(externalState),owner])
  for(const [name,mutate]of [
    ['remove-external',s=>s.data.reminderIntents.splice(1,1)],
    ['change-external',s=>s.data.reminderIntents[1].triggerAt='2026-10-03T00:00:00Z'],
    ['reorder-external',s=>s.data.reminderIntents.reverse()],
    ['convert-external',s=>{s.data.reminderIntents[1].deliveryOwner='pjsdas';s.data.reminderIntents[1].channel='in_product';delete s.data.reminderIntents[1].capability}],
    ['duplicate-external-id',s=>s.data.reminderIntents.push({...privateRow,id:'external-a'})],
    ['change-outbox',s=>s.data.reminderOutbox[0].attemptCount++],
  ]){const next=structuredClone(externalState);mutate(next);await denied({command:name,revision:1,snapshot:next})}
  const paused=structuredClone(externalState);paused.data.reminderIntents[0].state='paused'
  await db.exec('begin')
  const withExternal=await invoke({command:'private-pause-preserves-external',revision:1,snapshot:paused})
  assert.equal(withExternal.rows[0].outcome,'COMMITTED');assert.deepEqual(withExternal.rows[0].snapshot.data.reminderIntents.slice(1),externalState.data.reminderIntents.slice(1));assert.deepEqual(withExternal.rows[0].snapshot.data.reminderOutbox,externalState.data.reminderOutbox)
  await db.exec('rollback')
  const linked=structuredClone(externalState);linked.data.reminderOutbox.push({id:'private-linked',reminderIntentId:'private-fixture',capability:'chatgpt_tasks'})
  await db.query('update public.pjsdas_workspaces set snapshot=$1 where user_id=$2',[JSON.stringify(linked),owner])
  const linkedCancel=structuredClone(linked);linkedCancel.data.reminderIntents[0].state='cancelled'
  await denied({command:'linked-private-cancel',revision:1,snapshot:linkedCancel})
  await db.query('update public.pjsdas_workspaces set snapshot=$1 where user_id=$2',[JSON.stringify(state),owner])
  console.log('PASS v6 external/outbox rows and relative order protected; private pause leaves them exact; null capabilities and duplicate identities denied.')
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
  await db.query(`insert into public.pjsdas_business_management_grants(user_id,client_id,capability,consent_version,consent_text_hash) values($1,$2,'workspace.reminders.manage',6,$3)`,[owner,client,'a'.repeat(64)])
  await denied({command:'replaced-grant',revision:2})
  assert.equal((await db.query('select revision from public.pjsdas_workspaces where user_id=$1',[owner])).rows[0].revision,2)
  const oldStillWorks = await invoke({rpc:'pjsdas_commit_management_workspace_v1',operation:'business_management',id:v2Id,command:'v2-still-bounded',revision:2})
  assert.equal(oldStillWorks.rows[0].outcome,'COMMITTED')
  assert.equal(oldStillWorks.rows[0].receipt.managementAuthorization.consentVersion,2)
  const v3StillWorks=await invoke({rpc:'pjsdas_commit_opportunity_workspace_v1',operation:'opportunity_management',id:v3Id,command:'v3-still-bounded',revision:3})
  assert.equal(v3StillWorks.rows[0].outcome,'COMMITTED');assert.equal(v3StillWorks.rows[0].receipt.managementAuthorization.consentVersion,3)
  const v4StillWorks=await invoke({rpc:'pjsdas_commit_planning_workspace_v1',operation:'planning_management',id:v4Id,command:'v4-still-bounded',revision:4});assert.equal(v4StillWorks.rows[0].outcome,'COMMITTED')
  const v5StillWorks=await invoke({rpc:'pjsdas_commit_discovery_profile_workspace_v1',operation:'discovery_profile_management',id:v5Id,command:'v5-still-bounded',revision:5});assert.equal(v5StillWorks.rows[0].outcome,'COMMITTED')
  console.log('PASS: version-6 PostgreSQL migration, privileges, owner/client binding, version lock checks, revocation, regrant, undo binding and replacement-grant rejection.')
  console.log('LIMIT: PGlite is one backend; real concurrent multi-session lock scheduling still needs a dedicated Postgres concurrency test before activation.')
} finally { await db.close() }
