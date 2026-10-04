// Synthetic claims only; never reads a live token or enables provider configuration.
import assert from 'node:assert/strict'
import pg from 'pg'
import { PGlite } from '@electric-sql/pglite'
import { newReviewPacket, reviewPurpose } from '../../scripts/consumer-management/review-identities.ts'
import { prepareReviewResourceHook } from '../../scripts/consumer-management/review-resource-hook.ts'
const real = process.argv.includes('--postgres')
let db, admin
if (real) {
  const url = new URL(process.env.TA_MANAGEMENT_SQL_TEST_URL ?? 'http://missing.invalid')
  assert.equal(url.protocol, 'postgresql:'); assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname))
  assert.equal(url.pathname, '/ta_management_fixture'); assert.equal(url.username, 'postgres')
  assert.equal(url.password, 'fixture-only'); assert.equal(url.search, '')
  admin = new pg.Client({ connectionString: url.toString() }); await admin.connect()
  await admin.query('create database ta_review_hook_fixture'); url.pathname = '/ta_review_hook_fixture'
  db = new pg.Client({ connectionString: url.toString(), statement_timeout: 15000 }); await db.connect()
} else db = new PGlite()
const exec = sql => real ? db.query(sql) : db.exec(sql)
const now = Date.now(), deadline = new Date(now + 3600000).toISOString()
const manifest = newReviewPacket({ expectedSha: 'a'.repeat(40), clientId: '00000000-0000-4000-8000-000000000081', expiresAt: deadline }, now).manifest
const plan = prepareReviewResourceHook(manifest, now)
let cases = 0
const input = (label = 'a') => {
  const identity = manifest.identities.find(i => i.label === label)
  return { user_id: identity.id, authentication_method: 'oauth_provider/authorization_code', claims: {
    iss: `https://${manifest.project}.supabase.co/auth/v1`, sub: identity.id, role: 'authenticated', aud: 'authenticated',
    client_id: manifest.clientId, exp: Math.floor(now / 1000) + 7200, iat: Math.floor(now / 1000),
    scope: 'openid email profile offline_access', session_id: 'fixture-session',
    app_metadata: { purpose: reviewPurpose, review_project: manifest.project, review_client: manifest.clientId, review_lease: manifest.leaseId, review_expires_at: manifest.expiresAt, review_label: label },
    user_metadata: { unknown: ['z', 'a'] }, future: { untouched: true },
  } }
}
const call = async event => (await db.query('select public.pjsdas_review_oauth_resource_hook($1::jsonb) value', [JSON.stringify(event)])).rows[0].value
const unchanged = async event => { assert.deepEqual(await call(event), { claims: event.claims }); cases++ }
try {
  for (const role of ['anon', 'authenticated', 'service_role', 'supabase_auth_admin']) {
    if (!(await db.query('select 1 from pg_roles where rolname=$1', [role])).rows.length) await exec(`create role ${role}`)
  }
  // Match production's defaults: creating a function initially grants all three app roles.
  await exec('alter default privileges in schema public grant execute on functions to anon, authenticated, service_role')
  await exec('create table public.unrelated_data(id int primary key, raw jsonb); insert into public.unrelated_data values (1,\'{"unknown":["z","a"]}\');')
  const baseline = (await db.query('select * from public.unrelated_data')).rows
  const installBody = plan.install.match(/do \$install\$[\s\S]*end \$install\$;/)[0]
  await assert.rejects(exec(installBody), /Bounded explicit transaction required/)
  assert.equal((await db.query("select to_regprocedure('public.pjsdas_review_oauth_resource_hook(jsonb)') value")).rows[0].value, null)
  cases++
  const failedInstall = plan.install.replace('to supabase_auth_admin;', 'to missing_fixture_hook_role;')
  await assert.rejects(exec(failedInstall), e => e.code === '42704')
  await exec('rollback')
  assert.equal((await db.query("select to_regprocedure('public.pjsdas_review_oauth_resource_hook(jsonb)') value")).rows[0].value, null)
  cases++
  await exec(plan.install)
  // A colliding function is never silently replaced or dropped by installation.
  await assert.rejects(exec(plan.install), e => e.code === '42723')
  await exec('rollback'); cases++
  const fn = (await db.query("select prosecdef,proconfig from pg_proc where oid='public.pjsdas_review_oauth_resource_hook(jsonb)'::regprocedure")).rows[0]
  assert.equal(fn.prosecdef, false); assert.deepEqual(fn.proconfig, ['search_path=""'])
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.equal((await db.query("select has_function_privilege($1,'public.pjsdas_review_oauth_resource_hook(jsonb)','EXECUTE') allowed", [role])).rows[0].allowed, false)
    await exec(`set role ${role}`)
    await assert.rejects(call(input()), e => e.code === '42501'); await exec('reset role'); cases++
  }
  await exec('set role supabase_auth_admin')
  await assert.rejects(db.query('select * from public.unrelated_data'), e => e.code === '42501')
  for (const label of ['a', 'b']) for (const aud of ['authenticated', ['authenticated']]) {
    const event = input(label); event.claims.aud = aud
    const expected = structuredClone(event.claims); expected.aud = ['authenticated', `${manifest.origin}/api/mcp`]; expected.exp = plan.deadline ? Math.floor(Date.parse(plan.deadline) / 1000) : 0
    assert.deepEqual(await call(event), { claims: expected }); cases++
  }
  const shorter = input(); shorter.claims.exp = Math.floor(now / 1000) + 60
  assert.equal((await call(shorter)).claims.exp, shorter.claims.exp); cases++
  const negatives = [
    e => { delete e.claims.client_id }, e => { e.claims.client_id = 'other-client' },
    e => { e.claims.sub = e.user_id = 'unrelated-existing-user' }, e => { e.user_id = manifest.identities[1].id },
    e => { e.claims.iss = 'https://other.example/auth/v1' }, e => { e.claims.role = 'service_role' },
    e => { e.claims.aud = 'https://other.example/mcp' }, e => { e.claims.aud = ['authenticated', 'other'] },
    e => { e.claims.aud = null }, e => { e.claims.aud = [] },
    e => { e.claims.exp = '9999999999' }, e => { e.claims.exp = 0 }, e => { e.claims.exp = Math.floor(now / 1000) + 60.5 },
    e => { delete e.claims.app_metadata }, e => { e.claims.user_metadata = e.claims.app_metadata; e.claims.app_metadata = {} },
    ...['purpose', 'review_project', 'review_client', 'review_lease', 'review_expires_at', 'review_label'].map(k => e => { e.claims.app_metadata[k] = 'other' }),
  ]
  for (const mutate of negatives) { const event = input(); mutate(event); await unchanged(event) }
  await exec('reset role')
  assert.deepEqual((await db.query('select * from public.unrelated_data')).rows, baseline)
  const removeBody = plan.remove.match(/do \$remove\$[\s\S]*end \$remove\$;/)[0]
  await assert.rejects(exec(removeBody), /Bounded explicit transaction required/)
  assert.notEqual((await db.query("select to_regprocedure('public.pjsdas_review_oauth_resource_hook(jsonb)') value")).rows[0].value, null)
  cases++
  await exec(plan.remove)
  assert.equal((await db.query("select to_regprocedure('public.pjsdas_review_oauth_resource_hook(jsonb)') value")).rows[0].value, null)
  // Lease expiry is proved without a sleep or an expanded production lease.
  const expired = structuredClone(manifest); expired.expiresAt = new Date(now - 60000).toISOString()
  const expiredPlan = prepareReviewResourceHook(expired, now - 120000)
  await exec(expiredPlan.install)
  const event = input(); event.claims.app_metadata.review_expires_at = expired.expiresAt
  await unchanged(event); await exec(expiredPlan.remove)
  assert.deepEqual((await db.query('select * from public.unrelated_data')).rows, baseline)
  assert.throws(() => prepareReviewResourceHook(expired, now), /REVIEW_EXPIRY_INVALID/)
  console.log(JSON.stringify({ engine: real ? 'PostgreSQL' : 'PGlite', cases, result: 'PASS', unrelatedRows: 'unchanged', functionRemoved: true, liveConfigurationChanged: false }))
} finally { if (real) { await db.end(); await admin.end() } else await db.close() }
