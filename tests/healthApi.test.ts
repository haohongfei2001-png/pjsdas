import { describe, expect, it } from 'vitest'
import health, { PUBLIC_HEALTH_CAPABILITIES } from '../api/health.js'

const RELEASE_SHA = '1234567890abcdef1234567890abcdef12345678'

describe('public production health contract', () => {
  it('describes the authenticated v1.9 trusted-ingestion gateway without exposing demo data or secrets', async () => {
    const response = health.fetch(
      new Request('https://standby.example/api/health'),
      { PJSDAS_RELEASE_COMMIT_SHA: RELEASE_SHA },
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('access-control-allow-origin')).toBe('*')

    const body = await response.json() as Record<string, any>
    expect(body).toMatchObject({
      service: 'pjsdas-authenticated-mcp',
      version: '1.9.0-alpha.1',
      mode: 'google-drive-trusted-ingestion',
      auth: 'supabase-oauth-2.1',
      resource: 'https://standby.example/api/mcp',
      release: { commitSha: RELEASE_SHA },
      capabilities: PUBLIC_HEALTH_CAPABILITIES,
      status: 'ok',
    })
    expect(body.capabilities.jobPostingIdentityFreshness).toBe('v1.4-round-3')
    expect(body.capabilities.richOpportunityFacts).toBe('v1.5-round-1')
    expect(body.capabilities.componentAssessment).toBe('v1.5-round-2')
    expect(body.capabilities.opportunityAssessmentRead).toBe(true)
    expect(body.capabilities.applicationPortfolioDecision).toBe('v1.6-round-1')
    expect(body.capabilities.applicationPortfolioRead).toBe(true)
    expect(body.capabilities.prepGraph).toBe('v1.6-round-2')
    expect(body.capabilities.prepGraphRead).toBe(true)
    expect(body.capabilities.prepGraphTodayProjection).toBe(true)
    expect(body.capabilities.continuousDiscovery).toBe('v1.7')
    expect(body.capabilities.discoveryRunLedger).toBe(true)
    expect(body.capabilities.incrementalDiscoveryContext).toBe(true)
    expect(body.capabilities.discoveryAutomationPlan).toBe('v1')
    expect(body.capabilities.backgroundDiscoveryAutomation).toBe('v1')
    expect(body.capabilities.discoveryAiGateway).toBe('vercel-ai-gateway')
    expect(body.capabilities.discoveryWorkerVaultAuth).toBe(true)
    expect(body.capabilities.postingRefreshQueue).toBe(true)
    expect(body.capabilities.postingRefreshReview).toBe('v1.7-round-2')
    expect(body.capabilities.zeroResultDiscoveryRun).toBe(true)
    expect(body.capabilities.explicitDiscoveryRunContext).toBe(true)
    expect(body.capabilities.stableAccountSession).toBe('v1.8.1')
    expect(body.capabilities.browserDriveTokenRestoration).toBe(true)
    expect(body.capabilities.autonomousIngestion).toBe('v1.9')
    expect(body.capabilities.ingestionReconciliationLedger).toBe(true)
    expect(body.capabilities.coverageStatusRead).toBe(true)
    expect(body.capabilities.trustedMonitorIngestion).toBe(true)
    expect(body.capabilities.trustedGmailIngestion).toBe(true)
    expect(body.capabilities.backgroundGmailAutomation).toBe('v1')
    expect(body.capabilities.gmailReadOnlyIncrementalSync).toBe(true)
    expect(body.capabilities.automationVaultScheduler).toBe(true)
    expect(body.capabilities.optimisticDriveWriteGuard).toBe(true)
    expect(body.capabilities.deploymentPortability).toBe(true)
    expect(body.capabilities.releaseIdentityBinding).toBe(true)
    expect(body.capabilities.delegatedCredentialIsolation).toBe(true)
    expect(body.capabilities.trustedIngestionGrantModel).toBe('v1')
    expect(body.capabilities.transactionalWorkspaceFoundation).toBe('v1')
    expect(body.capabilities.mutationCommandLedger).toBe(true)
    expect(JSON.stringify(body)).not.toContain('synthetic-demo-only')
    expect(JSON.stringify(body)).not.toContain('AI_GATEWAY_API_KEY')
    expect(body).not.toHaveProperty('secretsConfigured')
  })
})
