import { describe, expect, it, vi } from 'vitest'
import { createDiscoveryAutomationHandler, discoveryAutomationTelemetryPatch } from '../gateway/discoveryAutomationHandler.js'
import type { DiscoveryGenerateText } from '../gateway/discoveryAutomationWorker.js'

const CLAIM_RPC = '/rest/v1/rpc/pjsdas_claim_enabled_discovery_automation_bindings'

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function createHandler(
  fetchImpl: typeof fetch,
  options: { generateTextImpl?: DiscoveryGenerateText } = {},
) {
  return createDiscoveryAutomationHandler({
    supabaseUrl: 'https://example.supabase.co',
    supabasePublishableKey: 'sb_publishable_test',
    tokenEncryptionKey: Buffer.alloc(32, 9).toString('base64url'),
    googleClientId: 'google-client',
    googleClientSecret: 'google-secret',
    generateTextImpl: options.generateTextImpl,
    fetchImpl,
  })
}

describe('discovery automation telemetry truth', () => {
  it('advances durable success only when at least one source run committed', () => {
    const base = {
      producer: 'server_scheduler' as const,
      checkedAt: '2026-09-25T00:00:00.000Z',
      configured: true,
      dueSourceCount: 0,
      completedSourceCount: 0,
      skippedSourceCount: 0,
      receivedCount: 0,
      accountedCount: 0,
      createdCount: 0,
      touchedCount: 0,
      unresolvedCount: 0,
    }

    expect(discoveryAutomationTelemetryPatch({
      ...base,
      state: 'checked_not_due',
    })).toEqual({
      checkedAt: base.checkedAt,
      lastError: null,
    })

    expect(discoveryAutomationTelemetryPatch({
      ...base,
      state: 'committed',
      dueSourceCount: 1,
      completedSourceCount: 1,
    })).toEqual({
      checkedAt: base.checkedAt,
      successAt: base.checkedAt,
      lastError: null,
    })
  })
})

describe('server-owned discovery automation endpoint', () => {
  it('rejects requests without the scheduler Bearer token before touching Supabase or the model', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const generateTextImpl = vi.fn(async () => ({ text: '{"observations":[]}' }))
    const response = await createHandler(fetchImpl, { generateTextImpl })(new Request('https://gateway.example/api/automation-discovery'))
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'AUTOMATION_AUTH_REQUIRED' })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(generateTextImpl).not.toHaveBeenCalled()
  })

  it('validates the Vault worker token and does not invoke AI SDK when no opted-in binding needs work', async () => {
    const calls: string[] = []
    const generateTextImpl = vi.fn(async () => ({ text: '{"observations":[]}' }))
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith(CLAIM_RPC)) return json([])
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch

    const response = await createHandler(fetchImpl, { generateTextImpl })(new Request('https://gateway.example/api/automation-discovery', {
      headers: { authorization: 'Bearer vault-worker-token' },
    }))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ processedUsers: 0, successfulUsers: 0, failedUsers: 0 })
    expect(calls).toEqual([`https://example.supabase.co${CLAIM_RPC}`])
    expect(generateTextImpl).not.toHaveBeenCalled()
  })

  it('maps a rejected Vault token to 401 without leaking authorization-store internals', async () => {
    const fetchImpl = vi.fn(async () => json({ code: '42501', message: 'permission denied' }, 403)) as unknown as typeof fetch
    const response = await createHandler(fetchImpl)(new Request('https://gateway.example/api/automation-discovery', {
      headers: { authorization: 'Bearer wrong-token' },
    }))
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'AUTOMATION_AUTH_REQUIRED' })
  })

  it('runs an authenticated zero-observation probe through the injected AI SDK boundary', async () => {
    const seen: Array<Record<string, unknown>> = []
    const generateTextImpl: DiscoveryGenerateText = vi.fn(async (input) => {
      seen.push(input as unknown as Record<string, unknown>)
      return { text: '{"observations":[]}' }
    })
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith(CLAIM_RPC)) return json([])
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch

    const response = await createHandler(fetchImpl, { generateTextImpl })(new Request('https://gateway.example/api/automation-discovery?probe=1', {
      headers: { authorization: 'Bearer vault-worker-token' },
    }))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ probe: true, ok: true, model: 'perplexity/sonar' })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ model: 'perplexity/sonar', temperature: 0.1, maxOutputTokens: 5000 })
  })

  it('does not treat an inbound OIDC-looking header as model identity', async () => {
    const generateTextImpl: DiscoveryGenerateText = vi.fn(async () => {
      throw { statusCode: 401 }
    })
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith(CLAIM_RPC)) return json([])
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch

    const response = await createHandler(fetchImpl, { generateTextImpl })(new Request('https://gateway.example/api/automation-discovery?probe=1', {
      headers: {
        authorization: 'Bearer vault-worker-token',
        'x-vercel-oidc-token': 'attacker-controlled',
      },
    }))
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      code: 'DISCOVERY_MODEL_AUTH_REQUIRED',
      retryable: false,
    })
    expect(generateTextImpl).toHaveBeenCalledTimes(1)
  })

  it('preserves bounded credit and transient provider failure semantics from the AI SDK error status', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith(CLAIM_RPC)) return json([])
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch

    const credits = await createHandler(fetchImpl, {
      generateTextImpl: async () => { throw { statusCode: 402 } },
    })(new Request('https://gateway.example/api/automation-discovery?probe=1', {
      headers: { authorization: 'Bearer vault-worker-token' },
    }))
    expect(credits.status).toBe(500)
    await expect(credits.json()).resolves.toMatchObject({ code: 'DISCOVERY_MODEL_CREDITS_REQUIRED', retryable: false })

    const unavailable = await createHandler(fetchImpl, {
      generateTextImpl: async () => { throw { statusCode: 503 } },
    })(new Request('https://gateway.example/api/automation-discovery?probe=1', {
      headers: { authorization: 'Bearer vault-worker-token' },
    }))
    expect(unavailable.status).toBe(503)
    await expect(unavailable.json()).resolves.toMatchObject({ code: 'DISCOVERY_MODEL_UNAVAILABLE', retryable: true })
  })
})
