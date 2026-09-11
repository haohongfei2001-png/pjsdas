import { describe, expect, it } from 'vitest'
import { remoteMcpHandler } from '../gateway/remoteHttp.js'

const protocolVersion = '2026-07-28'
const requestMeta = {
  'io.modelcontextprotocol/protocolVersion': protocolVersion,
  'io.modelcontextprotocol/clientInfo': {
    name: 'pjsdas-remote-test',
    version: '1.0.0',
  },
  'io.modelcontextprotocol/clientCapabilities': {},
}

function request(method: string, params: Record<string, unknown> = {}, name?: string) {
  const headers = new Headers({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': protocolVersion,
    'Mcp-Method': method,
  })
  if (name) headers.set('Mcp-Name', name)

  return new Request('https://pjsdas.example/api/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `${method}-1`,
      method,
      params: {
        ...params,
        _meta: requestMeta,
      },
    }),
  })
}

async function responseText(response: Response) {
  const text = await response.text()
  if (!response.headers.get('content-type')?.includes('text/event-stream')) return text

  return text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .join('\n')
}

describe('PJSDAS remote MCP HTTP alpha', () => {
  it('serves modern MCP discovery over Streamable HTTP', async () => {
    const response = await remoteMcpHandler.fetch(request('server/discover'))
    const text = await responseText(response)

    expect(response.status).toBe(200)
    expect(text).toContain('2026-07-28')
    expect(text).toContain('tools')
    expect(text).toContain('synthetic demo data')
  })

  it('advertises the six read-only PJSDAS tools remotely', async () => {
    const response = await remoteMcpHandler.fetch(request('tools/list'))
    const text = await responseText(response)

    expect(response.status).toBe(200)
    for (const tool of [
      'get_today_plan',
      'list_opportunities',
      'get_pipeline',
      'get_decision_rules',
      'explain_priority',
      'get_recent_timeline',
    ]) {
      expect(text).toContain(tool)
    }
  })

  it('executes a read-only tool through the remote HTTP handler', async () => {
    const response = await remoteMcpHandler.fetch(request(
      'tools/call',
      { name: 'get_decision_rules', arguments: {} },
      'get_decision_rules',
    ))
    const text = await responseText(response)

    expect(response.status).toBe(200)
    expect(text).toContain('rulesVersion')
    expect(text).toContain('remote-demo-v1')
  })
})
