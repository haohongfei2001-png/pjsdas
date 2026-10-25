// Synthetic serial migration, ACL and input-compatibility contracts only.
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { migration } from './discovery-authority-fixture.mjs'
const db = new PGlite()
const owner = '00000000-0000-4000-8000-000000000961'
const query = 'select * from public.pjsdas_commit_workspace_v4($1::jsonb)'
const payload = (id, revision = 0) => ({ target_user_id: owner, target_command_id: id,
  target_operation: 'synthetic_raw_fixture', target_payload_hash: `hash:${id}`, target_expected_revision: revision,
  target_snapshot: { synthetic: true }, target_schema_version: 4, target_principal_kind: 'first_party_web',
  target_client_id: null, target_provenance: null, target_compensation: null, target_effective_time: null, target_receipt_context: null })
const call = value => db.query(query, [JSON.stringify(value)])
try {
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;')
  for (const name of ['2026091901_ai_operated_mutation_foundation.sql', '20260923030000_cgr01_authoritative_commands.sql', '20261025065403_commit_workspace_metadata_only.sql']) await db.exec(await migration(name))
  await db.query('insert into auth.users values($1)', [owner])
  await db.query('insert into pjsdas_workspaces(user_id,snapshot,schema_version) values($1,$2,4)', [owner, '{}'])
  const old = async () => (await db.query("select proname,pg_get_functiondef(oid) as definition,proacl::text from pg_proc where pronamespace='public'::regnamespace and proname in ('pjsdas_commit_workspace_v2','pjsdas_commit_workspace_v3') order by proname")).rows
  const baseline = await old(), candidate = await migration('20261025084300_commit_workspace_raw_json.sql')
  await db.exec('begin'); await db.exec(candidate); await db.exec('rollback')
  assert.equal((await db.query("select to_regprocedure('public.pjsdas_commit_workspace_v4(jsonb)') as name")).rows[0].name, null)
  await db.exec('begin'); await db.exec(candidate); await db.exec('commit')
  assert.deepEqual(await old(), baseline)
  const entry = (await db.query("select prosecdef,proargnames[1] as first_name from pg_proc where oid='public.pjsdas_commit_workspace_v4(jsonb)'::regprocedure")).rows[0]
  assert.equal(entry.prosecdef, false); assert.ok(!entry.first_name)
  assert.equal((await db.query("select count(*)::int n from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid='public.pjsdas_commit_workspace_v4(jsonb)'::regprocedure and a.grantee=0")).rows[0].n, 0)
  for (const role of ['anon','authenticated']) {
    await db.exec(`set role ${role}`)
    await assert.rejects(() => call(payload(`denied-${role}`)), e => e.code === '42501')
    await db.exec('reset role')
  }
  await db.exec('set role service_role')
  for (const invalid of [null, [], 'string', { ...payload('unknown'), forged: true }, Object.fromEntries(Object.entries(payload('missing')).filter(([key]) => key !== 'target_snapshot'))]) {
    await assert.rejects(() => call(invalid), e => e.code === '22023')
  }
  await assert.rejects(() => call({ ...payload('null-snapshot'), target_snapshot: null }), e => e.code === '22023')
  const first = (await call(payload('first'))).rows[0]
  assert.equal(first.outcome, 'COMMITTED'); assert.equal(Number(first.revision), 1)
  assert.deepEqual(Object.keys(first).sort(), ['outcome','receipt','revision','workspace_id'])
  assert.equal(first.receipt.undoAvailable, false)
  assert.deepEqual((await call(payload('first'))).rows[0], { ...first, outcome: 'ALREADY_APPLIED' })
  assert.equal((await call(payload('stale',0))).rows[0].outcome, 'CONFLICT')
  await assert.rejects(() => call({ ...payload('first'), target_payload_hash: 'changed' }), e => e.code === '23505')
  const second = (await call({ ...payload('second',1), target_compensation: { synthetic: 'undo' }, target_provenance: { source: 'synthetic' }, target_receipt_context: { custom: 'retained' } })).rows[0]
  assert.equal(second.receipt.custom, 'retained'); assert.equal(second.receipt.undoAvailable, true)
  assert.equal(Number((await db.query('select count(*) from pjsdas_command_ledger')).rows[0].count), 2)
  assert.deepEqual((await db.query('select snapshot from pjsdas_workspaces')).rows[0].snapshot, { synthetic: true })
  console.log('PASS raw JSON serial contracts: unchanged v2/v3, atomic DDL rollback, invoker/ACL, exact keys/null mapping, replay/CAS/hash/receipt semantics. Real HTTP and spill proof require hosted PostgreSQL/PostgREST fixture.')
} finally { await db.close() }
