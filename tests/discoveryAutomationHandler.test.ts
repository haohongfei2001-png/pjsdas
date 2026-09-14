import { describe, expect, it, vi } from 'vitest'
import { createDiscoveryAutomationHandler } from '../gateway/discoveryAutomationHandler.js'

const CLAIM_RPC = '/rest/v1/rpc/pjsdas_claim_enabled_discovery_automation_bindings'

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function createHandler(
  fetchImpl: typeof fetch,
  options: {
    aiGatewayApiKey?: string
    aiGatewayTokenProvider?: () => Promise<string | undefined>
  } = {},
) {
  return createDiscoveryAutomationHandler({
    supabaseUrl: 'https://example.supabase.co',
    supabasePublishableKey: 'sb_publishable_test',
    tokenEncryptionKey: Buffer.alloc(32, 9).toString('base64url'),
    googleClientId: 'google-client',
    googleClientSecret: 'google-secret',
    aiGatewayApiKey: options.aiGatewayApiKey,
    aiGatewayTokenProvider: options.aiGatewayTokenProvider,
    fetchImpl,
  })
}

describe('server-owned discovery automation endpoint', () => {
  it('rejects requests without the scheduler Bearer token before touching Supabase or AI Gateway', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const response = await createHandler(fetchImpl)(new Request('https://gateway.example/api/automation-discovery'))
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'AUTOMATION_AUTH_REQUIRED' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('validates the Vault worker token and does not resolve model auth when no opted-in binding is due for work', async () => {
    const calls: string[] = []
    const tokenProvider = vi.fn(async () => 'must-not-be-used')
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith(CLAIM_RPC)) return json([])
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch

    const response = await createHandler(fetchImpl, { aiGatewayTokenProvider: tokenProvider })(new Request('https://gateway.example/api/automation-discovery', {
      headers: { authorization: 'Bearer vault-worker-token' },
    }))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ processedUsers: 0, successfulUsers: 0, failedUsers: 0 })
    expect(calls).toEqual([`https://example.supabase.co${CLAIM_RPC}`])
    expect(tokenProvider).not.toHaveBeenCalled()
  })

  it('maps a rejected Vault token to 401 without leaking authorization-store internals', async () => {
    const fetchImpl = vi.fn(async () => json({ code: '42501', message: 'permission denied' }, 403)) as unknown as typeof fetch
    const response = await createHandler(fetchImpl)(new Request('https://gateway.example/api/automation-discovery', {
      headers: { authorization: 'Bearer wrong-token' },
    }))
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'AUTOMATION_AUTH_REQUIRED' })
  })

  it('resolves the Vercel OIDC credential asynchronously for an authenticated AI Gateway probe', async () => {
    const authHeaders: string[] = []
    const tokenProvider = vi.fn(async () => 'vercel-oidc-token')
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith(CLAIM_RPC)) return json([])
      if (url === 'https://ai-gateway.vercel.sh/v1/chat/completions') {
        authHeaders.push(new Headers(init?.headers).get('authorization') ?? '')
        return json({ choices: [{ message: { content: '{"observations":[]}' } }] })
      }
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch

    const response = await createHandler(fetchImpl, { aiGatewayTokenProvider: tokenProvider })(new Request('https://gateway.example/api/automation-discovery?probe=1', {
      headers: { authorization: 'Bearer vault-worker-token' },
    }))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ probe: true, ok: true, model: 'perplexity/sonar' })
    expect(tokenProvider).toHaveBeenCalledTimes(1)
    expect(authHeaders).toEqual(['Bearer vercel-oidc-token'])
  })

  it('prefers an explicit deployment-owner AI Gateway key over dynamic OIDC resolution', async () => {
    const authHeaders: string[] = []
    const tokenProvider = vi.fn(async () => 'oidc-should-not-be-used')
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith(CLAIM_RPC)) return json([])
      if (url === 'https://ai-gateway.vercel.sh/v1/chat/completions') {
        authHeaders.push(new Headers(init?.headers).get('authorization') ?? '')
        return json({ choices: [{ message: { content: '{"observations":[]}' } }] })
      }
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch

    const response = await createHandler(fetchImpl, {
      aiGatewayApiKey: 'deployment-api-key',
      aiGatewayTokenProvider: tokenProvider,
    })(new Request('https://gateway.example/api/automation-discovery?probe=1', {
      headers: { authorization: 'Bearer vault-worker-token' },
    }))
    expect(response.status).toBe(200)
    expect(tokenProvider).not.toHaveBeenCalled()
    expect(authHeaders).toEqual(['Bearer deployment-api-key'])
  })

  it('does not trust an inbound OIDC-looking header as the deployment credential', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith(CLAIM_RPC)) return json([])
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch
    const response = await createHandler(fetchImpl)(new Request('https://gateway.example/api/automation-discovery?probe=1', {
      headers: {
        authorization: 'Bearer vault-worker-token',
        'x-vercel-oidc-token': 'attacker-controlled',
      },
    }))
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ code: 'DISCOVERY_MODEL_AUTH_REQUIRED' })
  })

  it('fails closed when dynamic OIDC resolution itself fails', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith(CLAIM_RPC)) return json([])
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch
    const response = await createHandler(fetchImpl, {
      aiGatewayTokenProvider: async () => { throw new Error('OIDC unavailable') },
    })(new Request('https://gateway.example/api/automation-discovery?probe=1', {
      headers: { authorization: 'Bearer vault-worker-token' },
    }))
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      code: 'DISCOVERY_MODEL_AUTH_REQUIRED',
      retryable: true,
    })
  })

  it('fails closed when there are opted-in user bindings but no AI Gateway deployment credential', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith(CLAIM_RPC)) {
        return json([{
          user_id: '00000000-0000-0000-0000-000000000001',
          google_subject: 'google-subject',
          google_email: 'user@example.com',
          refresh_token_ciphertext: 'ciphertext',
          granted_scopes: ['https://www.googleapis.com/auth/drive.appdata'],
          discovery_last_checked_at: null,
        }])
      }
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch

    const response = await createHandler(fetchImpl)(new Request('https://gateway.example/api/automation-discovery', {
      headers: { authorization: 'Bearer vault-worker-token' },
    }))
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ code: 'DISCOVERY_MODEL_AUTH_REQUIRED', retryable: true })
  })
})
