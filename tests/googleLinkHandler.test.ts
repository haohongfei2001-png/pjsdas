import { describe, expect, it, vi } from 'vitest'
import { createGoogleLinkHandler } from '../gateway/googleLinkHandler'

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const KEY = Buffer.alloc(32, 11).toString('base64url')
const ORIGIN = 'https://haohongfei2001-png.github.io'

function request(body: unknown, token = 'pjsdas-access-token', origin = ORIGIN) {
  return new Request('https://gateway.example/api/google-link', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      origin,
    },
    body: JSON.stringify(body),
  })
}

describe('Google Drive link handler', () => {
  it('verifies PJSDAS identity and Drive scope, encrypts refresh token, then upserts only the current user row', async () => {
    const calls: Array<{ url: string; auth: string | null; body?: string }> = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      const body = typeof init?.body === 'string' ? init.body : undefined
      calls.push({ url, auth: headers.get('authorization'), body })

      if (url.endsWith('/auth/v1/user')) return json({ id: 'user-a', email: 'a@gmail.com' })
      if (url.startsWith('https://oauth2.googleapis.com/tokeninfo?')) {
        return json({
          sub: 'google-a',
          email: 'a@gmail.com',
          scope: 'openid email profile https://www.googleapis.com/auth/drive.appdata',
        })
      }
      if (url.includes('/rest/v1/google_drive_connections?')) return new Response(null, { status: 201 })
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch

    const handler = createGoogleLinkHandler({
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'publishable-key',
      tokenEncryptionKey: KEY,
      allowedOrigins: [ORIGIN],
      fetchImpl,
    })

    const response = await handler(request({
      providerToken: 'google-access-secret',
      providerRefreshToken: 'google-refresh-secret',
    }))

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    await expect(response.json()).resolves.toMatchObject({ status: 'connected', googleEmail: 'a@gmail.com' })

    expect(calls[0]).toMatchObject({ auth: 'Bearer pjsdas-access-token' })
    expect(calls[1]?.url).toContain('oauth2.googleapis.com/tokeninfo')
    expect(calls[2]?.url).toContain('on_conflict=user_id')
    expect(calls[2]).toMatchObject({ auth: 'Bearer pjsdas-access-token' })

    const stored = JSON.parse(calls[2]?.body ?? '{}') as Record<string, unknown>
    expect(stored.user_id).toBe('user-a')
    expect(stored.google_subject).toBe('google-a')
    expect(stored.refresh_token_ciphertext).toEqual(expect.stringMatching(/^v1\./))
    expect(stored.refresh_token_ciphertext).not.toBe('google-refresh-secret')
    expect(calls[2]?.body).not.toContain('google-access-secret')
    expect(calls[2]?.body).not.toContain('google-refresh-secret')
  })

  it('refuses to persist a Google token without drive.appdata', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/auth/v1/user')) return json({ id: 'user-a', email: 'a@gmail.com' })
      if (url.startsWith('https://oauth2.googleapis.com/tokeninfo?')) {
        return json({ sub: 'google-a', email: 'a@gmail.com', scope: 'openid email profile' })
      }
      return json({ error: 'must not write' }, 500)
    }) as unknown as typeof fetch

    const handler = createGoogleLinkHandler({
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'publishable-key',
      tokenEncryptionKey: KEY,
      allowedOrigins: [ORIGIN],
      fetchImpl,
    })

    const response = await handler(request({
      providerToken: 'google-access',
      providerRefreshToken: 'google-refresh',
    }))
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'GOOGLE_SCOPE_MISSING' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('rejects account mismatch and disallowed origins', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/auth/v1/user')) return json({ id: 'user-a', email: 'a@gmail.com' })
      if (url.startsWith('https://oauth2.googleapis.com/tokeninfo?')) {
        return json({
          sub: 'google-b',
          email: 'b@gmail.com',
          scope: 'https://www.googleapis.com/auth/drive.appdata',
        })
      }
      return json({ error: 'must not write' }, 500)
    }) as unknown as typeof fetch

    const handler = createGoogleLinkHandler({
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'publishable-key',
      tokenEncryptionKey: KEY,
      allowedOrigins: [ORIGIN],
      fetchImpl,
    })

    const mismatch = await handler(request({ providerToken: 'a', providerRefreshToken: 'b' }))
    expect(mismatch.status).toBe(400)
    await expect(mismatch.json()).resolves.toMatchObject({ code: 'GOOGLE_ACCOUNT_MISMATCH' })

    const forbidden = await handler(request(
      { providerToken: 'a', providerRefreshToken: 'b' },
      'pjsdas-access-token',
      'https://evil.example',
    ))
    expect(forbidden.status).toBe(403)
  })

  it('handles CORS preflight without touching auth services', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const handler = createGoogleLinkHandler({
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'publishable-key',
      tokenEncryptionKey: KEY,
      allowedOrigins: [ORIGIN],
      fetchImpl,
    })

    const response = await handler(new Request('https://gateway.example/api/google-link', {
      method: 'OPTIONS', headers: { origin: ORIGIN },
    }))
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
