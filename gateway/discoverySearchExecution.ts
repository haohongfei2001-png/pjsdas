import { z } from 'zod/v4'
import { discoverySearchExecutionSchema, discoveryWebQuerySchema, type DiscoverySearchExecution } from '../src/discoverySearchEvidence.js'
import type { DiscoveryWebQuery } from '../src/discoveryQueryPlan.js'
import { hashMutationPayload } from './mutationKernel.js'
import { WorkspaceSourceError } from './workspaceSource.js'

const resultSchema = z.object({ url: z.string().url().max(2000), title: z.string().min(1).max(500),
  snippet: z.string().max(2000).optional() }).strict()
const responseSchema = z.object({ providerRequestId: z.string().min(1).max(240), results: z.array(resultSchema).max(25) }).strict()
export type DiscoverySearchHit = z.infer<typeof resultSchema>
export interface DiscoverySearchRequest {
  requestId: string; query: DiscoveryWebQuery; maxResults: number
}
export interface DiscoverySearchReservationRequest {
  requestId: string; application: 'todayaction'; provider: string; accountId: string; sourceId: string
  requestFingerprint: string; maxHttpRequests: 1; maximumCostUsd: number
}
export interface DiscoverySearchReservation extends DiscoverySearchReservationRequest {
  reservationId: string; reservedUsd: number; expiresAt: string
}
/** Server-owned adapters. The provider makes one bounded request with no hidden
 * application retry/fallback; its cost ceiling must include all billable work.
 * The budget adapter reserves atomically against a separately approved budget. */
export interface DiscoverySearchProvider {
  id: string
  maximumRequestCostUsd: number
  maximumResults?: number
  search(request: Readonly<DiscoverySearchRequest>): Promise<z.infer<typeof responseSchema>>
}
export type ReserveDiscoverySearch = (request: Readonly<DiscoverySearchReservationRequest>) => Promise<DiscoverySearchReservation>

export async function executeDiscoveryQueries(input: {
  queries: DiscoveryWebQuery[]; provider?: DiscoverySearchProvider; reserve?: ReserveDiscoverySearch
  accountId?: string; sourceId: string; now?: () => Date; authorize?: () => Promise<void>
}) {
  if (!input.provider) throw new WorkspaceSourceError('DISCOVERY_SEARCH_PROVIDER_REQUIRED', 'A real public-web search provider must be configured before Discovery can claim execution.', false)
  if (!input.reserve || !input.accountId) throw new WorkspaceSourceError('DISCOVERY_BUDGET_APPROVAL_REQUIRED', 'Public-web search requires a separately approved and atomically reserved TodayAction budget.', false)
  const provider = input.provider, now = input.now ?? (() => new Date())
  if (!provider.id || !Number.isFinite(provider.maximumRequestCostUsd) || provider.maximumRequestCostUsd <= 0) {
    throw new WorkspaceSourceError('DISCOVERY_SEARCH_PROVIDER_INVALID', 'The search provider has no defensible per-request cost ceiling.', false)
  }
  const maximumResults = provider.maximumResults ?? 25
  if (!Number.isInteger(maximumResults) || maximumResults < 1 || maximumResults > 25) throw new WorkspaceSourceError('DISCOVERY_SEARCH_PROVIDER_INVALID', 'The search provider result bound is invalid.', false)
  const queries = z.array(discoveryWebQuerySchema).min(1).max(48).parse(input.queries)
  const executions: DiscoverySearchExecution[] = [], hits: DiscoverySearchHit[] = []
  for (const query of queries) {
    if (query.domains) Object.freeze(query.domains)
    Object.freeze(query)
    await input.authorize?.()
    const startedAt = now().toISOString(), requestId = crypto.randomUUID()
    const request = Object.freeze({ requestId, query, maxResults: maximumResults })
    const budgetRequest = Object.freeze({ requestId, application: 'todayaction' as const, provider: provider.id,
      accountId: input.accountId, sourceId: input.sourceId, requestFingerprint: await hashMutationPayload('discovery_search', request),
      maxHttpRequests: 1 as const, maximumCostUsd: provider.maximumRequestCostUsd })
    let execution: DiscoverySearchExecution
    try {
      const reservation = await input.reserve(budgetRequest)
      if (!reservation || Object.entries(budgetRequest).some(([key, value]) => reservation[key as keyof DiscoverySearchReservationRequest] !== value)
        || !reservation.reservationId || !Number.isFinite(reservation.reservedUsd) || reservation.reservedUsd < budgetRequest.maximumCostUsd
        || !Number.isFinite(Date.parse(reservation.expiresAt)) || Date.parse(reservation.expiresAt) <= now().getTime()) {
        throw new WorkspaceSourceError('DISCOVERY_BUDGET_RESERVATION_INVALID', 'Search requires a current reservation for this exact account, query and maximum charge.', false)
      }
      await input.authorize?.()
      if (Date.parse(reservation.expiresAt) <= now().getTime()) throw new WorkspaceSourceError('DISCOVERY_BUDGET_RESERVATION_INVALID', 'The search reservation expired before execution.', false)
      const response = responseSchema.parse(await provider.search(request))
      if (response.results.length > maximumResults) throw new WorkspaceSourceError('DISCOVERY_SEARCH_INVALID_RESPONSE', 'Provider results exceed the recorded request bound.', false)
      hits.push(...response.results)
      execution = { version: 1, provider: provider.id, requestId, query, requestedMaxResults: maximumResults, startedAt, completedAt: now().toISOString(),
        outcome: response.results.length ? 'success' : 'empty', providerRequestId: response.providerRequestId,
        responseSha256: await hashMutationPayload('discovery_search_response', response), resultCount: response.results.length }
    } catch (caught) {
      // Permission loss aborts the run; partial public-source errors remain
      // visible instead of discarding already retrieved evidence.
      if (caught instanceof WorkspaceSourceError && ['AUTH_FORBIDDEN', 'AUTOMATION_AUTH_REQUIRED', 'DISCOVERY_SCOPE_CHANGED'].includes(caught.code)) throw caught
      execution = { version: 1, provider: provider.id, requestId, query, requestedMaxResults: maximumResults, startedAt, completedAt: now().toISOString(),
        outcome: 'failed', resultCount: 0, errorCode: caught instanceof WorkspaceSourceError ? caught.code : 'DISCOVERY_SEARCH_FAILED' }
    }
    executions.push(discoverySearchExecutionSchema.parse(execution))
  }
  return { executions, hits: [...new Map(hits.map(hit => [hit.url, hit])).values()],
    completedQueryCount: executions.filter(item => item.outcome !== 'failed').length,
    failedQueryCount: executions.filter(item => item.outcome === 'failed').length }
}
