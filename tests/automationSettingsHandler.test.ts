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

describe('automation settings API', () => {
  it('returns Gmail and background-discovery status without exposing refresh-token material', async () => {
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
        discovery_automation_enabled: true,
        discovery_last_checked_at: '2026-09-15T01:00:00.000Z',
        discovery_last_success_at: '2026-09-15T01:00:00.000Z',
        discovery_last_error: null,
      }])
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch

    const response = await handler(fetchImpl)(request('POST', { action: 'read' }))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      googleEmail: 'a@gmail.com',
      gmailScopeGranted: true,
      gmailEnabled: true,
      gmailHistoryIdPresent: true,
      gmailLastCheckedAt: '2026-09-15T00:00:00.000Z',
      gmailLastSuccessAt: '2026-09-15T00:00:00.000Z',
      gmailLastError: null,
      discoveryEnabled: true,
      discoveryLastCheckedAt: '2026-09-15T01:00:00.000Z',
      discoveryLastSuccessAt: '2026-09-15T01:00:00.000Z',
      discoveryLastError: null,
    })
  })

  it('refuses to enable Gmail automation before Gmail read-only permission exists', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/auth/v1/user')) return json({ id: 'user-a', email: 'a@gmail.com' })
      if (url.includes('/rest/v1/google_drive_connections?') && (!init?.method || init.method === 'GET')) return json([{
        user_id: 'user-a',
        google_email: 'a@gmail.com',
        granted_scopes: ['https://www.googleapis.com/auth/drive.appdata'],
        gmail_automation_enabled: false,
        discovery_automation_enabled: false,
      }])
      return json({ error: 'must not mutate' }, 500)
    }) as unknown as typeof fetch

    const response = await handler(fetchImpl)(request('POST', { gmailEnabled: true }))
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ code: 'GOOGLE_GMAIL_SCOPE_REQUIRED' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('enables Gmail only for the authenticated user and resets the Gmail cursor', async () => {
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
        discovery_automation_enabled: false,
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
      gmail_intake_consent_version: null,
      gmail_history_id: null,
      gmail_sync_mode: null,
      gmail_page_token: null,
      gmail_pending_history_id: null,
      gmail_pending_message_ids: [],
      gmail_last_error: null,
    })
    expect(writes[0]?.body).not.toHaveProperty('discovery_automation_enabled')
  })

  it('enables background discovery without requesting Gmail scope and clears only discovery error state', async () => {
    const writes: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/auth/v1/user')) return json({ id: 'user-a', email: 'a@gmail.com' })
      if (url.includes('/rest/v1/google_drive_connections?') && (!init?.method || init.method === 'GET')) return json([{
        user_id: 'user-a',
        google_email: 'a@gmail.com',
        granted_scopes: ['https://www.googleapis.com/auth/drive.appdata'],
        gmail_automation_enabled: false,
        discovery_automation_enabled: false,
        discovery_last_error: 'old worker error',
      }])
      if (url.includes('/rest/v1/google_drive_connections?') && init?.method === 'PATCH') {
        writes.push(JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>)
        return new Response(null, { status: 204 })
      }
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch

    const response = await handler(fetchImpl)(request('POST', { discoveryEnabled: true }))
    expect(response.status).toBe(200)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ discovery_automation_enabled: true, discovery_last_error: null })
    expect(writes[0]).not.toHaveProperty('gmail_automation_enabled')
    await expect(response.json()).resolves.toMatchObject({ discoveryEnabled: true, gmailEnabled: false })
  })

  it('requires at least one recognized boolean setting', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/auth/v1/user')) return json({ id: 'user-a', email: 'a@gmail.com' })
      if (url.includes('/rest/v1/google_drive_connections?')) return json([{
        user_id: 'user-a', google_email: 'a@gmail.com', granted_scopes: [],
      }])
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch

    const response = await handler(fetchImpl)(request('POST', {}))
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })
  it.each([
    { version: undefined, missing: true, status: 200, patches: 2 },
    { version: 'uu06-v1', missing: true, status: 409, patches: 1 },
    { version: 'uu06-v1', missing: false, status: 200, patches: 1 },
    { version: 'future-v2', missing: false, status: 400, patches: 0 },
  ])('persists only explicit supported consent and fails safely before migration: $version / missing=$missing', async ({ version, missing, status, patches }) => {
    const writes: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/auth/v1/user')) return json({ id: 'user-a' })
      if (init?.method !== 'PATCH') return json([{ user_id: 'user-a', granted_scopes: [GMAIL_SCOPE] }])
      const body = JSON.parse(String(init.body)); writes.push(body)
      if (missing && 'gmail_intake_consent_version' in body) return json({ code: 'PGRST204', message: 'Missing gmail_intake_consent_version' }, 400)
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const response = await handler(fetchImpl)(request('POST', { gmailEnabled: true, gmailIntakeConsentVersion: version }))
    expect(response.status).toBe(status)
    expect(writes).toHaveLength(patches)
    if (patches) expect(writes[0]?.gmail_intake_consent_version).toBe(version ?? null)
    if (patches === 2) expect(writes[1]).not.toHaveProperty('gmail_intake_consent_version')
    if (status === 409) await expect(response.json()).resolves.toMatchObject({ code: 'GMAIL_INTAKE_NOT_DEPLOYED' })
  })

})
