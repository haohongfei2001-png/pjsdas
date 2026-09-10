import { describe, expect, it } from 'vitest'
import { chatgptCompatHandler } from '../gateway/chatgptCompat'

function legacyRequest(method: string, params: Record<string, unknown> = {}, protocolVersion = '2025-11-25') {
  return new Request('https://pjsdas.example/api/mcp-compat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': protocolVersion,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: `${method}-1`, method, params }),
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

describe('minimal ChatGPT MCP compatibility server', () => {
  it('accepts legacy initialize', async () => {
    const response = await chatgptCompatHandler.fetch(new Request('https://pjsdas.example/api/mcp-compat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'chatgpt-probe', version: '1.0.0' },
        },
      }),
    }))
    expect(response.status).toBe(200)
    expect(await responseText(response)).toContain('pjsdas-compat')
  })

  it('lists only search and fetch', async () => {
    const response = await chatgptCompatHandler.fetch(legacyRequest('tools/list'))
    const text = await responseText(response)
    expect(response.status).toBe(200)
    expect(text).toContain('search')
    expect(text).toContain('fetch')
    expect(text).not.toContain('get_today_plan')
  })

  it('calls search', async () => {
    const response = await chatgptCompatHandler.fetch(legacyRequest('tools/call', {
      name: 'search',
      arguments: { query: 'AI product' },
    }))
    const text = await responseText(response)
    expect(response.status).toBe(200)
    expect(text).toContain('demo-opportunity-1')
    expect(text).toContain('synthetic')
  })
})
