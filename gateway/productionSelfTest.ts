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
  opportunityParticipationState: 'v1',
  gmailCompleteConsumption: 'v1',
  discoverySourceVerification: 'v1',
  discoveryFactAssessmentSeparation: true,
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
  requireAuthenticatedTools?: boolean
  fetchImpl?: typeof fetch
}): Promise<ProductionSelfTestResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const baseUrl = options.baseUrl.replace(/\/$/, '')
  const expectedCommitSha = options.expectedCommitSha?.trim().toLowerCase()
  const expectedWorkspaceAuthority = options.expectedWorkspaceAuthority ?? 'google-drive'
  const expectedMode = expectedWorkspaceAuthority === 'transactional'
    ? 'transactional-connected'
    : 'google-drive-trusted-ingestion'
  const expectedMcpTools = authenticatedMcpReleaseRequiredTools(expectedWorkspaceAuthority)
  const checks: ProductionSelfTestCheck[] = []

  try {
    const response = await fetchImpl(`${baseUrl}/api/health`, { headers: { accept: 'application/json' } })
    const payload = response.ok ? await response.json() as Record<string, any> : undefined
    checks.push(check('health.http', response.status === 200, `HTTP ${response.status}`))
    checks.push(check('health.version', payload?.version === '1.9.0-alpha.1', `version=${String(payload?.version)}`))
    checks.push(check('health.mode', payload?.mode === expectedMode, `mode=${String(payload?.mode)}; expected=${expectedMode}`))
    checks.push(check('health.workspace-authority', payload?.workspaceAuthority === expectedWorkspaceAuthority, `workspaceAuthority=${String(payload?.workspaceAuthority)}; expected=${expectedWorkspaceAuthority}`))
    checks.push(check('health.resource-origin', typeof payload?.resource === 'string' && payload.resource.startsWith(`${baseUrl}/`), `resource=${String(payload?.resource)}`))
    if (expectedCommitSha) {
      const actualCommitSha = typeof payload?.release?.commitSha === 'string' ? payload.release.commitSha.toLowerCase() : undefined
      checks.push(check(
        'health.release-commit',
        actualCommitSha === expectedCommitSha,
        `commitSha=${String(actualCommitSha)}; expected=${expectedCommitSha}`,
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
      headers: { 'content-type': 'application/json', origin: 'https://haohongfei2001-png.github.io' },
      body: '{}',
    })
    checks.push(check('google-access-token.unauthorized', response.status === 401, `HTTP ${response.status}; unauthenticated restore must be rejected`))
  } catch (caught) {
    checks.push(check('google-access-token.fetch', false, caught instanceof Error ? caught.message : String(caught)))
  }

  try {
    const response = await fetchImpl(`${baseUrl}/api/automation-settings`, {
      headers: { origin: 'https://haohongfei2001-png.github.io' },
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
    checks.push(check('mcp.metadata-origin', response.headers.get('www-authenticate')?.includes(`${baseUrl}/.well-known/oauth-protected-resource`) === true, response.headers.get('www-authenticate') ?? 'missing'))
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

  return {
    ok: checks.every((item) => item.status !== 'fail'),
    baseUrl,
    checks,
  }
}
