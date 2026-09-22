import { backendUrl } from '../gateway/backendOrigin.js'
import {
  AUTHENTICATED_GATEWAY_VERSION,
} from '../gateway/authenticatedRemoteHttp.js'
import {
  AUTHENTICATED_MCP_TOOL_SURFACE_VERSION,
  authenticatedMcpReleaseRequiredTools,
} from '../gateway/mcpToolSurface.js'
import { backendReleaseCommit, backendReleaseContract, type ReleaseIdentityEnvironment } from '../gateway/releaseIdentity.js'
import { publicProductionTopology } from '../gateway/productionTopology.js'

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
  discoveryAutomationPlan: 'v1',
  backgroundDiscoveryAutomation: 'v1',
  discoveryAiGateway: 'vercel-ai-gateway',
  discoveryWorkerVaultAuth: true,
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
  backgroundGmailAutomation: 'v1',
  gmailReadOnlyIncrementalSync: true,
  automationVaultScheduler: true,
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
  delegatedCredentialIsolation: true,
  trustedIngestionGrantModel: 'v1',
  transactionalWorkspaceFoundation: 'v1',
  mutationCommandLedger: true,
  explicitUserCommands: 'v1',
  semanticIntakeContract: 'v1',
  decisionRequests: 'v1',
  semanticCompensatingUndo: 'v1',
  semanticServerWritePolicy: 'v1',
  paiaOwnerIntake: 'v1',
  reminderIntent: 'v1',
  externalReminderCapabilityTruth: 'v1',
  crossSourceSemanticDedupe: 'v1',
  todayBriefReadModel: 'v1',
  todayAgendaReadModel: 'v1',
  opportunityDecisionReadModel: 'v1',
  opportunityConclusionDetail: 'v1',
  latestStartPlanning: 'v1',
  opportunityParticipationState: 'v1',
  gmailCompleteConsumption: 'v1',
  discoverySourceVerification: 'v1',
  discoveryFactAssessmentSeparation: true,
  canonicalOriginPolicy: 'v1',
  controlledAudience: 'v1',
  connectedOriginMigration: 'v1',
  releaseCandidateManifest: 'v1',
} as const

export function currentWorkspaceAuthority(environment: Record<string, string | undefined> = process.env) {
  return environment.PJSDAS_CONNECTED_AUTHORITY?.trim() === 'transactional'
    ? { authority: 'transactional' as const, mode: 'transactional-connected' as const }
    : { authority: 'google-drive' as const, mode: 'google-drive-trusted-ingestion' as const }
}

export default {
  fetch(request?: Request, releaseEnvironment?: ReleaseIdentityEnvironment) {
    const workspace = currentWorkspaceAuthority()
    const topology = publicProductionTopology()
    const releaseContract = backendReleaseContract()
    return new Response(JSON.stringify({
      service: 'pjsdas-authenticated-mcp',
      version: AUTHENTICATED_GATEWAY_VERSION,
      mode: workspace.mode,
      workspaceAuthority: workspace.authority,
      topology,
      auth: 'supabase-oauth-2.1',
      resource: backendUrl('/api/mcp', request),
      release: {
        commitSha: backendReleaseCommit(releaseEnvironment) ?? null,
        ...releaseContract,
      },
      authenticatedMcp: {
        toolSurfaceVersion: AUTHENTICATED_MCP_TOOL_SURFACE_VERSION,
        releaseRequiredTools: authenticatedMcpReleaseRequiredTools(workspace.authority),
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
