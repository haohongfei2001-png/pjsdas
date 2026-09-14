import { backendUrl } from '../gateway/backendOrigin.js'
import {
  AUTHENTICATED_GATEWAY_VERSION,
} from '../gateway/authenticatedRemoteHttp.js'
import {
  AUTHENTICATED_MCP_RELEASE_REQUIRED_TOOLS,
  AUTHENTICATED_MCP_TOOL_SURFACE_VERSION,
} from '../gateway/mcpToolSurface.js'
import { backendReleaseCommit, type ReleaseIdentityEnvironment } from '../gateway/releaseIdentity.js'

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
  continuousDiscovery: 'v1.7',
  discoveryRunLedger: true,
  incrementalDiscoveryContext: true,
  postingRefreshQueue: true,
  postingRefreshReview: 'v1.7-round-2',
  zeroResultDiscoveryRun: true,
  explicitDiscoveryRunContext: true,
  stableAccountSession: 'v1.8.1',
  browserDriveTokenRestoration: true,
  autonomousIngestion: 'v1.9',
  ingestionReconciliationLedger: true,
  coverageStatusRead: true,
  trustedMonitorIngestion: true,
  trustedGmailIngestion: true,
  optimisticDriveWriteGuard: true,
  dynamicSourceRegistry: true,
  coverageFreshnessSla: true,
  workspaceIntegrityAudit: true,
  ingestionDryRunReplay: true,
  sourceHealthHistory: true,
  productionSelfTest: true,
  deploymentPortability: true,
  releaseIdentityBinding: true,
  authenticatedMcpToolSurface: true,
} as const

export default {
  fetch(request?: Request, releaseEnvironment?: ReleaseIdentityEnvironment) {
    return new Response(JSON.stringify({
      service: 'pjsdas-authenticated-mcp',
      version: AUTHENTICATED_GATEWAY_VERSION,
      mode: 'google-drive-trusted-ingestion',
      auth: 'supabase-oauth-2.1',
      resource: backendUrl('/api/mcp', request),
      release: {
        commitSha: backendReleaseCommit(releaseEnvironment) ?? null,
      },
      authenticatedMcp: {
        toolSurfaceVersion: AUTHENTICATED_MCP_TOOL_SURFACE_VERSION,
        releaseRequiredTools: AUTHENTICATED_MCP_RELEASE_REQUIRED_TOOLS,
      },
      capabilities: PUBLIC_HEALTH_CAPABILITIES,
      status: 'ok',
    }), {
      status: 200,
      headers: {
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
      },
    })
  },
}
