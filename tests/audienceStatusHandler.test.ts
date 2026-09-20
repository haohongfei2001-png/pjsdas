import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAudienceStatusHandler } from '../gateway/audienceStatusHandler.js'

const ORIGIN = 'https://todayaction.com'

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  delete process.env.PJSDAS_AUDIENCE_MODE
  delete process.env.PJSDAS_SUPABASE_SERVICE_ROLE_KEY
})

describe('audience status first-party read contract', () => {
  it('supports POST action=read for canonical same-origin browsers', async () => {
    process.env.PJSDAS_AUDIENCE_MODE = 'allowlist'
    process.env.PJSDAS_SUPABASE_SERVICE_ROLE_KEY = 'service-role'
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/auth/v1/user')) return json({ id: 'user-a', email: 'a@example.com' })
      if (url.includes('/rest/v1/pjsdas_access_grants?')) {
        return json([{ user_id: 'user-a', email: 'a@example.com', role: 'owner' }])
      }
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch

    const handler = createAudienceStatusHandler({
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'publishable',
      allowedOrigins: [ORIGIN],
      fetchImpl,
    })
    const response = await handler(new Request('https://todayaction.com/api/access', {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        authorization: 'Bearer user-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'read' }),
    }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      authenticated: true,
      allowed: true,
      mode: 'allowlist',
      role: 'owner',
      email: 'a@example.com',
    })
  })

  it('still rejects requests without an approved Origin before touching auth', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const handler = createAudienceStatusHandler({
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'publishable',
      allowedOrigins: [ORIGIN],
      fetchImpl,
    })
    const response = await handler(new Request('https://todayaction.com/api/access', {
      method: 'GET',
      headers: { authorization: 'Bearer user-token' },
    }))
    expect(response.status).toBe(403)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
