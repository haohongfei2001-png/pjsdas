import { AUTHENTICATED_GATEWAY_VERSION } from './authenticatedRemoteHttp.js'
import {
  AUTHENTICATED_MCP_TOOL_SURFACE_VERSION,
  authenticatedMcpReleaseRequiredTools,
} from './mcpToolSurface.js'

export interface ProductionSelfTestCheck {
  name: string
  status: 'pass' | 'fail' | 'skipped'
  detail: string
}

export interface ProductionSelfTestResult {
  ok: boolean
  baseUrl: string
  checks: ProductionSelfTestCheck[]
}

const REQUIRED_CAPABILITIES: Record<string, unknown> = {
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
  authoritativeBusinessCommands: 'cgr-01',
  durableCommandReceipts: 'cgr-01',
  commandReceiptRecovery: true,
  objectAwareCommandConflicts: true,
  dependencyAwareCommandUndo: 'cgr-01',
  accountScopedCommandClient: true,
  boundedSnapshotCompatibility: 'cgr-01',
  todayAuthoritativeReadFreshness: 'cgr-02',
  todayCrossClientRefreshTargetMs: 15_000,
  tellPjsdasExplicitUnderstanding: true,
  tellPjsdasAuthoritativeSaveState: 'cgr-02',
  todayRecentAuthoritativeChanges: true,
  canonicalCaptureRoute: '/today/capture',
}

function check(name: string, condition: boolean, detail: string): ProductionSelfTestCheck {
  return { name, status: condition ? 'pass' : 'fail', detail }
}

async function textOf(response: Response) {
  return response.text()
}

function mcpToolsRequest(baseUrl: string, token?: string) {
  const headers = new Headers({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2025-06-18',
  })
  if (token) headers.set('authorization', `Bearer ${token}`)
  return new Request(`${baseUrl}/api/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  })
}

export async function runProductionSelfTest(options: {
  baseUrl: string
  accessToken?: string
  expectedCommitSha?: string
  expectedWorkspaceAuthority?: 'google-drive' | 'transactional'
  expectedAudienceMode?: 'legacy' | 'allowlist'
  expectedCanonicalWebOrigin?: string
  expectedCanonicalApiOrigin?: string
  expectedProductVersion?: string
  expectedReleaseChannel?: 'prerelease' | 'stable'
  expectedMcpContractHash?: string
  expectedMigrationSetHash?: string
  expectedSnapshotSchema?: string
  expectedSnapshotVersion?: number
  webUrl?: string
  firstPartyTestOrigin?: string
  requireAuthenticatedTools?: boolean
  fetchImpl?: typeof fetch
}): Promise<ProductionSelfTestResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const baseUrl = options.baseUrl.replace(/\/$/, '')
  const expectedCommitSha = options.expectedCommitSha?.trim().toLowerCase()
  const expectedWorkspaceAuthority = options.expectedWorkspaceAuthority ?? 'google-drive'
  const expectedAudienceMode = options.expectedAudienceMode ?? 'legacy'
  const expectedCanonicalWebOrigin = options.expectedCanonicalWebOrigin?.replace(/\/$/, '')
  const expectedCanonicalApiOrigin = options.expectedCanonicalApiOrigin?.replace(/\/$/, '')
  const expectedProductVersion = options.expectedProductVersion?.trim()
  const expectedReleaseChannel = options.expectedReleaseChannel
  const expectedMcpContractHash = options.expectedMcpContractHash?.trim()
  const expectedMigrationSetHash = options.expectedMigrationSetHash?.trim()
  const expectedSnapshotSchema = options.expectedSnapshotSchema?.trim()
  const expectedSnapshotVersion = options.expectedSnapshotVersion
  const webUrl = options.webUrl?.replace(/\/$/, '')
  const firstPartyTestOrigin = options.firstPartyTestOrigin?.replace(/\/$/, '')
    ?? expectedCanonicalWebOrigin
    ?? 'https://haohongfei2001-png.github.io'
  const expectedResourceOrigin = expectedCanonicalApiOrigin ?? baseUrl
  const expectedMode = expectedWorkspaceAuthority === 'transactional'
    ? 'transactional-connected'
    : 'google-drive-trusted-ingestion'
  const expectedMcpTools = authenticatedMcpReleaseRequiredTools(expectedWorkspaceAuthority)
  const checks: ProductionSelfTestCheck[] = []

  try {
    const response = await fetchImpl(`${baseUrl}/api/health`, { headers: { accept: 'application/json' } })
    const payload = response.ok ? await response.json() as Record<string, any> : undefined
    checks.push(check('health.http', response.status === 200, `HTTP ${response.status}`))
    checks.push(check('health.version', payload?.version === AUTHENTICATED_GATEWAY_VERSION, `version=${String(payload?.version)}; expected=${AUTHENTICATED_GATEWAY_VERSION}`))
    checks.push(check('health.mode', payload?.mode === expectedMode, `mode=${String(payload?.mode)}; expected=${expectedMode}`))
    checks.push(check('health.workspace-authority', payload?.workspaceAuthority === expectedWorkspaceAuthority, `workspaceAuthority=${String(payload?.workspaceAuthority)}; expected=${expectedWorkspaceAuthority}`))
    checks.push(check('health.audience-mode', payload?.topology?.audienceMode === expectedAudienceMode, `audienceMode=${String(payload?.topology?.audienceMode)}; expected=${expectedAudienceMode}`))
    if (expectedCanonicalWebOrigin) {
      checks.push(check('health.canonical-web-origin', payload?.topology?.canonicalWebOrigin === expectedCanonicalWebOrigin, `canonicalWebOrigin=${String(payload?.topology?.canonicalWebOrigin)}; expected=${expectedCanonicalWebOrigin}`))
    }
    if (expectedCanonicalApiOrigin) {
      checks.push(check('health.canonical-api-origin', payload?.topology?.canonicalApiOrigin === expectedCanonicalApiOrigin, `canonicalApiOrigin=${String(payload?.topology?.canonicalApiOrigin)}; expected=${expectedCanonicalApiOrigin}`))
    }
    checks.push(check('health.resource-origin', typeof payload?.resource === 'string' && payload.resource.startsWith(`${expectedResourceOrigin}/`), `resource=${String(payload?.resource)}; expectedOrigin=${expectedResourceOrigin}`))
    if (expectedCommitSha) {
      const actualCommitSha = typeof payload?.release?.commitSha === 'string' ? payload.release.commitSha.toLowerCase() : undefined
      checks.push(check(
        'health.release-commit',
        actualCommitSha === expectedCommitSha,
        `commitSha=${String(actualCommitSha)}; expected=${expectedCommitSha}`,
      ))
    }
    if (expectedProductVersion) {
      checks.push(check(
        'health.release-product-version',
        payload?.release?.productVersion === expectedProductVersion,
        `productVersion=${String(payload?.release?.productVersion)}; expected=${expectedProductVersion}`,
      ))
    }
    if (expectedReleaseChannel) {
      checks.push(check(
        'health.release-channel',
        payload?.release?.releaseChannel === expectedReleaseChannel,
        `releaseChannel=${String(payload?.release?.releaseChannel)}; expected=${expectedReleaseChannel}`,
      ))
    }
    if (expectedMcpContractHash) {
      checks.push(check(
        'health.release-mcp-contract',
        payload?.release?.mcpContractHash === expectedMcpContractHash,
        `mcpContractHash=${String(payload?.release?.mcpContractHash)}; expected=${expectedMcpContractHash}`,
      ))
    }
    if (expectedMigrationSetHash) {
      checks.push(check(
        'health.release-migration-set',
        payload?.release?.migrationSetHash === expectedMigrationSetHash,
        `migrationSetHash=${String(payload?.release?.migrationSetHash)}; expected=${expectedMigrationSetHash}`,
      ))
    }
    if (expectedSnapshotSchema) {
      checks.push(check(
        'health.release-snapshot-schema',
        payload?.release?.schemaCompatibility?.snapshotSchema === expectedSnapshotSchema,
        `snapshotSchema=${String(payload?.release?.schemaCompatibility?.snapshotSchema)}; expected=${expectedSnapshotSchema}`,
      ))
    }
    if (expectedSnapshotVersion !== undefined) {
      checks.push(check(
        'health.release-snapshot-version',
        payload?.release?.schemaCompatibility?.snapshotVersion === expectedSnapshotVersion,
        `snapshotVersion=${String(payload?.release?.schemaCompatibility?.snapshotVersion)}; expected=${expectedSnapshotVersion}`,
      ))
    }
    const capabilities = payload?.capabilities ?? {}
    for (const [key, expected] of Object.entries(REQUIRED_CAPABILITIES)) {
      checks.push(check(`health.capability.${key}`, capabilities[key] === expected, `${key}=${String(capabilities[key])}`))
    }
    const authenticatedMcp = payload?.authenticatedMcp ?? {}
    checks.push(check(
      'health.authenticated-mcp-tool-surface-version',
      authenticatedMcp.toolSurfaceVersion === AUTHENTICATED_MCP_TOOL_SURFACE_VERSION,
      `toolSurfaceVersion=${String(authenticatedMcp.toolSurfaceVersion)}`,
    ))
    const releaseRequiredTools = Array.isArray(authenticatedMcp.releaseRequiredTools) ? authenticatedMcp.releaseRequiredTools : []
    for (const tool of expectedMcpTools) {
      checks.push(check(
        `health.authenticated-mcp-tool.${tool}`,
        releaseRequiredTools.includes(tool),
        releaseRequiredTools.includes(tool) ? 'present' : 'missing',
      ))
    }
  } catch (caught) {
    checks.push(check('health.fetch', false, caught instanceof Error ? caught.message : String(caught)))
  }

  try {
    const response = await fetchImpl(`${baseUrl}/api/google-access-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: firstPartyTestOrigin },
      body: '{}',
    })
    checks.push(check('google-access-token.unauthorized', response.status === 401, `HTTP ${response.status}; unauthenticated restore must be rejected`))
  } catch (caught) {
    checks.push(check('google-access-token.fetch', false, caught instanceof Error ? caught.message : String(caught)))
  }

  try {
    const response = await fetchImpl(`${baseUrl}/api/automation-settings`, {
      headers: { origin: firstPartyTestOrigin },
    })
    checks.push(check('gmail-automation.settings-unauthorized', response.status === 401, `HTTP ${response.status}; user automation settings must require PJSDAS authentication`))
  } catch (caught) {
    checks.push(check('gmail-automation.settings-fetch', false, caught instanceof Error ? caught.message : String(caught)))
  }

  try {
    const response = await fetchImpl(`${baseUrl}/api/automation-gmail`, { method: 'POST' })
    checks.push(check('gmail-automation.worker-unauthorized', response.status === 401, `HTTP ${response.status}; background worker must require the Vault scheduler token`))
  } catch (caught) {
    checks.push(check('gmail-automation.worker-fetch', false, caught instanceof Error ? caught.message : String(caught)))
  }

  try {
    const response = await fetchImpl(`${baseUrl}/api/automation-discovery`, { method: 'POST' })
    checks.push(check('discovery-automation.worker-unauthorized', response.status === 401, `HTTP ${response.status}; server-owned discovery worker must require the Vault scheduler token`))
  } catch (caught) {
    checks.push(check('discovery-automation.worker-fetch', false, caught instanceof Error ? caught.message : String(caught)))
  }

  try {
    const response = await fetchImpl(mcpToolsRequest(baseUrl))
    checks.push(check('mcp.unauthorized', response.status === 401, `HTTP ${response.status}; anonymous tools/list must be rejected`))
    checks.push(check('mcp.metadata-origin', response.headers.get('www-authenticate')?.includes(`${expectedResourceOrigin}/.well-known/oauth-protected-resource`) === true, response.headers.get('www-authenticate') ?? 'missing'))
  } catch (caught) {
    checks.push(check('mcp.unauthorized.fetch', false, caught instanceof Error ? caught.message : String(caught)))
  }

  if (options.accessToken?.trim()) {
    try {
      const response = await fetchImpl(mcpToolsRequest(baseUrl, options.accessToken.trim()))
      const text = await textOf(response)
      checks.push(check('mcp.authenticated.http', response.status === 200, `HTTP ${response.status}`))
      for (const tool of expectedMcpTools) {
        checks.push(check(`mcp.tool.${tool}`, text.includes(tool), text.includes(tool) ? 'present' : 'missing'))
      }
    } catch (caught) {
      checks.push(check('mcp.authenticated.fetch', false, caught instanceof Error ? caught.message : String(caught)))
    }
  } else if (options.requireAuthenticatedTools) {
    checks.push(check(
      'mcp.authenticated.tools',
      false,
      'PJSDAS_SELF_TEST_ACCESS_TOKEN not supplied; strict live-auth verification requires authenticated MCP tool discovery.',
    ))
  } else {
    checks.push({ name: 'mcp.authenticated.tools', status: 'skipped', detail: 'Live authenticated tool-list verification is optional; deployed release tool surface is verified through /api/health.' })
  }

  if (webUrl) {
    try {
      const response = await fetchImpl(`${webUrl}/release-manifest.json`, { headers: { accept: 'application/json' } })
      const manifest = response.ok ? await response.json() as Record<string, any> : undefined
      checks.push(check('frontend-manifest.http', response.status === 200, `HTTP ${response.status}`))
      checks.push(check('frontend-manifest.schema', manifest?.schema === 'pjsdas-release-manifest' && manifest?.version === 1, `schema=${String(manifest?.schema)}; version=${String(manifest?.version)}`))
      checks.push(check('frontend-manifest.artifact-digest', /^sha256:[0-9a-f]{64}$/i.test(String(manifest?.frontendArtifactDigest ?? '')), `frontendArtifactDigest=${String(manifest?.frontendArtifactDigest)}`))
      if (expectedCommitSha) {
        checks.push(check('frontend-manifest.commit', String(manifest?.commitSha ?? '').toLowerCase() === expectedCommitSha, `commitSha=${String(manifest?.commitSha)}; expected=${expectedCommitSha}`))
      }
      if (expectedProductVersion) {
        checks.push(check('frontend-manifest.product-version', manifest?.productVersion === expectedProductVersion, `productVersion=${String(manifest?.productVersion)}; expected=${expectedProductVersion}`))
      }
      if (expectedMcpContractHash) {
        checks.push(check('frontend-manifest.mcp-contract', manifest?.mcpContractHash === expectedMcpContractHash, `mcpContractHash=${String(manifest?.mcpContractHash)}; expected=${expectedMcpContractHash}`))
      }
      if (expectedMigrationSetHash) {
        checks.push(check('frontend-manifest.migration-set', manifest?.migrationSetHash === expectedMigrationSetHash, `migrationSetHash=${String(manifest?.migrationSetHash)}; expected=${expectedMigrationSetHash}`))
      }
      checks.push(check(
        'frontend-manifest.authority',
        manifest?.topology?.connectedAuthority === expectedWorkspaceAuthority,
        `connectedAuthority=${String(manifest?.topology?.connectedAuthority)}; expected=${expectedWorkspaceAuthority}`,
      ))
    } catch (caught) {
      checks.push(check('frontend-manifest.fetch', false, caught instanceof Error ? caught.message : String(caught)))
    }
  }

  return {
    ok: checks.every((item) => item.status !== 'fail'),
    baseUrl,
    checks,
  }
}
