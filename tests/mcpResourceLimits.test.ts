import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { createPjsdasMcpServer } from '../gateway/serverFactory.js'
import { remoteMcpHandler } from '../gateway/remoteHttp.js'
import { authenticatedRemoteMcpFetch } from '../gateway/authenticatedRemoteHttp.js'
import { MCP_MAX_REQUEST_BODY_BYTES, MCP_MAX_TOOL_INPUT_ELEMENTS } from '../gateway/mcpResourceLimits.js'

function request(version: string, method: string, params: Record<string, unknown>) {
  return new Request('https://todayaction.example/api/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': version,
      'Mcp-Method': method,
      ...(method === 'tools/call' ? { 'Mcp-Name': 'resource_limit_probe' } : {}),
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

describe.each(['2026-07-28', '2025-06-18'])('MCP resource budgets (%s)', version => {
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
