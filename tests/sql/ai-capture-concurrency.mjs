// Synthetic PostgreSQL multi-session checks. Never a production URL or provider request.
// Uses the already-running, existing CI PostgreSQL service and its role bootstrap.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { fixtureUrl, migration, state } from './discovery-authority-fixture.mjs'

// Reject missing/non-fixture configuration before constructing a database client.
const url = fixtureUrl()
const database = `ta_capture_fixture_${randomUUID().replaceAll('-', '')}`
const config = { connectionString: url.toString(), statement_timeout: 15000, connectionTimeoutMillis: 5000 }
const owner = '00000000-0000-4000-8000-000000000901'
const names = ['observer', 'writer', 'racer', 'blocker']
let admin, created = false, clients = {}, pids = {}, witnesses = 0, groups = 0
const track = promise => {
  const pending = { settled: false }
  pending.result = promise.then(value => { pending.settled = true; return { value } }, error => { pending.settled = true; return { error } })
  return pending
}
const q = (name, sql, values) => clients[name].query(sql, values)
const admitSql = 'select * from public.pjsdas_admit_ai_capture($1,$2,$3,$4,$5,$6,$7,$8)'
const commitSql = 'select * from public.pjsdas_commit_ai_capture($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)'
const reference = '2026-10-19T00:00:00.000Z' // Synthetic interpretation anchor; expiry uses DB admission time.
const observation = id => ({ contractVersion: 1, inputId: `ai:${id}`, statementMode: 'current_intent', originalText: 'capture text',
  source: { kind: 'web', sourceId: 'todayaction-web', sourceRecordId: id, timezone: 'UTC', observedAt: reference },
  candidates: [{ id: 'ai-capture:1', kind: 'manual_action', title: 'Synthetic task', objectConfidence: 'high', eventConfidence: 'high', evidenceRefs: [], sourceVersionRefs: [] }] })
const admit = (name, id, units = 3) => q(name, admitSql, [owner, id, `hash:${id}`, 'capture text', 'UTC', reference, 0, units])
const confirm = (name, id, command = `confirm:${id}`) => q(name, commitSql,
  [owner, command, 'ai_capture_confirm', `hash:${command}`, 0, state, 4, 'first_party_web', null, {}, null, reference, {}, id, observation(id)])
async function ready(id) {
  await admit('observer', id)
  const obs = observation(id)
  await q('observer', 'select * from public.pjsdas_finish_ai_capture($1,$2,$3,$4,$5,$6)',
    [owner, id, `hash:${id}`, 'READY', { status: 'ready_for_review', statementMode: obs.statementMode, candidates: obs.candidates }, obs])
}
async function reset(limit = 30) {
  await q('observer', 'truncate public.pjsdas_ai_capture_previews,public.pjsdas_ai_capture_policies,public.pjsdas_command_ledger,public.pjsdas_workspaces')
  await q('observer', 'insert into public.pjsdas_workspaces(user_id,snapshot,schema_version) values($1,$2,4)', [owner, state])
  await q('observer', `insert into public.pjsdas_ai_capture_policies
    (user_id,enabled,data_scope_approved,funding_boundary_reference,valid_until,max_request_units,free_units_limit)
    values($1,true,true,'synthetic-enforced-no-overage',clock_timestamp()+interval '1 hour',3,$2)`, [owner, limit])
}
async function durable() {
  return {
    workspace: (await q('observer', 'select revision,snapshot from public.pjsdas_workspaces where user_id=$1', [owner])).rows[0],
    previews: (await q('observer', 'select request_id,status,command_id from public.pjsdas_ai_capture_previews order by request_id')).rows,
    count: Number((await q('observer', 'select count(*) from public.pjsdas_command_ledger')).rows[0].count),
    held: Number((await q('observer', 'select reserved_units from public.pjsdas_ai_capture_policies where user_id=$1', [owner])).rows[0].reserved_units),
  }
}
async function waitForBlock(waiter, holder, pending, relation) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const row = (await q('observer', `select a.wait_event_type, pg_blocking_pids(a.pid) as blockers,
      exists(select 1 from pg_locks w join pg_locks h on h.locktype=w.locktype and h.transactionid=w.transactionid
        where w.pid=$1 and h.pid=$2 and w.locktype='transactionid' and not w.granted and h.granted) as transaction_lock,
      exists(select 1 from pg_locks r where r.pid=$1 and r.locktype='relation' and r.relation=$3::regclass and r.granted) as relation_lock
      from pg_stat_activity a where a.pid=$1`, [pids[waiter], pids[holder], relation])).rows[0]
    if (row?.wait_event_type === 'Lock' && row.blockers.includes(pids[holder]) && row.transaction_lock && row.relation_lock) {
      assert.equal(pending.settled, false); witnesses++; return
    }
    if (pending.settled) { const result = await pending.result; throw result.error ?? new Error('Contender completed without exact lock witness') }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Missing lock witness ${waiter} behind ${holder}`)
}
async function waitPastExpiry(table, column, where = '') {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if ((await q('observer', `select clock_timestamp() > ${column} as expired from public.${table} ${where}`)).rows[0]?.expired) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Fixture DB clock did not cross expiry')
}
const committed = result => { assert.ifError(result.error); assert.equal(result.value.rows[0].outcome, 'COMMITTED') }
const denied = (result, code) => { assert.ok(result.error); assert.equal(result.error.code, code) }

try {
  admin = new pg.Client(config); await admin.connect()
  assert.equal(Math.floor(Number((await admin.query('show server_version_num')).rows[0].server_version_num) / 10000), 17, 'Existing PostgreSQL 17 service required')
  await admin.query(`create database ${database}`); created = true
  const local = new URL(url); local.pathname = `/${database}`
  clients = Object.fromEntries(names.map(name => [name, new pg.Client({ ...config, connectionString: local.toString(), application_name: `ta-capture-${name}` })]))
  await Promise.all(Object.values(clients).map(client => client.connect()))
  for (const name of names) pids[name] = Number((await q(name, 'select pg_backend_pid() as pid')).rows[0].pid)
  await q('observer', 'create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;')
  for (const file of ['2026091901_ai_operated_mutation_foundation.sql', '20260923030000_cgr01_authoritative_commands.sql', '20261019071353_ai_capture_durable_receipts.sql']) await q('observer', await migration(file))
  await q('observer', 'insert into auth.users values($1)', [owner])
  for (const name of ['writer', 'racer', 'blocker']) await q(name, 'set role service_role')

  // The second admission is already in flight while the first transaction is held.
  for (const sameId of [true, false]) {
    await reset(3); await q('writer', 'begin'); await admit('writer', 'first')
    const second = track(admit('racer', sameId ? 'first' : 'second'))
    await waitForBlock('racer', 'writer', second, 'public.pjsdas_workspaces')
    assert.equal((await durable()).held, 0, 'Uncommitted reservation is invisible')
    await q('writer', 'commit'); denied(await second.result, sameId ? '23505' : '42501')
    const saved = await durable(); assert.equal(saved.held, 3); assert.equal(saved.previews.length, 1); assert.equal(saved.count, 0)
    groups++
  }

  await reset(3); await q('writer', 'begin'); await admit('writer', 'rollback-admission')
  const retryAdmission = track(admit('racer', 'rollback-admission'))
  await waitForBlock('racer', 'writer', retryAdmission, 'public.pjsdas_workspaces'); await q('writer', 'rollback')
  assert.ifError((await retryAdmission.result).error); assert.equal((await durable()).held, 3); assert.equal((await durable()).previews.length, 1); groups++

  await reset(); await ready('same-review'); await q('writer', 'begin'); assert.equal((await confirm('writer', 'same-review')).rows[0].outcome, 'COMMITTED')
  const secondConfirm = track(confirm('racer', 'same-review', 'different-confirm'))
  await waitForBlock('racer', 'writer', secondConfirm, 'public.pjsdas_workspaces'); await q('writer', 'commit')
  denied(await secondConfirm.result, '42501'); assert.equal((await durable()).count, 1)
  assert.equal((await confirm('racer', 'same-review')).rows[0].outcome, 'ALREADY_APPLIED'); groups++

  await reset(); await ready('revision-loser'); await q('writer', 'begin')
  await q('writer', 'select * from public.pjsdas_commit_workspace_v2($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
    [owner, 'unrelated-command', 'fixture-unrelated', 'unrelated-hash', 0, state, 4, 'first_party_web', null, {}, null, reference, {}])
  const revisionLoser = track(confirm('racer', 'revision-loser'))
  await waitForBlock('racer', 'writer', revisionLoser, 'public.pjsdas_workspaces'); await q('writer', 'commit')
  const conflict = await revisionLoser.result; assert.ifError(conflict.error); assert.equal(conflict.value.rows[0].outcome, 'CONFLICT')
  const conflicted = await durable(); assert.equal(conflicted.count, 1); assert.equal(conflicted.previews[0].status, 'READY'); assert.equal(conflicted.previews[0].command_id, null); groups++

  await reset(); await ready('rollback-confirm'); await q('writer', 'begin'); await confirm('writer', 'rollback-confirm')
  const retryConfirm = track(confirm('racer', 'rollback-confirm'))
  await waitForBlock('racer', 'writer', retryConfirm, 'public.pjsdas_workspaces'); await q('writer', 'rollback')
  committed(await retryConfirm.result); assert.equal((await durable()).count, 1); assert.equal((await durable()).previews[0].status, 'COMMITTED'); groups++

  // Start contenders before expiry, witness queueing, then use DB wall-clock evidence.
  for (const preview of [false, true]) {
    await reset(); if (preview) await ready('expires')
    const table = preview ? 'pjsdas_ai_capture_previews' : 'pjsdas_ai_capture_policies'
    const column = preview ? 'expires_at' : 'valid_until'
    await q('observer', `update public.${table} set ${column}=clock_timestamp()+interval '1500 milliseconds'`)
    await q('blocker', 'begin'); await q('blocker', 'select id from public.pjsdas_workspaces where user_id=$1 for update', [owner])
    await q('racer', 'begin')
    assert.equal((await q('racer', `select transaction_timestamp() < ${column} as started_before_expiry from public.${table}`)).rows[0].started_before_expiry, true, 'Contender transaction must start before expiry')
    const expiring = track(preview ? confirm('racer', 'expires') : admit('racer', 'expires'))
    await waitForBlock('racer', 'blocker', expiring, 'public.pjsdas_workspaces')
    await waitPastExpiry(table, column); await q('blocker', 'commit')
    denied(await expiring.result, '42501'); await q('racer', 'rollback')
    const saved = await durable(); assert.equal(saved.count, 0); assert.equal(saved.held, preview ? 3 : 0)
    if (preview) assert.equal(saved.previews[0].status, 'READY'); else assert.equal(saved.previews.length, 0)
    groups++
  }

  // Revocation wins before admission obtains its policy lock.
  await reset(); await q('blocker', 'begin'); await q('blocker', 'update public.pjsdas_ai_capture_policies set enabled=false where user_id=$1', [owner])
  const revoked = track(admit('racer', 'revoked'))
  await waitForBlock('racer', 'blocker', revoked, 'public.pjsdas_ai_capture_policies'); await q('blocker', 'commit')
  denied(await revoked.result, '42501'); assert.equal((await durable()).held, 0); assert.equal((await durable()).previews.length, 0); groups++

  // Admission wins: revocation waits for its reservation, then fences future sends.
  await reset(); await q('writer', 'begin'); await admit('writer', 'admission-first')
  const revokeAfter = track(q('racer', 'update public.pjsdas_ai_capture_policies set enabled=false where user_id=$1', [owner]))
  await waitForBlock('racer', 'writer', revokeAfter, 'public.pjsdas_ai_capture_policies'); await q('writer', 'commit')
  assert.ifError((await revokeAfter.result).error); await assert.rejects(() => admit('writer', 'after-revoke'), { code: '42501' })
  assert.equal((await durable()).held, 3); groups++

  // Funding/data-sharing revocation is dispatch-only, not a hidden cancellation of
  // a user's already-reviewed local write. Global server-disable confirmation is
  // tested in authoritativeCommands.test.ts before reaching this RPC.
  await reset(); await ready('review-before-revoke')
  await q('observer', 'update public.pjsdas_ai_capture_policies set enabled=false')
  assert.equal((await confirm('writer', 'review-before-revoke')).rows[0].outcome, 'COMMITTED'); groups++
  assert.equal(groups, 11); assert.equal(witnesses, 10)
  console.log(`PASS AI capture PostgreSQL 17: ${groups} schedules, ${witnesses} exact lock witnesses; single reservation, last-credit contention, confirm/replay, rollback, revision, wall-clock expiry and dispatch revocation.`)
} finally {
  await Promise.allSettled(['writer', 'racer', 'blocker'].filter(name => clients[name]).map(name => clients[name].query('rollback')))
  await Promise.allSettled(Object.values(clients).map(client => client.end()))
  if (admin) await admin.end().catch(() => {})
  if (created) {
    const cleanup = new pg.Client(config)
    try { await cleanup.connect(); await cleanup.query(`drop database ${database}`) }
    finally { await cleanup.end() }
  }
}
