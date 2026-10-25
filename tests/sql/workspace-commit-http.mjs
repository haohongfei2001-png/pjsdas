// Real HTTP -> pinned PostgREST -> PostgreSQL 17 -> original immutable receipt.
// Synthetic CI only; no production configuration, credentials or model calls.
// https://github.com/PostgREST/postgrest/releases/tag/v14.5
// https://postgrest.org/en/v14/references/configuration.html
import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { request as httpRequest } from 'node:http'
import pg from 'pg'
import { fixtureUrl, migration } from './discovery-authority-fixture.mjs'

const url = fixtureUrl() // Reject unsafe targets before any process/client creation.
const docker = promisify(execFile)
const suffix = randomUUID().replaceAll('-', '')
const database = `ta_http_fixture_${suffix}`, container = `ta-postgrest-${suffix}`
const port = 33017, origin = `http://127.0.0.1:${port}`
const secret = 'synthetic-only-postgrest-jwt-secret-never-production'
const owner = '00000000-0000-4000-8000-000000000971'
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
function token(role) {
  const input = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ role, exp: Math.floor(Date.now() / 1000) + 600 })}`
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`
}
function body(id, revision, snapshot = { synthetic: true }, hash = `hash:${id}`) {
  return { target_user_id: owner, target_command_id: id, target_operation: 'synthetic_http_fixture', target_payload_hash: hash,
    target_expected_revision: revision, target_snapshot: snapshot, target_schema_version: 4, target_principal_kind: 'first_party_web',
    target_client_id: null, target_provenance: {}, target_compensation: null, target_effective_time: null, target_receipt_context: {} }
}
let path = '/rpc/pjsdas_commit_workspace_v3?select=outcome,workspace_id,revision,receipt'
const headers = role => ({ 'content-type': 'application/json', ...(role ? { authorization: `Bearer ${token(role)}` } : {}) })
async function post(value, role = 'service_role') {
  const started = performance.now(), request = JSON.stringify(value)
  const response = await fetch(origin + path, { method: 'POST', headers: headers(role), body: request, signal: AbortSignal.timeout(60000) })
  const text = await response.text()
  return { status: response.status, value: JSON.parse(text), requestBytes: Buffer.byteLength(request), responseBytes: Buffer.byteLength(text), elapsedMs: Math.round(performance.now() - started) }
}
// Seeded synthetic bytes are repeatable but deliberately resist TOAST's usual
// compression of the flat repeated-string control. No user content is sampled.
function seededText(bytes, seed) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const output = Buffer.allocUnsafe(bytes)
  let state = seed >>> 0
  for (let index = 0; index < bytes; index++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5
    output[index] = alphabet.charCodeAt((state >>> 0) & 63)
  }
  return output.toString('ascii')
}
function diagnosticShapes() {
  const structured = { synthetic: true, rows: Array.from({ length: 7000 }, (_, index) => ({
    id: `synthetic-${index}`, company: `Fixture Company ${index % 53}`, role: 'Synthetic engineer',
    notes: 'Synthetic narrative for an isolated benchmark. '.repeat(8),
    source: { url: `https://example.invalid/jobs/${index}`, verified: true, aliases: [`fixture:${index}`, `source:${index}`] },
    history: [{ version: 1, value: index }, { version: 2, value: index + 1 }],
  })) }
  const shapes = [
    { name: 'structured-arrays', snapshot: structured, receiptContext: {} },
    { name: 'seeded-high-entropy', snapshot: { synthetic: true, payload: seededText(4_000_000, 0x514A2026) }, receiptContext: {} },
    { name: 'large-receipt-only', snapshot: { synthetic: true }, receiptContext: { syntheticReceiptPayload: seededText(3_000_000, 0x72656365) } },
  ]
  for (const shape of shapes) {
    const payloadBytes = Buffer.byteLength(JSON.stringify(shape.snapshot)) + Buffer.byteLength(JSON.stringify(shape.receiptContext))
    assert.ok(payloadBytes >= 3_000_000 && payloadBytes <= 5_000_000, `${shape.name} must stay within the bounded diagnostic input`)
  }
  return shapes
}
function planTempNodes(plan) {
  const result = []
  function visit(node) {
    if (!node) return
    result.push({ nodeType: node['Node Type'], functionName: node['Function Name'], alias: node.Alias,
      tempRead: node['Temp Read Blocks'] ?? 0, tempWritten: node['Temp Written Blocks'] ?? 0,
      rows: node['Actual Rows'], loops: node['Actual Loops'] })
    for (const child of node.Plans ?? []) visit(child)
  }
  visit(plan)
  return result // Parent counts include children: never sum these as total IO.
}
let admin, db, created = false, started = false, dockerAttempted = false
try {
  admin = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000, statement_timeout: 15000 }); await admin.connect()
  assert.equal(Math.floor(Number((await admin.query('show server_version_num')).rows[0].server_version_num) / 10000), 17)
  await admin.query(`create database ${database}`); created = true
  const local = new URL(url); local.pathname = `/${database}`
  db = new pg.Client({ connectionString: local.toString(), connectionTimeoutMillis: 5000, statement_timeout: 15000 }); await db.connect()
  await db.query('create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;')
  for (const name of ['2026091901_ai_operated_mutation_foundation.sql', '20260923030000_cgr01_authoritative_commands.sql', '20261025065403_commit_workspace_metadata_only.sql']) await db.query(await migration(name))
  await db.query(await migration('20261025084300_commit_workspace_raw_json.sql'))
  await db.query(`create function public.fixture_http_settings() returns table(statement_timeout text,lock_timeout text,work_mem text)
    language sql stable as $$select current_setting('statement_timeout'),current_setting('lock_timeout'),current_setting('work_mem')$$`)
  await db.query('insert into auth.users values($1)', [owner])
  await db.query('insert into public.pjsdas_workspaces(user_id,snapshot,schema_version) values($1,$2,4)', [owner, '{}'])
  local.search = '?options=' + encodeURIComponent('-c work_mem=2184kB -c statement_timeout=8s -c lock_timeout=8s') // Only this synthetic PostgREST connection.
  // Existing CI roles only. PostgREST authenticates with the synthetic fixture
  // postgres connection, then SET ROLE follows signed JWT or anonymous role.
  dockerAttempted = true
  await docker('docker', ['run', '--detach', '--rm', '--name', container, '--network', 'host',
    '-e', `PGRST_DB_URI=${local}`, '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=anon',
    '-e', `PGRST_JWT_SECRET=${secret}`, '-e', 'PGRST_SERVER_HOST=127.0.0.1', '-e', `PGRST_SERVER_PORT=${port}`,
    '-e', 'PGRST_DB_POOL=4', '-e', 'PGRST_DB_PLAN_ENABLED=true', '-e', 'PGRST_DB_TX_END=commit-allow-override', 'postgrest/postgrest:v14.5'], { timeout: 120000, maxBuffer: 1024 * 1024 })
  started = true
  let ready = false
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(origin + '/', { headers: headers('service_role'), signal: AbortSignal.timeout(1000) })
      if (response.ok) { await response.text(); ready = true; break }
      await response.text()
    } catch { /* Startup only, never a mutation retry. */ }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.ok(ready, 'Pinned PostgREST did not become ready')
  const effective = await fetch(origin + '/rpc/fixture_http_settings', { headers: headers('service_role'), signal: AbortSignal.timeout(5000) })
  assert.equal(effective.status, 200)
  assert.deepEqual(await effective.json(), [{ statement_timeout: '8s', lock_timeout: '8s', work_mem: '2184kB' }])
  console.log('Synthetic HTTP session settings verified: statement_timeout=8s lock_timeout=8s work_mem=2184kB; not proof of a past production request setting.')
  const measurements = []
  for (const version of [3, 4]) {
  path = `/rpc/pjsdas_commit_workspace_v${version}?select=outcome,workspace_id,revision,receipt`
  await db.query('truncate public.pjsdas_command_ledger,public.pjsdas_workspaces')
  await db.query('insert into public.pjsdas_workspaces(user_id,snapshot,schema_version) values($1,$2,4)', [owner, '{}'])
  for (const role of [null, 'anon', 'authenticated']) {
    const denied = await post(body(`denied-${role}`, 0), role)
    assert.ok([401, 403].includes(denied.status), `Expected execution denial for ${role}: ${denied.status}`)
    assert.equal(denied.value.code, '42501')
  }
  assert.equal(Number((await db.query('select count(*) from pjsdas_command_ledger')).rows[0].count), 0)
  const first = await post(body('first', 0))
  assert.equal(first.status, 200); assert.equal(first.value[0].outcome, 'COMMITTED')
  assert.deepEqual(Object.keys(first.value[0]).sort(), ['outcome', 'receipt', 'revision', 'workspace_id'])
  assert.equal(first.value[0].revision, 1)
  const replay = await post(body('first', 0))
  assert.equal(replay.value[0].outcome, 'ALREADY_APPLIED'); assert.deepEqual(replay.value[0].receipt, first.value[0].receipt)
  const conflict = await post(body('stale', 0))
  assert.equal(conflict.value[0].outcome, 'CONFLICT')
  const mismatch = await post(body('first', 1, {}, 'wrong-hash'))
  assert.equal(mismatch.status, 409); assert.equal(mismatch.value.code, '23505')
  assert.equal(Number((await db.query('select count(*) from pjsdas_command_ledger')).rows[0].count), 1)

  // Both HTTP transactions are in flight and blocked on this exact workspace,
  // not merely two sequential requests called "concurrency".
  await db.query('begin'); await db.query('select id from pjsdas_workspaces where user_id=$1 for update', [owner])
  const holder = Number((await db.query('select pg_backend_pid() as pid')).rows[0].pid)
  const races = ['race-a', 'race-b'].map(id => post(body(id, 1, { winner: id })))
  // Attach rejection handlers before awaiting a lock witness.
  const raced = Promise.all(races); raced.catch(() => {})
  let witnessed = false
  const lockDeadline = Date.now() + 10000
  while (Date.now() < lockDeadline) {
    const rows = (await admin.query("select pid,pg_blocking_pids(pid) as blockers from pg_stat_activity where datname=$1 and wait_event_type='Lock' and query like $2", [database, `%pjsdas_commit_workspace_v${version}%`])).rows
    if (rows.length === 2 && rows.some(row => row.blockers.includes(holder))) { witnessed = true; break }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(witnessed, 'Both real HTTP writers must reach the controlled workspace lock')
  await db.query('commit')
  const pair = await raced
  assert.deepEqual(pair.map(item => item.value[0].outcome).sort(), ['COMMITTED', 'CONFLICT'])
  assert.equal(Number((await db.query('select revision from pjsdas_workspaces')).rows[0].revision), 2)
  assert.equal(Number((await db.query("select count(*) from pjsdas_command_ledger where command_id like 'race-%'")).rows[0].count), 1)

  // Deliberately discard response bytes after headers. Database readback, not
  // transport success, establishes the original command before a same-ID retry.
  const lost = body('discarded-response', 2, { recovered: true })
  await new Promise((resolve, reject) => {
    const request = httpRequest(origin + path, { method: 'POST', headers: headers('service_role') }, response => {
      response.destroy(); request.destroy(); resolve()
    })
    request.setTimeout(60000, () => request.destroy(new Error('Synthetic request timed out')))
    request.on('error', reject); request.end(JSON.stringify(lost))
  })
  const recorded = (await db.query('select receipt from pjsdas_command_ledger where command_id=$1', ['discarded-response'])).rows[0]
  assert.ok(recorded)
  const recovered = await post(lost)
  assert.equal(recovered.value[0].outcome, 'ALREADY_APPLIED'); assert.deepEqual(recovered.value[0].receipt, recorded.receipt)
  assert.equal(Number((await db.query('select revision from pjsdas_workspaces')).rows[0].revision), 3)

  const large = await post(body('large', 3, { fixture: 'synthetic-only-'.repeat(1800000) }))
  assert.equal(large.status, 200); assert.equal(large.value[0].outcome, 'COMMITTED')
  assert.ok(large.requestBytes > 25_000_000); assert.ok(large.responseBytes < 2048)
  const readback = (await db.query('select revision,octet_length(snapshot::text) as bytes from pjsdas_workspaces')).rows[0]
  assert.equal(Number(readback.revision), 4); assert.ok(Number(readback.bytes) > 25_000_000)
  console.log('PASS real PostgREST v14.5/PG17 HTTP: JWT denials, three outcomes, immutable replay/hash rejection, exact concurrent lock witness, discarded-response recovery, large request/small receipt.', JSON.stringify({ largeRequestBytes: large.requestBytes, largeResponseBytes: large.responseBytes, largeElapsedMs: large.elapsedMs, version }))

  // Verify override support on the ordinary HTTP response first. PostgREST
  // v14.5 Response.hs DbPlanResult intentionally emits only content headers,
  // not Preference-Applied, so plan rollback is proved by database readback.
  const rollbackProbe = await fetch(origin + path, { method: 'POST',
    headers: { ...headers('service_role'), prefer: 'tx=rollback' },
    body: JSON.stringify(body('rollback-probe', 4)), signal: AbortSignal.timeout(60000) })
  assert.equal(rollbackProbe.status, 200)
  assert.ok(rollbackProbe.headers.get('preference-applied')?.includes('tx=rollback'))
  assert.equal((await rollbackProbe.json())[0].outcome, 'COMMITTED')
  assert.equal(Number((await db.query("select count(*) from pjsdas_command_ledger where command_id='rollback-probe'")).rows[0].count), 0)
  assert.equal(Number((await db.query('select revision from pjsdas_workspaces')).rows[0].revision), 4)

  // Plan mode measures the entire real PostgREST statement, including input
  // record materialization hidden from a direct SQL RPC benchmark. Roll back
  // every ANALYZE request, and verify that it did not append a real fixture row.
  for (const [outcome, id, revision] of [['COMMITTED', 'plan-new', 4], ['ALREADY_APPLIED', 'large', 3], ['CONFLICT', 'plan-stale', -1]]) {
    const before = Number((await db.query('select count(*) from pjsdas_command_ledger')).rows[0].count)
    const response = await fetch(origin + path, { method: 'POST', headers: { ...headers('service_role'),
      accept: 'application/vnd.pgrst.plan+json; options=analyze|buffers', prefer: 'tx=rollback' },
      body: JSON.stringify(body(id, revision, { fixture: 'synthetic-only-'.repeat(1800000) })), signal: AbortSignal.timeout(60000) })
    assert.equal(response.status, 200)
    const plan = (await response.json())[0]
    assert.ok(plan?.Plan && typeof plan['Execution Time'] === 'number')
    const result = { version, outcome, tempRead: plan.Plan['Temp Read Blocks'] ?? 0, tempWritten: plan.Plan['Temp Written Blocks'] ?? 0, executionMs: plan['Execution Time'] }
    measurements.push(result); console.log('Real HTTP synthetic query plan:', JSON.stringify(result))
    if (version === 3 && outcome === 'COMMITTED') assert.ok(result.tempWritten > 0, 'Named input baseline must reproduce PostgREST materialization')
    if (version === 4) assert.equal(result.tempWritten, 0, `Raw JSON ${outcome} should avoid input/return spill`)
    assert.equal(Number((await db.query('select count(*) from pjsdas_command_ledger')).rows[0].count), before)
    assert.equal(Number((await db.query('select revision from pjsdas_workspaces')).rows[0].revision), 4)
  }
  }
  console.log('PostgREST HTTP plan summary:', JSON.stringify(measurements))

  // Diagnostic matrix, NOT a reproduction of the user's workload or a latency
  // guarantee. No zero-spill assertion is generalized beyond the original
  // small-receipt control above. In particular, a large returned receipt can
  // still spill even when v4 avoids input and snapshot-return materialization.
  const diagnosticDeadline = performance.now() + 95000
  const diagnosticSignal = () => {
    const remaining = Math.floor(diagnosticDeadline - performance.now())
    assert.ok(remaining > 0, 'Synthetic diagnostic matrix exceeded its 95-second request budget')
    return AbortSignal.timeout(Math.min(15000, remaining))
  }
  const diagnostics = []
  for (const shape of diagnosticShapes()) for (const version of [3, 4]) {
    path = `/rpc/pjsdas_commit_workspace_v${version}?select=outcome,workspace_id,revision,receipt`
    // Fresh comparable preimages, not a growing snapshot/ledger across cases.
    await db.query('truncate public.pjsdas_command_ledger,public.pjsdas_workspaces')
    await db.query('insert into public.pjsdas_workspaces(user_id,snapshot,schema_version) values($1,$2,4)', [owner, '{}'])
    const value = body(`shape-${shape.name}-v${version}`, 0, shape.snapshot)
    value.target_receipt_context = shape.receiptContext
    const serializationStarted = performance.now(), request = JSON.stringify(value)
    const result = { shape: shape.name, version, fixtureOnly: true, requestJsonBytes: Buffer.byteLength(request),
      serializationMs: Math.round(performance.now() - serializationStarted) }
    try {
      const planStarted = performance.now()
      const response = await fetch(origin + path, { method: 'POST', headers: { ...headers('service_role'),
        accept: 'application/vnd.pgrst.plan+json; options=analyze|buffers', prefer: 'tx=rollback' },
        body: request, signal: diagnosticSignal() })
      result.planHttpStatus = response.status
      const planBody = await response.json()
      result.planHttpMs = Math.round(performance.now() - planStarted)
      if (!response.ok) { result.planErrorCode = planBody.code; throw new Error(`Synthetic ${shape.name}/v${version} plan HTTP ${response.status}`) }
      const plan = planBody[0]
      assert.ok(plan?.Plan && typeof plan['Execution Time'] === 'number')
      Object.assign(result, { planExecutionMs: plan['Execution Time'], planPlanningMs: plan['Planning Time'],
        tempRead: plan.Plan['Temp Read Blocks'] ?? 0, tempWritten: plan.Plan['Temp Written Blocks'] ?? 0,
        planTempNodes: planTempNodes(plan.Plan) })
      assert.equal(Number((await db.query('select count(*) from pjsdas_command_ledger')).rows[0].count), 0)
      assert.equal(Number((await db.query('select revision from pjsdas_workspaces')).rows[0].revision), 0)

      // Commit once after the rolled-back ANALYZE; never retry after a timeout.
      const commitStarted = performance.now()
      const committed = await fetch(origin + path, { method: 'POST', headers: headers('service_role'), body: request, signal: diagnosticSignal() })
      const responseText = await committed.text()
      Object.assign(result, { commitHttpStatus: committed.status, commitHttpMs: Math.round(performance.now() - commitStarted),
        responseJsonBytes: Buffer.byteLength(responseText) })
      const receiptRows = JSON.parse(responseText)
      if (!committed.ok) { result.commitErrorCode = receiptRows.code; throw new Error(`Synthetic ${shape.name}/v${version} commit HTTP ${committed.status}`) }
      assert.equal(receiptRows[0].outcome, 'COMMITTED'); assert.equal(receiptRows[0].revision, 1)
      const stored = (await db.query(`select pg_column_size(w.snapshot) as snapshot_stored_bytes,
        octet_length(w.snapshot::text) as snapshot_jsonb_text_bytes, pg_column_size(l.receipt) as receipt_stored_bytes,
        octet_length(l.receipt::text) as receipt_jsonb_text_bytes, w.revision
        from pjsdas_workspaces w join pjsdas_command_ledger l on l.workspace_id=w.id
        where w.user_id=$1 and l.command_id=$2`, [owner, value.target_command_id])).rows[0]
      assert.equal(Number(stored.revision), 1)
      Object.assign(result, { snapshotStoredBytes: stored.snapshot_stored_bytes, snapshotJsonbTextBytes: stored.snapshot_jsonb_text_bytes,
        receiptStoredBytes: stored.receipt_stored_bytes, receiptJsonbTextBytes: stored.receipt_jsonb_text_bytes })
      // Payload shape, unlike measured performance, is an invariant of this fixture.
      if (shape.name === 'large-receipt-only') assert.ok(result.responseJsonBytes > 3_000_000)
      else assert.ok(result.responseJsonBytes < 2048)
      diagnostics.push(result)
      console.log('Synthetic shape diagnostic (not production reproduction):', JSON.stringify(result))
    } catch (error) {
      console.error('Synthetic shape diagnostic incomplete; no automatic request retry:', JSON.stringify({ ...result, error: error.name }))
      throw error
    }
  }
  assert.ok(performance.now() <= diagnosticDeadline, 'Synthetic diagnostic matrix exceeded its 95-second request budget')
  console.log('Synthetic shape matrix completed; no production latency claim:', JSON.stringify(diagnostics))
} catch (error) {
  if (started) {
    const logs = await docker('docker', ['logs', '--tail', '200', container], { timeout: 10000 }).catch(() => ({ stdout: '', stderr: '' }))
    console.error(logs.stdout, logs.stderr)
  }
  throw error
} finally {
  if (db) await db.query('rollback').catch(() => {})
  if (dockerAttempted) await docker('docker', ['rm', '--force', container], { timeout: 10000 }).catch(() => {})
  if (db) await db.end().catch(() => {})
  if (admin) {
    try { if (created) await admin.query(`drop database ${database} with (force)`) }
    finally { await admin.end() }
  }
}
