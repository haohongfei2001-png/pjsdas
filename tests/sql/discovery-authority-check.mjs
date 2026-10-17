// Newly rebuilt B2 assertions, not recovered historical test results.
// In-memory PostgreSQL only. PGlite cannot certify concurrent lock ordering.
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import {
  authorityMigration, owner, other, absent, client, source, subject, workerToken,
  state, commitSignature, claimSignature, migration, exec, fixtureUrl, installBase,
  seedExistingAuthority, proof, commit, asRole, durableState, securityCatalog,
  functionCatalog, receiptProof,
} from './discovery-authority-fixture.mjs'

const db = new PGlite()
let groups = 0
let rejectedCalls = 0
const check = async (name, work) => { await work(); groups++; console.log(`PASS B2 SQL: ${name}`) }
const service = work => asRole(db, 'service_role', work)
async function denied(authority, options = {}, code = '42501') {
  const before = await durableState(db)
  await assert.rejects(() => service(() => commit(db, authority, options)), error => error.code === code)
  assert.deepEqual(await durableState(db), before, 'rejection must not mutate either workspace or original ledger')
  rejectedCalls++
}
const connection = async () => (await db.query('select * from public.google_drive_connections where user_id=$1', [owner])).rows[0]
const grant = async () => (await db.query(`select * from public.pjsdas_authorization_grants
  where user_id=$1 and client_id=$2 and source_id=$3 and capability='ingest_discovery_run'`, [owner, client, source])).rows[0]
const claim = token => service(() => db.query('select * from public.pjsdas_claim_enabled_discovery_automation_bindings_v2($1)', [token]))

try {
  await check('real-run URL guard rejects production, alternate credentials and connection options', async () => {
    assert.equal(fixtureUrl('postgresql://postgres:fixture-only@127.0.0.1:5432/ta_management_fixture').hostname, '127.0.0.1')
    for (const url of [undefined, 'postgres://postgres:fixture-only@localhost/ta_management_fixture',
      'postgresql://postgres:fixture-only@db.example.invalid/ta_management_fixture',
      'postgresql://postgres:fixture-only@localhost/postgres',
      'postgresql://postgres:secret@localhost/ta_management_fixture',
      'postgresql://service_role:fixture-only@localhost/ta_management_fixture',
      'postgresql://postgres:fixture-only@localhost/ta_management_fixture?options=-csearch_path=other',
      'postgresql://postgres:fixture-only@localhost/ta_management_fixture#unsafe']) {
      assert.throws(() => fixtureUrl(url ?? 'http://missing.invalid'), /isolated loopback fixture/)
    }
  })
  await installBase(db, { createRoles: true })
  await seedExistingAuthority(db)
  const securityBefore = await securityCatalog(db)
  const functionsBefore = await functionCatalog(db)
  const grantsBefore = (await db.query('select * from public.pjsdas_authorization_grants order by user_id,source_id')).rows
  const connectionsBefore = (await db.query('select * from public.google_drive_connections order by user_id')).rows
  const columns = async () => (await db.query(`select table_name,column_name,data_type,is_nullable,column_default
    from information_schema.columns where table_schema='public' order by table_name,ordinal_position`)).rows
  const columnsBefore = await columns()
  const baselineState = await durableState(db)
  // Existing default privileges may be broad; each new RPC must still revoke.
  await exec(db, 'alter default privileges grant execute on functions to anon,authenticated;')
  await exec(db, await migration(authorityMigration))

  await check('migration preserves all existing ACLs, RLS, policies, functions, grants and consent', async () => {
    assert.deepEqual(await securityCatalog(db), securityBefore)
    const functionsAfter = await functionCatalog(db)
    for (const existing of functionsBefore) {
      assert.deepEqual(functionsAfter.find(row => row.signature === existing.signature), existing)
    }
    assert.equal(functionsAfter.length - functionsBefore.length, 4)
    assert.deepEqual((await db.query('select * from public.pjsdas_authorization_grants order by user_id,source_id')).rows.map(({ id, revision, ...row }) => row), grantsBefore)
    assert.deepEqual((await db.query('select * from public.google_drive_connections order by user_id')).rows.map(({ discovery_consent_generation, ...row }) => row), connectionsBefore)
    const columnsAfter = await columns()
    for (const existing of columnsBefore) assert.deepEqual(columnsAfter.find(row => row.table_name === existing.table_name && row.column_name === existing.column_name), existing)
    assert.deepEqual(columnsAfter.filter(row => !columnsBefore.some(old => old.table_name === row.table_name && old.column_name === row.column_name))
      .map(row => [row.table_name, row.column_name, row.data_type, row.is_nullable]), [
      ['google_drive_connections', 'discovery_consent_generation', 'uuid', 'NO'],
      ['pjsdas_authorization_grants', 'id', 'uuid', 'NO'],
      ['pjsdas_authorization_grants', 'revision', 'bigint', 'NO'],
    ])
    assert.deepEqual(await durableState(db), baselineState)
    const rows = (await db.query('select id,revision from public.pjsdas_authorization_grants')).rows
    assert.equal(new Set(rows.map(row => row.id)).size, rows.length)
    for (const row of rows) assert.equal(Number(row.revision), 1)
    assert.ok((await connection()).discovery_consent_generation)
  })

  await check('service-only RPCs remain closed under broad defaults and authenticated RLS stays owner-scoped', async () => {
    const delegated = await proof(db)
    const automation = await proof(db, 'automation')
    for (const role of ['anon', 'authenticated']) {
      for (const signature of [commitSignature, claimSignature,
        'public.pjsdas_bump_ingestion_grant_revision()', 'public.pjsdas_rotate_discovery_consent_generation()']) {
        assert.equal((await db.query("select has_function_privilege($1,$2,'EXECUTE') allowed", [role, signature])).rows[0].allowed, false)
      }
      for (const authority of [delegated, automation]) {
        await assert.rejects(() => asRole(db, role, () => commit(db, authority)), error => error.code === '42501')
        rejectedCalls++
      }
      await assert.rejects(() => asRole(db, role, () => db.query('select * from public.pjsdas_claim_enabled_discovery_automation_bindings_v2($1)', [workerToken])), error => error.code === '42501')
    }
    for (const signature of [commitSignature, claimSignature]) {
      assert.equal((await db.query("select has_function_privilege('service_role',$1,'EXECUTE') allowed", [signature])).rows[0].allowed, true)
    }
    const guard = (await db.query('select prosecdef,proconfig from pg_proc where oid=$1::regprocedure', [commitSignature])).rows[0]
    assert.equal(guard.prosecdef, false)
    assert.deepEqual(guard.proconfig, ['search_path=public, pg_temp'])
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [owner])
    await asRole(db, 'authenticated', async () => {
      const rows = (await db.query('select user_id from public.pjsdas_authorization_grants')).rows
      assert.equal(rows.length, 2)
      assert.ok(rows.every(row => row.user_id === owner))
      await assert.rejects(() => db.query('update public.pjsdas_authorization_grants set revoked_at=now()'), error => error.code === '42501')
      await assert.rejects(() => db.query('select * from public.google_drive_connections'), error => error.code === '42501')
    })
    await db.query("select set_config('request.jwt.claim.sub','',false)")
    assert.deepEqual(await durableState(db), baselineState)
  })

  await check('grant UUID is immutable, caller cannot select insert identity or revision, every update advances revision', async () => {
    const original = await grant()
    for (const [column, value] of [['id', other], ['user_id', other], ['client_id', 'forged-client'],
      ['source_id', 'discovery:unknown'], ['capability', 'ingest_gmail_run']]) {
      await assert.rejects(() => db.query(`update public.pjsdas_authorization_grants set ${column}=$1 where id=$2`, [value, original.id]), error => error.code === '22023')
      assert.deepEqual(await grant(), original)
    }
    await db.query('update public.pjsdas_authorization_grants set revision=999 where id=$1', [original.id])
    assert.equal(Number((await grant()).revision), 2)
    await db.query('update public.pjsdas_authorization_grants set granted_at=granted_at where id=$1', [original.id])
    assert.equal(Number((await grant()).revision), 3)
    const inserted = (await db.query(`insert into public.pjsdas_authorization_grants(id,revision,user_id,client_id,source_id,capability)
      values($1,999,$2,$3,'discovery:temporary','ingest_discovery_run') returning id,revision`, [other, owner, client])).rows[0]
    assert.notEqual(inserted.id, other)
    assert.equal(Number(inserted.revision), 1)
    await db.query('delete from public.pjsdas_authorization_grants where id=$1', [inserted.id])
  })

  await check('consent generation rotates only on enable/revoke/subject transitions and cannot be forged', async () => {
    const original = await connection()
    await db.query(`update public.google_drive_connections set discovery_consent_generation=$2,
      discovery_last_checked_at=now(),discovery_last_success_at=now(),discovery_last_error='TRANSIENT',
      refresh_token_ciphertext='v1.rotated-fixture',updated_at=now(),discovery_automation_enabled=true where user_id=$1`, [owner, other])
    assert.equal((await connection()).discovery_consent_generation, original.discovery_consent_generation)
    await assert.rejects(() => db.query('update public.google_drive_connections set user_id=$2 where user_id=$1', [owner, absent]), error => error.code === '22023')
    let previous = original.discovery_consent_generation
    for (const update of ['discovery_automation_enabled=false', 'discovery_automation_enabled=true',
      'revoked_at=now()', 'revoked_at=null', "google_subject='fixture-replacement-subject'", `google_subject='${subject}'`]) {
      await db.query(`update public.google_drive_connections set ${update} where user_id=$1`, [owner])
      const next = (await connection()).discovery_consent_generation
      assert.notEqual(next, previous)
      previous = next
    }
    await db.query('update public.google_drive_connections set discovery_last_error=null where user_id=$1', [owner])
    assert.equal((await connection()).discovery_consent_generation, previous)
    await db.query('insert into auth.users(id) values($1)', [absent])
    const inserted = (await db.query('insert into public.google_drive_connections(user_id,discovery_consent_generation) values($1,$2) returning discovery_consent_generation', [absent, other])).rows[0]
    assert.notEqual(inserted.discovery_consent_generation, other)
    await db.query('delete from public.google_drive_connections where user_id=$1', [absent])
  })

  await check('delegated owner/client/source/kind/capability/UUID/revision denial leaves both durable stores unchanged', async () => {
    const delegated = await proof(db)
    const wrongCapability = (await db.query("select id,revision from public.pjsdas_authorization_grants where user_id=$1 and capability='ingest_gmail_run'", [owner])).rows[0]
    for (const options of [
      { authorization: null }, { authorization: [] }, { authorization: 'malformed' }, { authorization: {} },
      { operation: 'arbitrary_write' }, { operation: null }, { user: other }, { user: absent },
      { clientId: null }, { clientId: '' }, { clientId: 'other-client' }, { principal: 'first_party_web' },
      { principal: 'automation' }, { principal: null }, { provenance: {} }, { provenance: { sourceId: ' ' } },
      { provenance: { sourceId: 'discovery:unknown' } },
      ...[{ userId: other }, { kind: 'automation' }, { kind: 'unknown' }, { clientId: 'other-client' },
        { sourceId: 'discovery:unknown' }, { grantId: other }, { grantId: 'invalid-uuid' },
        { grantRevision: 0 }, { grantRevision: 999 }, { grantRevision: null },
        { grantId: wrongCapability.id, grantRevision: Number(wrongCapability.revision), sourceId: 'gmail:fixture' }]
        .map(change => ({ authorization: { ...delegated, ...change } })),
      { provenance: { sourceId: 'discovery:unknown' }, authorization: { ...delegated, sourceId: 'discovery:unknown' } },
      { provenance: { sourceId: 'gmail:fixture' }, authorization: { ...delegated, sourceId: 'gmail:fixture', grantId: wrongCapability.id, grantRevision: Number(wrongCapability.revision) } },
    ]) await denied(delegated, options)
    const beforeFuture = await proof(db)
    await db.query("update public.pjsdas_authorization_grants set granted_at=now()+interval '1 day' where id=$1", [beforeFuture.grantId])
    await denied(await proof(db))
    await db.query("update public.pjsdas_authorization_grants set granted_at=now()-interval '1 day' where id=$1", [beforeFuture.grantId])
  })

  await check('automation owner/subject/generation/kind/client and blank provenance fail closed', async () => {
    const automation = await proof(db, 'automation')
    for (const options of [
      { user: other }, { user: absent }, { clientId: client }, { clientId: '' },
      { principal: 'delegated_mcp' }, { principal: 'unknown' }, { operation: 'other_operation' },
      { authorization: null }, { authorization: [] }, { authorization: {} },
      { provenance: null }, { provenance: {} }, { provenance: { sourceId: '' } }, { provenance: { sourceId: '  ' } },
      ...[{ userId: other }, { kind: 'delegated_mcp' }, { kind: 'unknown' },
        { googleSubject: 'replacement-subject' }, { googleSubject: null },
        { consentGeneration: other }, { consentGeneration: 'invalid-uuid' }, { consentGeneration: null }]
        .map(change => ({ authorization: { ...automation, ...change } })),
      { user: absent, authorization: { ...automation, userId: absent } },
    ]) await denied(automation, options)
    // SQL binds automation to consent, not to a source registry. Its source
    // boundary is nonblank provenance; registered-plan checks belong to worker tests.
    const before = await durableState(db)
    const valid = await service(() => commit(db, automation, { command: 'automation-source-boundary', revision: 99, provenance: { sourceId: 'discovery:server' } }))
    assert.equal(valid.outcome, 'CONFLICT')
    assert.deepEqual(await durableState(db), before)
  })

  await check('new claim reuses token verifier and opt-in selection; old scheduler projection is unchanged', async () => {
    for (const token of [null, '', 'wrong-fixture-token']) await assert.rejects(() => claim(token), error => error.code === '42501')
    const oldRows = (await asRole(db, 'anon', () => db.query('select * from public.pjsdas_claim_enabled_discovery_automation_bindings($1)', [workerToken]))).rows
    const newRows = (await claim(workerToken)).rows
    assert.equal(newRows.length, 1)
    assert.equal(newRows[0].user_id, owner)
    assert.equal(newRows[0].discovery_consent_generation, (await connection()).discovery_consent_generation)
    assert.deepEqual(newRows.map(({ discovery_consent_generation, ...row }) => row), oldRows)
    for (const change of ['discovery_automation_enabled=false', 'revoked_at=now()',
      "discovery_last_error='GOOGLE_AUTH_EXPIRED'", "discovery_last_error='GOOGLE_AUTH_EXPIRED: reconnect'",
      "discovery_last_error='GOOGLE_AUTH_EXPIRED [profile] HTTP 401'"]) {
      const admitted = await proof(db, 'automation')
      await db.query(`update public.google_drive_connections set ${change} where user_id=$1`, [owner])
      assert.equal((await claim(workerToken)).rows.length, 0)
      await denied(admitted)
      await denied(await proof(db, 'automation'))
      await db.query('update public.google_drive_connections set discovery_automation_enabled=true,revoked_at=null,discovery_last_error=null where user_id=$1', [owner])
    }
    await db.query("update public.google_drive_connections set discovery_last_error='GOOGLE_AUTH_EXPIRED_NOT' where user_id=$1", [owner])
    assert.equal((await claim(workerToken)).rows.length, 1)
    await db.query('update public.google_drive_connections set discovery_last_error=null where user_id=$1', [owner])
  })

  let delegatedReceipt
  let originalDelegated
  await check('guard calls the original CAS/ledger, replaces forged receipt proof, replays immutable receipt and rejects hash reuse', async () => {
    originalDelegated = await proof(db)
    const snapshot = structuredClone(state)
    snapshot.data.opportunities.push({ id: 'fixture-discovery-result' })
    const options = { command: 'delegated-original', snapshot, compensation: { operation: 'fixture-undo' },
      effectiveTime: '2026-10-08T00:00:00Z', receiptContext: { displayLabel: 'Fixture attribution',
        discoveryAuthorization: { grantId: 'forged', grantRevision: 999, rawCredential: 'forged' } } }
    const committed = await service(() => commit(db, originalDelegated, options))
    assert.equal(committed.outcome, 'COMMITTED')
    assert.equal(Number(committed.revision), 1)
    assert.deepEqual(committed.receipt.discoveryAuthorization, receiptProof(originalDelegated))
    assert.equal(committed.receipt.displayLabel, 'Fixture attribution')
    assert.equal(committed.receipt.undoAvailable, true)
    const durable = await durableState(db)
    assert.equal(durable.ledger.length, 1)
    const row = durable.ledger[0]
    assert.equal(row.user_id, owner)
    assert.equal(row.command_id, 'delegated-original')
    assert.equal(row.operation, 'ingest_verified_discovery')
    assert.equal(row.principal_kind, 'delegated_mcp')
    assert.equal(row.client_id, client)
    assert.deepEqual(row.provenance, { sourceId: source })
    assert.equal(Number(row.expected_revision), 0)
    assert.equal(Number(row.resulting_revision), 1)
    assert.deepEqual(row.receipt, committed.receipt)
    assert.deepEqual(durable.workspaces.find(row => row.user_id === owner).snapshot, snapshot)
    const replay = await service(() => commit(db, originalDelegated, { ...options, revision: 999, snapshot: state, receiptContext: { displayLabel: 'rewritten' } }))
    assert.equal(replay.outcome, 'ALREADY_APPLIED')
    assert.deepEqual(replay.receipt, committed.receipt)
    assert.deepEqual(await durableState(db), durable)
    const conflict = await service(() => commit(db, originalDelegated, { command: 'stale-workspace-cas', revision: 0 }))
    assert.equal(conflict.outcome, 'CONFLICT')
    assert.equal(Number(conflict.receipt.actualRevision), 1)
    assert.deepEqual(await durableState(db), durable)
    await denied(originalDelegated, { ...options, hash: 'different-payload' }, '23505')
    delegatedReceipt = committed.receipt
  })

  await check('revocation/regrant and delete/recreate never revive delegated admission; fresh replay retains original proof', async () => {
    await db.query('update public.pjsdas_authorization_grants set revoked_at=now() where id=$1', [originalDelegated.grantId])
    await denied(originalDelegated, { command: 'delegated-original', revision: 1 })
    await denied(await proof(db), { command: 'revoked-fresh-proof', revision: 1 })
    await db.query('update public.pjsdas_authorization_grants set revoked_at=null where id=$1', [originalDelegated.grantId])
    await denied(originalDelegated, { command: 'regranted-stale-proof', revision: 1 })
    const fresh = await proof(db)
    const replay = await service(() => commit(db, fresh, { command: 'delegated-original', revision: 1 }))
    assert.equal(replay.outcome, 'ALREADY_APPLIED')
    assert.deepEqual(replay.receipt, delegatedReceipt)
    assert.notEqual(replay.receipt.discoveryAuthorization.grantRevision, fresh.grantRevision)
    await db.query('delete from public.pjsdas_authorization_grants where id=$1', [fresh.grantId])
    await db.query(`insert into public.pjsdas_authorization_grants(id,revision,user_id,client_id,source_id,capability)
      values($1,999,$2,$3,$4,'ingest_discovery_run')`, [fresh.grantId, owner, client, source])
    const replacement = await proof(db)
    assert.notEqual(replacement.grantId, fresh.grantId)
    assert.equal(replacement.grantRevision, 1)
    await denied(fresh, { command: 'replacement-stale-proof', revision: 1 })
    const committed = await service(() => commit(db, replacement, { command: 'replacement-fresh-proof', revision: 1 }))
    assert.equal(committed.outcome, 'COMMITTED')
    assert.deepEqual(committed.receipt.discoveryAuthorization, receiptProof(replacement))
  })

  await check('automation receipt excludes caller extras and remains historical through pause/resume and revoke/regrant ABA', async () => {
    const admitted = await proof(db, 'automation')
    const committed = await service(() => commit(db, { ...admitted, extraUntrusted: 'do-not-copy', refreshToken: 'fixture-only' },
      { command: 'automation-original', revision: 2, provenance: { sourceId: 'discovery:server' }, receiptContext: { discoveryAuthorization: { forged: true } } }))
    assert.equal(committed.outcome, 'COMMITTED')
    assert.deepEqual(committed.receipt.discoveryAuthorization, receiptProof(admitted))
    for (const [off, on] of [['discovery_automation_enabled=false', 'discovery_automation_enabled=true'], ['revoked_at=now()', 'revoked_at=null']]) {
      const before = await proof(db, 'automation')
      await db.query(`update public.google_drive_connections set ${off} where user_id=$1`, [owner])
      await denied(before, { command: 'automation-original', revision: 3 })
      await db.query(`update public.google_drive_connections set ${on} where user_id=$1`, [owner])
      await denied(before, { command: 'automation-original', revision: 3 })
      const fresh = await proof(db, 'automation')
      assert.notEqual(fresh.consentGeneration, before.consentGeneration)
      const replay = await service(() => commit(db, fresh, { command: 'automation-original', revision: 3 }))
      assert.equal(replay.outcome, 'ALREADY_APPLIED')
      assert.deepEqual(replay.receipt, committed.receipt)
      assert.notEqual(replay.receipt.discoveryAuthorization.consentGeneration, fresh.consentGeneration)
    }
    const fresh = await proof(db, 'automation')
    await db.query('delete from public.google_drive_connections where user_id=$1', [owner])
    await db.query(`insert into public.google_drive_connections(user_id,google_subject,refresh_token_ciphertext,discovery_automation_enabled,discovery_consent_generation)
      values($1,$2,'v1.fixture-replacement',true,$3)`, [owner, subject, fresh.consentGeneration])
    assert.notEqual((await proof(db, 'automation')).consentGeneration, fresh.consentGeneration)
    await denied(fresh, { command: 'replaced-connection', revision: 3 })
    const finalProof = await proof(db, 'automation')
    assert.equal((await service(() => commit(db, finalProof, { command: 'automation-fresh', revision: 3 }))).outcome, 'COMMITTED')
    const rows = (await durableState(db)).ledger
    assert.equal(rows.length, 4)
    assert.deepEqual(rows.find(row => row.command_id === 'automation-original').receipt, committed.receipt)
  })

  await check('missing pre-existing table privileges fail closed and are never repaired by the guard', async () => {
    for (const [table, kind] of [['pjsdas_authorization_grants', 'delegated_mcp'], ['google_drive_connections', 'automation']]) {
      const admitted = await proof(db, kind)
      for (const privilege of ['select', 'update']) {
        await exec(db, `revoke ${privilege} on public.${table} from service_role`)
        try {
          await denied(admitted, { command: `missing-${table}-${privilege}`, revision: 4 })
          assert.equal((await db.query('select has_table_privilege(\'service_role\',$1,$2) allowed', [`public.${table}`, privilege])).rows[0].allowed, false)
        } finally { await exec(db, `grant ${privilege} on public.${table} to service_role`) }
      }
    }
    assert.deepEqual(await securityCatalog(db), securityBefore)
  })

  await check('missing guarded RPC or original CAS RPC cannot silently fall back to another write path', async () => {
    const admitted = await proof(db)
    const before = await durableState(db)
    const v2Signature = 'public.pjsdas_commit_workspace_v2(uuid,text,text,text,bigint,jsonb,integer,text,text,jsonb,jsonb,timestamptz,jsonb)'
    for (const [signature, oldName, newName] of [
      [v2Signature, 'pjsdas_commit_workspace_v2', 'fixture_missing_workspace_v2'],
      [commitSignature, 'pjsdas_commit_discovery_workspace_v1', 'fixture_missing_discovery_v1'],
    ]) {
      await exec(db, `alter function ${signature} rename to ${newName}`)
      try { await denied(admitted, { command: `missing-${oldName}`, revision: 4 }, '42883') }
      finally { await exec(db, `alter function ${signature.replace(oldName, newName)} rename to ${oldName}`) }
    }
    assert.deepEqual(await durableState(db), before)
    const oldFunctionsAfter = await functionCatalog(db)
    for (const original of functionsBefore) assert.deepEqual(oldFunctionsAfter.find(row => row.signature === original.signature), original)
  })

  console.log(`PASS rebuilt B2 SQL authority: ${groups} assertion groups; ${rejectedCalls} rejected guarded calls; 4 durable commits.`)
  console.log('LIMIT: PGlite validates SQL behavior only. Four-session PostgreSQL 17 lock schedules must pass discovery-authority-concurrency.mjs before claiming race coverage.')
} finally { await db.close() }
