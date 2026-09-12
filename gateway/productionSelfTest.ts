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
  fetchImpl?: typeof fetch
}): Promise<ProductionSelfTestResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const baseUrl = options.baseUrl.replace(/\/$/, '')
  const checks: ProductionSelfTestCheck[] = []

  try {
    const response = await fetchImpl(`${baseUrl}/api/health`, { headers: { accept: 'application/json' } })
    const payload = response.ok ? await response.json() as Record<string, any> : undefined
    checks.push(check('health.http', response.status === 200, `HTTP ${response.status}`))
    checks.push(check('health.version', payload?.version === '1.9.0-alpha.1', `version=${String(payload?.version)}`))
    checks.push(check('health.mode', payload?.mode === 'google-drive-trusted-ingestion', `mode=${String(payload?.mode)}`))
    const capabilities = payload?.capabilities ?? {}
    for (const [key, expected] of Object.entries(REQUIRED_CAPABILITIES)) {
      checks.push(check(`health.capability.${key}`, capabilities[key] === expected, `${key}=${String(capabilities[key])}`))
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
    const response = await fetchImpl(mcpToolsRequest(baseUrl))
    checks.push(check('mcp.unauthorized', response.status === 401, `HTTP ${response.status}; anonymous tools/list must be rejected`))
  } catch (caught) {
    checks.push(check('mcp.unauthorized.fetch', false, caught instanceof Error ? caught.message : String(caught)))
  }

  if (options.accessToken?.trim()) {
    try {
      const response = await fetchImpl(mcpToolsRequest(baseUrl, options.accessToken.trim()))
      const text = await textOf(response)
      checks.push(check('mcp.authenticated.http', response.status === 200, `HTTP ${response.status}`))
      for (const tool of ['get_coverage_status', 'get_workspace_integrity', 'ingest_discovery_run', 'ingest_gmail_run']) {
        checks.push(check(`mcp.tool.${tool}`, text.includes(tool), text.includes(tool) ? 'present' : 'missing'))
      }
    } catch (caught) {
      checks.push(check('mcp.authenticated.fetch', false, caught instanceof Error ? caught.message : String(caught)))
    }
  } else {
    checks.push({ name: 'mcp.authenticated.tools', status: 'skipped', detail: 'PJSDAS_SELF_TEST_ACCESS_TOKEN not supplied; authenticated tool-list verification is deferred.' })
  }

  return {
    ok: checks.every((item) => item.status !== 'fail'),
    baseUrl,
    checks,
  }
}
