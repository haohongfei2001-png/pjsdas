import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { buildDiscoveryWebQueries } from '../src/discoveryQueryPlan.js'
import { createDiscoveryAutomationHandler } from '../gateway/discoveryAutomationHandler.js'
import { LedgerHarness, scheduler, USER, GENERATION } from './fixtures/b2Ledger.rebuilt.js'
beforeEach(() => { vi.stubEnv('PJSDAS_CONNECTED_AUTHORITY', 'transactional'); vi.stubEnv('PJSDAS_SUPABASE_SERVICE_ROLE_KEY', 'synthetic-unused-key') })
afterEach(() => vi.unstubAllEnvs())
const terms = ['Explicit A', 'Explicit B', 'Explicit C', 'Explicit D', 'Explicit E', 'Explicit F', 'OMITTED EXPLICIT G']
const cases = [
  { name: 'role terms', patch: { targetRoleQueries: terms }, omitted: 'omittedTermCount' },
  { name: 'locations', patch: { preferredLocations: ['City A','City B','City C','City D','City E'], locationPolicy: 'strict' as const }, omitted: 'omittedLocationCount' },
  { name: 'query targets', patch: { targetRoleQueries: terms.slice(0,6), preferredLocations: ['City A','City B','City C'], locationPolicy: 'strict' as const }, omitted: 'omittedTargetCount' },
] as const
it.each(cases)('executes the full $name scope across bounded batches instead of dropping it', async ({ patch }) => {
  const db = new LedgerHarness(); Object.assign(db.snapshot.data.discoveryProfile!, patch)
  const before = structuredClone(db.snapshot.data.discoveryProfile), plan = buildDiscoveryWebQueries(db.snapshot.data.discoveryProfile)
  expect(plan.omittedTermCount + plan.omittedLocationCount + plan.omittedTargetCount).toBe(0)
  const work = scheduler(db)
  work.search.mockImplementation(async () => ({ providerRequestId: 'actual-offline-empty', results: [] }))
  let result = await work.run()
  const firstCalls = work.search.mock.calls.length
  expect(firstCalls).toBeLessThanOrEqual(48)
  if (result.remainingQueryCount) {
    expect(result.state).toBe('committed_with_exceptions')
    result = await work.run()
    expect(work.search.mock.calls.length - firstCalls).toBeLessThanOrEqual(48)
  }
  expect(result.remainingQueryCount).toBe(0)
  expect(work.search).toHaveBeenCalledTimes(plan.queries.length)
  expect(work.reserveSearch).toHaveBeenCalledTimes(plan.queries.length)
  expect(db.snapshot.data.discoveryProfile).toEqual(before)
  expect(work.generateTextImpl).not.toHaveBeenCalled(); expect(work.reserveSpend).not.toHaveBeenCalled()
})
it('rejects an invalid oversized stored profile before paid retrieval, with failure-only scheduler telemetry', async () => {
  const db = new LedgerHarness(); db.snapshot.data.discoveryProfile!.targetRoleQueries = Array.from({ length: 1000 }, (_, i) => `Legacy oversized role ${i}`)
  const before = structuredClone(db.snapshot), work = scheduler(db), calls: string[] = []
  const handler = createDiscoveryAutomationHandler({ supabaseUrl: 'https://offline.invalid', supabasePublishableKey: 'synthetic-public',
    supabaseServiceRoleKey: 'synthetic-backend', tokenEncryptionKey: 'unused', googleClientId: 'unused', googleClientSecret: 'unused',
    now: () => db.now, reserveSearch: work.reserveSearch, reserveSpend: work.reserveSpend, generateTextImpl: work.generateTextImpl,
    searchProvider: { id: 'offline-only', maximumRequestCostUsd: 0.005, search: work.search },
    fetchImpl: async (input, init) => {
      const path = new URL(String(input)).pathname; calls.push(path)
      if (path.endsWith('pjsdas_claim_enabled_discovery_automation_bindings_v2')) return Response.json([{ user_id: USER, google_subject: 'synthetic-subject', refresh_token_ciphertext: 'unused', discovery_consent_generation: GENERATION }])
      if (path === '/rest/v1/pjsdas_workspaces' && (init?.method ?? 'GET') === 'GET') return db.fetch(input, init)
      if (path.endsWith('/pjsdas_update_google_automation_state')) {
        const patch = JSON.parse(String(init?.body)).state_patch
        expect(patch.success_at).toBeNull(); expect(patch.last_error).toContain('最多 30 项')
        return Response.json(true)
      }
      throw new Error(`Unexpected call after scope preflight: ${path}`)
    } })
  const response = await handler(new Request('https://gateway.invalid/api/automation-discovery?force=1', { headers: { authorization: 'Bearer synthetic-worker' } }))
  const body = await response.json()
  expect(JSON.stringify(body)).toContain('最多 30 项')
  expect(body).toMatchObject({ successfulUsers: 0, failedUsers: 1 })
  expect(calls).toEqual(['/rest/v1/rpc/pjsdas_claim_enabled_discovery_automation_bindings_v2', '/rest/v1/pjsdas_workspaces', '/rest/v1/rpc/pjsdas_update_google_automation_state'])
  expect(work.search).not.toHaveBeenCalled(); expect(work.reserveSearch).not.toHaveBeenCalled(); expect(work.generateTextImpl).not.toHaveBeenCalled(); expect(work.reserveSpend).not.toHaveBeenCalled()
  expect(db.snapshot).toEqual(before); expect(db.writes).toEqual([])
})
it('retains normal unrestricted web execution for a complete bounded confirmed scope', async () => {
  const db = new LedgerHarness(), work = scheduler(db)
  work.search.mockImplementation(async () => ({ providerRequestId: 'synthetic-empty', results: [] }))
  expect(await work.run()).toMatchObject({ state: 'committed', successfulSourceCount: 4, partialSourceCount: 0 })
  expect(work.search).toHaveBeenCalledTimes(4)
})
