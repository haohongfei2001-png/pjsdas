import { describe, expect, it, vi } from 'vitest'
import { createAutomationSettingsHandler } from '../gateway/automationSettingsHandler.js'

const ORIGIN = 'https://haohongfei2001-png.github.io'
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function request(method: 'GET' | 'POST', body?: unknown) {
  return new Request('https://gateway.example/api/automation-settings', {
    method,
    headers: {
      authorization: 'Bearer pjsdas-user-token',
      origin: ORIGIN,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
}

function handler(fetchImpl: typeof fetch) {
  return createAutomationSettingsHandler({
    supabaseUrl: 'https://example.supabase.co',
    supabasePublishableKey: 'publishable-key',
    allowedOrigins: [ORIGIN],
    fetchImpl,
  })
}

describe('Gmail automation settings API', () => {
  it('returns the current user automation status without exposing refresh-token material', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/auth/v1/user')) return json({ id: 'user-a', email: 'a@gmail.com' })
      if (url.includes('/rest/v1/google_drive_connections?')) return json([{
        user_id: 'user-a',
        google_email: 'a@gmail.com',
        granted_scopes: ['openid', 'https://www.googleapis.com/auth/drive.appdata', GMAIL_SCOPE],
        gmail_automation_enabled: true,
        gmail_history_id: '123',
        gmail_last_checked_at: '2026-09-15T00:00:00.000Z',
        gmail_last_success_at: '2026-09-15T00:00:00.000Z',
        gmail_last_error: null,
      }])
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch

    const response = await handler(fetchImpl)(request('GET'))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      googleEmail: 'a@gmail.com',
      gmailScopeGranted: true,
      gmailEnabled: true,
      gmailHistoryIdPresent: true,
      gmailLastCheckedAt: '2026-09-15T00:00:00.000Z',
      gmailLastSuccessAt: '2026-09-15T00:00:00.000Z',
      gmailLastError: null,
    })
  })

  it('refuses to enable automation before Gmail read-only permission exists', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/auth/v1/user')) return json({ id: 'user-a', email: 'a@gmail.com' })
      if (url.includes('/rest/v1/google_drive_connections?') && (!init?.method || init.method === 'GET')) return json([{
        user_id: 'user-a',
        google_email: 'a@gmail.com',
        granted_scopes: ['https://www.googleapis.com/auth/drive.appdata'],
        gmail_automation_enabled: false,
      }])
      return json({ error: 'must not mutate' }, 500)
    }) as unknown as typeof fetch

    const response = await handler(fetchImpl)(request('POST', { gmailEnabled: true }))
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ code: 'GOOGLE_GMAIL_SCOPE_REQUIRED' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('enables only the authenticated user row and resets the cursor for a safe bounded bootstrap', async () => {
    const writes: Array<{ url: string; body: Record<string, unknown> }> = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/auth/v1/user')) return json({ id: 'user-a', email: 'a@gmail.com' })
      if (url.includes('/rest/v1/google_drive_connections?') && (!init?.method || init.method === 'GET')) return json([{
        user_id: 'user-a',
        google_email: 'a@gmail.com',
        granted_scopes: ['https://www.googleapis.com/auth/drive.appdata', GMAIL_SCOPE],
        gmail_automation_enabled: false,
        gmail_history_id: 'old-cursor',
      }])
      if (url.includes('/rest/v1/google_drive_connections?') && init?.method === 'PATCH') {
        writes.push({ url, body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown> })
        return new Response(null, { status: 204 })
      }
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch

    const response = await handler(fetchImpl)(request('POST', { gmailEnabled: true }))
    expect(response.status).toBe(200)
    expect(writes).toHaveLength(1)
    expect(writes[0]?.url).toContain('user_id=eq.user-a')
    expect(writes[0]?.body).toMatchObject({
      gmail_automation_enabled: true,
      gmail_history_id: null,
      gmail_last_error: null,
    })
  })
})
