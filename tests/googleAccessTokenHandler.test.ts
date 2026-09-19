import { describe, expect, it, vi } from 'vitest'
import { createGoogleAccessTokenHandler } from '../gateway/googleAccessTokenHandler.js'
import { encryptSecret } from '../gateway/tokenCrypto.js'

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const KEY = Buffer.alloc(32, 19).toString('base64url')
const ORIGIN = 'https://haohongfei2001-png.github.io'

function jwt(payload: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(payload)}.test-signature`
}

function request(origin = ORIGIN, token = 'pjsdas-session-token') {
  return new Request('https://gateway.example/api/google-access-token', {
    method: 'POST',
    headers: { origin, authorization: `Bearer ${token}` },
  })
}

describe('stable account Google access token handler', () => {
  it('authenticates the PJSDAS account, decrypts its stored refresh token, and returns only a short-lived Google token', async () => {
    const ciphertext = await encryptSecret('google-refresh-secret', KEY)
    const calls: Array<{ url: string; auth: string | null; body?: string }> = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      const body = init?.body == null ? undefined : String(init.body)
      calls.push({ url, auth: headers.get('authorization'), body })

      if (url.endsWith('/auth/v1/user')) return json({ id: 'user-a', email: 'a@gmail.com' })
      if (url.includes('/rest/v1/google_drive_connections?')) {
        return json([{
          user_id: 'user-a',
          google_subject: 'google-a',
          google_email: 'a@gmail.com',
          refresh_token_ciphertext: ciphertext,
          granted_scopes: ['https://www.googleapis.com/auth/drive.appdata'],
          revoked_at: null,
        }])
      }
      if (url === 'https://oauth2.googleapis.com/token') return json({ access_token: 'short-google-token' })
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch

    const handler = createGoogleAccessTokenHandler({
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'publishable-key',
      tokenEncryptionKey: KEY,
      googleClientId: 'google-client-id',
      googleClientSecret: 'google-client-secret',
      allowedOrigins: [ORIGIN],
      fetchImpl,
    })

    const response = await handler(request())
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    const payload = await response.json() as Record<string, unknown>
    expect(payload).toEqual({
      accessToken: 'short-google-token',
      expiresInSeconds: 3000,
      googleEmail: 'a@gmail.com',
    })
    expect(JSON.stringify(payload)).not.toContain('google-refresh-secret')

    expect(calls[0]).toMatchObject({ auth: 'Bearer pjsdas-session-token' })
    expect(calls[1]).toMatchObject({ auth: 'Bearer pjsdas-session-token' })
    expect(calls[2]?.body).toContain('refresh_token=google-refresh-secret')
    expect(calls[2]?.body).toContain('client_id=google-client-id')
    expect(calls[2]?.body).toContain('client_secret=google-client-secret')
  })

  it('fails closed when this account has no durable Google Drive binding', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/auth/v1/user')) return json({ id: 'user-a', email: 'a@gmail.com' })
      if (url.includes('/rest/v1/google_drive_connections?')) return json([])
      return json({ error: 'must not reach Google' }, 500)
    }) as unknown as typeof fetch

    const handler = createGoogleAccessTokenHandler({
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'publishable-key',
      tokenEncryptionKey: KEY,
      googleClientId: 'google-client-id',
      googleClientSecret: 'google-client-secret',
      allowedOrigins: [ORIGIN],
      fetchImpl,
    })

    const response = await handler(request())
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ code: 'GOOGLE_CONNECTION_REQUIRED' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('rejects delegated OAuth sessions before reading Google connection state', async () => {
    const oauthToken = jwt({
      sub: 'user-a',
      client_id: '1af5d928-7c67-4330-9521-e8886794fd14',
    })
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/auth/v1/user')) return json({ id: 'user-a', email: 'a@gmail.com' })
      return json({ error: 'must not read binding' }, 500)
    }) as unknown as typeof fetch
    const handler = createGoogleAccessTokenHandler({
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'publishable-key',
      tokenEncryptionKey: KEY,
      googleClientId: 'google-client-id',
      googleClientSecret: 'google-client-secret',
      allowedOrigins: [ORIGIN],
      fetchImpl,
    })

    const response = await handler(request(ORIGIN, oauthToken))
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ code: 'AUTH_FORBIDDEN' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('rejects requests without a first-party browser origin before touching auth services', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const handler = createGoogleAccessTokenHandler({
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'publishable-key',
      tokenEncryptionKey: KEY,
      googleClientId: 'google-client-id',
      googleClientSecret: 'google-client-secret',
      allowedOrigins: [ORIGIN],
      fetchImpl,
    })
    const response = await handler(new Request('https://gateway.example/api/google-access-token', {
      method: 'POST',
      headers: { authorization: 'Bearer pjsdas-session-token' },
    }))
    expect(response.status).toBe(403)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects disallowed origins before touching auth services', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const handler = createGoogleAccessTokenHandler({
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'publishable-key',
      tokenEncryptionKey: KEY,
      googleClientId: 'google-client-id',
      googleClientSecret: 'google-client-secret',
      allowedOrigins: [ORIGIN],
      fetchImpl,
    })

    const response = await handler(request('https://evil.example'))
    expect(response.status).toBe(403)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
