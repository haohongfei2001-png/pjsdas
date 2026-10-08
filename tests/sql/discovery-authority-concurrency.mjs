// Rebuilt B2 multi-session gate. Only the existing PostgreSQL 17 CI fixture is
// accepted; no production URL, fallback endpoint, service install or PGlite pass.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import pg from 'pg'
import {
  authorityMigration, owner, client, source, subject, fixtureUrl, installBase,
  seedExistingAuthority, migration, proof, commitQuery, args, durableState, receiptProof,
} from './discovery-authority-fixture.mjs'

const url = fixtureUrl()
const database = 'ta_discovery_authority_fixture'
const adminConfig = { connectionString: url.toString(), statement_timeout: 15000, connectionTimeoutMillis: 5000 }
let admin
let created = false
let clients = {}
let groups = 0
let lockWitnesses = 0
let committedCount = 0
let pids
const track = promise => {
  const pending = { settled: false }
  pending.result = promise.then(value => { pending.settled = true; return { value } }, error => { pending.settled = true; return { error } })
  return pending
}

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
      throw result.error ?? new Error(`${waiter} finished without the required lock on ${relation} held by ${holder}`)
    }
    // This delay only bounds observation load. Passage of time never passes a
    // schedule: the exact blocker PID, transaction lock and relation are required.
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`${waiter} did not reach the witnessed ${holder} transaction-lock boundary on ${relation}`)
}

const authorityTable = kind => kind === 'delegated_mcp' ? 'public.pjsdas_authorization_grants' : 'public.google_drive_connections'
const currentRevision = async () => Number((await clients.observer.query('select revision from public.pjsdas_workspaces where user_id=$1', [owner])).rows[0].revision)
async function setActive(kind) {
  if (kind === 'delegated_mcp') {
    await clients.observer.query(`update public.pjsdas_authorization_grants set revoked_at=null
      where user_id=$1 and client_id=$2 and source_id=$3 and capability='ingest_discovery_run'`, [owner, client, source])
  } else {
    await clients.observer.query(`update public.google_drive_connections set revoked_at=null,
      discovery_automation_enabled=true,discovery_last_error=null,google_subject=$2 where user_id=$1`, [owner, subject])
  }
}
async function revoke(db, kind) {
  await db.query(`update ${authorityTable(kind)} set revoked_at=clock_timestamp() where user_id=$1${kind === 'delegated_mcp' ? " and client_id=$2 and source_id=$3 and capability='ingest_discovery_run'" : ''}`,
    kind === 'delegated_mcp' ? [owner, client, source] : [owner])
}
async function regrant(db, kind) {
  await db.query(`update ${authorityTable(kind)} set revoked_at=null where user_id=$1${kind === 'delegated_mcp' ? " and client_id=$2 and source_id=$3 and capability='ingest_discovery_run'" : ''}`,
    kind === 'delegated_mcp' ? [owner, client, source] : [owner])
}
function checkpointOptions(command, revision, snapshot) {
  const fingerprint = createHash('sha256').update(command).digest('hex')
  const batch = { version: 1, planFingerprint: fingerprint, cycleId: fingerprint, claimAttemptId: '11111111-1111-4111-8111-111111111111', index: 0, count: 1, queryStart: 0, queryCount: 1, totalQueryCount: 1, phase: 'claimed' }
  return { command, revision, snapshot, operation: 'checkpoint_discovery_search', provenance: {
    sourceId: source, scopeFingerprint: fingerprint, producer: 'server_scheduler', runId: command,
    searchPlanFingerprint: fingerprint, searchCycleId: fingerprint, searchBatchIndex: 0, searchPhase: 'claimed', searchBatch: batch,
  } }
}
async function verifyOneCommit(before, result, authority, command, revision, operation = 'ingest_verified_discovery') {
  assert.equal(result.outcome, 'COMMITTED')
  assert.equal(Number(result.revision), revision + 1)
  assert.deepEqual(result.receipt.discoveryAuthorization, receiptProof(authority))
  const after = await durableState(clients.observer)
  assert.equal(after.ledger.length, before.ledger.length + 1)
  assert.deepEqual(after.ledger.slice(0, -1), before.ledger, 'earlier durable receipts remain immutable')
  const row = after.ledger.at(-1)
  assert.equal(row.command_id, command)
  assert.equal(row.principal_kind, authority.kind)
  assert.equal(row.operation, operation)
  assert.equal(Number(row.expected_revision), revision)
  assert.equal(Number(row.resulting_revision), revision + 1)
  assert.deepEqual(row.receipt, result.receipt)
  assert.deepEqual(after.workspaces.filter(row => row.user_id !== owner), before.workspaces.filter(row => row.user_id !== owner))
  assert.equal(await currentRevision(), revision + 1)
  committedCount++
}

async function writerFirst(kind, checkpoint = false) {
  const { observer, blocker, writer, revoker } = clients
  await setActive(kind)
  const admitted = await proof(observer, kind)
  const revision = await currentRevision()
  const before = await durableState(observer)
  const command = `${kind}-${checkpoint ? 'checkpoint-' : ''}writer-first`
  const options = checkpoint ? checkpointOptions(command, revision, before.workspaces.find(row => row.user_id === owner).snapshot) : { command, revision }
  await blocker.query('begin')
  await blocker.query('select id from public.pjsdas_workspaces where user_id=$1 for update', [owner])
  await writer.query('begin')
  const write = track(writer.query(commitQuery, args(admitted, options)))
  await waitForBlock('writer', 'blocker', write, 'public.pjsdas_workspaces', 'RowShareLock')
  // Waiting inside the original CAS proves the guard already holds authority.
  const revocation = track(revoke(revoker, kind))
  await waitForBlock('revoker', 'writer', revocation, authorityTable(kind), 'RowExclusiveLock')
  assert.deepEqual(await durableState(observer), before)
  await blocker.query('commit')
  const result = await write.result
  assert.ifError(result.error)
  assert.equal(result.value.rows[0].outcome, 'COMMITTED')
  // Function return is not transaction commit: authority must remain locked
  // until the writer transaction releases it, not just until nested CAS returns.
  await waitForBlock('revoker', 'writer', revocation, authorityTable(kind), 'RowExclusiveLock')
  assert.deepEqual(await durableState(observer), before)
  await writer.query('commit')
  assert.ifError((await revocation.result).error)
  await verifyOneCommit(before, result.value.rows[0], admitted, command, revision, options.operation)
  const after = await durableState(observer)
  const replay = await writer.query(commitQuery, args(admitted, options)).then(() => null, error => error)
  assert.equal(replay?.code, '42501', 'revoked authority cannot replay through the guard')
  assert.deepEqual(await durableState(observer), after)
  groups++
  console.log(`PASS B2 real ${kind}: writer-first, authority lock held through transaction commit; revocation serialized after one CAS/ledger write.`)
}

async function invalidatingRace(kind, name, mutate, { activeAfter = false, checkpoint = false } = {}) {
  const { observer, writer, revoker } = clients
  await setActive(kind)
  const admitted = await proof(observer, kind)
  const revision = await currentRevision()
  const before = await durableState(observer)
  const command = `${kind}-${name}`
  const options = checkpoint ? checkpointOptions(command, revision, before.workspaces.find(row => row.user_id === owner).snapshot) : { command, revision }
  await revoker.query('begin')
  await mutate(revoker, kind, admitted)
  const write = track(writer.query(commitQuery, args(admitted, options)))
  await waitForBlock('writer', 'revoker', write, authorityTable(kind), 'RowShareLock')
  assert.deepEqual(await durableState(observer), before)
  await revoker.query('commit')
  assert.equal((await write.result).error?.code, '42501', `${kind} ${name} must reject the old admission after its exact blocker commits`)
  assert.deepEqual(await durableState(observer), before)
  if (activeAfter) {
    const fresh = await proof(observer, kind)
    assert.notDeepEqual(receiptProof(fresh), receiptProof(admitted), 'an active final row must carry a new admission identity')
    // Show denial is specifically stale authority: fresh admission succeeds
    // through the same entry point and records the newer immutable proof.
    const current = await writer.query(commitQuery, args(fresh, { ...options, command: `${command}-fresh`, revision }))
    await verifyOneCommit(before, current.rows[0], fresh, `${command}-fresh`, revision, options.operation)
  }
  groups++
  console.log(`PASS B2 real ${kind}: ${name}, queued stale admission denied with unchanged workspace and ledger${activeAfter ? '; fresh authority committed once' : ''}.`)
}

async function competingClaims() {
  const { observer, writer, revoker } = clients
  await setActive('automation')
  const admitted = await proof(observer, 'automation'), revision = await currentRevision(), before = await durableState(observer)
  const command = 'concurrent-search-claim', options = checkpointOptions(command, revision, before.workspaces.find(row => row.user_id === owner).snapshot)
  await writer.query('begin')
  const first = await writer.query(commitQuery, args(admitted, options))
  assert.equal(first.rows[0].outcome, 'COMMITTED')
  const secondOptions = { ...options, hash: 'different-owner-attempt', provenance: { ...options.provenance,
    searchBatch: { ...options.provenance.searchBatch, claimAttemptId: '22222222-2222-4222-8222-222222222222' } } }
  const second = track(revoker.query(commitQuery, args(admitted, secondOptions)))
  await waitForBlock('revoker', 'writer', second, 'public.pjsdas_workspaces', 'RowShareLock')
  assert.deepEqual(await durableState(observer), before)
  await writer.query('commit')
  assert.equal((await second.result).error?.code, '23505')
  await verifyOneCommit(before, first.rows[0], admitted, command, revision, 'checkpoint_discovery_search')
  assert.deepEqual((await durableState(observer)).workspaces.find(row => row.user_id === owner).snapshot, options.snapshot)
  groups++
  console.log('PASS B2 real concurrent search claims: exact workspace-lock witness, one original nonce/receipt, losing attempt cannot dispatch.')
}

try {
  // Isolate this fixture from all prior commands in test:concurrency. Creation
  // fails if a previous database remains; never drop or reuse an unknown one.
  admin = new pg.Client(adminConfig)
  await admin.connect()
  const version = Number((await admin.query('show server_version_num')).rows[0].server_version_num)
  assert.equal(Math.floor(version / 10000), 17, 'the real concurrency gate requires PostgreSQL 17')
  assert.equal((await admin.query("select count(*)::int n from pg_roles where rolname in ('anon','authenticated','service_role')")).rows[0].n, 3,
    'run after the existing SQL fixture bootstrap; this gate does not provision roles or credentials')
  await admin.query(`create database ${database}`)
  created = true
  await admin.end()
  admin = null
  const fixture = new URL(url)
  fixture.pathname = `/${database}`
  clients = Object.fromEntries(['observer', 'blocker', 'writer', 'revoker'].map(name => [name,
    new pg.Client({ ...adminConfig, connectionString: fixture.toString(), application_name: `ta-discovery-authority-${name}` })]))
  const connected = await Promise.allSettled(Object.values(clients).map(client => client.connect()))
  const failed = connected.find(result => result.status === 'rejected')
  if (failed) throw failed.reason
  const { observer, writer, revoker } = clients
  pids = Object.fromEntries(await Promise.all(Object.entries(clients).map(async ([name, client]) => [name, (await client.query('select pg_backend_pid() pid')).rows[0].pid])))
  assert.equal(new Set(Object.values(pids)).size, 4)
  assert.equal((await observer.query('select count(*)::int n from pg_stat_activity where datname=current_database()')).rows[0].n, 4)
  await installBase(observer)
  await seedExistingAuthority(observer)
  await observer.query(await migration(authorityMigration))
  await writer.query('set role service_role')
  await revoker.query('set role service_role')

  for (const kind of ['delegated_mcp', 'automation']) {
    await writerFirst(kind)
    await invalidatingRace(kind, 'revoke-first', revoke)
    await invalidatingRace(kind, 'revoke-regrant-ABA', async (db, kind) => {
      await revoke(db, kind)
      await regrant(db, kind)
    }, { activeAfter: true })
  }
  await invalidatingRace('automation', 'pause-first', db => db.query('update public.google_drive_connections set discovery_automation_enabled=false where user_id=$1', [owner]))
  await invalidatingRace('automation', 'pause-resume-ABA', async db => {
    await db.query('update public.google_drive_connections set discovery_automation_enabled=false where user_id=$1', [owner])
    await db.query('update public.google_drive_connections set discovery_automation_enabled=true where user_id=$1', [owner])
  }, { activeAfter: true })
  await invalidatingRace('automation', 'subject-replace-restore-ABA', async db => {
    await db.query("update public.google_drive_connections set google_subject='fixture-replaced-subject' where user_id=$1", [owner])
    await db.query('update public.google_drive_connections set google_subject=$2 where user_id=$1', [owner, subject])
  }, { activeAfter: true })
  // Delete/recreate requires pre-existing INSERT/DELETE privileges on grants.
  // Google connection service ACL intentionally lacks those permissions, so its
  // replacement-generation case is covered in PGlite without widening real ACLs.
  await invalidatingRace('delegated_mcp', 'delete-recreate-ABA', async (db, kind, admitted) => {
    await db.query('delete from public.pjsdas_authorization_grants where id=$1', [admitted.grantId])
    await db.query(`insert into public.pjsdas_authorization_grants(id,revision,user_id,client_id,source_id,capability)
      values($1,$2,$3,$4,$5,'ingest_discovery_run')`, [admitted.grantId, admitted.grantRevision, owner, client, source])
  }, { activeAfter: true })

  await writerFirst('automation', true)
  await invalidatingRace('automation', 'checkpoint-revoke-first', revoke, { checkpoint: true })
  await competingClaims()

  const final = await durableState(observer)
  assert.equal(final.ledger.length, committedCount)
  assert.equal(await currentRevision(), committedCount)
  console.log(`PASS rebuilt B2 PostgreSQL 17: exactly 4 sessions, ${groups} controlled schedules, ${lockWitnesses} exact lock witnesses, ${committedCount} original CAS/ledger commits.`)
} finally {
  // Queue all rollbacks together: writer-first and revoker-first schedules have
  // opposite dependencies. Settled/rejected query promises are already tracked.
  await Promise.allSettled(['blocker', 'revoker', 'writer'].filter(name => clients[name])
    .map(name => clients[name].query('rollback')))
  await Promise.allSettled(Object.values(clients).map(client => client.end()))
  if (admin) await admin.end().catch(() => {})
  if (created) {
    const cleanup = new pg.Client(adminConfig)
    try { await cleanup.connect(); await cleanup.query(`drop database ${database}`) }
    finally { await cleanup.end() }
  }
}
