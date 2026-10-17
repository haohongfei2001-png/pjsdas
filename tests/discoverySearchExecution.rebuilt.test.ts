import { describe, expect, it, vi } from 'vitest'
import { executeDiscoveryQueries, type DiscoverySearchReservation } from '../gateway/discoverySearchExecution.js'
import { KnownDiscoverySearchFailure } from '../gateway/discoveryExecutionOutcome.js'
import { WorkspaceSourceError } from '../gateway/workspaceSource.js'

const at = new Date('2026-10-07T20:00:00Z'), query = { query: 'Explicit product role', coverage: 'general_web' as const }
function fixture() {
  const search = vi.fn(async () => ({ providerRequestId: 'offline-response', results: [] as Array<{ url: string; title: string }> }))
  const reserve = vi.fn(async request => ({ ...request, reservationId: 'offline-reservation', reservedUsd: request.maximumCostUsd, expiresAt: '2026-10-08T20:00:00Z' }))
  const authorize = vi.fn(async () => {})
  const provider = { id: 'offline-only', maximumRequestCostUsd: 0.005, maximumResults: 20, search }
  return { search, reserve, authorize, provider, run: (queries = [query]) => executeDiscoveryQueries({ queries, provider, reserve, authorize, accountId: 'offline-account', sourceId: 'offline-source', now: () => at }) }
}
describe('rebuilt bounded public-search execution (all offline)', () => {
  it.each(['requestId', 'application', 'provider', 'accountId', 'sourceId', 'requestFingerprint', 'maxHttpRequests', 'maximumCostUsd', 'reservationId', 'reservedUsd', 'expiresAt'] as const)('denies mismatched/invalid reservation %s before provider access', async field => {
    const f = fixture()
    f.reserve.mockImplementation(async request => ({ ...request, reservationId: 'reservation', reservedUsd: request.maximumCostUsd, expiresAt: '2026-10-08T20:00:00Z',
      [field]: field === 'reservationId' ? '' : field === 'reservedUsd' ? 0.004 : field === 'expiresAt' ? at.toISOString() : field === 'maxHttpRequests' ? 2 : field === 'maximumCostUsd' ? 1 : 'wrong',
    }) as DiscoverySearchReservation)
    const result = await f.run()
    expect(result).toMatchObject({ completedQueryCount: 0, failedQueryCount: 1, hits: [], executions: [{ outcome: 'failed', errorCode: 'DISCOVERY_BUDGET_RESERVATION_INVALID', resultCount: 0 }] })
    expect(f.search).not.toHaveBeenCalled(); expect(f.reserve).toHaveBeenCalledTimes(1)
  })
  it('binds immutable request content, result limit, account and exact request fingerprint before one call', async () => {
    const f = fixture()
    f.reserve.mockImplementation(async request => {
      expect(Object.isFrozen(request)).toBe(true)
      expect(request).toMatchObject({ application: 'todayaction', accountId: 'offline-account', sourceId: 'offline-source', provider: 'offline-only', maxHttpRequests: 1, maximumCostUsd: 0.005, requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) })
      return { ...request, reservationId: 'bound', reservedUsd: 0.005, expiresAt: '2026-10-08T20:00:00Z' }
    })
    f.search.mockImplementation(async request => {
      expect(Object.isFrozen(request)).toBe(true); expect(Object.isFrozen(request.query)).toBe(true)
      expect(request.maxResults).toBe(20)
      expect(request.requestId).toBe(f.reserve.mock.calls[0][0].requestId)
      return { providerRequestId: 'actual-empty-response', results: [] }
    })
    expect(await f.run()).toMatchObject({ completedQueryCount: 1, failedQueryCount: 0, executions: [{ outcome: 'empty', resultCount: 0, providerRequestId: 'actual-empty-response', responseSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }] })
    expect(f.search).toHaveBeenCalledTimes(1); expect(f.authorize).toHaveBeenCalledTimes(2)
  })
  it('retains partial query outcomes without inventing empty success or retrying', async () => {
    const f = fixture()
    f.search.mockRejectedValueOnce(new KnownDiscoverySearchFailure('DISCOVERY_SEARCH_RATE_LIMITED', 'Definite synthetic rate-limit response')).mockResolvedValueOnce({ providerRequestId: 'found', results: [{ url: 'https://example.test/1', title: 'Found' }] }).mockResolvedValueOnce({ providerRequestId: 'empty', results: [] })
    const result = await f.run([query, { ...query, query: 'Second' }, { ...query, query: 'Third' }])
    expect(result).toMatchObject({ completedQueryCount: 2, failedQueryCount: 1, hits: [{ url: 'https://example.test/1', title: 'Found' }] })
    expect(result.executions.map(item => item.outcome)).toEqual(['failed', 'success', 'empty'])
    expect(result.executions[0].providerRequestId).toBeUndefined(); expect(result.executions[0].responseSha256).toBeUndefined()
    expect(f.reserve).toHaveBeenCalledTimes(3); expect(f.search).toHaveBeenCalledTimes(3)
  })
  it.each(['AUTH_FORBIDDEN', 'AUTOMATION_AUTH_REQUIRED', 'DISCOVERY_SCOPE_CHANGED'])('stops after reservation when authority changes: %s', async code => {
    const f = fixture(); f.authorize.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => { throw new WorkspaceSourceError(code, 'Synthetic authority change') })
    await expect(f.run([query, query])).rejects.toMatchObject({ code })
    expect(f.search).not.toHaveBeenCalled(); expect(f.reserve).toHaveBeenCalledTimes(1)
  })
  it.each([undefined, '', 0, NaN, -1])('rejects missing provider identity or invalid ceiling: %s', async value => {
    const f = fixture(); if (typeof value === 'string' || value === undefined) f.provider.id = value as string; else f.provider.maximumRequestCostUsd = value
    await expect(f.run()).rejects.toMatchObject({ code: 'DISCOVERY_SEARCH_PROVIDER_INVALID' })
    expect(f.reserve).not.toHaveBeenCalled(); expect(f.search).not.toHaveBeenCalled()
  })
  it('rejects result overflow and missing response ID without accepting unverified hits', async () => {
    const f = fixture(); f.search.mockResolvedValueOnce({ providerRequestId: 'too-many', results: Array.from({ length: 21 }, (_, i) => ({ url: `https://example.test/${i}`, title: 'Synthetic' })) }).mockResolvedValueOnce({ providerRequestId: '', results: [] })
    const first = await f.run([query, query])
    expect(first).toMatchObject({ completedQueryCount: 0, failedQueryCount: 1, uncertain: true, hits: [] })
    expect(f.search).toHaveBeenCalledTimes(1)
    const second = await f.run([query, query])
    expect(second).toMatchObject({ completedQueryCount: 0, failedQueryCount: 1, uncertain: true, hits: [] })
    expect(f.search).toHaveBeenCalledTimes(2)
  })
  it('cannot attach a closed website filter to a general-web query', async () => {
    const f = fixture()
    await expect(f.run([{ ...query, domains: ['example.com'] } as typeof query])).rejects.toThrow()
    expect(f.reserve).not.toHaveBeenCalled(); expect(f.search).not.toHaveBeenCalled()
  })
})
