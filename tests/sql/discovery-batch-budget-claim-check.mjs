// Isolated, synthetic SQL regressions. No network, providers, real credentials,
// repository writes, or durable PGlite directory. Run with the checkout path.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = resolve(process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url)))
const require = createRequire(resolve(root, 'tests/sql/package.json'))
const { PGlite } = await import(pathToFileURL(require.resolve('@electric-sql/pglite')).href)
const {
  authorityMigration, owner, other, absent, client, source, state, commitSignature,
  installBase, seedExistingAuthority, migration, proof, commit, asRole,
  durableState, securityCatalog, functionCatalog, receiptProof,
} = await import(pathToFileURL(resolve(root, 'tests/sql/discovery-authority-fixture.mjs')).href)
const candidateName = '20261008164000_discovery_batch_budget_claim.sql'
const candidate = await migration(candidateName)
const db = new PGlite()
const failures = []
let groups = 0, denials = 0, sequence = 0
const amount = queryCount => 427031 + queryCount * 5000
const digest = value => createHash('sha256').update(String(value)).digest('hex')
const clone = value => structuredClone(value)
const micro = amount(12)
let automation, delegated, windowStart, windowEnd
const revision = async (user = owner) => Number((await db.query('select revision from public.pjsdas_workspaces where user_id=$1', [user])).rows[0].revision)
const rawSnapshots = async () => (await db.query('select user_id,snapshot::text as snapshot,schema_version from public.pjsdas_workspaces order by user_id')).rows
// Recover the inner transaction before fixture asRole's RESET ROLE so the
// original SQLSTATE survives; otherwise RESET ROLE masks it with 25P02.
async function roleCall(role, work) {
  await db.exec('savepoint role_call')
  try {
    return await asRole(db, role, async () => {
      try { return await work() }
      catch (error) { await db.exec('rollback to savepoint role_call'); throw error }
    })
  } finally { await db.exec('release savepoint role_call') }
}
const service = (authority, options) => roleCall('service_role', () => commit(db, authority, options))
const policy = (changes = {}) => ({ version: 1, application: 'todayaction', approvalId: 'fixture:approved-budget',
  accountId: owner, scopeFingerprint: 'c'.repeat(64), currency: 'USD', maximumMicroUsd: micro * 2,
  validFrom: windowStart, expiresAt: windowEnd, tariffVersion: 'todayaction-standard-search-text-2026-10-08', ...changes })
function claim(options = {}) {
  const id = ++sequence
  const terms = options.policy ?? policy()
  const batch = { version: 1, planFingerprint: digest(`plan:${id}`), cycleId: digest(`cycle:${id}`),
    claimAttemptId: randomUUID(), index: 0, count: 1, queryStart: 0, queryCount: 12,
    totalQueryCount: 12, phase: 'claimed', ...options.batch }
  const sourceId = options.sourceId ?? source
  const hold = { version: 1, policy: terms, policyFingerprint: digest(JSON.stringify(terms)), sourceId,
    claimAttemptId: batch.claimAttemptId, searchRequestLimit: batch.queryCount, modelRequestLimit: 1,
    reservedMicroUsd: amount(batch.queryCount), ...options.hold }
  return { command: `fixture-budget-claim:${id}`, operation: 'checkpoint_discovery_search', snapshot: state,
    user: options.user ?? owner, provenance: { sourceId, scopeFingerprint: terms.scopeFingerprint,
      producer: 'server_scheduler', runId: `server-discovery-batch:synthetic:${id}`,
      searchPlanFingerprint: batch.planFingerprint, searchCycleId: batch.cycleId,
      searchBatchIndex: batch.index, searchPhase: batch.phase, searchBatch: batch,
      discoveryBudgetHold: hold, ...options.provenance }, ...options.commit }
}
function settle(original, outcome = 'unknown', options = {}) {
  const provenance = clone(original.provenance)
  delete provenance.discoveryBudgetHold
  provenance.searchPhase = 'settled'
  provenance.searchBatch = { ...provenance.searchBatch, phase: 'settled', outcome,
    successfulQueryCount: 0, failedQueryCount: 12, omittedHitCount: 0 }
  return { ...original, command: `${original.command}:settled`, provenance, ...options }
}
async function send(options, authority = automation) {
  const before = await rawSnapshots()
  const result = await service(authority, { ...options, revision: options.revision ?? await revision(options.user ?? owner) })
  if (options.operation === 'checkpoint_discovery_search') assert.deepEqual(await rawSnapshots(), before, 'every checkpoint preserves exact raw v4 snapshot and schema')
  return result
}
async function admitted(options, expected = true, authority = automation) {
  const before = await rawSnapshots()
  const result = await send(options, authority)
  assert.equal(result.outcome, 'COMMITTED')
  assert.deepEqual(result.receipt.discoveryBudget, { version: 1, hold: options.provenance.discoveryBudgetHold,
    admitted: expected, retainedMicroUsd: expected ? options.provenance.discoveryBudgetHold.reservedMicroUsd : 0 })
  assert.deepEqual(result.receipt.discoveryAuthorization, receiptProof(authority))
  assert.deepEqual(await rawSnapshots(), before, 'claim must preserve exact canonical v4 JSON and schema')
  return result
}
async function denied(options, authority = automation, code = '42501') {
  const before = await durableState(db)
  await db.exec('savepoint expected_rejection')
  let error
  try { await send(options, authority) } catch (caught) { error = caught }
  await db.exec('rollback to savepoint expected_rejection; release savepoint expected_rejection')
  assert.ok(error, `Expected SQL rejection: ${options.command}`)
  assert.equal(error.code, code, `Unexpected rejection for ${options.command}: ${error.message}`)
  assert.deepEqual(await durableState(db), before, 'rejection must not change workspace or original ledger')
  denials++
}
async function check(name, work) {
  await db.exec('begin')
  try { await work(); groups++; console.log(`PASS budget SQL: ${name}`) }
  catch (error) { failures.push({ name, message: error.message }); console.error(`FAIL budget SQL: ${name}\n${error.stack}`) }
  finally { await db.exec('rollback') }
}
try {
  await installBase(db, { createRoles: true })
  await seedExistingAuthority(db)
  await db.exec(await migration(authorityMigration))
  automation = await proof(db, 'automation'); delegated = await proof(db)
  const now = new Date((await db.query('select clock_timestamp() as now')).rows[0].now).getTime()
  windowStart = new Date(now - 86400000).toISOString(); windowEnd = new Date(now + 86400000).toISOString()
  const baseline = await durableState(db), security = await securityCatalog(db), functions = await functionCatalog(db)
  const identity = async () => (await db.query(`select oid::regprocedure::text as signature, proowner, proacl::text,
    prosecdef, proconfig, provolatile, proparallel, prokind from pg_proc where oid=$1::regprocedure`, [commitSignature])).rows[0]
  const beforeIdentity = await identity()
  await db.exec(candidate)
  console.log(`Candidate SHA256: ${digest(candidate)}`)

  await check('migration replaces one function body, preserves owner/signature/ACL/RLS/grants and is repeatable', async () => {
    assert.deepEqual(await securityCatalog(db), security)
    assert.deepEqual(await identity(), beforeIdentity)
    const after = await functionCatalog(db)
    assert.equal(after.length, functions.length)
    for (const old of functions) {
      const current = after.find(row => row.signature === old.signature)
      assert.ok(current)
      if (old.signature.includes('pjsdas_commit_discovery_workspace_v1(')) assert.equal(current.acl, old.acl)
      else assert.deepEqual(current, old)
    }
    assert.deepEqual(await durableState(db), baseline)
    await db.exec(candidate)
    assert.deepEqual(await securityCatalog(db), security)
    assert.deepEqual(await identity(), beforeIdentity)
    assert.deepEqual(await functionCatalog(db), after)
    const definition = after.find(row => row.signature.includes('pjsdas_commit_discovery_workspace_v1(')).definition
    assert.match(definition, /google_drive_connections c[\s\S]*?for share/)
    assert.match(definition, /pjsdas_authorization_grants g[\s\S]*?for share/)
    assert.ok(definition.indexOf('for share') < definition.indexOf('for update'), 'authority lock must precede workspace lock')
    assert.match(definition, /clock_timestamp\(\)/, 'window admission must use wall time after locks')
  })

  await check('anon and authenticated cannot execute; owner-scoped RLS and invoker privileges remain enforced', async () => {
    for (const role of ['anon', 'authenticated']) {
      assert.equal((await db.query("select has_function_privilege($1,$2,'EXECUTE') allowed", [role, commitSignature])).rows[0].allowed, false)
      await db.exec('savepoint denied_role')
      let error
      try { await roleCall(role, () => commit(db, automation, claim())) } catch (caught) { error = caught }
      await db.exec('rollback to savepoint denied_role; release savepoint denied_role')
      assert.equal(error?.code, '42501')
    }
    assert.equal((await db.query("select has_function_privilege('service_role',$1,'EXECUTE') allowed", [commitSignature])).rows[0].allowed, true)
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [owner])
    const rows = await roleCall('authenticated', () => db.query('select user_id from public.pjsdas_authorization_grants'))
    assert.equal(rows.rows.length, 2); assert.ok(rows.rows.every(row => row.user_id === owner))
    await denied(claim(), delegated)
    await denied(claim({ user: other }))
    await denied(claim({ user: absent, commit: { revision: 0 } }))
    for (const table of ['google_drive_connections', 'pjsdas_workspaces']) {
      await db.exec(`revoke update on public.${table} from service_role`)
      await denied(claim())
      await db.exec(`grant update on public.${table} to service_role`)
    }
  })

  await check('legacy checkpoints/delegated facts preserve compatibility and strip forged budget receipt context', async () => {
    const legacy = claim()
    delete legacy.provenance.discoveryBudgetHold
    legacy.receiptContext = { displayLabel: 'synthetic-label', discoveryBudget: { admitted: true, retainedMicroUsd: 0 } }
    const first = await send(legacy)
    assert.equal(first.outcome, 'COMMITTED'); assert.equal(first.receipt.discoveryBudget, undefined)
    assert.equal(first.receipt.displayLabel, 'synthetic-label')
    const facts = await send({ command: 'synthetic-delegated-facts', operation: 'ingest_verified_discovery',
      provenance: { sourceId: source }, receiptContext: legacy.receiptContext }, delegated)
    assert.equal(facts.outcome, 'COMMITTED'); assert.equal(facts.receipt.discoveryBudget, undefined)
    assert.deepEqual(facts.receipt.discoveryAuthorization, receiptProof(delegated))
    assert.deepEqual((await durableState(db)).workspaces.map(row => row.snapshot), baseline.workspaces.map(row => row.snapshot))
  })

  await check('one approval aggregates exact held amount across source, plan and cycle while accounts stay isolated', async () => {
    const terms = policy({ maximumMicroUsd: micro * 4 })
    const first = claim({ policy: terms }); await admitted(first)
    const nextPlan = claim({ policy: terms, batch: { cycleId: first.provenance.searchCycleId } }); await admitted(nextPlan)
    const nextCycle = claim({ policy: terms, batch: { planFingerprint: first.provenance.searchPlanFingerprint } }); await admitted(nextCycle)
    const nextSource = claim({ policy: terms, sourceId: 'discovery:other-synthetic', batch: { planFingerprint: first.provenance.searchPlanFingerprint, cycleId: first.provenance.searchCycleId } }); await admitted(nextSource)
    const declined = claim({ policy: terms }); await admitted(declined, false)
    const rows = (await durableState(db)).ledger
    assert.equal(rows.length, 5)
    assert.equal(rows.reduce((sum, row) => sum + row.receipt.discoveryBudget.retainedMicroUsd, 0), terms.maximumMicroUsd)
    assert.ok(rows.every(row => row.provenance.searchPhase === 'claimed'), 'unsettled/unknown holds count toward cap')
    await db.query('update public.google_drive_connections set discovery_automation_enabled=true where user_id=$1', [other])
    const otherAuthority = await proof(db, 'automation', other)
    await admitted(claim({ user: other, policy: { ...terms, accountId: other } }), true, otherAuthority)
    const ownerRows = (await durableState(db)).ledger.filter(row => row.user_id === owner)
    assert.equal(ownerRows.reduce((sum, row) => sum + row.receipt.discoveryBudget.retainedMicroUsd, 0), terms.maximumMicroUsd)
  })

  await check('one-micro precision and smallest/largest query batches use exact fixed-tariff arithmetic', async () => {
    for (const count of [1, 48]) {
      const terms = policy({ approvalId: `fixture:boundary-${count}`, maximumMicroUsd: amount(count) * 2 - 1 })
      await admitted(claim({ policy: terms, batch: { queryCount: count, totalQueryCount: count } }))
      await admitted(claim({ policy: terms, batch: { queryCount: count, totalQueryCount: count } }), false)
    }
    const exact = policy({ approvalId: 'fixture:exact-cap', maximumMicroUsd: micro * 2 })
    await admitted(claim({ policy: exact })); await admitted(claim({ policy: exact }))
    await admitted(claim({ policy: exact }), false)
  })

  await check('declined original claim is durable, immutable and only settles budget_exhausted without facts', async () => {
    const deniedClaim = claim({ policy: policy({ maximumMicroUsd: micro - 1 }),
      commit: { receiptContext: { discoveryBudget: { version: 1, admitted: true, retainedMicroUsd: micro } } } })
    const original = await admitted(deniedClaim, false)
    const durable = await durableState(db)
    assert.equal(durable.ledger.length, 1); assert.equal(Number(durable.workspaces[0].revision), 1)
    const replay = await send(deniedClaim)
    assert.equal(replay.outcome, 'ALREADY_APPLIED'); assert.deepEqual(replay.receipt, original.receipt)
    assert.deepEqual(await durableState(db), durable)
    for (const outcome of ['complete', 'unknown', 'failed', null]) await denied(settle(deniedClaim, outcome))
    await denied(settle(deniedClaim, 'budget_exhausted', { operation: 'ingest_verified_discovery' }))
    const withHold = settle(deniedClaim, 'budget_exhausted')
    withHold.provenance.discoveryBudgetHold = deniedClaim.provenance.discoveryBudgetHold
    await denied(withHold)
    const finish = await send(settle(deniedClaim, 'budget_exhausted', {
      receiptContext: { discoveryBudget: { admitted: true, retainedMicroUsd: micro } } }))
    assert.equal(finish.outcome, 'COMMITTED'); assert.deepEqual(finish.receipt.discoveryBudget, original.receipt.discoveryBudget)
    assert.deepEqual((await durableState(db)).ledger.find(row => row.command_id === deniedClaim.command), durable.ledger[0])
  })

  await check('unknown and successful settlements retain the full hold and cannot free/reuse cap', async () => {
    const terms = policy({ maximumMicroUsd: micro * 2 })
    const unknown = claim({ policy: terms }), complete = claim({ policy: terms })
    const initial = await admitted(unknown)
    const unknownFinish = await send(settle(unknown, 'unknown'))
    assert.deepEqual(unknownFinish.receipt.discoveryBudget, initial.receipt.discoveryBudget)
    const next = await admitted(complete)
    const completeFinish = await send(settle(complete, 'complete', { operation: 'ingest_verified_discovery' }))
    assert.deepEqual(completeFinish.receipt.discoveryBudget, next.receipt.discoveryBudget)
    await admitted(claim({ policy: terms }), false)
    const originalRows = (await durableState(db)).ledger.filter(row => row.provenance.searchPhase === 'claimed')
    assert.equal(originalRows.reduce((sum, row) => sum + row.receipt.discoveryBudget.retainedMicroUsd, 0), terms.maximumMicroUsd)
    await denied({ ...settle(unknown), command: 'duplicate-unknown-settlement' })
    await denied({ ...settle(complete, 'complete'), command: 'duplicate-facts-settlement', operation: 'ingest_verified_discovery' })
  })

  await check('explicit non-UTC offsets preserve the same absolute budget window', async () => {
    const offset = value => new Date(Date.parse(value) + 330 * 60000).toISOString().replace('Z', '+05:30')
    const terms = policy({ validFrom: offset(windowStart), expiresAt: offset(windowEnd) })
    await admitted(claim({ policy: terms }))
  })

  await check('same claim preserves original admission after expiration; new claims cannot spend expired approval', async () => {
    const now = new Date((await db.query('select clock_timestamp() as now')).rows[0].now).getTime()
    const terms = policy({ expiresAt: new Date(now + 800).toISOString() })
    const original = claim({ policy: terms }), first = await admitted(original)
    const declinedClaim = claim({ policy: { ...terms, approvalId: 'fixture:expired-declined', maximumMicroUsd: micro - 1 } })
    const declined = await admitted(declinedClaim, false)
    await new Promise(resolve => setTimeout(resolve, 900))
    const before = await durableState(db)
    const replay = await send(original)
    assert.equal(replay.outcome, 'ALREADY_APPLIED'); assert.deepEqual(replay.receipt, first.receipt)
    const declinedReplay = await send(declinedClaim)
    assert.equal(declinedReplay.outcome, 'ALREADY_APPLIED'); assert.deepEqual(declinedReplay.receipt, declined.receipt)
    assert.deepEqual(await durableState(db), before)
    await denied(claim({ policy: terms }))
    const changed = clone(original); changed.provenance.discoveryBudgetHold.policy.expiresAt = windowEnd
    await denied(changed)
    const finished = await send(settle(original, 'unknown'))
    assert.deepEqual(finished.receipt.discoveryBudget, first.receipt.discoveryBudget)
  })

  await check('existing approval terms cannot mutate cap, dates, scope or tariff to reset funding', async () => {
    const terms = policy(); await admitted(claim({ policy: terms }))
    for (const changes of [ { maximumMicroUsd: micro * 100 }, { maximumMicroUsd: micro },
      { validFrom: new Date(Date.parse(windowStart) - 1000).toISOString() },
      { expiresAt: new Date(Date.parse(windowEnd) + 1000).toISOString() },
      { scopeFingerprint: 'e'.repeat(64) }, { tariffVersion: 'future-cheaper-tariff' }, { currency: 'EUR' } ]) {
      await denied(claim({ policy: { ...terms, ...changes } }))
    }
  })

  await check('original nonce/claim ownership, CAS conflicts and compensation/snapshot boundaries are preserved', async () => {
    const original = claim(); const first = await admitted(original)
    await denied({ ...original, command: 'second-owner-of-batch' })
    await denied({ ...original, hash: 'changed-original-hash' }, automation, '23505')
    const changedNonce = clone(original); changedNonce.provenance.searchBatch.claimAttemptId = randomUUID()
    changedNonce.provenance.discoveryBudgetHold.claimAttemptId = changedNonce.provenance.searchBatch.claimAttemptId
    await denied(changedNonce)
    const wrongSettlement = settle(original); wrongSettlement.provenance.searchBatch.claimAttemptId = randomUUID()
    await denied(wrongSettlement)
    await denied(claim({ batch: { index: 1, queryStart: 12 } }))
    await denied(claim({ commit: { compensation: { operation: 'refund-hold' } } }))
    await denied(claim({ commit: { snapshot: { ...state, data: { ...state.data, scheduleNodes: [{ id: 'forged-v4-change' }] } } } }))
    const before = await durableState(db)
    const conflict = await send(claim({ commit: { revision: 0 } }))
    assert.equal(conflict.outcome, 'CONFLICT'); assert.deepEqual(await durableState(db), before)
    const replay = await send(original); assert.deepEqual(replay.receipt, first.receipt)
  })

  const invalidTerms = [
    ['foreign account', hold => { hold.policy.accountId = other }],
    ['wrong scope', hold => { hold.policy.scopeFingerprint = 'e'.repeat(64) }],
    ['wrong source', hold => { hold.sourceId = 'discovery:unapproved' }],
    ['wrong nonce', hold => { hold.claimAttemptId = randomUUID() }],
    ['non-uuid nonce', (hold, batch) => { hold.claimAttemptId = batch.claimAttemptId = 'a'.repeat(36) }],
    ['hyphen-only nonce', (hold, batch) => { hold.claimAttemptId = batch.claimAttemptId = '-'.repeat(36) }],
    ['invalid UUID variant', (hold, batch) => { hold.claimAttemptId = batch.claimAttemptId = '11111111-1111-4111-1111-111111111111' }],
    ['string hold version', hold => { hold.version = '1' }],
    ['string policy version', hold => { hold.policy.version = '1' }],
    ['unknown hold field', hold => { hold.refund = true }],
    ['unknown policy field', hold => { hold.policy.reset = true }],
    ['wrong application', hold => { hold.policy.application = 'another-app' }],
    ['wrong currency', hold => { hold.policy.currency = 'EUR' }],
    ['unknown tariff', hold => { hold.policy.tariffVersion = 'cheaper' }],
    ['invalid approval id', hold => { hold.policy.approvalId = 'unapproved / id' }],
    ['empty approval id', hold => { hold.policy.approvalId = '' }],
    ['oversize approval id', hold => { hold.policy.approvalId = 'a'.repeat(121) }],
    ['zero cap', hold => { hold.policy.maximumMicroUsd = 0 }],
    ['negative cap', hold => { hold.policy.maximumMicroUsd = -1 }],
    ['fractional cap', hold => { hold.policy.maximumMicroUsd = micro + 0.5 }],
    ['string cap', hold => { hold.policy.maximumMicroUsd = String(micro) }],
    ['unsafe cap', hold => { hold.policy.maximumMicroUsd = 9007199254740992 }],
    ['missing start', hold => { delete hold.policy.validFrom }],
    ['malformed expiration', hold => { hold.policy.expiresAt = 'not-a-timestamp' }],
    ['relative rolling window', hold => { hold.policy.validFrom = 'yesterday'; hold.policy.expiresAt = 'tomorrow' }],
    ['date-only budget window', hold => { hold.policy.validFrom = windowStart.slice(0, 10); hold.policy.expiresAt = windowEnd.slice(0, 10) }],
    ['timezone-free budget window', hold => { hold.policy.validFrom = windowStart.slice(0, -1); hold.policy.expiresAt = windowEnd.slice(0, -1) }],
    ['infinite expiration', hold => { hold.policy.expiresAt = 'infinity' }],
    ['negative window', hold => { hold.policy.expiresAt = windowStart }],
    ['future window', hold => { hold.policy.validFrom = windowEnd; hold.policy.expiresAt = new Date(Date.parse(windowEnd) + 86400000).toISOString() }],
    ['expired window', hold => { hold.policy.expiresAt = new Date(Date.parse(windowStart) + 1000).toISOString() }],
    ['missing model envelope', hold => { hold.modelRequestLimit = 0 }],
    ['extra model request', hold => { hold.modelRequestLimit = 2 }],
    ['string model limit', hold => { hold.modelRequestLimit = '1' }],
    ['zero query count', (hold, batch) => { hold.searchRequestLimit = batch.queryCount = 0; hold.reservedMicroUsd = amount(0) }],
    ['oversize query count', (hold, batch) => { hold.searchRequestLimit = batch.queryCount = 49; hold.reservedMicroUsd = amount(49) }],
    ['string search limit', hold => { hold.searchRequestLimit = '12' }],
    ['mismatched query count', hold => { hold.searchRequestLimit = 11; hold.reservedMicroUsd = amount(11) }],
    ['missing model tariff', hold => { hold.reservedMicroUsd = 60000 }],
    ['underhold one micro', hold => { hold.reservedMicroUsd -= 1 }],
    ['overhold one micro', hold => { hold.reservedMicroUsd += 1 }],
    ['fractional hold', hold => { hold.reservedMicroUsd += 0.5 }],
    ['string hold', hold => { hold.reservedMicroUsd = String(micro) }],
    ['missing fingerprint', hold => { delete hold.policyFingerprint }],
    ['malformed fingerprint', hold => { hold.policyFingerprint = 'forged' }],
    ['null policy', hold => { hold.policy = null }],
  ]
  for (const [name, mutate] of invalidTerms) await check(`rejects ${name} without durable mutation`, async () => {
    const options = claim(); mutate(options.provenance.discoveryBudgetHold, options.provenance.searchBatch)
    await denied(options)
  })

  await check('forged receipt_context admission/hold/retained amount is replaced by authoritative budget', async () => {
    const options = claim({ commit: { receiptContext: { displayLabel: 'keep-safe-label', discoveryAuthorization: { userId: other },
      discoveryBudget: { version: 1, admitted: true, retainedMicroUsd: 0, hold: { accountId: other }, evil: true } } } })
    const result = await admitted(options)
    assert.equal(result.receipt.displayLabel, 'keep-safe-label')
    assert.equal(result.receipt.discoveryBudget.evil, undefined)
    const finish = await send(settle(options, 'unknown', { receiptContext: options.receiptContext }))
    assert.deepEqual(finish.receipt.discoveryBudget, result.receipt.discoveryBudget)
  })

  await check('malformed historical budget admission blocks fresh claims instead of silently freeing money', async () => {
    const original = claim(); await admitted(original)
    for (const mutation of ["receipt - 'discoveryBudget'", "jsonb_set(receipt,'{discoveryBudget,retainedMicroUsd}','0')",
      "jsonb_set(receipt,'{discoveryBudget,admitted}','null')", "jsonb_set(receipt,'{discoveryBudget,hold,reservedMicroUsd}','1')"]) {
      await db.exec('savepoint corrupt_fixture_history')
      await db.query(`update public.pjsdas_command_ledger set receipt=${mutation} where command_id=$1`, [original.command])
      await denied(claim())
      await db.exec('rollback to savepoint corrupt_fixture_history; release savepoint corrupt_fixture_history')
    }
  })

  await check('revoked, disabled, stale and expired Google authority blocks claims and historical replays', async () => {
    const original = claim(); await admitted(original)
    for (const update of [ 'revoked_at=now()', 'discovery_automation_enabled=false',
      "discovery_last_error='GOOGLE_AUTH_EXPIRED: reconnect'", "google_subject='fixture-replaced-subject'" ]) {
      await db.exec('savepoint authority_mutation')
      await db.query(`update public.google_drive_connections set ${update} where user_id=$1`, [owner])
      await denied(original); await denied(claim())
      await db.exec('rollback to savepoint authority_mutation; release savepoint authority_mutation')
    }
    for (const changes of [{ userId: other }, { googleSubject: 'forged' }, { consentGeneration: randomUUID() }, { kind: 'delegated_mcp' }]) {
      await denied(claim(), { ...automation, ...changes })
    }
    await db.query('update public.pjsdas_authorization_grants set revoked_at=now() where id=$1', [delegated.grantId])
    await denied({ command: 'delegated-revoked-facts', operation: 'ingest_verified_discovery', provenance: { sourceId: source } }, delegated)
  })

  assert.deepEqual(await securityCatalog(db), security)
  assert.deepEqual(await durableState(db), baseline, 'every synthetic test is transaction-isolated')
  console.log(`RESULT: ${groups} passed assertion groups; ${failures.length} failed groups; ${denials} rejected guarded calls.`)
  console.log('LIMIT: PGlite executes actual SQL serially. Real PostgreSQL competing claim/revocation lock schedules and production migration applicability were not tested.')
  if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exitCode = 1 }
} finally { await db.close() }
