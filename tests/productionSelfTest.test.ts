import { describe, expect, it, vi } from 'vitest'
import { runProductionSelfTest } from '../gateway/productionSelfTest.js'

const BASE_URL = 'https://example.test'
const METADATA_URL = `${BASE_URL}/.well-known/oauth-protected-resource`
const RELEASE_SHA = '1234567890abcdef1234567890abcdef12345678'

function health() {
  return {
    service: 'pjsdas-authenticated-mcp',
    version: '1.9.0-alpha.1',
    mode: 'google-drive-trusted-ingestion',
    resource: `${BASE_URL}/api/mcp`,
    release: { commitSha: RELEASE_SHA },
    status: 'ok',
    capabilities: {
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
      deploymentPortability: true,
      releaseIdentityBinding: true,
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
    if (url.endsWith('/api/mcp')) return unauthorizedMcp()
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
}

describe('production self-test', () => {
  it('passes public health and unauthorized safety checks while explicitly skipping auth tool discovery without a token in non-release mode', async () => {
    const result = await runProductionSelfTest({ baseUrl: BASE_URL, fetchImpl: publicFetch() })
    expect(result.ok).toBe(true)
    expect(result.checks.find((item) => item.name === 'health.resource-origin')?.status).toBe('pass')
    expect(result.checks.find((item) => item.name === 'mcp.metadata-origin')?.status).toBe('pass')
    expect(result.checks.find((item) => item.name === 'mcp.authenticated.tools')?.status).toBe('skipped')
  })

  it('fails closed without a token when authenticated tool discovery is required for release', async () => {
    const result = await runProductionSelfTest({
      baseUrl: BASE_URL,
      requireAuthenticatedTools: true,
      fetchImpl: publicFetch(),
    })
    expect(result.ok).toBe(false)
    expect(result.checks.find((item) => item.name === 'mcp.authenticated.tools')).toMatchObject({
      status: 'fail',
    })
  })

  it('verifies the hardened authenticated tool surface when a test token is supplied', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL | Request) => {
      const request = input instanceof Request ? input : new Request(String(input))
      if (request.url.endsWith('/api/health')) return Response.json(health())
      if (request.url.endsWith('/api/google-access-token')) return Response.json({ code: 'AUTH_REQUIRED' }, { status: 401 })
      if (request.url.endsWith('/api/mcp') && !request.headers.get('authorization')) return unauthorizedMcp()
      if (request.url.endsWith('/api/mcp')) return new Response('data: {"tools":[{"name":"get_coverage_status"},{"name":"get_workspace_integrity"},{"name":"ingest_discovery_run"},{"name":"ingest_gmail_run"}]}', { status: 200, headers: { 'content-type': 'text/event-stream' } })
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch
    const result = await runProductionSelfTest({
      baseUrl: BASE_URL,
      accessToken: 'token',
      requireAuthenticatedTools: true,
      fetchImpl,
    })
    expect(result.ok).toBe(true)
    for (const tool of ['get_coverage_status', 'get_workspace_integrity', 'ingest_discovery_run', 'ingest_gmail_run']) {
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
