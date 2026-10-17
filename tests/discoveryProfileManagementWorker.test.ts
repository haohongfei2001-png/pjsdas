import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runDiscoveryAutomationForBinding, discoverSourceRun } from '../gateway/discoveryAutomationWorker.js'
import { applyDiscoveryProfileManagement, getDiscoveryProfileManagementRead } from '../src/discoveryProfileManagement.js'
import { buildDiscoveryAutomationPlan } from '../src/discoveryAutomation.js'
import { buildContinuousDiscoverySummary } from '../src/continuousDiscovery.js'
import { effectiveSourceRegistry } from '../src/sourceRegistry.js'
import { syntheticDiscoveryBudget } from './fixtures/discoveryBudget.js'
import { LedgerHarness, scheduler, USER, GENERATION, AUTOMATION } from './fixtures/b2Ledger.rebuilt.js'
import { offlineSearchFixture } from './fixtures/discoverySearch.rebuilt.js'
beforeEach(() => { vi.stubEnv('PJSDAS_CONNECTED_AUTHORITY', 'transactional'); vi.stubEnv('PJSDAS_SUPABASE_SERVICE_ROLE_KEY', 'synthetic-unused-key') })
afterEach(() => vi.unstubAllEnvs())
async function configured() {
  const db = new LedgerHarness()
  db.snapshot.data.discoveryProfile!.notes = 'Historical note must not become a search instruction'
  db.snapshot.data.discoveryProfile!.strengths = ['Historical strength must not be inferred']
  db.snapshot = (await applyDiscoveryProfileManagement(db.snapshot, { kind: 'patch_discovery_profile',
    expectedFingerprint: (await getDiscoveryProfileManagementRead(db.snapshot)).fingerprint,
    patch: { targetRoleQueries: ['Explicit role'], preferredLocations: ['Explicit city'], mustHave: [], mustNotHave: [], searchGoal: 'Explicit current search goal' } }, 'scope-worker-update', db.now)).snapshot
  return db
}
function options(db: LedgerHarness, generateTextImpl = vi.fn(async () => ({ text: '{"observations":[]}' }))) {
  return { binding: { userId: USER, googleSubject: 'synthetic-subject', refreshTokenCiphertext: 'unused', discoveryConsentGeneration: GENERATION },
    tokenEncryptionKey: '', googleClientId: '', googleClientSecret: '', fetchImpl: db.fetch, generateTextImpl, now: () => db.now,
    authorize: async () => { expect(db.liveAuthorization).toEqual(AUTOMATION) } }
}
function funded(db: LedgerHarness) {
  const work = scheduler(db)
  return { work, input: { ...options(db, work.generateTextImpl), reserveSearch: work.reserveSearch, reserveSpend: work.reserveSpend,
    searchProvider: { id: 'offline-scope', maximumRequestCostUsd: 0.01, search: work.search } } }
}

describe('scope changes neither grant spending nor preserve stale discovery authority', () => {
  it('reset stops the actual worker before provider, model or workspace writes', async () => {
    const db = await configured()
    db.snapshot = (await applyDiscoveryProfileManagement(db.snapshot, { kind: 'reset_discovery_profile', expectedFingerprint: (await getDiscoveryProfileManagementRead(db.snapshot)).fingerprint }, 'scope-worker-reset', db.now)).snapshot
    const input = options(db)
    expect(await runDiscoveryAutomationForBinding(input)).toMatchObject({ state: 'not_configured', configured: false, completedSourceCount: 0 })
    expect(input.generateTextImpl).not.toHaveBeenCalled(); expect(db.calls).toHaveLength(1); expect(db.writes).toEqual([])
  })
  it.each([false, true])('confirmed scope still cannot spend without an independent reservation (force=%s)', async force => {
    const db = await configured(), input = options(db)
    await expect(runDiscoveryAutomationForBinding({ ...input, force })).rejects.toMatchObject({ code: 'DISCOVERY_BUDGET_APPROVAL_REQUIRED' })
    expect(input.generateTextImpl).not.toHaveBeenCalled(); expect(db.writes).toEqual([])
  })
  it('only the current explicit role/location/goal enters future queries and model context', async () => {
    const db = await configured(), profile = db.snapshot.data.discoveryProfile!
    const sources = effectiveSourceRegistry(db.snapshot.data.timeline)
    const plan = buildDiscoveryAutomationPlan({ profile, sources, continuousDiscovery: buildContinuousDiscoverySummary({ changeSets: [], opportunities: [], inbox: [], now: db.now }) })
    const source = plan.sourceRuns.find(item => item.sourceId === 'monitor:urgent-campus')!
    expect(source.queryHints).toContain('Explicit role Explicit city'); expect(source.maxObservations).toBe(18)
    expect(source.cadenceMinutes).toBe(sources.find(item => item.sourceId === source.sourceId)!.cadenceMinutes)
    const search = offlineSearchFixture([{ url: 'https://example.test/job', title: 'Synthetic search hit' }])
    const generateTextImpl = vi.fn(async () => ({ text: '{"observations":[]}' }))
    await discoverSourceRun(db.snapshot, source, { executionRules: [], now: db.now,
      ai: { ...syntheticDiscoveryBudget, ...search, generateTextImpl } })
    expect(generateTextImpl).toHaveBeenCalledOnce()
    const request = generateTextImpl.mock.calls[0][0] as any
    expect(request.prompt).toContain('Explicit current search goal')
    expect(request.prompt).not.toContain(profile.notes); expect(request.prompt).not.toContain(profile.strengths[0]); expect(request.maxRetries).toBe(0)
    expect(search.queries).toHaveLength(source.webQueries!.length)
  })
  it.each(['reset', 'patch'] as const)('scope %s during interpretation prevents commit and any further model/search calls', async mode => {
    const db = await configured(), { work, input } = funded(db)
    work.generateTextImpl.mockImplementationOnce(async () => {
      if (mode === 'reset') delete db.snapshot.data.discoveryProfile
      else db.snapshot.data.discoveryProfile!.searchGoal = 'Changed by the user'
      db.revision += 1
      return { text: '{"observations":[]}' }
    })
    const result = await runDiscoveryAutomationForBinding(input)
    expect(result).toMatchObject({ state: 'verified_not_committed', completedSourceCount: 0, skippedSourceCount: result.dueSourceCount })
    expect(work.generateTextImpl).toHaveBeenCalledOnce(); expect(work.reserveSpend).toHaveBeenCalledOnce()
    expect(work.search.mock.calls.length).toBeGreaterThan(0)
    expect(work.search.mock.calls.length).toBe(work.reserveSearch.mock.calls.length)
    expect(db.attempts.filter(row => row.target_operation === 'ingest_verified_discovery')).toEqual([])
    expect(db.writes).toHaveLength(1); expect(db.writes[0].target_provenance.searchPhase).toBe('claimed')
  })
  it('CAS retry rechecks current scope without repeating already paid retrieval', async () => {
    const db = await configured(), { work, input } = funded(db)
    let searchedBeforeConflict = 0
    db.beforeCommit = body => { if (body.target_operation !== 'ingest_verified_discovery') return; db.beforeCommit = undefined; searchedBeforeConflict = work.search.mock.calls.length; db.snapshot.data.discoveryProfile!.searchGoal = 'Changed during CAS'; db.revision += 1 }
    const result = await runDiscoveryAutomationForBinding({ ...input, force: true })
    expect(db.attempts.filter(row => row.target_operation === 'ingest_verified_discovery')).toHaveLength(1)
    expect(db.writes.filter(row => row.target_operation === 'ingest_verified_discovery')).toHaveLength(0)
    expect(db.writes.filter(row => row.target_operation === 'checkpoint_discovery_search')).toHaveLength(1)
    expect(work.generateTextImpl).toHaveBeenCalledOnce(); expect(work.reserveSpend).toHaveBeenCalledOnce()
    expect(work.search).toHaveBeenCalledTimes(searchedBeforeConflict)
    expect(work.reserveSearch).toHaveBeenCalledTimes(searchedBeforeConflict)
    expect(result.skippedSourceCount).toBe(result.dueSourceCount); expect(result.completedSourceCount).toBe(0)
    expect(db.snapshot.data.discoveryProfile!.searchGoal).toBe('Changed during CAS')
  })
})
