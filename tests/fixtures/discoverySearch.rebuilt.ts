import { executeDiscoveryQueries, type DiscoverySearchHit, type DiscoverySearchProvider, type ReserveDiscoverySearch } from '../../gateway/discoverySearchExecution.js'

/** Offline provider accounting fixture. It records one result for each actual
 * adapter invocation; model text alone never creates execution evidence. */
export function offlineSearchFixture(results: DiscoverySearchHit[] = []) {
  const queries: Parameters<DiscoverySearchProvider['search']>[0][] = []
  const reservations: Parameters<ReserveDiscoverySearch>[0][] = []
  const searchProvider: DiscoverySearchProvider = { id: 'synthetic-offline-search', maximumRequestCostUsd: 0.005,
    maximumResults: 20, async search(request) {
      queries.push(structuredClone(request))
      return { providerRequestId: `synthetic-response-${queries.length}`, results: structuredClone(results) }
    } }
  const reserveSearch: ReserveDiscoverySearch = async request => {
    reservations.push(structuredClone(request))
    return { ...request, reservationId: `synthetic-reservation:${request.requestId}`, reservedUsd: request.maximumCostUsd, expiresAt: '2099-01-01T00:00:00Z' }
  }
  return { searchProvider, reserveSearch, queries, reservations }
}

export async function emptySearchExecution(sourceId: string, completedAt: string) {
  const fixture = offlineSearchFixture()
  return (await executeDiscoveryQueries({ queries: [{ query: 'Explicit synthetic product search', coverage: 'general_web' }],
    provider: fixture.searchProvider, reserve: fixture.reserveSearch, accountId: 'synthetic-account', sourceId, now: () => new Date(completedAt) })).executions
}
