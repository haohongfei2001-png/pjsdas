import { afterEach, describe, expect, it, vi } from 'vitest'
import { authenticatedRemoteMcpFetch } from '../gateway/authenticatedRemoteHttp.js'
import { oauthClientIdFromValidatedAccessToken } from '../gateway/supabaseIdentity.js'

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}

function jwt(payload: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(payload)}.test-signature`
}

function mcpRequest(token: string) {
  return new Request('https://pjsdas-remote-alpha.vercel.app/api/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
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

describe('authenticated write capability boundary', () => {
  it('keeps the release tool directory stable for ordinary authenticated sessions while authorization remains call-scoped', async () => {
    vi.stubEnv('PJSDAS_TOKEN_ENCRYPTION_KEY', 'test-proposal-signing-secret')
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/auth/v1/user')) return json({ id: 'user-a', email: 'a@gmail.com' })
      return json({ error: 'unexpected outbound request' }, 500)
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchImpl)

    const response = await authenticatedRemoteMcpFetch(mcpRequest('ordinary-first-party-session-token'))
    expect(response.status).toBe(200)
    const text = await responseText(response)
    expect(text).toContain('get_today_plan')
    expect(text).toContain('propose_changes')
    expect(text).toContain('add_opportunities')
    expect(text).not.toContain('apply_user_command')
    expect(text).toContain('ingest_discovery_run')
    expect(text).toContain('ingest_gmail_run')
  })

  it('does not remove trusted-ingestion tools from a validated OAuth client when no grant exists', async () => {
    vi.stubEnv('PJSDAS_TOKEN_ENCRYPTION_KEY', 'test-proposal-signing-secret')
    const oauthToken = jwt({
      sub: 'user-a',
      client_id: '1af5d928-7c67-4330-9521-e8886794fd14',
      session_id: '4962aabb-4001-4c4a-a242-385f03bdbfb4',
    })
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/auth/v1/user')) return json({ id: 'user-a', email: 'a@gmail.com' })
      if (url.includes('/rest/v1/pjsdas_authorization_grants?')) return json([])
      return json({ error: 'unexpected outbound request' }, 500)
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchImpl)

    const response = await authenticatedRemoteMcpFetch(mcpRequest(oauthToken))
    expect(response.status).toBe(200)
    const text = await responseText(response)
    expect(text).toContain('add_opportunities')
    expect(text).not.toContain('apply_user_command')
    expect(text).toContain('ingest_discovery_run')
    expect(text).toContain('ingest_gmail_run')
    expect(oauthClientIdFromValidatedAccessToken(oauthToken)).toBe('1af5d928-7c67-4330-9521-e8886794fd14')
  })

  it('does not change the advertised tool directory when one trusted-ingestion grant exists', async () => {
    vi.stubEnv('PJSDAS_TOKEN_ENCRYPTION_KEY', 'test-proposal-signing-secret')
    const clientId = '1af5d928-7c67-4330-9521-e8886794fd14'
    const oauthToken = jwt({ sub: 'user-a', client_id: clientId })
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/auth/v1/user')) return json({ id: 'user-a', email: 'a@gmail.com' })
      if (url.includes('/rest/v1/pjsdas_authorization_grants?')) return json([{
        user_id: 'user-a',
        client_id: clientId,
        source_id: 'monitor:urgent-campus',
        capability: 'ingest_discovery_run',
        revoked_at: null,
      }])
      return json({ error: 'unexpected outbound request' }, 500)
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchImpl)

    const response = await authenticatedRemoteMcpFetch(mcpRequest(oauthToken))
    expect(response.status).toBe(200)
    const text = await responseText(response)
    expect(text).toContain('add_opportunities')
    expect(text).toContain('ingest_discovery_run')
    expect(text).toContain('ingest_gmail_run')
  })

  it('exposes the bounded P1 command tool only after transactional authority is activated', async () => {
    vi.stubEnv('PJSDAS_TOKEN_ENCRYPTION_KEY', 'test-proposal-signing-secret')
    vi.stubEnv('PJSDAS_CONNECTED_AUTHORITY', 'transactional')
    vi.stubEnv('PJSDAS_SUPABASE_SERVICE_ROLE_KEY', 'service-role-test')
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/auth/v1/user')) return json({ id: 'user-a', email: 'a@gmail.com' })
      return json({ error: 'unexpected outbound request' }, 500)
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchImpl)

    const response = await authenticatedRemoteMcpFetch(mcpRequest('ordinary-first-party-session-token'))
    expect(response.status).toBe(200)
    const text = await responseText(response)
    expect(text).toContain('add_opportunities')
    expect(text).toContain('apply_user_command')
    expect(text).toContain('ingest_discovery_run')
    expect(text).toContain('ingest_gmail_run')
  })

  it('cannot gain any authenticated write capability from a token that Supabase rejects', async () => {
    vi.stubEnv('PJSDAS_TOKEN_ENCRYPTION_KEY', 'test-proposal-signing-secret')
    const forged = jwt({
      sub: 'attacker',
      client_id: '1af5d928-7c67-4330-9521-e8886794fd14',
    })
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/auth/v1/user')) return json({ message: 'invalid token' }, 401)
      return json({ error: 'unexpected outbound request' }, 500)
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchImpl)

    const response = await authenticatedRemoteMcpFetch(mcpRequest(forged))
    expect(response.status).toBe(401)
    const text = await response.text()
    expect(text).toContain('AUTH_REQUIRED')
    expect(text).not.toContain('add_opportunities')
    expect(text).not.toContain('ingest_discovery_run')
  })
})
