import { describe, expect, it } from 'vitest'
import { remoteMcpHandler } from '../gateway/remoteHttp'

const legacyVersions = ['2025-06-18', '2025-11-25'] as const

function request(body: Record<string, unknown>, protocolVersion?: string) {
  const headers = new Headers({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  })
  if (protocolVersion) headers.set('MCP-Protocol-Version', protocolVersion)

  return new Request('https://pjsdas.example/api/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
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

describe('PJSDAS remote MCP legacy compatibility', () => {
  it.each(legacyVersions)('accepts a standard %s initialize request', async (protocolVersion) => {
    const response = await remoteMcpHandler.fetch(request({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: 'chatgpt-compat-probe', version: '1.0.0' },
      },
    }))
    const text = await responseText(response)

    expect(response.status).toBe(200)
    expect(text).toContain('protocolVersion')
    expect(text).toContain('pjsdas')
  })

  it.each(legacyVersions)('serves tools/list for %s stateless legacy traffic', async (protocolVersion) => {
    const response = await remoteMcpHandler.fetch(request({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    }, protocolVersion))
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
})
