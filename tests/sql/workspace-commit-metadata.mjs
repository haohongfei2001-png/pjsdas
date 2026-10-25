// Synthetic engines only. PostgreSQL mode uses the existing isolated CI service;
// never accepts a production URL, changes server settings or reads real data.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fixtureUrl, migration, exec } from './discovery-authority-fixture.mjs'

const real = process.argv.includes('--postgres')
const owner = '00000000-0000-4000-8000-000000000951'
const signature = version => `public.pjsdas_commit_workspace_v${version}(uuid,text,text,text,bigint,jsonb,integer,text,text,jsonb,jsonb,timestamptz,jsonb)`
const sql = version => `select outcome,workspace_id,revision,receipt from public.pjsdas_commit_workspace_v${version}(${Array.from({ length: 13 }, (_, i) => `$${i + 1}`).join(',')})`
const args = (id, revision, snapshot = { synthetic: true }, hash = `hash:${id}`) =>
  [owner, id, 'synthetic_metadata_fixture', hash, revision, JSON.stringify(snapshot), 4, 'first_party_web', null, '{}', null, null, '{}']
let db, admin, pg, config, database, created = false, racer
const acl = async () => ({
  relations: (await db.query("select c.relname,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','S') order by c.relname")).rows,
  functions: (await db.query("select p.proname,p.proacl::text,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname <> 'pjsdas_commit_workspace_v3' order by p.proname,p.oid")).rows,
})
try {
  if (real) {
    const url = fixtureUrl() // Must reject unsafe targets before constructing a client.
    pg = (await import('pg')).default
    config = { connectionString: url.toString(), statement_timeout: 30000, connectionTimeoutMillis: 5000 }
    admin = new pg.Client(config); await admin.connect()
    assert.equal(Math.floor(Number((await admin.query('show server_version_num')).rows[0].server_version_num) / 10000), 17)
    database = `ta_metadata_fixture_${randomUUID().replaceAll('-', '')}`
    await admin.query(`create database ${database}`); created = true
    const local = new URL(url); local.pathname = `/${database}`
    config = { ...config, connectionString: local.toString() }
    db = new pg.Client(config); await db.connect()
  } else {
    const { PGlite } = await import('@electric-sql/pglite')
    db = new PGlite()
    await exec(db, 'create role anon; create role authenticated; create role service_role bypassrls;')
  }
  await exec(db, 'create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;')
  for (const name of ['2026091901_ai_operated_mutation_foundation.sql', '20260923030000_cgr01_authoritative_commands.sql']) await exec(db, await migration(name))
  const beforeAcl = await acl()
  await exec(db, await migration('20261025065403_commit_workspace_metadata_only.sql'))
  assert.deepEqual(await acl(), beforeAcl, 'Existing function/table ACL and RLS flags must remain unchanged')
  const rights = (await db.query(`select r.rolname,has_function_privilege(r.oid,$1,'execute') as allowed from pg_roles r where r.rolname in ('anon','authenticated','service_role') order by r.rolname`, [signature(3)])).rows
  assert.deepEqual(rights, [{ rolname: 'anon', allowed: false }, { rolname: 'authenticated', allowed: false }, { rolname: 'service_role', allowed: true }])
  assert.equal((await db.query("select count(*)::int as count from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=$1::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE'", [signature(3)])).rows[0].count, 0)
  await db.query('insert into auth.users values($1)', [owner])
  await db.query('insert into public.pjsdas_workspaces(user_id,snapshot,schema_version) values($1,$2,4)', [owner, '{}'])
  await exec(db, 'set role service_role')
  const first = (await db.query(sql(3), args('first', 0))).rows[0]
  assert.equal(first.outcome, 'COMMITTED'); assert.equal(Number(first.revision), 1)
  assert.deepEqual(Object.keys(first).sort(), ['outcome', 'receipt', 'revision', 'workspace_id'])
  assert.deepEqual((await db.query('select snapshot from pjsdas_workspaces where user_id=$1', [owner])).rows[0].snapshot, { synthetic: true })
  const replay = (await db.query(sql(3), args('first', 0, { mustNotReplace: true }))).rows[0]
  assert.equal(replay.outcome, 'ALREADY_APPLIED'); assert.deepEqual(replay.receipt, first.receipt)
  assert.equal((await db.query(sql(3), args('conflict', 0))).rows[0].outcome, 'CONFLICT')
  await assert.rejects(() => db.query(sql(3), args('first', 1, {}, 'different-hash')), error => error.code === '23505')
  assert.equal(Number((await db.query('select count(*) from pjsdas_command_ledger')).rows[0].count), 1)
  assert.equal(Number((await db.query('select revision from pjsdas_workspaces')).rows[0].revision), 1)
  // Legacy callers still receive snapshots, not a changed return contract.
  const legacy = (await db.query(sql(2).replace('outcome,workspace_id,revision,receipt', '*'), args('legacy', 1, { legacy: true }))).rows[0]
  assert.equal(legacy.outcome, 'COMMITTED'); assert.deepEqual(legacy.snapshot, { legacy: true })
  const laterReplay = (await db.query(sql(3), args('first', 0, { mustNotReplace: true }))).rows[0]
  assert.equal(laterReplay.outcome, 'ALREADY_APPLIED'); assert.equal(Number(laterReplay.revision), 2)
  assert.deepEqual(laterReplay.receipt, first.receipt)
  assert.deepEqual((await db.query('select snapshot from pjsdas_workspaces')).rows[0].snapshot, { legacy: true })
  for (const role of ['anon', 'authenticated']) {
    await exec(db, `reset role; set role ${role}`)
    await assert.rejects(() => db.query(sql(3), args(`denied-${role}`, 2)), error => error.code === '42501')
  }
  await exec(db, 'reset role; set role service_role')
  console.log('PASS metadata RPC: three outcomes, exact receipt replay, hash rejection, unchanged legacy snapshot contract and ACLs, service-role-only execution.')

  if (real) {
    // Exact lock witness: the second command must wait behind the first user's
    // uncommitted revision and then return CONFLICT, not overwrite it.
    racer = new pg.Client(config); await racer.connect(); await racer.query('set role service_role')
    const holderPid = Number((await db.query('select pg_backend_pid() as pid')).rows[0].pid)
    const racerPid = Number((await racer.query('select pg_backend_pid() as pid')).rows[0].pid)
    await db.query('begin')
    assert.equal((await db.query(sql(3), args('lock-winner', 2, { winner: true }))).rows[0].outcome, 'COMMITTED')
    let settled = false
    const pending = racer.query(sql(3), args('lock-loser', 2, { loser: true })).then(value => { settled = true; return { value } }, error => { settled = true; return { error } })
    let witnessed = false
    const deadline = Date.now() + 10000
    while (Date.now() < deadline && !settled) {
      const row = (await admin.query('select wait_event_type,pg_blocking_pids(pid) as blockers from pg_stat_activity where pid=$1', [racerPid])).rows[0]
      if (row?.wait_event_type === 'Lock' && row.blockers.includes(holderPid)) { witnessed = true; break }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.ok(witnessed, 'Exact pending backend/blocker lock witness required')
    await db.query('commit')
    const raced = await pending; assert.ifError(raced.error); assert.equal(raced.value.rows[0].outcome, 'CONFLICT')
    assert.deepEqual((await db.query('select snapshot from pjsdas_workspaces')).rows[0].snapshot, { winner: true })
    console.log('PASS metadata RPC PostgreSQL 17: exact same-workspace lock witness and stale-CAS rejection.')

    await db.query("set work_mem='2184kB'") // Session-local fixture, not server configuration.
    const large = { fixture: 'synthetic-only-'.repeat(1800000) }
    assert.ok(Buffer.byteLength(JSON.stringify(large)) > 25_000_000)
    await db.query('update pjsdas_workspaces set snapshot=$1 where user_id=$2', [JSON.stringify(large), owner])
    const results = []
    for (const version of [2, 3]) {
      const revision = Number((await db.query('select revision from pjsdas_workspaces')).rows[0].revision)
      const command = `benchmark-v${version}`
      for (const [expected, id, base] of [['COMMITTED', command, revision], ['ALREADY_APPLIED', command, revision], ['CONFLICT', `${command}-conflict`, -1]]) {
        const values = args(id, base, large)
        await db.query('begin')
        const plan = (await db.query('explain (analyze,buffers,format json) ' + sql(version), values)).rows[0]['QUERY PLAN'][0]
        await db.query('rollback') // Preserve the real first-commit branch for result verification.
        assert.equal((await db.query(sql(version), values)).rows[0].outcome, expected)
        const tempWritten = plan.Plan['Temp Written Blocks'] ?? 0
        const result = { version, outcome: expected, tempRead: plan.Plan['Temp Read Blocks'] ?? 0, tempWritten, executionMs: plan['Execution Time'] }
        results.push(result)
        console.log('Synthetic snapshot result:', JSON.stringify(result))
        // Fresh supplied JSONB spills in v2. Replay/conflict can keep a stored
        // TOAST representation: do not falsely require those paths to spill.
        if (version === 2 && expected === 'COMMITTED') assert.ok(tempWritten > 0, 'v2 first commit must demonstrate the original spill')
        if (version === 3) assert.equal(tempWritten, 0, `v3 ${expected} must not spill its return value`)
      }
    }
    console.log('PASS PostgreSQL 17 synthetic large-snapshot materialization comparison:', JSON.stringify(results))
  } else console.log('PGlite serial contracts only; temp-block and lock evidence require --postgres in existing PostgreSQL 17 CI.')
} finally {
  if (db) await exec(db, 'rollback').catch(() => {})
  if (racer) { await racer.query('rollback').catch(() => {}); await racer.end().catch(() => {}) }
  if (db) { if (real) await db.end().catch(() => {}); else await db.close() }
  if (admin) {
    try { if (created) await admin.query(`drop database ${database}`) }
    finally { await admin.end() }
  }
}
