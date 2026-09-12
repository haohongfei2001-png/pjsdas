const base = (process.env.PJSDAS_BASE_URL || process.argv[2] || 'https://pjsdas-remote-alpha.vercel.app').replace(/\/+$/, '')
const expectedVersion = process.env.PJSDAS_EXPECTED_VERSION || '1.7.0-alpha.1'
const expectedResource = (process.env.PJSDAS_EXPECTED_RESOURCE || `${base}/api/mcp`).replace(/\/+$/, '')
const githubPagesOrigin = 'https://haohongfei2001-png.github.io'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function fetchJson(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    signal: AbortSignal.timeout(15_000),
  })
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    throw new Error(`${path} returned non-JSON body (HTTP ${response.status}): ${text.slice(0, 200)}`)
  }
  return { response, body }
}

async function main() {
  console.log(`PJSDAS production smoke: ${base}`)
  console.log(`Expected OAuth resource: ${expectedResource}`)

  const health = await fetchJson('/api/health')
  assert(health.response.status === 200, `/api/health expected 200, got ${health.response.status}`)
  assert(health.body?.version === expectedVersion, `/api/health version expected ${expectedVersion}, got ${health.body?.version}`)
  assert(health.body?.mode === 'google-drive-readonly', 'health mode is not google-drive-readonly')
  assert(health.body?.auth === 'supabase-oauth-2.1', 'health auth contract is not Supabase OAuth')
  assert(health.body?.resource === expectedResource, `health resource expected ${expectedResource}, got ${health.body?.resource}`)
  assert(health.body?.capabilities?.discoveryContext === true, 'get_discovery_context capability is not advertised')
  assert(health.body?.capabilities?.discoveryQualityGate === 'v1.4-round-3', 'Round 3 discovery quality gate is not advertised')
  assert(health.body?.capabilities?.reviewOnlyProposals === true, 'review-only proposal capability is not advertised')
  assert(health.body?.capabilities?.discoveredOpportunityProposals === true, 'discovered-opportunity proposal capability is not advertised')
  assert(health.body?.capabilities?.discoveryInbox === 'v1.4-round-2', 'v1.4 Discovery Inbox decision workspace is not advertised')
  assert(health.body?.capabilities?.jobPostingIdentityFreshness === 'v1.4-round-3', 'job posting identity/freshness capability is not advertised')
  assert(health.body?.capabilities?.richOpportunityFacts === 'v1.5-round-1', 'Rich Opportunity fact capability is not advertised')
  assert(health.body?.capabilities?.componentAssessment === 'v1.5-round-2', 'component assessment capability is not advertised')
  assert(health.body?.capabilities?.opportunityAssessmentRead === true, 'opportunity assessment read capability is not advertised')
  assert(health.body?.capabilities?.applicationPortfolioDecision === 'v1.6-round-1', 'application portfolio decision capability is not advertised')
  assert(health.body?.capabilities?.applicationPortfolioRead === true, 'application portfolio read capability is not advertised')
  assert(health.body?.capabilities?.prepGraph === 'v1.6-round-2', 'Prep Graph capability is not advertised')
  assert(health.body?.capabilities?.prepGraphRead === true, 'Prep Graph read capability is not advertised')
  assert(health.body?.capabilities?.prepGraphTodayProjection === true, 'Prep Graph Today projection is not advertised')
  assert(health.body?.capabilities?.continuousDiscovery === 'v1.7', 'Continuous Discovery capability is not advertised')
  assert(health.body?.capabilities?.discoveryRunLedger === true, 'Discovery Run ledger capability is not advertised')
  assert(health.body?.capabilities?.incrementalDiscoveryContext === true, 'incremental discovery context is not advertised')
  assert(health.body?.capabilities?.postingRefreshQueue === true, 'posting refresh queue is not advertised')
  console.log('✓ health/version/capabilities')

  const unauth = await fetchJson('/api/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  })
  assert(unauth.response.status === 401, `/api/mcp without bearer expected 401, got ${unauth.response.status}`)
  assert(unauth.body?.code === 'AUTH_REQUIRED', `unauthenticated MCP code expected AUTH_REQUIRED, got ${unauth.body?.code}`)
  const challenge = unauth.response.headers.get('www-authenticate') || ''
  assert(challenge.includes('/.well-known/oauth-protected-resource'), 'MCP OAuth challenge does not point to protected-resource metadata')
  console.log('✓ unauthenticated MCP fails closed with OAuth challenge')

  const metadata = await fetchJson('/.well-known/oauth-protected-resource')
  assert(metadata.response.status === 200, `protected-resource metadata expected 200, got ${metadata.response.status}`)
  assert(metadata.body?.resource === expectedResource, `protected resource expected ${expectedResource}, got ${metadata.body?.resource}`)
  assert(Array.isArray(metadata.body?.authorization_servers) && metadata.body.authorization_servers.length > 0, 'authorization_servers missing')
  console.log('✓ OAuth protected-resource metadata')

  const preflight = await fetch(`${base}/api/proposal-verify`, {
    method: 'OPTIONS',
    headers: { origin: githubPagesOrigin },
    signal: AbortSignal.timeout(15_000),
  })
  assert(preflight.status === 204, `proposal verify CORS preflight expected 204, got ${preflight.status}`)
  assert(preflight.headers.get('access-control-allow-origin') === githubPagesOrigin, 'proposal verify CORS origin mismatch')
  console.log('✓ proposal review CORS')

  const invalidProposal = await fetchJson('/api/proposal-verify', {
    method: 'POST',
    headers: {
      origin: githubPagesOrigin,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ token: 'invalid.v1.7-smoke-token' }),
  })
  assert(invalidProposal.response.status === 400, `invalid proposal expected 400, got ${invalidProposal.response.status}`)
  assert(invalidProposal.body?.code === 'PROPOSAL_INVALID', `invalid proposal code expected PROPOSAL_INVALID, got ${invalidProposal.body?.code}`)
  console.log('✓ signed proposal verifier rejects invalid capability tokens')

  console.log('PJSDAS v1.7 Continuous Discovery public production contract passed.')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
