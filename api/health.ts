import {
  AUTHENTICATED_GATEWAY_VERSION,
  AUTHENTICATED_MCP_RESOURCE,
} from '../gateway/authenticatedRemoteHttp.js'

export const PUBLIC_HEALTH_CAPABILITIES = {
  discoveryContext: true,
  discoveryQualityGate: 'v1.4-round-3',
  reviewOnlyProposals: true,
  discoveredOpportunityProposals: true,
  discoveryInbox: 'v1.4-round-2',
  jobPostingIdentityFreshness: 'v1.4-round-3',
  richOpportunityFacts: 'v1.5-round-1',
  componentAssessment: 'v1.5-round-2',
  opportunityAssessmentRead: true,
  applicationPortfolioDecision: 'v1.6-round-1',
  applicationPortfolioRead: true,
  prepGraph: 'v1.6-round-2',
  prepGraphRead: true,
  prepGraphTodayProjection: true,
} as const

export default {
  fetch() {
    return new Response(JSON.stringify({
      service: 'pjsdas-authenticated-mcp',
      version: AUTHENTICATED_GATEWAY_VERSION,
      mode: 'google-drive-readonly',
      auth: 'supabase-oauth-2.1',
      resource: AUTHENTICATED_MCP_RESOURCE,
      capabilities: PUBLIC_HEALTH_CAPABILITIES,
      status: 'ok',
    }), {
      status: 200,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
      },
    })
  },
}
