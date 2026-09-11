import { afterEach, describe, expect, it, vi } from 'vitest'
import { authenticatedRemoteMcpFetch, PROTECTED_RESOURCE_METADATA_URL } from '../gateway/authenticatedRemoteHttp.js'
import protectedResource from '../api/oauth-protected-resource.js'
import primaryMcp from '../api/mcp.js'

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}

function mcpRequest(method: string, token?: string, path = '/api/mcp-auth') {
  const headers = new Headers({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2025-06-18',
  })
  if (token) headers.set('authorization', `Bearer ${token}`)
  return new Request(`https://pjsdas-remote-alpha.vercel.app${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }),
  })
}

async function responseText(response: Response) {
  const text = await response.text()
  if (!response.headers.get('content-type')?.includes('text/event-stream')) return text
  return text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('authenticated remote MCP', () => {
  it('makes the existing /api/mcp connector require OAuth instead of serving demo data', async () => {
    const response = await primaryMcp.fetch(mcpRequest('tools/list', undefined, '/api/mcp'))
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain(PROTECTED_RESOURCE_METADATA_URL)
    expect(await response.text()).not.toContain('synthetic demo data')
  })

  it('advertises OAuth metadata instead of exposing tools anonymously', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchImpl)

    const response = await authenticatedRemoteMcpFetch(mcpRequest('tools/list'))
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain(PROTECTED_RESOURCE_METADATA_URL)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('allows authenticated tool discovery, including propose_changes, without touching Google Drive', async () => {
    vi.stubEnv('PJSDAS_TOKEN_ENCRYPTION_KEY', 'test-proposal-signing-secret')
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/auth/v1/user')) return json({ id: 'user-a', email: 'a@gmail.com' })
      return json({ error: 'unexpected outbound request' }, 500)
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchImpl)

    const response = await authenticatedRemoteMcpFetch(mcpRequest('tools/list', 'valid-user-token'))
    expect(response.status).toBe(200)
    const text = await responseText(response)
    expect(text).toContain('get_today_plan')
    expect(text).toContain('get_decision_rules')
    expect(text).toContain('propose_changes')
    expect(text).toContain('does not change the workspace')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(fetchImpl).mock.calls[0]?.[0])).toContain('/auth/v1/user')
  })

  it('publishes standard protected-resource metadata pointing to the existing /api/mcp connector', async () => {
    const response = protectedResource.fetch()
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      resource: 'https://pjsdas-remote-alpha.vercel.app/api/mcp',
      authorization_servers: ['https://yyrzwpoxlxpafdlbkdtg.supabase.co/auth/v1'],
      bearer_methods_supported: ['header'],
    })
  })
})
