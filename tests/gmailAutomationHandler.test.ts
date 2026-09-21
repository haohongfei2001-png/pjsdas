import { describe, expect, it, vi } from 'vitest'
import { createGmailAutomationHandler } from '../gateway/gmailAutomationHandler.js'

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function createHandler(fetchImpl: typeof fetch) {
  return createGmailAutomationHandler({
    supabaseUrl: 'https://example.supabase.co',
    supabasePublishableKey: 'sb_publishable_test',
    tokenEncryptionKey: Buffer.alloc(32, 9).toString('base64url'),
    googleClientId: 'google-client',
    googleClientSecret: 'google-secret',
    fetchImpl,
  })
}

describe('Gmail automation worker endpoint', () => {
  it('rejects requests without the scheduler Bearer token before touching Supabase', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const response = await createHandler(fetchImpl)(new Request('https://gateway.example/api/automation-gmail'))
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'AUTOMATION_AUTH_REQUIRED' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('passes the scheduler token only to the protected claim RPC and succeeds cleanly when no user is enabled', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; apikey: string | null }> = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      calls.push({ url, body, apikey: new Headers(init?.headers).get('apikey') })
      if (url.endsWith('/rest/v1/rpc/pjsdas_claim_gmail_automation_bindings_v4')) return json([])
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch

    const response = await createHandler(fetchImpl)(new Request('https://gateway.example/api/automation-gmail', {
      headers: { authorization: 'Bearer vault-worker-token' },
    }))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      processedUsers: 0,
      successfulUsers: 0,
      failedUsers: 0,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ apikey: 'sb_publishable_test' })
    expect(calls[0]?.body).toEqual({ worker_token: 'vault-worker-token' })
  })

  it('maps a rejected Vault token to 401 instead of leaking authorization-store details', async () => {
    const fetchImpl = vi.fn(async () => json({ code: '42501', message: 'permission denied' }, 403)) as unknown as typeof fetch
    const response = await createHandler(fetchImpl)(new Request('https://gateway.example/api/automation-gmail', {
      headers: { authorization: 'Bearer wrong-token' },
    }))
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'AUTOMATION_AUTH_REQUIRED' })
  })
})
