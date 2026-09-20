import { describe, expect, it, vi } from 'vitest'
import { runProductionSelfTest } from '../gateway/productionSelfTest.js'

const BASE_URL = 'https://example.test'
const METADATA_URL = `${BASE_URL}/.well-known/oauth-protected-resource`
const RELEASE_SHA = '1234567890abcdef1234567890abcdef12345678'
const DRIVE_REQUIRED_TOOLS = ['get_coverage_status', 'get_workspace_integrity', 'add_opportunities', 'ingest_discovery_run', 'ingest_gmail_run']
const TRANSACTIONAL_REQUIRED_TOOLS = ['get_coverage_status', 'get_workspace_integrity', 'add_opportunities', 'apply_user_command', 'semantic_intake', 'resolve_semantic_decision', 'undo_semantic_command', 'ingest_discovery_run', 'ingest_gmail_run']

function health() {
  return {
    service: 'pjsdas-authenticated-mcp',
    version: '1.9.0-alpha.1',
    mode: 'google-drive-trusted-ingestion',
    workspaceAuthority: 'google-drive',
    topology: {
      canonicalWebOrigin: null,
      canonicalApiOrigin: null,
      legacyWebOrigins: ['https://haohongfei2001-png.github.io'],
      audienceMode: 'legacy',
    },
    resource: `${BASE_URL}/api/mcp`,
    release: {
      commitSha: RELEASE_SHA,
      productVersion: '1.1.0-rc.1',
      releaseChannel: 'prerelease',
      mcpContractHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      migrationSetHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      schemaCompatibility: {
        snapshotSchema: 'pjsdas-local-snapshot',
        snapshotVersion: 3,
      },
    },
    authenticatedMcp: {
      toolSurfaceVersion: 'v4',
      releaseRequiredTools: DRIVE_REQUIRED_TOOLS,
    },
    status: 'ok',
    capabilities: {
      stableAccountSession: 'v1.8.1',
      autonomousIngestion: 'v1.9',
      discoveryAutomationPlan: 'v1',
      backgroundDiscoveryAutomation: 'v1',
      discoveryAiGateway: 'vercel-ai-gateway',
      discoveryWorkerVaultAuth: true,
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
      opportunityParticipationState: 'v1',
      gmailCompleteConsumption: 'v1',
      discoverySourceVerification: 'v1',
      discoveryFactAssessmentSeparation: true,
      canonicalOriginPolicy: 'v1',
      controlledAudience: 'v1',
      connectedOriginMigration: 'v1',
      releaseCandidateManifest: 'v1',
    },
  }
}

function unauthorizedMcp() {
  return Response.json({ code: 'AUTH_REQUIRED' }, {
    status: 401,
    headers: { 'WWW-Authenticate': `Bearer resource_metadata="${METADATA_URL}"` },
  })
}

function publicFetch(payload = health()) {
  return vi.fn(async (input: RequestInfo | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.endsWith('/api/health')) return Response.json(payload)
    if (url.endsWith('/api/google-access-token')) return Response.json({ code: 'AUTH_REQUIRED' }, { status: 401 })
    if (url.endsWith('/api/automation-settings')) return Response.json({ code: 'AUTH_REQUIRED' }, { status: 401 })
    if (url.endsWith('/api/automation-gmail')) return Response.json({ code: 'AUTOMATION_AUTH_REQUIRED' }, { status: 401 })
    if (url.endsWith('/api/automation-discovery')) return Response.json({ code: 'AUTOMATION_AUTH_REQUIRED' }, { status: 401 })
    if (url.endsWith('/api/mcp')) return unauthorizedMcp()
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
}

describe('production self-test', () => {
  it('passes the release contract without a test account when health proves the deployed MCP and automation surfaces', async () => {
    const result = await runProductionSelfTest({ baseUrl: BASE_URL, fetchImpl: publicFetch() })
    expect(result.ok).toBe(true)
    expect(result.checks.find((item) => item.name === 'health.resource-origin')?.status).toBe('pass')
    expect(result.checks.find((item) => item.name === 'health.workspace-authority')?.status).toBe('pass')
    expect(result.checks.find((item) => item.name === 'health.capability.discoveryAutomationPlan')?.status).toBe('pass')
    expect(result.checks.find((item) => item.name === 'health.capability.backgroundDiscoveryAutomation')?.status).toBe('pass')
    expect(result.checks.find((item) => item.name === 'health.authenticated-mcp-tool-surface-version')?.status).toBe('pass')
    for (const tool of DRIVE_REQUIRED_TOOLS) {
      expect(result.checks.find((item) => item.name === `health.authenticated-mcp-tool.${tool}`)?.status).toBe('pass')
    }
    expect(result.checks.find((item) => item.name === 'gmail-automation.settings-unauthorized')?.status).toBe('pass')
    expect(result.checks.find((item) => item.name === 'gmail-automation.worker-unauthorized')?.status).toBe('pass')
    expect(result.checks.find((item) => item.name === 'discovery-automation.worker-unauthorized')?.status).toBe('pass')
    expect(result.checks.find((item) => item.name === 'mcp.metadata-origin')?.status).toBe('pass')
    expect(result.checks.find((item) => item.name === 'mcp.authenticated.tools')?.status).toBe('skipped')
  })

  it('validates configured canonical topology and audience mode independently of the fallback host', async () => {
    const canonicalApi = 'https://api.pjsdas.example'
    const canonicalWeb = 'https://pjsdas.example'
    const payload = health() as any
    payload.topology = {
      canonicalWebOrigin: canonicalWeb,
      canonicalApiOrigin: canonicalApi,
      legacyWebOrigins: ['https://haohongfei2001-png.github.io'],
      audienceMode: 'allowlist',
    }
    payload.resource = `${canonicalApi}/api/mcp`

    const fetchImpl = vi.fn(async (input: RequestInfo | URL | Request) => {
      const request = input instanceof Request ? input : new Request(String(input))
      if (request.url.endsWith('/api/health')) return Response.json(payload)
      if (request.url.endsWith('/api/google-access-token')) return Response.json({ code: 'AUTH_REQUIRED' }, { status: 401 })
      if (request.url.endsWith('/api/automation-settings')) return Response.json({ code: 'AUTH_REQUIRED' }, { status: 401 })
      if (request.url.endsWith('/api/automation-gmail')) return Response.json({ code: 'AUTOMATION_AUTH_REQUIRED' }, { status: 401 })
      if (request.url.endsWith('/api/automation-discovery')) return Response.json({ code: 'AUTOMATION_AUTH_REQUIRED' }, { status: 401 })
      if (request.url.endsWith('/api/mcp')) return Response.json({ code: 'AUTH_REQUIRED' }, {
        status: 401,
        headers: { 'WWW-Authenticate': `Bearer resource_metadata="${canonicalApi}/.well-known/oauth-protected-resource"` },
      })
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    const result = await runProductionSelfTest({
      baseUrl: BASE_URL,
      expectedAudienceMode: 'allowlist',
      expectedCanonicalWebOrigin: canonicalWeb,
      expectedCanonicalApiOrigin: canonicalApi,
      fetchImpl,
    })
    expect(result.ok).toBe(true)
    expect(result.checks.find((item) => item.name === 'health.audience-mode')?.status).toBe('pass')
    expect(result.checks.find((item) => item.name === 'health.canonical-web-origin')?.status).toBe('pass')
    expect(result.checks.find((item) => item.name === 'health.canonical-api-origin')?.status).toBe('pass')
    expect(result.checks.find((item) => item.name === 'mcp.metadata-origin')?.status).toBe('pass')
  })

  it('matches deployed frontend artifact identity to the backend RC contract', async () => {
    const webUrl = 'https://web.example/pjsdas'
    const fetchImpl = vi.fn(async (input: RequestInfo | URL | Request) => {
      const request = input instanceof Request ? input : new Request(String(input))
      if (request.url === `${webUrl}/release-manifest.json`) {
        return Response.json({
          schema: 'pjsdas-release-manifest',
          version: 1,
          productVersion: '1.1.0-rc.1',
          releaseChannel: 'prerelease',
          commitSha: RELEASE_SHA,
          frontendArtifactDigest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          mcpContractHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          migrationSetHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          topology: { connectedAuthority: 'google-drive' },
        })
      }
      return publicFetch()(request)
    }) as unknown as typeof fetch

    const result = await runProductionSelfTest({
      baseUrl: BASE_URL,
      webUrl,
      expectedCommitSha: RELEASE_SHA,
      expectedProductVersion: '1.1.0-rc.1',
      expectedReleaseChannel: 'prerelease',
      expectedMcpContractHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      expectedMigrationSetHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      expectedSnapshotSchema: 'pjsdas-local-snapshot',
      expectedSnapshotVersion: 3,
      fetchImpl,
    })
    expect(result.ok).toBe(true)
    expect(result.checks.find((item) => item.name === 'health.release-product-version')?.status).toBe('pass')
    expect(result.checks.find((item) => item.name === 'frontend-manifest.artifact-digest')?.status).toBe('pass')
    expect(result.checks.find((item) => item.name === 'frontend-manifest.commit')?.status).toBe('pass')
    expect(result.checks.find((item) => item.name === 'frontend-manifest.mcp-contract')?.status).toBe('pass')
  })

  it('accepts transactional mode only when the caller explicitly expects it', async () => {
    const transactional = health() as any
    transactional.mode = 'transactional-connected'
    transactional.workspaceAuthority = 'transactional'
    transactional.authenticatedMcp.releaseRequiredTools = TRANSACTIONAL_REQUIRED_TOOLS
    const matching = await runProductionSelfTest({
      baseUrl: BASE_URL,
      expectedWorkspaceAuthority: 'transactional',
      fetchImpl: publicFetch(transactional),
    })
    expect(matching.ok).toBe(true)

    const mismatched = await runProductionSelfTest({
      baseUrl: BASE_URL,
      fetchImpl: publicFetch(transactional),
    })
    expect(mismatched.ok).toBe(false)
    expect(mismatched.checks.find((item) => item.name === 'health.workspace-authority')?.status).toBe('fail')
  })

  it('fails closed when the deployed health contract omits a required authenticated MCP tool', async () => {
    const bad = health() as any
    bad.authenticatedMcp.releaseRequiredTools = DRIVE_REQUIRED_TOOLS.filter((tool) => tool !== 'ingest_gmail_run')
    const result = await runProductionSelfTest({ baseUrl: BASE_URL, fetchImpl: publicFetch(bad) })
    expect(result.ok).toBe(false)
    expect(result.checks.find((item) => item.name === 'health.authenticated-mcp-tool.ingest_gmail_run')?.status).toBe('fail')
  })

  it('fails closed when the discovery automation capability is missing', async () => {
    const bad = health() as any
    delete bad.capabilities.backgroundDiscoveryAutomation
    const result = await runProductionSelfTest({ baseUrl: BASE_URL, fetchImpl: publicFetch(bad) })
    expect(result.ok).toBe(false)
    expect(result.checks.find((item) => item.name === 'health.capability.backgroundDiscoveryAutomation')?.status).toBe('fail')
  })

  it('keeps optional strict live-auth verification available when explicitly requested', async () => {
    const result = await runProductionSelfTest({
      baseUrl: BASE_URL,
      requireAuthenticatedTools: true,
      fetchImpl: publicFetch(),
    })
    expect(result.ok).toBe(false)
    expect(result.checks.find((item) => item.name === 'mcp.authenticated.tools')).toMatchObject({ status: 'fail' })
  })

  it('verifies the live authenticated tool surface when an optional test token is supplied', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL | Request) => {
      const request = input instanceof Request ? input : new Request(String(input))
      if (request.url.endsWith('/api/health')) return Response.json(health())
      if (request.url.endsWith('/api/google-access-token')) return Response.json({ code: 'AUTH_REQUIRED' }, { status: 401 })
      if (request.url.endsWith('/api/automation-settings')) return Response.json({ code: 'AUTH_REQUIRED' }, { status: 401 })
      if (request.url.endsWith('/api/automation-gmail')) return Response.json({ code: 'AUTOMATION_AUTH_REQUIRED' }, { status: 401 })
      if (request.url.endsWith('/api/automation-discovery')) return Response.json({ code: 'AUTOMATION_AUTH_REQUIRED' }, { status: 401 })
      if (request.url.endsWith('/api/mcp') && !request.headers.get('authorization')) return unauthorizedMcp()
      if (request.url.endsWith('/api/mcp')) return new Response(`data: ${JSON.stringify({ tools: DRIVE_REQUIRED_TOOLS.map((name) => ({ name })) })}`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch
    const result = await runProductionSelfTest({ baseUrl: BASE_URL, accessToken: 'token', fetchImpl })
    expect(result.ok).toBe(true)
    for (const tool of DRIVE_REQUIRED_TOOLS) {
      expect(result.checks.find((item) => item.name === `mcp.tool.${tool}`)?.status).toBe('pass')
    }
  })

  it('fails closed when production health advertises the wrong version or misses a hardening capability', async () => {
    const bad = health() as any
    bad.version = '1.8.0'
    delete bad.capabilities.workspaceIntegrityAudit
    const result = await runProductionSelfTest({ baseUrl: BASE_URL, fetchImpl: publicFetch(bad) })
    expect(result.ok).toBe(false)
    expect(result.checks.find((item) => item.name === 'health.version')?.status).toBe('fail')
    expect(result.checks.find((item) => item.name === 'health.capability.workspaceIntegrityAudit')?.status).toBe('fail')
  })

  it('fails closed when a Gmail automation endpoint is missing from production', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.endsWith('/api/health')) return Response.json(health())
      if (url.endsWith('/api/google-access-token')) return Response.json({ code: 'AUTH_REQUIRED' }, { status: 401 })
      if (url.endsWith('/api/automation-settings')) return new Response('not found', { status: 404 })
      if (url.endsWith('/api/automation-gmail')) return Response.json({ code: 'AUTOMATION_AUTH_REQUIRED' }, { status: 401 })
      if (url.endsWith('/api/automation-discovery')) return Response.json({ code: 'AUTOMATION_AUTH_REQUIRED' }, { status: 401 })
      if (url.endsWith('/api/mcp')) return unauthorizedMcp()
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch
    const result = await runProductionSelfTest({ baseUrl: BASE_URL, fetchImpl })
    expect(result.ok).toBe(false)
    expect(result.checks.find((item) => item.name === 'gmail-automation.settings-unauthorized')?.status).toBe('fail')
  })

  it('fails closed when the discovery automation endpoint is missing from production', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.endsWith('/api/health')) return Response.json(health())
      if (url.endsWith('/api/google-access-token')) return Response.json({ code: 'AUTH_REQUIRED' }, { status: 401 })
      if (url.endsWith('/api/automation-settings')) return Response.json({ code: 'AUTH_REQUIRED' }, { status: 401 })
      if (url.endsWith('/api/automation-gmail')) return Response.json({ code: 'AUTOMATION_AUTH_REQUIRED' }, { status: 401 })
      if (url.endsWith('/api/automation-discovery')) return new Response('not found', { status: 404 })
      if (url.endsWith('/api/mcp')) return unauthorizedMcp()
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch
    const result = await runProductionSelfTest({ baseUrl: BASE_URL, fetchImpl })
    expect(result.ok).toBe(false)
    expect(result.checks.find((item) => item.name === 'discovery-automation.worker-unauthorized')?.status).toBe('fail')
  })

  it('fails closed when the backend health contract belongs to a different git commit', async () => {
    const matching = await runProductionSelfTest({
      baseUrl: BASE_URL,
      expectedCommitSha: RELEASE_SHA,
      fetchImpl: publicFetch(),
    })
    expect(matching.ok).toBe(true)
    expect(matching.checks.find((item) => item.name === 'health.release-commit')?.status).toBe('pass')

    const stale = await runProductionSelfTest({
      baseUrl: BASE_URL,
      expectedCommitSha: 'ffffffffffffffffffffffffffffffffffffffff',
      fetchImpl: publicFetch(),
    })
    expect(stale.ok).toBe(false)
    expect(stale.checks.find((item) => item.name === 'health.release-commit')?.status).toBe('fail')
  })
})
