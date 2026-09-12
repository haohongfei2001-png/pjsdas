import { describe, expect, it, vi } from 'vitest'
import { runProductionSelfTest } from '../gateway/productionSelfTest.js'

function health() {
  return {
    service: 'pjsdas-authenticated-mcp',
    version: '1.9.0-alpha.1',
    mode: 'google-drive-trusted-ingestion',
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
    },
  }
}

describe('production self-test', () => {
  it('passes public health and unauthorized safety checks while explicitly skipping auth tool discovery without a token', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.endsWith('/api/health')) return Response.json(health())
      if (url.endsWith('/api/google-access-token')) return Response.json({ code: 'AUTH_REQUIRED' }, { status: 401 })
      if (url.endsWith('/api/mcp')) return Response.json({ code: 'AUTH_REQUIRED' }, { status: 401 })
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch
    const result = await runProductionSelfTest({ baseUrl: 'https://example.test', fetchImpl })
    expect(result.ok).toBe(true)
    expect(result.checks.find((item) => item.name === 'mcp.authenticated.tools')?.status).toBe('skipped')
  })

  it('verifies the hardened authenticated tool surface when a test token is supplied', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL | Request) => {
      const request = input instanceof Request ? input : new Request(String(input))
      if (request.url.endsWith('/api/health')) return Response.json(health())
      if (request.url.endsWith('/api/google-access-token')) return Response.json({ code: 'AUTH_REQUIRED' }, { status: 401 })
      if (request.url.endsWith('/api/mcp') && !request.headers.get('authorization')) return Response.json({ code: 'AUTH_REQUIRED' }, { status: 401 })
      if (request.url.endsWith('/api/mcp')) return new Response('data: {"tools":[{"name":"get_coverage_status"},{"name":"get_workspace_integrity"},{"name":"ingest_discovery_run"},{"name":"ingest_gmail_run"}]}', { status: 200, headers: { 'content-type': 'text/event-stream' } })
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch
    const result = await runProductionSelfTest({ baseUrl: 'https://example.test', accessToken: 'token', fetchImpl })
    expect(result.ok).toBe(true)
    for (const tool of ['get_coverage_status', 'get_workspace_integrity', 'ingest_discovery_run', 'ingest_gmail_run']) {
      expect(result.checks.find((item) => item.name === `mcp.tool.${tool}`)?.status).toBe('pass')
    }
  })

  it('fails closed when production health advertises the wrong version or misses a hardening capability', async () => {
    const bad = health() as any
    bad.version = '1.8.0'
    delete bad.capabilities.workspaceIntegrityAudit
    const fetchImpl = vi.fn(async (input: RequestInfo | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.endsWith('/api/health')) return Response.json(bad)
      return Response.json({ code: 'AUTH_REQUIRED' }, { status: 401 })
    }) as unknown as typeof fetch
    const result = await runProductionSelfTest({ baseUrl: 'https://example.test', fetchImpl })
    expect(result.ok).toBe(false)
    expect(result.checks.find((item) => item.name === 'health.version')?.status).toBe('fail')
    expect(result.checks.find((item) => item.name === 'health.capability.workspaceIntegrityAudit')?.status).toBe('fail')
  })
})
