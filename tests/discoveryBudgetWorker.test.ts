import { budgetWire } from './fixtures/b2BudgetLedger.js'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { LedgerHarness, scheduler, clone, USER } from './fixtures/b2Ledger.rebuilt.js'
import { discoveryProfileManagementFingerprint } from '../src/discoveryProfileManagement.js'
import { DISCOVERY_SPEND_TARIFF as T, type DiscoverySpendPolicy } from '../gateway/discoverySpendPolicy.js'
import type { DiscoveryModelTransport } from '../gateway/discoveryBatchSpend.js'

async function fixture(cap = 10_000_000) {
  const db = new LedgerHarness(), work = scheduler(db)
  const policy: DiscoverySpendPolicy = { version: 1, application: 'todayaction', approvalId: 'synthetic-budget-worker',
    accountId: USER, scopeFingerprint: await discoveryProfileManagementFingerprint(db.snapshot.data.discoveryProfile!),
    currency: 'USD', maximumMicroUsd: cap, validFrom: '2026-10-01T00:00:00Z', expiresAt: '2028-01-01T00:00:00Z', tariffVersion: T.version }
  const model = vi.fn<DiscoveryModelTransport>(async (_input, beforeRequest) => { await beforeRequest(); return { text: '{"observations":[]}' } })
  const provider = { id: T.searchProvider, maximumRequestCostUsd: 0.005, maximumResults: 20, search: work.search }
  const overrides = { batchSpend: { policy, modelTransport: model }, aiGatewayModel: T.model as string, searchProvider: provider, fetchImpl: budgetWire(db) }
  const run = (force = false) => work.run(force, overrides)
  return { db, work, policy, model, overrides, run }
}
beforeEach(() => { vi.stubEnv('PJSDAS_CONNECTED_AUTHORITY', 'transactional'); vi.stubEnv('PJSDAS_SUPABASE_SERVICE_ROLE_KEY', 'synthetic-unused-key') })
afterEach(() => vi.unstubAllEnvs())

describe('worker consumes only original admitted budget claim slots', () => {
  it('wires the four complete source queries and model calls through their own retained receipts', async () => {
    const f = await fixture()
    expect(await f.run()).toMatchObject({ state: 'committed_with_exceptions', scopeComplete: false, totalQueryCount: 4, remainingQueryCount: 0, partialSourceCount: 4 })
    expect(f.work.search).toHaveBeenCalledTimes(4); expect(f.model).toHaveBeenCalledTimes(4)
    expect(f.work.reserveSearch).not.toHaveBeenCalled(); expect(f.work.reserveSpend).not.toHaveBeenCalled(); expect(f.work.generateTextImpl).not.toHaveBeenCalled()
    const claims = [...f.db.rows.values()].filter(row => row.provenance.searchPhase === 'claimed')
    expect(claims).toHaveLength(4)
    for (const claim of claims) expect(claim.receipt.discoveryBudget).toMatchObject({ admitted: true, retainedMicroUsd: 432031,
      hold: { policy: f.policy, searchRequestLimit: 1, modelRequestLimit: 1 } })
    const originals = clone([...f.db.rows.values()])
    expect(await f.run()).toMatchObject({ state: 'checked_not_due' })
    expect([...f.db.rows.values()]).toEqual(originals)
    expect(f.work.search).toHaveBeenCalledTimes(4); expect(f.model).toHaveBeenCalledTimes(4)
    expect(JSON.stringify(f.db.snapshot)).not.toContain('maximumMicroUsd')
    expect(f.db.unexpectedUrls).toEqual([])
  })
  it('a cap-declined second source settles budget_exhausted and blocks later cadence/force spending', async () => {
    const f = await fixture(432031)
    const result = await f.run()
    expect(result).toMatchObject({ budgetExhausted: true, scopeComplete: false, remainingQueryCount: 3 })
    expect(f.work.search).toHaveBeenCalledTimes(1); expect(f.model).toHaveBeenCalledTimes(1)
    const rejected = [...f.db.rows.values()].find(row => row.provenance.searchPhase === 'claimed' && (row.receipt.discoveryBudget as { admitted: boolean }).admitted === false)!
    expect(rejected.receipt.discoveryBudget).toMatchObject({ admitted: false, retainedMicroUsd: 0 })
    expect([...f.db.rows.values()].some(row => row.provenance.searchPhase === 'settled' && (row.provenance.searchBatch as { outcome: string }).outcome === 'budget_exhausted')).toBe(true)
    f.db.now = new Date('2027-01-01T00:00:00Z')
    expect(await f.run(true)).toMatchObject({ budgetExhausted: true, remainingQueryCount: 3 })
    expect(f.work.search).toHaveBeenCalledTimes(1); expect(f.model).toHaveBeenCalledTimes(1)
  })
  it.each(['claim acknowledgement', 'search response', 'model response'] as const)('retains unknown %s and never repeats its source after a later cadence', async phase => {
    const f = await fixture()
    if (phase === 'claim acknowledgement') f.db.lostAck = true
    if (phase === 'search response') f.work.search.mockRejectedValueOnce(new Error('accepted but lost response'))
    if (phase === 'model response') f.model.mockRejectedValueOnce(new Error('accepted but lost response'))
    await f.run()
    const original = clone([...f.db.rows.values()].find(row => row.provenance.searchPhase === 'claimed')!)
    expect(original.receipt.discoveryBudget).toMatchObject({ admitted: true, retainedMicroUsd: 432031 })
    const calls = (f.work.search.mock.calls as unknown as Array<[{ query: unknown }]>).map(call => clone(call))
    f.db.lostAck = false; f.db.now = new Date('2027-01-01T00:00:00Z')
    expect(await f.run(true)).toMatchObject({ uncertainSourceCount: expect.any(Number), scopeComplete: false })
    const query = calls[0]?.[0] as unknown as { query: unknown } | undefined
    if (query) expect((f.work.search.mock.calls as unknown as Array<[{ query: unknown }]>).filter(call => JSON.stringify(call[0].query) === JSON.stringify(query.query))).toHaveLength(1)
    expect(f.db.rows.get(original.command_id)).toEqual(original)
  })
  it.each(['account', 'scope', 'model', 'expiry'] as const)('rejects changed %s before claims or external work', async change => {
    const f = await fixture()
    if (change === 'account') f.policy.accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    if (change === 'scope') f.policy.scopeFingerprint = 'a'.repeat(64)
    if (change === 'model') f.overrides.aiGatewayModel = 'perplexity/sonar'
    if (change === 'expiry') f.db.now = new Date(f.policy.expiresAt)
    await expect(f.run()).rejects.toThrow()
    expect(f.db.rows.size).toBe(0); expect(f.work.search).not.toHaveBeenCalled(); expect(f.model).not.toHaveBeenCalled()
  })
  it('refuses a replay whose original atomic admission is missing', async () => {
    const f = await fixture(); await f.run()
    const before = f.work.search.mock.calls.length
    delete [...f.db.rows.values()][0].receipt.discoveryBudget
    await expect(f.run()).rejects.toThrow()
    expect(f.work.search).toHaveBeenCalledTimes(before)
  })
})
