// PostgreSQL 17-only, four-session synthetic budget gate. This test creates and
// drops only its own fresh fixture database after the loopback URL guard passes.
// No server bootstrap, package installation, provider call, production fallback,
// or PGlite substitution. Run after the existing SQL fixture role bootstrap.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url)))
const require = createRequire(resolve(root, 'tests/sql/package.json'))
const pg = require('pg')
const {
  authorityMigration, owner, subject, state, fixtureUrl, installBase,
  seedExistingAuthority, migration, proof, commitQuery, args, durableState,
  receiptProof, securityCatalog, functionCatalog, commitSignature,
} = await import(pathToFileURL(resolve(root, 'tests/sql/discovery-authority-fixture.mjs')).href)

// Validate before constructing any client. Only the existing synthetic
// postgresql://postgres:fixture-only@127.0.0.1/... fixture contract is accepted.
const url = fixtureUrl()
const candidate = await migration('20261008164000_discovery_batch_budget_claim.sql')
const database = 'ta_discovery_budget_fixture'
const adminConfig = { connectionString: url.toString(), statement_timeout: 15000, connectionTimeoutMillis: 5000 }
const names = ['observer', 'blocker', 'writer', 'racer']
const queryCount = 12
const heldMicroUsd = 487031 // 12 x 5,000 search + 427,031 fixed model envelope.
const scope = 'c'.repeat(64)
const digest = value => createHash('sha256').update(String(value)).digest('hex')
let admin, created = false, clients = {}, pids = {}
let groups = 0, lockWitnesses = 0, committedCount = 0
let securityBefore, identityBefore, originalSnapshots

const track = promise => {
  const pending = { settled: false }
  pending.result = promise.then(value => { pending.settled = true; return { value } }, error => { pending.settled = true; return { error } })
  return pending
}
const currentRevision = async () => Number((await clients.observer.query('select revision from public.pjsdas_workspaces where user_id=$1', [owner])).rows[0].revision)
const rawSnapshots = async () => (await clients.observer.query('select user_id,snapshot::text as snapshot,schema_version from public.pjsdas_workspaces order by user_id')).rows
const identity = async () => (await clients.observer.query(`select oid::regprocedure::text as signature, proowner, proacl::text,
  prosecdef, proconfig, provolatile, proparallel, prokind from pg_proc where oid=$1::regprocedure`, [commitSignature])).rows[0]
const call = (client, authority, options) => clients[client].query(commitQuery, args(authority, options))
const clock = async () => new Date((await clients.observer.query('select clock_timestamp() as wall_clock')).rows[0].wall_clock).getTime()

async function waitForBlock(waiter, holder, pending, relation, mode) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const row = (await clients.observer.query(`select a.wait_event_type,
      pg_blocking_pids(a.pid) as blockers,
      exists(select 1 from pg_locks w join pg_locks h
        on h.locktype=w.locktype and h.transactionid=w.transactionid
        where w.pid=$1 and h.pid=$2 and w.locktype='transactionid'
          and not w.granted and h.granted) as exact_transaction_lock,
      exists(select 1 from pg_locks r where r.pid=$1 and r.locktype='relation'
        and r.relation=$3::regclass and r.mode=$4 and r.granted) as relation_lock
      from pg_stat_activity a where a.pid=$1`, [pids[waiter], pids[holder], relation, mode])).rows[0]
    if (row?.wait_event_type === 'Lock' && row.blockers.includes(pids[holder]) && row.exact_transaction_lock && row.relation_lock) {
      assert.equal(pending.settled, false, `${waiter} must still be queued behind ${holder}`)
      lockWitnesses++
      return
    }
    if (pending.settled) {
      const result = await pending.result
      throw result.error ?? new Error(`${waiter} completed without a witnessed ${holder} transaction lock on ${relation}`)
    }
    // Time only bounds observer load; it is never evidence that a query blocked.
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Missing exact lock witness: ${waiter} behind ${holder} on ${relation}`)
}

async function activate() {
  await clients.observer.query(`update public.google_drive_connections set revoked_at=null,
    discovery_automation_enabled=true,discovery_last_error=null,google_subject=$2 where user_id=$1`, [owner, subject])
  return proof(clients.observer, 'automation')
}
async function revoke(client) {
  return clients[client].query('update public.google_drive_connections set revoked_at=clock_timestamp() where user_id=$1', [owner])
}
async function terms(name, cap = heldMicroUsd, expiresAt) {
  const now = await clock()
  return { version: 1, application: 'todayaction', approvalId: `fixture:budget:${name}`, accountId: owner,
    scopeFingerprint: scope, currency: 'USD', maximumMicroUsd: cap,
    validFrom: new Date(now - 3600000).toISOString(), expiresAt: expiresAt ?? new Date(now + 3600000).toISOString(),
    tariffVersion: 'todayaction-standard-search-text-2026-10-08' }
}
function claim(name, policy, revision) {
  // Every contender differs in all three dimensions. Approval/account alone
  // must determine the shared cap, rather than source, plan or cycle grouping.
  const sourceId = `discovery:fixture-budget:${name}`
  const batch = { version: 1, planFingerprint: digest(`plan:${name}`), cycleId: digest(`cycle:${name}`),
    claimAttemptId: randomUUID(), index: 0, count: 1, queryStart: 0,
    queryCount, totalQueryCount: queryCount, phase: 'claimed' }
  const hold = { version: 1, policy, policyFingerprint: digest(JSON.stringify(policy)), sourceId,
    claimAttemptId: batch.claimAttemptId, searchRequestLimit: queryCount, modelRequestLimit: 1, reservedMicroUsd: heldMicroUsd }
  return { command: `fixture-budget:${name}`, operation: 'checkpoint_discovery_search', revision, snapshot: state,
    provenance: { sourceId, scopeFingerprint: scope, producer: 'server_scheduler', runId: `fixture-budget:${name}`,
      searchPlanFingerprint: batch.planFingerprint, searchCycleId: batch.cycleId, searchBatchIndex: 0,
      searchPhase: 'claimed', searchBatch: batch, discoveryBudgetHold: hold } }
}
function assertAdmission(result, options, authority, admitted) {
  assert.equal(result.outcome, 'COMMITTED')
  assert.equal(result.receipt.status, 'COMMITTED')
  assert.equal(Number(result.revision), options.revision + 1)
  assert.deepEqual(result.receipt.discoveryAuthorization, receiptProof(authority))
  assert.deepEqual(result.receipt.discoveryBudget, { version: 1, hold: options.provenance.discoveryBudgetHold,
    admitted, retainedMicroUsd: admitted ? heldMicroUsd : 0 })
}
async function assertInvariants() {
  assert.deepEqual(await rawSnapshots(), originalSnapshots, 'all raw v4 snapshots and schema versions must remain unchanged')
  assert.deepEqual(await securityCatalog(clients.observer), securityBefore, 'no ACL, RLS, policy or relation privilege changes')
  assert.deepEqual(await identity(), identityBefore, 'guard owner, signature, invoker security and function grants stay unchanged')
}
async function verifyAppend(before, additions) {
  const after = await durableState(clients.observer)
  assert.equal(after.ledger.length, before.ledger.length + additions.length)
  assert.deepEqual(after.ledger.slice(0, before.ledger.length), before.ledger, 'previous ledger rows are immutable')
  for (const { result, options, authority, admitted } of additions) {
    assertAdmission(result, options, authority, admitted)
    const row = after.ledger.find(row => row.command_id === options.command)
    assert.ok(row); assert.equal(row.user_id, owner); assert.equal(row.status, 'COMMITTED')
    assert.equal(row.operation, 'checkpoint_discovery_search'); assert.equal(row.principal_kind, 'automation')
    assert.equal(Number(row.expected_revision), options.revision)
    assert.equal(Number(row.resulting_revision), options.revision + 1)
    assert.deepEqual(row.provenance, options.provenance); assert.deepEqual(row.receipt, result.receipt)
  }
  assert.deepEqual(after.workspaces.filter(row => row.user_id !== owner), before.workspaces.filter(row => row.user_id !== owner))
  assert.equal(await currentRevision(), Number(before.workspaces.find(row => row.user_id === owner).revision) + additions.length)
  committedCount += additions.length
  await assertInvariants()
}
async function assertHeld(policy, expected, count) {
  const rows = (await clients.observer.query(`select provenance,receipt from public.pjsdas_command_ledger
    where user_id=$1 and status='COMMITTED' and operation='checkpoint_discovery_search'
      and principal_kind='automation' and provenance->>'searchPhase'='claimed'
      and provenance #>> '{discoveryBudgetHold,policy,approvalId}'=$2`, [owner, policy.approvalId])).rows
  assert.equal(rows.length, count)
  const total = rows.reduce((sum, row) => sum + row.receipt.discoveryBudget.retainedMicroUsd, 0)
  assert.equal(total, expected); assert.ok(total <= policy.maximumMicroUsd)
}
async function replayUnchanged(options, authority, original) {
  const before = await durableState(clients.observer)
  const result = (await call('writer', authority, { ...options, revision: await currentRevision() })).rows[0]
  assert.equal(result.outcome, 'ALREADY_APPLIED'); assert.deepEqual(result.receipt, original.receipt)
  assert.deepEqual(await durableState(clients.observer), before)
  await assertInvariants()
}
async function deniedUnchanged(options, authority, client = 'writer') {
  const before = await durableState(clients.observer)
  const error = await call(client, authority, options).then(() => null, error => error)
  assert.equal(error?.code, '42501')
  assert.deepEqual(await durableState(clients.observer), before)
}

async function capContention() {
  const authority = await activate(), policy = await terms('contention'), revision = await currentRevision()
  const before = await durableState(clients.observer)
  const firstOptions = claim('contention-first', policy, revision)
  // Target the next revision here so the budget decline itself becomes durable.
  // The separate CAS schedule covers contenders that both read the old revision.
  const secondOptions = claim('contention-second', policy, revision + 1)
  await clients.writer.query('begin')
  const first = (await call('writer', authority, firstOptions)).rows[0]
  assertAdmission(first, firstOptions, authority, true)
  const secondPending = track(call('racer', authority, secondOptions))
  await waitForBlock('racer', 'writer', secondPending, 'public.pjsdas_workspaces', 'RowShareLock')
  assert.deepEqual(await durableState(clients.observer), before, 'uncommitted first hold is invisible to the observer')
  await clients.writer.query('commit')
  const secondResult = await secondPending.result; assert.ifError(secondResult.error)
  const second = secondResult.value.rows[0]
  await verifyAppend(before, [ { result: first, options: firstOptions, authority, admitted: true },
    { result: second, options: secondOptions, authority, admitted: false } ])
  await assertHeld(policy, heldMicroUsd, 2)
  await replayUnchanged(firstOptions, authority, first)
  await replayUnchanged(secondOptions, authority, second)
  await assertHeld(policy, heldMicroUsd, 2)
  groups++
  console.log('PASS PostgreSQL budget contention: second source/plan/cycle waits on first claim, then durably declines with zero retained amount; replay preserves both decisions.')
}

async function casLoserAndRetry() {
  const authority = await activate(), policy = await terms('cas-retry', heldMicroUsd * 2), revision = await currentRevision()
  const before = await durableState(clients.observer)
  const firstOptions = claim('cas-first', policy, revision), losingOptions = claim('cas-second', policy, revision)
  await clients.writer.query('begin')
  const first = (await call('writer', authority, firstOptions)).rows[0]
  assertAdmission(first, firstOptions, authority, true)
  const loserPending = track(call('racer', authority, losingOptions))
  await waitForBlock('racer', 'writer', loserPending, 'public.pjsdas_workspaces', 'RowShareLock')
  assert.deepEqual(await durableState(clients.observer), before)
  await clients.writer.query('commit')
  const loser = await loserPending.result; assert.ifError(loser.error)
  assert.equal(loser.value.rows[0].outcome, 'CONFLICT')
  assert.equal(loser.value.rows[0].receipt.status, 'CONFLICT')
  assert.equal(Number(loser.value.rows[0].receipt.actualRevision), revision + 1)
  await verifyAppend(before, [{ result: first, options: firstOptions, authority, admitted: true }])
  await assertHeld(policy, heldMicroUsd, 1)
  assert.equal((await durableState(clients.observer)).ledger.some(row => row.command_id === losingOptions.command), false)
  const retryBefore = await durableState(clients.observer)
  const retryOptions = { ...losingOptions, revision: revision + 1 }
  const retry = (await call('racer', authority, retryOptions)).rows[0]
  await verifyAppend(retryBefore, [{ result: retry, options: retryOptions, authority, admitted: true }])
  await assertHeld(policy, heldMicroUsd * 2, 2)
  await replayUnchanged(firstOptions, authority, first); await replayUnchanged(retryOptions, authority, retry)
  const fullBefore = await durableState(clients.observer), thirdOptions = claim('cas-third', policy, await currentRevision())
  const third = (await call('writer', authority, thirdOptions)).rows[0]
  await verifyAppend(fullBefore, [{ result: third, options: thirdOptions, authority, admitted: false }])
  await assertHeld(policy, heldMicroUsd * 2, 3)
  groups++
  console.log('PASS PostgreSQL budget CAS: stale loser creates no phantom hold; exact command retry spends remaining cap once; replay consumes nothing further.')
}

async function rollbackAndRedo() {
  const authority = await activate(), policy = await terms('rollback'), revision = await currentRevision()
  const before = await durableState(clients.observer)
  const firstOptions = claim('rollback-first', policy, revision), racerOptions = claim('rollback-racer', policy, revision)
  await clients.writer.query('begin')
  const transient = (await call('writer', authority, firstOptions)).rows[0]
  assertAdmission(transient, firstOptions, authority, true)
  const racerPending = track(call('racer', authority, racerOptions))
  await waitForBlock('racer', 'writer', racerPending, 'public.pjsdas_workspaces', 'RowShareLock')
  assert.deepEqual(await durableState(clients.observer), before)
  await clients.writer.query('rollback')
  const raced = await racerPending.result; assert.ifError(raced.error)
  const winner = raced.value.rows[0]
  await verifyAppend(before, [{ result: winner, options: racerOptions, authority, admitted: true }])
  await assertHeld(policy, heldMicroUsd, 1)
  assert.equal((await durableState(clients.observer)).ledger.some(row => row.command_id === firstOptions.command), false)
  const redoBefore = await durableState(clients.observer), redoOptions = { ...firstOptions, revision: await currentRevision() }
  const redo = (await call('writer', authority, redoOptions)).rows[0]
  await verifyAppend(redoBefore, [{ result: redo, options: redoOptions, authority, admitted: false }])
  assert.notDeepEqual(redo.receipt.discoveryBudget, transient.receipt.discoveryBudget, 'rolled-back result cannot become a historical admission')
  await replayUnchanged(redoOptions, authority, redo); await replayUnchanged(racerOptions, authority, winner)
  await assertHeld(policy, heldMicroUsd, 2)
  groups++
  console.log('PASS PostgreSQL budget rollback: aborted hold disappears atomically; waiter wins capacity; redo obtains a fresh declined decision, then replays it unchanged.')
}

async function writerFirstRevocation() {
  const authority = await activate(), policy = await terms('writer-first'), revision = await currentRevision()
  const before = await durableState(clients.observer), options = claim('writer-first', policy, revision)
  await clients.blocker.query('begin')
  await clients.blocker.query('select id from public.pjsdas_workspaces where user_id=$1 for update', [owner])
  await clients.writer.query('begin')
  const pending = track(call('writer', authority, options))
  await waitForBlock('writer', 'blocker', pending, 'public.pjsdas_workspaces', 'RowShareLock')
  const revocation = track(revoke('racer'))
  await waitForBlock('racer', 'writer', revocation, 'public.google_drive_connections', 'RowExclusiveLock')
  assert.deepEqual(await durableState(clients.observer), before)
  await clients.blocker.query('commit')
  const written = await pending.result; assert.ifError(written.error)
  const result = written.value.rows[0]; assertAdmission(result, options, authority, true)
  // A function return has not released authority or published the budget hold.
  await waitForBlock('racer', 'writer', revocation, 'public.google_drive_connections', 'RowExclusiveLock')
  assert.deepEqual(await durableState(clients.observer), before)
  await clients.writer.query('commit')
  assert.ifError((await revocation.result).error)
  await verifyAppend(before, [{ result, options, authority, admitted: true }])
  await assertHeld(policy, heldMicroUsd, 1)
  await deniedUnchanged({ ...options, revision: await currentRevision() }, authority)
  groups++
  console.log('PASS PostgreSQL budget writer-first: authority precedes workspace locking and remains held through commit; later revocation prevents replay.')
}

async function revokeFirst() {
  const authority = await activate(), policy = await terms('revoke-first'), revision = await currentRevision()
  const before = await durableState(clients.observer), options = claim('revoke-first', policy, revision)
  await clients.racer.query('begin'); await revoke('racer')
  const pending = track(call('writer', authority, options))
  await waitForBlock('writer', 'racer', pending, 'public.google_drive_connections', 'RowShareLock')
  assert.deepEqual(await durableState(clients.observer), before)
  await clients.racer.query('commit')
  assert.equal((await pending.result).error?.code, '42501')
  assert.deepEqual(await durableState(clients.observer), before)
  await assertHeld(policy, 0, 0); await assertInvariants()
  groups++
  console.log('PASS PostgreSQL budget revoke-first: queued claim reads revoked authority after the lock and rejects without any ledger or snapshot mutation.')
}

async function expiryWhileBlocked() {
  const authority = await activate(), revision = await currentRevision(), expiration = await clock() + 3000
  const policy = await terms('blocked-expiry', heldMicroUsd, new Date(expiration).toISOString())
  const before = await durableState(clients.observer), options = claim('blocked-expiry', policy, revision)
  await clients.blocker.query('begin')
  await clients.blocker.query('select id from public.pjsdas_workspaces where user_id=$1 for update', [owner])
  await clients.writer.query('begin')
  const transactionStart = (await clients.writer.query('select transaction_timestamp() < $1::timestamptz as before_expiry', [policy.expiresAt])).rows[0]
  assert.equal(transactionStart.before_expiry, true)
  const pending = track(call('writer', authority, options))
  await waitForBlock('writer', 'blocker', pending, 'public.pjsdas_workspaces', 'RowShareLock')
  assert.ok(await clock() < expiration, 'claim must reach the witnessed lock while approval is still open')
  const deadline = Date.now() + 7000
  while (await clock() < expiration) {
    assert.ok(Date.now() < deadline, 'database wall clock must cross approval expiry while the lock is held')
    assert.equal(pending.settled, false)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(pending.settled, false)
  assert.deepEqual(await durableState(clients.observer), before)
  await clients.blocker.query('commit')
  const result = await pending.result
  assert.equal(result.error?.code, '42501')
  assert.match(result.error.message, /budget window is closed/i)
  await clients.writer.query('rollback')
  assert.deepEqual(await durableState(clients.observer), before)
  await assertHeld(policy, 0, 0)
  await deniedUnchanged(options, authority)
  await assertInvariants()
  groups++
  console.log('PASS PostgreSQL budget expiry: transaction started before expiry, waited on the exact workspace lock, then wall-clock admission rejected without a hold.')
}

try {
  admin = new pg.Client(adminConfig)
  await admin.connect()
  const version = Number((await admin.query('show server_version_num')).rows[0].server_version_num)
  assert.equal(Math.floor(version / 10000), 17, 'requires PostgreSQL 17; no alternate engine fallback')
  assert.equal((await admin.query("select count(*)::int n from pg_roles where rolname in ('anon','authenticated','service_role')")).rows[0].n, 3,
    'run after the existing SQL fixture bootstrap; this test never provisions roles or credentials')
  // CREATE must fail if this name already exists. Never reuse/drop unknown data.
  await admin.query(`create database ${database}`); created = true
  await admin.end(); admin = null
  const fixture = new URL(url); fixture.pathname = `/${database}`
  clients = Object.fromEntries(names.map(name => [name, new pg.Client({ ...adminConfig,
    connectionString: fixture.toString(), application_name: `ta-discovery-budget-${name}` })]))
  const connected = await Promise.allSettled(Object.values(clients).map(client => client.connect()))
  const failure = connected.find(result => result.status === 'rejected'); if (failure) throw failure.reason
  pids = Object.fromEntries(await Promise.all(Object.entries(clients).map(async ([name, client]) =>
    [name, (await client.query('select pg_backend_pid() pid')).rows[0].pid])))
  assert.equal(new Set(Object.values(pids)).size, 4)
  assert.equal((await clients.observer.query('select count(*)::int n from pg_stat_activity where datname=current_database()')).rows[0].n, 4)
  await installBase(clients.observer); await seedExistingAuthority(clients.observer)
  await clients.observer.query(await migration(authorityMigration))
  securityBefore = await securityCatalog(clients.observer)
  identityBefore = await identity(); originalSnapshots = await rawSnapshots()
  const functionsBefore = await functionCatalog(clients.observer)
  await clients.observer.query(candidate)
  await assertInvariants()
  const functionsAfter = await functionCatalog(clients.observer)
  assert.equal(functionsAfter.length, functionsBefore.length)
  for (const previous of functionsBefore) {
    const current = functionsAfter.find(row => row.signature === previous.signature)
    if (previous.signature.includes('pjsdas_commit_discovery_workspace_v1(')) assert.equal(current.acl, previous.acl)
    else assert.deepEqual(current, previous)
  }
  for (const name of ['writer', 'racer']) await clients[name].query('set role service_role')
  console.log(`Candidate SHA256: ${digest(candidate)}`)
  await capContention()
  await casLoserAndRetry()
  await rollbackAndRedo()
  await writerFirstRevocation()
  await revokeFirst()
  await expiryWhileBlocked()
  const final = await durableState(clients.observer)
  assert.equal(groups, 6); assert.equal(committedCount, 8); assert.equal(lockWitnesses, 8)
  assert.equal(final.ledger.length, committedCount); assert.equal(await currentRevision(), committedCount)
  await assertInvariants()
  console.log(`PASS PostgreSQL 17 Discovery budget: 4 sessions, ${groups} controlled schedules, ${lockWitnesses} exact lock witnesses, ${committedCount} original ledger commits; raw v4 snapshot and security catalogs preserved.`)
} finally {
  // Opposite lock dependencies require concurrent rollback requests. Pending
  // query results are already rejection-handled by track(). Drop only the DB
  // whose successful CREATE this invocation recorded.
  await Promise.allSettled(['blocker', 'racer', 'writer'].filter(name => clients[name]).map(name => clients[name].query('rollback')))
  await Promise.allSettled(Object.values(clients).map(client => client.end()))
  if (admin) await admin.end().catch(() => {})
  if (created) {
    const cleanup = new pg.Client(adminConfig)
    try { await cleanup.connect(); await cleanup.query(`drop database ${database}`) }
    finally { await cleanup.end() }
  }
}
