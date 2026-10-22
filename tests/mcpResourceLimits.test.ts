import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { createPjsdasMcpServer } from '../gateway/serverFactory.js'
import { remoteMcpHandler } from '../gateway/remoteHttp.js'
import { authenticatedRemoteMcpFetch } from '../gateway/authenticatedRemoteHttp.js'
import { MCP_MAX_REQUEST_BODY_BYTES, MCP_MAX_TOOL_INPUT_ELEMENTS } from '../gateway/mcpResourceLimits.js'
import { semanticIntakeSchema } from '../gateway/semanticIntake.js'

function request(version: string, method: string, params: Record<string, unknown>) {
  return new Request('https://todayaction.example/api/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': version,
      'Mcp-Method': method,
      ...(method === 'tools/call' ? { 'Mcp-Name': String(params.name) } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {
      ...params,
      ...(version === '2026-07-28' ? { _meta: {
        'io.modelcontextprotocol/protocolVersion': version,
        'io.modelcontextprotocol/clientInfo': { name: 'resource-limit-test', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      } } : {}),
    } }),
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

it('preserves the existing body budget for valid multibyte semantic evidence', () => {
  const refs = Array(20).fill('证'.repeat(1000))
  const payload = {
    contractVersion: 1, inputId: 'body-budget-example',
    source: { kind: 'mcp', sourceId: 'test', sourceRecordId: 'test', observedAt: '2026-10-22T00:00:00Z', timezone: 'UTC' },
    statementMode: 'assertion',
    candidates: Array.from({ length: 12 }, (_, i) => ({ kind: 'application_action', id: `candidate-${i}`,
      objectConfidence: 'high', eventConfidence: 'high', evidenceRefs: refs, sourceVersionRefs: refs })),
  }
  expect(semanticIntakeSchema.safeParse(payload).success).toBe(true)
  const bytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength
  expect(bytes).toBeGreaterThan(1024 * 1024)
  expect(bytes).toBeLessThan(MCP_MAX_REQUEST_BODY_BYTES)
})

describe.each(['2026-07-28', '2025-06-18'])('MCP resource budgets (%s)', version => {
  it('retains the real opportunity archive contract above 10,000 elements', async () => {
    const invoke = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'management schema accepted' }] }))
    const read = vi.fn(async () => { throw new Error('Unexpected workspace read') })
    const handler = createMcpHandler(() => createPjsdasMcpServer({ read }, {
      scopedManagement: {
        business: undefined,
        opportunity: { invoke }, planning: { invoke },
        discoveryProfile: { invoke }, privateReminder: { invoke },
      },
    }), { maxRequestBodySize: MCP_MAX_REQUEST_BODY_BYTES })
    const ids = Array.from({ length: 2500 }, (_, i) => `id-${i}`)
    const args = { commandId: 'resource-budget-archive', baseRevision: 0, change: { operations: [{
      kind: 'archive_opportunity', id: 'opportunity-1', expectedFingerprint: 'a'.repeat(64),
      reason: 'Compatibility test, no data is written',
      dependencies: { processIds: ids, eventIds: ids, actionIds: ids, scheduleNodeIds: ids, reminderIntentIds: ids },
    }] } }
    expect(new TextEncoder().encode(JSON.stringify(args)).byteLength).toBeLessThan(262144)
    try {
      const response = await handler.fetch(request(version, 'tools/call', { name: 'execute_opportunity_management', arguments: args }))
      expect(await response.text()).toContain('management schema accepted')
      expect(invoke).toHaveBeenCalledExactlyOnceWith('execute_opportunity_management', args)
      expect(read).not.toHaveBeenCalled()
    } finally { await handler.close() }
  })

  it('bounds near-budget invalid validation in a measured regression case', async () => {
    const invoke = vi.fn()
    const handler = createMcpHandler(() => {
      const server = createPjsdasMcpServer({ read: async () => { throw new Error('Unexpected read') } })
      server.registerTool('resource_limit_probe', { inputSchema: z.object({ values: z.array(z.number()) }) }, invoke)
      return server
    }, { maxRequestBodySize: MCP_MAX_REQUEST_BODY_BYTES })
    // This is a regression workload, not a proof of safety for all Zod schemas.
    const req = request(version, 'tools/call', { name: 'resource_limit_probe', arguments: {
      values: Array(MCP_MAX_TOOL_INPUT_ELEMENTS - 1).fill('invalid'),
    } })
    const started = performance.now()
    const before = process.memoryUsage().heapUsed
    try {
      const response = await handler.fetch(req)
      const body = await response.text()
      expect(body).toContain('error')
      expect(invoke).not.toHaveBeenCalled()
      expect(performance.now() - started).toBeLessThan(10_000)
      expect(process.memoryUsage().heapUsed - before).toBeLessThan(256 * 1024 * 1024)
    } finally { await handler.close() }
  }, 15_000)

  it.each([false, true])('counts real streamed multibyte bytes and stops reading overflow (understated length %s)', async declaredLength => {
    const template = request(version, 'tools/list', {})
    const encoded = new TextEncoder().encode('界'.repeat(Math.ceil(MCP_MAX_REQUEST_BODY_BYTES / 3) + 1000))
    expect(encoded.byteLength).toBeGreaterThan(MCP_MAX_REQUEST_BODY_BYTES)
    let offset = 0
    let pulls = 0
    let sourceController: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { sourceController = controller },
      pull(controller) {
        pulls++
        if (offset >= encoded.length) { controller.enqueue(new Uint8Array(65536)); return }
        const next = Math.min(offset + 65536, encoded.length)
        controller.enqueue(encoded.subarray(offset, next))
        offset = next
      },
    })
    const headers = new Headers(template.headers)
    if (declaredLength) headers.set('content-length', '1')
    const req = new Request(template.url, { method: 'POST', headers, body: stream, duplex: 'half' } as RequestInit)
    const response = await remoteMcpHandler.fetch(req)
    expect(response.status).toBe(413)
    expect(pulls).toBeGreaterThan(1)
    // SDK 2.3 releases its reader on overflow but does not cancel the upstream
    // stream (and may clone the Request). Assert bounded consumption, then close
    // our synthetic source, rather than expecting upstream cancellation.
    // Allow the Request/stream implementation's small prefetch queue, but not
    // continued draining of this deliberately never-ending source.
    expect(pulls).toBeLessThanOrEqual(Math.ceil(MCP_MAX_REQUEST_BODY_BYTES / 65536) + 4)
    const pullsAtResponse = pulls
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(pulls).toBe(pullsAtResponse)
    expect(req.body?.locked).toBe(false)
    sourceController!.close()
  })

  it.each([false, true])('bounds validation in consumer-only mode %s without reducing the boundary', async consumerBusinessOnly => {
    const read = vi.fn(async () => { throw new Error('Unexpected workspace read') })
    const invoke = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'within budget' }] }))
    const handler = createMcpHandler(() => {
      const server = createPjsdasMcpServer({ read }, { consumerBusinessOnly })
      server.registerTool('resource_limit_probe', {
        inputSchema: z.object({ values: z.array(z.number()) }),
      }, invoke)
      return server
    }, { maxRequestBodySize: MCP_MAX_REQUEST_BODY_BYTES })
    try {
      // One object member plus each array entry counts toward the SDK budget.
      const accepted = await handler.fetch(request(version, 'tools/call', {
        name: 'resource_limit_probe', arguments: { values: Array(MCP_MAX_TOOL_INPUT_ELEMENTS - 1).fill(0) },
      }))
      expect(await accepted.text()).toContain('within budget')
      expect(invoke).toHaveBeenCalledTimes(1)

      const rejected = await handler.fetch(request(version, 'tools/call', {
        name: 'resource_limit_probe', arguments: { values: Array(MCP_MAX_TOOL_INPUT_ELEMENTS).fill(0) },
      }))
      expect(await rejected.text()).toContain(`more than the maximum of ${MCP_MAX_TOOL_INPUT_ELEMENTS} elements`)
      expect(invoke).toHaveBeenCalledTimes(1)
      expect(read).not.toHaveBeenCalled()
    } finally {
      await handler.close()
    }
  })

  it.each([false, true])('rejects streamed oversized demo requests, understated Content-Length: %s', async declaredLength => {
    const req = request(version, 'tools/list', { padding: 'x'.repeat(MCP_MAX_REQUEST_BODY_BYTES) })
    if (declaredLength) req.headers.set('content-length', '1')
    else expect(req.headers.has('content-length')).toBe(false)
    const response = await remoteMcpHandler.fetch(req)
    expect(response.status).toBe(413)
    expect(await response.text()).toContain('Payload Too Large')
  })

  it('rejects oversized authenticated requests without workspace access', async () => {
    vi.stubEnv('PJSDAS_TOKEN_ENCRYPTION_KEY', 'resource-limit-test-key')
    const outbound = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/auth/v1/user')) {
        return Response.json({ id: 'resource-limit-user', email: 'limits@example.com' })
      }
      throw new Error('Unexpected workspace access')
    })
    vi.stubGlobal('fetch', outbound)
    const req = request(version, 'tools/list', { padding: 'x'.repeat(MCP_MAX_REQUEST_BODY_BYTES) })
    req.headers.set('authorization', 'Bearer resource-limit-test-token')
    const response = await authenticatedRemoteMcpFetch(req)
    expect(response.status).toBe(413)
    expect(await response.text()).toContain('Payload Too Large')
    expect(outbound).toHaveBeenCalledTimes(1)
    expect(String(outbound.mock.calls[0]?.[0])).toContain('/auth/v1/user')
  })
})
