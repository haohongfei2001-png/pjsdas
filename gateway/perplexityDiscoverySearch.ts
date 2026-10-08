import { z } from 'zod/v4'
import { discoveryWebQuerySchema } from '../src/discoverySearchEvidence.js'
import { boundedResponseText } from './discoveryPublicSource.js'
import type { DiscoverySearchProvider } from './discoverySearchExecution.js'
import { WorkspaceSourceError } from './workspaceSource.js'

const endpoint = 'https://api.perplexity.ai/search'
const responseSchema = z.object({ id: z.string().trim().min(1).max(240), results: z.array(z.object({
  url: z.string().url().max(2000), title: z.string().trim().min(1).max(10000), snippet: z.string().max(100000).optional(),
})).max(20) })

/** Explicit server-side construction only. Nothing reads an environment key or
 * enables this provider automatically. The caller must use the existing atomic
 * spend-reservation/authority boundary before search(). No SDK retry/fallback.
 * Official pricing checked 2026-10-07: successful POST /search is $0.005 (web),
 * or $0.001 (fast), including a successful empty response; no token surcharge.
 * https://docs.perplexity.ai/docs/getting-started/pricing
 */
export function createPerplexityDiscoverySearchProvider(options: { apiKey: string; searchType?: 'web' | 'fast'; fetchImpl?: typeof fetch }): DiscoverySearchProvider {
  const apiKey = options.apiKey.trim()
  const parsedType = z.enum(['web', 'fast']).safeParse(options.searchType ?? 'web')
  if (!parsedType.success) throw new WorkspaceSourceError('DISCOVERY_SEARCH_PROVIDER_INVALID', 'The configured search type has no approved price bound.', false)
  const searchType = parsedType.data
  if (!apiKey || /[\r\n]/.test(apiKey)) throw new WorkspaceSourceError('DISCOVERY_SEARCH_CREDENTIAL_REQUIRED', 'The approved search credential is unavailable.', false)
  const fetchImpl = options.fetchImpl ?? fetch
  return { id: `perplexity-search-${searchType}`, maximumRequestCostUsd: searchType === 'web' ? 0.005 : 0.001, maximumResults: 20,
    async search(request) {
      const query = discoveryWebQuerySchema.parse(request.query)
      if (!Number.isInteger(request.maxResults) || request.maxResults < 1 || request.maxResults > 20) {
        throw new WorkspaceSourceError('DISCOVERY_SEARCH_INVALID_REQUEST', 'Public web search supports at most 20 results per request.', false)
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15_000)
      try {
        const response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ query: query.query, search_type: searchType, max_results: request.maxResults,
            max_tokens: 4096, max_tokens_per_page: 512,
            ...(query.domains ? { search_domain_filter: query.domains } : {}) }) })
        if (!response.ok) {
          const code = response.status === 401 || response.status === 403 ? 'DISCOVERY_SEARCH_UNAUTHORIZED'
            : response.status === 429 ? 'DISCOVERY_SEARCH_RATE_LIMITED' : 'DISCOVERY_SEARCH_UNAVAILABLE'
          throw new WorkspaceSourceError(code, `Public-web search did not complete (HTTP ${response.status}); no automatic retry was made.`, false)
        }
        if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
          throw new WorkspaceSourceError('DISCOVERY_SEARCH_INVALID_RESPONSE', 'Search returned an unsupported response format.', false)
        }
        const parsed = responseSchema.safeParse(JSON.parse(await boundedResponseText(response, controller.signal)))
        if (!parsed.success) throw new WorkspaceSourceError('DISCOVERY_SEARCH_INVALID_RESPONSE', 'Search returned invalid response evidence.', false)
        return { providerRequestId: parsed.data.id, results: parsed.data.results.map(item => ({
          url: item.url, title: item.title.slice(0, 500), ...(item.snippet === undefined ? {} : { snippet: item.snippet.slice(0, 2000) }),
        })) }
      } catch (caught) {
        if (caught instanceof WorkspaceSourceError && caught.code.startsWith('DISCOVERY_SEARCH_')) throw caught
        throw new WorkspaceSourceError(controller.signal.aborted ? 'DISCOVERY_SEARCH_TIMEOUT' : 'DISCOVERY_SEARCH_INVALID_RESPONSE',
          'Public-web search could not produce bounded response evidence; no automatic retry was made.', false)
      } finally { controller.abort(); clearTimeout(timer) }
    },
  }
}
