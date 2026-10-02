// No-network synthetic integration: actual gateway executor/store + real PGlite RPC.
// Run from the reviewed repo: node --import tsx tests/sql/planning-management-gateway.mjs "$PWD"
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const repo = resolve(process.argv[2] ?? process.cwd())
const load = path => import(pathToFileURL(resolve(repo, path)).href)
const sqlRequire = createRequire(resolve(repo, 'tests/sql/package.json'))
const { PGlite } = await import(pathToFileURL(sqlRequire.resolve('@electric-sql/pglite')).href)
const { createAuthoritativeCommandExecutor } = await load('gateway/authoritativeCommands.ts')
const { getPlanningManagementRead, planningManagementFingerprint } = await load('src/planningManagement.ts')
const { unknownDeadlineWorkspace } = await load('tests/fixtures/unknownDeadlineWorkspace.ts')
const { validateSnapshot } = await load('src/snapshot.ts')
const db = new PGlite()
const network = globalThis.fetch
globalThis.fetch = async () => { throw new Error('Unexpected external network call') }
const protectedData = snapshot => Object.fromEntries(Object.entries(snapshot.data).filter(([key]) => !['decisionRules', 'timePlanning', 'timeline'].includes(key)))
try {
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;')
  for (const file of ['2026091901_ai_operated_mutation_foundation.sql', '20260923030000_cgr01_authoritative_commands.sql', '20261002123812_consumer_management_atomic_grants.sql', '20261002175431_opportunity_management_v3.sql', '20261002195807_planning_management_v4.sql']) await db.exec(await readFile(resolve(repo, 'supabase/migrations', file), 'utf8'))
  for (const [index, scenario] of ['normalized', 'raw-action-date', 'metadata-restore', 'newer-config-conflict', 'legacy-missing-arrays'].entries()) {
    const owner = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
    const client = '10000000-0000-4000-8000-000000000001'
    const id = `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
    const initial = JSON.parse(JSON.stringify(unknownDeadlineWorkspace(1)))
    if (scenario === 'raw-action-date') { initial.data.actions[0].dueAt = '2026-08-27T15:59:59Z'; initial.data.actions[0].timingMode = 'deadline' }
    if (scenario === 'metadata-restore') initial.data.timePlanning = { version: 1, defaultDailyMinutes: 0, weeklyWindows: [], dateOverrides: {}, updatedAt: '2026-10-01T00:00:00Z', syntheticMetadata: { retained: true } }
    if (scenario === 'legacy-missing-arrays') { initial.version = 1; for (const key of ['scheduleNodes', 'decisionRequests', 'semanticReceipts', 'reminderIntents', 'reminderOutbox']) delete initial.data[key] }
    validateSnapshot(initial)
    await db.query('insert into auth.users(id) values($1)', [owner])
    await db.query('insert into public.pjsdas_workspaces(user_id,snapshot,schema_version) values($1,$2,$3)', [owner, JSON.stringify(initial), initial.version])
    await db.query("insert into public.pjsdas_business_management_grants(id,user_id,client_id,capability,consent_version,consent_text_hash) values($1,$2,$3,'workspace.planning.manage',4,$4)", [id, owner, client, 'a'.repeat(64)])
    const grant = { id, revision: 1, userId: owner, clientId: client, consentVersion: 4, capability: 'workspace.planning.manage', grantedAt: '2026-10-01T00:00:00Z' }
    const principal = { kind: 'delegated_mcp', userId: owner, clientId: client }
    let posts = 0
    const fetchImpl = async (input, init) => {
      const url = new URL(String(input))
      assert.equal(url.origin, 'https://fixture.invalid')
      if (init?.method === 'POST') {
        posts++
        assert.equal(url.pathname, '/rest/v1/rpc/pjsdas_commit_planning_workspace_v1')
        const body = JSON.parse(String(init.body))
        assert.equal(body.target_user_id, owner)
        assert.equal(body.target_client_id, client)
        try {
          const result = await db.query('select * from public.pjsdas_commit_planning_workspace_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)', [owner, body.target_command_id, body.target_operation, body.target_payload_hash, body.target_expected_revision, JSON.stringify(body.target_snapshot), body.target_schema_version, body.target_principal_kind, client, JSON.stringify(body.target_provenance), JSON.stringify(body.target_compensation), body.target_effective_time, JSON.stringify(body.target_receipt_context), body.target_grant_id, body.target_grant_revision])
          return Response.json(result.rows.map(({ snapshot, ...row }) => row))
        } catch (error) { return Response.json({ code: error.code, message: error.message }, { status: error.code === '42501' ? 403 : 500 }) }
      }
      assert.equal(url.searchParams.get('user_id'), `eq.${owner}`)
      if (url.pathname === '/rest/v1/pjsdas_workspaces') return Response.json((await db.query('select * from public.pjsdas_workspaces where user_id=$1', [owner])).rows)
      assert.equal(url.pathname, '/rest/v1/pjsdas_command_ledger')
      const rows = (await db.query("select * from public.pjsdas_command_ledger where user_id=$1 and status='COMMITTED' order by resulting_revision", [owner])).rows
      const command = url.searchParams.get('command_id'), after = url.searchParams.get('resulting_revision')
      return Response.json(rows.filter(row => (!command || command === `eq.${row.command_id}`) && (!after || row.resulting_revision > Number(after.slice(3)))))
    }
    const executor = createAuthoritativeCommandExecutor({ supabaseUrl: 'https://fixture.invalid', serviceRoleKey: 'fixture-only', fetchImpl, resolvePlanningManagementGrant: async () => grant })
    if (scenario === 'legacy-missing-arrays') {
      await assert.rejects(getPlanningManagementRead(initial), error => error.code === 'INVALID_CONFIGURATION' && /separate snapshot migration/.test(error.message))
      const command = { commandId: `review-${scenario}-apply`, baseRevision: 0, command: { type: 'planning_management', value: { operations: [{ kind: 'patch_time_preferences', expectedFingerprint: await planningManagementFingerprint(null), patch: { defaultDailyMinutes: 60 } }] } } }
      await assert.rejects(executor.execute(principal, command), error => error.code === 'INVALID_CONFIGURATION' && /separate snapshot migration/.test(error.message))
      assert.equal(posts, 0)
      assert.deepEqual((await db.query('select snapshot from public.pjsdas_workspaces where user_id=$1', [owner])).rows[0].snapshot, initial)
      console.log('PASS legacy-missing-arrays: explicit migration error before RPC, original workspace retained')
      continue
    }
    const read = await getPlanningManagementRead(initial)
    const command = { commandId: `review-${scenario}-apply`, baseRevision: 0, command: { type: 'planning_management', value: { operations: [{ kind: 'patch_time_preferences', expectedFingerprint: read.timePreferences.fingerprint, patch: { defaultDailyMinutes: 60 } }] } } }
    const applied = await executor.execute(principal, command)
    assert.equal(applied.outcome, 'COMMITTED', scenario)
    assert.equal((await executor.execute(principal, command)).outcome, 'ALREADY_APPLIED')
    const undo = { commandId: `review-${scenario}-undo`, targetCommandId: command.commandId, expectedCompensationFingerprint: applied.result.compensationFingerprint }
    if (scenario === 'newer-config-conflict') {
      const current = (await db.query('select snapshot from public.pjsdas_workspaces where user_id=$1', [owner])).rows[0].snapshot
      current.data.timePlanning.defaultDailyMinutes = 90
      await db.query('update public.pjsdas_workspaces set snapshot=$1,revision=2 where user_id=$2', [JSON.stringify(current), owner])
      await assert.rejects(executor.undo(principal, undo), error => error.code === 'RESTORE_CONFLICT')
      assert.equal(posts, 1)
      assert.deepEqual((await db.query('select snapshot from public.pjsdas_workspaces where user_id=$1', [owner])).rows[0].snapshot, current)
      console.log('PASS newer-config-conflict: restore refuses newer configuration before RPC and retains it')
      continue
    }
    assert.equal((await executor.undo(principal, undo)).outcome, 'COMMITTED')
    assert.equal((await executor.undo(principal, undo)).outcome, 'ALREADY_APPLIED')
    assert.equal(posts, 2)
    const stored = (await db.query('select snapshot from public.pjsdas_workspaces where user_id=$1', [owner])).rows[0].snapshot
    assert.deepEqual(protectedData(stored), protectedData(initial))
    assert.deepEqual(stored.data.timePlanning, initial.data.timePlanning)
    assert.deepEqual(stored.data.timeline.slice(0, initial.data.timeline?.length ?? 0), initial.data.timeline ?? [])
    console.log(`PASS ${scenario}: actual gateway + SQL commit/replay/restore preserve protected raw data and history`)
  }
} finally { globalThis.fetch = network; await db.close() }
