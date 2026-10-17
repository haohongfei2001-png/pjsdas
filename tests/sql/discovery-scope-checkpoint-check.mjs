// New local SQL gate. No provider, credentials, network or real database.
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { authorityMigration, owner, source, state, installBase, seedExistingAuthority, migration, proof, commit, asRole, durableState, securityCatalog } from './discovery-authority-fixture.mjs'
const db = new PGlite()
const batch = { version: 1, planFingerprint: 'a'.repeat(64), cycleId: 'b'.repeat(64), claimAttemptId: '11111111-1111-4111-8111-111111111111', index: 0, count: 2, queryStart: 0, queryCount: 12, totalQueryCount: 20, phase: 'claimed' }
function provenance(value = batch) { return { sourceId: source, scopeFingerprint: 'c'.repeat(64), producer: 'server_scheduler', runId: 'server-discovery-batch:synthetic', searchPlanFingerprint: value.planFingerprint, searchCycleId: value.cycleId, searchBatchIndex: value.index, searchPhase: value.phase, searchBatch: value } }
try {
  await installBase(db, { createRoles: true }); await seedExistingAuthority(db)
  const security = await securityCatalog(db)
  await db.exec(await migration(authorityMigration))
  assert.deepEqual(await securityCatalog(db), security)
  const automation = await proof(db, 'automation'), delegated = await proof(db)
  const base = { command: 'claim-batch-zero', operation: 'checkpoint_discovery_search', provenance: provenance(), snapshot: state }
  const service = (authority, options) => asRole(db, 'service_role', () => commit(db, authority, options))
  const denied = async (authority, options, code = '42501') => {
    const before = await durableState(db)
    await assert.rejects(() => service(authority, options), error => error.code === code)
    assert.deepEqual(await durableState(db), before)
  }
  for (const role of ['anon', 'authenticated']) await assert.rejects(() => asRole(db, role, () => commit(db, automation, base)), error => error.code === '42501')
  await denied(delegated, base)
  for (const options of [
    { compensation: { operation: 'undo-something' } }, { provenance: { sourceId: source } },
    { provenance: { ...provenance(), searchPhase: 'invented' } },
    { provenance: { ...provenance(), searchBatch: { ...batch, claimAttemptId: 'not-a-uuid' } } },
    { provenance: { ...provenance(), searchBatch: { ...batch, index: 1 } } },
    { snapshot: { ...state, data: { ...state.data, opportunities: [{ id: 'forged-opportunity' }] } } },
  ]) await denied(automation, { ...base, ...options })
  const settled = { ...batch, phase: 'settled', outcome: 'complete', successfulQueryCount: 12, failedQueryCount: 0, omittedHitCount: 0 }
  await denied(automation, { ...base, command: 'settled-without-claim', provenance: provenance(settled) })
  await denied(automation, { ...base, command: 'facts-without-claim', operation: 'ingest_verified_discovery', provenance: provenance(settled) })
  await denied(automation, { ...base, command: 'facts-forged-as-claim', operation: 'ingest_verified_discovery' })
  await denied(automation, { ...base, command: 'skip-first-batch', provenance: provenance({ ...batch, index: 1, queryStart: 12, queryCount: 8 }) })
  const claim = await service(automation, base)
  assert.equal(claim.outcome, 'COMMITTED'); assert.equal(Number(claim.revision), 1)
  const afterClaim = await durableState(db)
  assert.deepEqual(afterClaim.workspaces.find(item => item.user_id === owner).snapshot, state)
  assert.equal(afterClaim.ledger.length, 1); assert.equal(claim.receipt.undoAvailable, false)
  const replay = await service(automation, { ...base, revision: 1 })
  assert.equal(replay.outcome, 'ALREADY_APPLIED'); assert.deepEqual(replay.receipt, claim.receipt)
  assert.deepEqual(await durableState(db), afterClaim)
  await denied(automation, { ...base, command: 'alternative-claim-id', revision: 1 })
  await denied(automation, { ...base, hash: 'changed-attempt', revision: 1 }, '23505')
  await denied(automation, { ...base, command: 'wrong-owner-settlement', revision: 1, provenance: provenance({ ...settled, claimAttemptId: '22222222-2222-4222-8222-222222222222' }) })
  await denied(delegated, { ...base, command: 'client-forged-facts-cursor', operation: 'ingest_verified_discovery', revision: 1, provenance: provenance(settled) })
  const finish = await service(automation, { ...base, command: 'settle-batch-zero', revision: 1, provenance: provenance(settled) })
  assert.equal(finish.outcome, 'COMMITTED'); assert.equal(Number(finish.revision), 2)
  assert.deepEqual((await durableState(db)).workspaces.find(item => item.user_id === owner).snapshot, state)
  const claimedReplayAfterSettlement = await service(automation, { ...base, revision: 2 })
  assert.equal(claimedReplayAfterSettlement.outcome, 'ALREADY_APPLIED'); assert.deepEqual(claimedReplayAfterSettlement.receipt, claim.receipt)
  await denied(automation, { ...base, command: 'duplicate-settlement', revision: 2, provenance: provenance(settled) })
  await denied(automation, { ...base, command: 'duplicate-facts-settlement', operation: 'ingest_verified_discovery', revision: 2, provenance: provenance(settled) })
  await db.query('update public.google_drive_connections set discovery_automation_enabled=false where user_id=$1', [owner])
  await denied(automation, { ...base, revision: 2 })
  assert.deepEqual(await securityCatalog(db), security)
  console.log('PASS search checkpoint SQL: existing ACL/RLS preserved; no client cursor capability; snapshot remains byte-equivalent; original claims/nonce, settlement uniqueness, immutable replay and revocation enforced.')
} finally { await db.close() }
