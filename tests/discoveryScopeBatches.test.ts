import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildDiscoveryWebQueries } from '../src/discoveryQueryPlan.js'
import { KnownDiscoverySearchFailure } from '../gateway/discoveryExecutionOutcome.js'
import { WorkspaceSourceError } from '../gateway/workspaceSource.js'
import { LedgerHarness, scheduler, clone, AUTOMATION } from './fixtures/b2Ledger.rebuilt.js'

beforeEach(() => { vi.stubEnv('PJSDAS_CONNECTED_AUTHORITY', 'transactional'); vi.stubEnv('PJSDAS_SUPABASE_SERVICE_ROLE_KEY', 'synthetic-unused-key') })
afterEach(() => vi.unstubAllEnvs())
function largeScope() {
  const db = new LedgerHarness()
  Object.assign(db.snapshot.data.discoveryProfile!, { targetRoleQueries: Array.from({ length: 7 }, (_, i) => `Explicit role ${i}`), preferredLocations: ['City A', 'City B', 'City C'], locationPolicy: 'strict' })
  const work = scheduler(db)
  work.search.mockImplementation(async () => ({ providerRequestId: `actual-offline-${work.search.mock.calls.length}`, results: [] }))
  return { db, work }
}
describe('complete confirmed scope in bounded immutable batches (offline)', () => {
  it('preserves every target and all four coverage categories, without a hidden campus or site restriction', () => {
    const { db } = largeScope(), plan = buildDiscoveryWebQueries(db.snapshot.data.discoveryProfile)
    expect(plan.queries).toHaveLength(84); expect(plan.omittedTermCount + plan.omittedLocationCount + plan.omittedTargetCount).toBe(0)
    for (const role of db.snapshot.data.discoveryProfile!.targetRoleQueries) for (const city of ['City A', 'City B', 'City C']) {
      expect(plan.queries.filter(item => item.query.startsWith(`${role} ${city} `)).map(item => item.coverage)).toEqual(['general_web', 'employer_sites', 'university_publishers', 'recruiting_platforms'])
    }
    expect(plan.queries.filter(item => item.coverage === 'general_web').every(item => !item.domains)).toBe(true)
    expect(JSON.stringify(plan)).not.toMatch(/2027|校招|国企/)
  })
  it('uses at most the existing 48-query tick, resumes across cadence buckets and only finishes after all 84 queries', async () => {
    const { db, work } = largeScope(), originalProfile = clone(db.snapshot.data.discoveryProfile)
    const first = await work.run()
    expect(first).toMatchObject({ state: 'committed_with_exceptions', totalQueryCount: 84, remainingQueryCount: 36, partialSourceCount: 4, successfulSourceCount: 0 })
    expect(work.search).toHaveBeenCalledTimes(48); expect(work.reserveSearch).toHaveBeenCalledTimes(48)
    const original = clone([...db.rows.values()]); db.snapshot.data.timeline = []; db.revision += 1
    db.now = new Date('2026-10-09T20:00:00Z') // Continue the original unfinished cycle, not a new paid search.
    const second = await work.run()
    expect(second).toMatchObject({ state: 'committed', totalQueryCount: 84, remainingQueryCount: 0, partialSourceCount: 0, successfulSourceCount: 4 })
    expect(work.search).toHaveBeenCalledTimes(84); expect(work.reserveSearch).toHaveBeenCalledTimes(84)
    const sent = work.search.mock.calls.map(call => JSON.stringify((call as unknown as [{ query: unknown }])[0].query))
    expect(new Set(sent).size).toBe(84)
    expect(sent.sort()).toEqual(buildDiscoveryWebQueries(db.snapshot.data.discoveryProfile).queries.map(item => JSON.stringify(item)).sort())
    for (const row of original) expect(db.rows.get(row.command_id)).toEqual(row)
    expect(db.snapshot.data.discoveryProfile).toEqual(originalProfile)
    expect(db.snapshot.data.actions).toEqual([]); expect(db.snapshot.data.scheduleNodes).toEqual([])
    expect((await work.run()).state).toBe('checked_not_due'); expect(work.search).toHaveBeenCalledTimes(84)
  })
  it.each(['before outbound call', 'after outbound call'] as const)('an uncertain claim %s never retries or reserves again, even forced after a year', async boundary => {
    const { db, work } = largeScope()
    if (boundary === 'before outbound call') db.lostAck = true
    else db.beforeCommit = body => { if (body.target_operation === 'ingest_verified_discovery') { db.failWorkspaceAfterCommit = true; db.failLedgerAfterCommit = true; throw new Error('Synthetic crash before facts commit') } }
    await work.run().catch(() => undefined)
    const calls = work.search.mock.calls.length, reservations = work.reserveSearch.mock.calls.length
    expect(calls).toBe(boundary === 'before outbound call' ? 0 : 12)
    db.lostAck = false; db.beforeCommit = undefined; db.failWorkspaceAfterCommit = false; db.failLedgerAfterCommit = false
    db.now = new Date('2027-10-09T20:00:00Z')
    const resumed = await work.run(true)
    // In the after-call case other unclaimed sources may run once. The exact
    // uncertain source's queries are never sent or reserved a second time.
    expect(resumed.uncertainSourceCount).toBeGreaterThan(0)
    const firstSource = db.writes.find(item => item.target_operation === 'checkpoint_discovery_search')!.target_provenance.sourceId
    const sourceRequests = work.reserveSearch.mock.calls.filter(call => call[0].sourceId === firstSource)
    expect(sourceRequests).toHaveLength(boundary === 'before outbound call' ? 0 : 12)
    if (boundary === 'before outbound call') { expect(work.search).toHaveBeenCalledTimes(calls); expect(work.reserveSearch).toHaveBeenCalledTimes(reservations) }
  })
  it('stops at the approved budget boundary and retains an explicit uncovered scope without auto retry', async () => {
    const { db, work } = largeScope()
    work.reserveSearch.mockRejectedValueOnce(new WorkspaceSourceError('DISCOVERY_BUDGET_EXHAUSTED', 'Synthetic approved budget is spent'))
    expect(await work.run()).toMatchObject({ budgetExhausted: true, remainingQueryCount: 84, successfulSourceCount: 0 })
    expect(work.reserveSearch).toHaveBeenCalledTimes(1); expect(work.search).not.toHaveBeenCalled(); expect(work.reserveSpend).not.toHaveBeenCalled()
    db.now = new Date('2027-10-09T20:00:00Z')
    expect(await work.run(true)).toMatchObject({ budgetExhausted: true, remainingQueryCount: 84 })
    expect(work.reserveSearch).toHaveBeenCalledTimes(1); expect(work.search).not.toHaveBeenCalled()
  })
  it('keeps unsuccessful queries and omitted hits partial after later batches finish', async () => {
    const { work } = largeScope()
    work.search.mockRejectedValueOnce(new KnownDiscoverySearchFailure('DISCOVERY_SEARCH_UNAVAILABLE', 'Definite synthetic HTTP failure'))
    expect(await work.run()).toMatchObject({ remainingQueryCount: 37, partialSourceCount: 4 })
    expect(await work.run()).toMatchObject({ state: 'committed_with_exceptions', remainingQueryCount: 1, partialSourceCount: 1, successfulSourceCount: 3 })
    expect(work.search).toHaveBeenCalledTimes(84)
    expect(await work.run()).toMatchObject({ state: 'checked_not_due', remainingQueryCount: 1, partialSourceCount: 1, scopeComplete: false })
    expect(work.search).toHaveBeenCalledTimes(84)
  })
  it.each(['scope', 'consent'] as const)('stops a claimed batch when %s changes before its first reservation', async kind => {
    const { db, work } = largeScope()
    db.beforeCommit = body => {
      if (body.target_operation !== 'checkpoint_discovery_search') return
      db.beforeCommit = undefined
      // This models a change immediately after the claim's write response.
      db.responseTransform = response => {
        if (kind === 'scope') db.snapshot.data.discoveryProfile!.targetRoleQueries = ['Revised scope']
        else db.liveAuthorization = { ...AUTOMATION, consentGeneration: '99999999-9999-4999-8999-999999999999' }
        return response
      }
    }
    const result = await work.run()
    expect(result.sourceErrors?.[0]?.code).toBe(kind === 'scope' ? 'DISCOVERY_SCOPE_CHANGED' : 'AUTH_FORBIDDEN')
    expect(work.search).not.toHaveBeenCalled(); expect(work.reserveSearch).not.toHaveBeenCalled(); expect(work.generateTextImpl).not.toHaveBeenCalled()
  })
  it('admits each query only once when two scheduler invocations compete for the same immutable claims', async () => {
    const db = new LedgerHarness(), first = scheduler(db), second = scheduler(db)
    for (const work of [first, second]) work.search.mockImplementation(async () => ({ providerRequestId: 'offline-concurrent', results: [] }))
    await Promise.allSettled([first.run(), second.run()])
    const sent = [...first.search.mock.calls, ...second.search.mock.calls].map(call => JSON.stringify((call as unknown as [{ query: unknown }])[0].query))
    expect(sent).toHaveLength(4); expect(new Set(sent).size).toBe(4)
    expect(first.reserveSearch.mock.calls.length + second.reserveSearch.mock.calls.length).toBe(4)
    expect([...db.rows.values()].filter(row => row.operation === 'checkpoint_discovery_search')).toHaveLength(4)
    expect([...db.rows.values()].filter(row => row.operation === 'ingest_verified_discovery')).toHaveLength(4)
  })
  it.each(['query cursor', 'settled count', 'plan', 'claim owner', 'receipt hash', 'owner account'] as const)('rejects corrupt authoritative progress %s before another paid request', async corruption => {
    const { db, work } = largeScope(); await work.run()
    const before = work.search.mock.calls.length
    db.ledgerTransform = (rows, url) => {
      if (!url.searchParams.has('provenance->>searchCycleId')) return rows
      const row = rows.find(item => item.operation === 'ingest_verified_discovery')!
      const batch = row.provenance.searchBatch as Record<string, unknown>
      if (corruption === 'query cursor') batch.queryStart = 13
      if (corruption === 'settled count') batch.successfulQueryCount = 11
      if (corruption === 'plan') batch.planFingerprint = 'f'.repeat(64)
      if (corruption === 'claim owner') batch.claimAttemptId = '22222222-2222-4222-8222-222222222222'
      if (corruption === 'receipt hash') row.payload_hash = 'f'.repeat(64)
      if (corruption === 'owner account') row.user_id = 'foreign-account'
      return rows
    }
    await expect(work.run()).rejects.toThrow()
    expect(work.search).toHaveBeenCalledTimes(before); expect(work.reserveSearch).toHaveBeenCalledTimes(before)
  })
  it.each(['provider', 'price ceiling', 'result bound', 'model', 'budget policy', 'scope'] as const)('binds the full execution plan to %s without borrowing old completed coverage', async changed => {
    const { db, work } = largeScope(); await work.run()
    const oldFingerprints = new Set([...db.rows.values()].map(row => row.provenance.searchPlanFingerprint))
    const overrides: Parameters<typeof work.run>[1] = {}
    if (changed === 'provider' || changed === 'price ceiling' || changed === 'result bound') overrides.searchProvider = {
      id: changed === 'provider' ? 'offline-other' : 'offline-rebuilt', maximumRequestCostUsd: changed === 'price ceiling' ? 0.02 : 0.01,
      maximumResults: changed === 'result bound' ? 20 : 25, search: work.search,
    }
    if (changed === 'model') overrides.aiGatewayModel = 'offline-model-v2'
    if (changed === 'budget policy') overrides.budgetPolicyVersion = 'newly-approved-synthetic-policy'
    if (changed === 'scope') db.snapshot.data.discoveryProfile!.targetRoleQueries[0] = 'User revised explicit role'
    const next = await work.run(true, overrides)
    expect(next.remainingQueryCount).toBe(36) // New plan starts at batch zero, not the prior plan's cursor.
    expect(work.search).toHaveBeenCalledTimes(96)
    expect(new Set([...db.rows.values()].map(row => row.provenance.searchPlanFingerprint)).size).toBe(oldFingerprints.size + 1)
  })
})
