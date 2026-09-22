import { describe, expect, it, vi } from 'vitest'
import { createGmailPushHandler } from '../gateway/gmailPushHandler.js'

const AUDIENCE = 'https://todayaction.com/api/gmail-push'
const PUSH_SA = 'pjsdas-gmail-push@example.iam.gserviceaccount.com'
const SUBSCRIPTION = 'projects/example/subscriptions/pjsdas-gmail-events-production'

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function pushRequest(payload: unknown, token = 'header.payload.signature', subscription = SUBSCRIPTION) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64')
  return new Request(AUDIENCE, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ message: { data, messageId: 'pubsub-1' }, subscription }),
  })
}

function claims(overrides: Record<string, unknown> = {}) {
  return {
    aud: AUDIENCE,
    email: PUSH_SA,
    email_verified: 'true',
    iss: 'https://accounts.google.com',
    ...overrides,
  }
}

function handler(fetchImpl: typeof fetch) {
  return createGmailPushHandler({
    supabaseUrl: 'https://example.supabase.co',
    supabasePublishableKey: 'sb_publishable_test',
    supabaseServiceRoleKey: 'service-role-test',
    expectedAudience: AUDIENCE,
    expectedServiceAccountEmail: PUSH_SA,
    expectedSubscription: SUBSCRIPTION,
    deliveryMode: 'push',
    executionControlsEnabled: true,
    fetchImpl,
  })
}

describe('authenticated Gmail Pub/Sub push', () => {
  it('stays dormant in polling delivery mode', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const response = await createGmailPushHandler({
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'sb_publishable_test',
      supabaseServiceRoleKey: 'service-role-test',
      expectedAudience: AUDIENCE,
      expectedServiceAccountEmail: PUSH_SA,
      expectedSubscription: SUBSCRIPTION,
      deliveryMode: 'polling',
      executionControlsEnabled: true,
      fetchImpl,
    })(pushRequest({ emailAddress: 'a@example.com', historyId: '1' }))
    expect(response.status).toBe(503)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('fails closed before token verification when fenced execution is disabled', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const response = await createGmailPushHandler({
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'sb_publishable_test',
      supabaseServiceRoleKey: 'service-role-test',
      expectedAudience: AUDIENCE,
      expectedServiceAccountEmail: PUSH_SA,
      expectedSubscription: SUBSCRIPTION,
      executionControlsEnabled: false,
      fetchImpl,
    })(pushRequest({ emailAddress: 'a@example.com', historyId: '1' }))
    expect(response.status).toBe(503)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('validates Google OIDC then enqueues the existing worker without interpreting message content', async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown>; auth: string | null }> = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
      calls.push({ url, body, auth: headers.get('authorization') })
      if (url.startsWith('https://oauth2.googleapis.com/tokeninfo?')) return json(claims())
      if (url.endsWith('/rest/v1/rpc/pjsdas_enqueue_gmail_push_worker')) return json(true)
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch

    const response = await handler(fetchImpl)(pushRequest({
      emailAddress: 'Owner@Example.com',
      historyId: '998877',
    }))
    expect(response.status).toBe(204)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toMatchObject({
      auth: 'Bearer service-role-test',
      body: { target_email: 'owner@example.com', notified_history_id: '998877' },
    })
  })

  it('rejects a non-JWT bearer locally before token verification', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const response = await handler(fetchImpl)(pushRequest(
      { emailAddress: 'a@example.com', historyId: '1' },
      'not-a-jwt',
    ))
    expect(response.status).toBe(401)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects a token with the wrong audience before any Supabase call', async () => {
    const fetchImpl = vi.fn(async () => json(claims({ aud: 'https://wrong.example/push' }))) as unknown as typeof fetch
    const response = await handler(fetchImpl)(pushRequest({ emailAddress: 'a@example.com', historyId: '1' }))
    expect(response.status).toBe(401)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('rejects an authenticated push from a different subscription', async () => {
    const fetchImpl = vi.fn(async () => json(claims())) as unknown as typeof fetch
    const response = await handler(fetchImpl)(pushRequest(
      { emailAddress: 'a@example.com', historyId: '1' },
      'header.payload.signature',
      'projects/example/subscriptions/other',
    ))
    expect(response.status).toBe(403)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('acknowledges authenticated poison payloads without creating a retry loop', async () => {
    const fetchImpl = vi.fn(async () => json(claims())) as unknown as typeof fetch
    const response = await handler(fetchImpl)(pushRequest({ emailAddress: 'bad', historyId: 'not-a-number' }))
    expect(response.status).toBe(204)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('returns a retryable failure when Google token verification is temporarily unavailable', async () => {
    const fetchImpl = vi.fn(async () => json({ error: 'temporary' }, 503)) as unknown as typeof fetch
    const response = await handler(fetchImpl)(pushRequest({ emailAddress: 'a@example.com', historyId: '1' }))
    expect(response.status).toBe(503)
  })
})
