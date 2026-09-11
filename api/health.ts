import {
  AUTHENTICATED_GATEWAY_VERSION,
  AUTHENTICATED_MCP_RESOURCE,
} from '../gateway/authenticatedRemoteHttp.js'

export const PUBLIC_HEALTH_CAPABILITIES = {
  discoveryContext: true,
  discoveryQualityGate: 'v1.3-round-1',
  reviewOnlyProposals: true,
  discoveredOpportunityProposals: true,
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
