import { describe, expect, it, vi } from 'vitest'
import { createGoogleConnectionStore } from '../gateway/googleConnectionStore.js'
import { createAutomationConnectionStore } from '../gateway/automationConnectionStore.js'
import { googleRefreshLifecycle } from '../gateway/googleRefreshLifecycle.js'
import { decryptSecret } from '../gateway/tokenCrypto.js'
const key = Buffer.alloc(32, 44).toString('base64url')

describe('Google refresh persistence fencing', () => {
  it('encrypts rotation before persistence and passes only fixed revocation metadata', async () => {
    const persist = vi.fn(async (_patch: { nextCiphertext?: string; reconnectRequired?: boolean }) => {})
    const lifecycle = googleRefreshLifecycle(key, persist)
    await lifecycle.onRefreshTokenRotated!('fictional-replacement')
    const patch = persist.mock.calls[0][0]
    expect(patch.nextCiphertext).toMatch(/^v1\./)
    expect(await decryptSecret(patch.nextCiphertext!, key)).toBe('fictional-replacement')
    expect(JSON.stringify(patch)).not.toContain('fictional-replacement')
    await lifecycle.onReconnectRequired!()
    expect(persist.mock.calls[1][0]).toEqual({ reconnectRequired: true })
  })
  it('fences owner writes against the exact encrypted binding and fails a conflict closed', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json([]))
    const store = createGoogleConnectionStore({ supabaseUrl: 'https://fixture.invalid', publishableKey: 'fixture', fetchImpl })
    await expect(store.updateRefreshState('fictional-owner', 'fictional-session', 'v1.previous', { nextCiphertext: 'v1.next' })).rejects.toMatchObject({ code: 'GOOGLE_CONNECTION_CHANGED', retryable: true })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(new URL(String(url)).searchParams.get('refresh_token_ciphertext')).toBe('eq.v1.previous')
    expect(new URL(String(url)).searchParams.get('revoked_at')).toBe('is.null')
    expect(JSON.parse(String(init?.body))).not.toHaveProperty('gmail_history_id')
  })
  it('does not read/return expired credentials for an already blocked binding', async () => {
    const fetchImpl = vi.fn(async () => Response.json([{ user_id: 'fictional-owner', google_subject: 'fictional-subject', refresh_token_ciphertext: 'v1.fixture', gmail_last_error: 'GOOGLE_AUTH_EXPIRED: reconnect' }]))
    const store = createGoogleConnectionStore({ supabaseUrl: 'https://fixture.invalid', publishableKey: 'fixture', fetchImpl })
    await expect(store.readForUser('fictional-owner', 'fictional-session')).rejects.toMatchObject({ code: 'GOOGLE_AUTH_EXPIRED' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('requires a confirmed boolean for generation-fenced state writes, retaining strict legacy void contracts', async () => {
    const store = createAutomationConnectionStore({ supabaseUrl: 'https://fixture.invalid', supabasePublishableKey: 'fixture', workerToken: 'fictional-worker', fetchImpl: async () => new Response(null, { status: 204 }) })
    await expect(store.updateDiscoveryRunState('fictional-owner', {}, 'v1.expected')).rejects.toMatchObject({ code: 'AUTH_INVALID' })
  })
  it('fences worker rotation and revocation and rejects malformed acknowledgments', async () => {
    for (const result of [false, null, {}, 'true']) {
      const fetchImpl = vi.fn(async () => Response.json(result))
      const store = createAutomationConnectionStore({ supabaseUrl: 'https://fixture.invalid', supabasePublishableKey: 'fixture', workerToken: 'fictional-worker', fetchImpl })
      await expect(store.updateGoogleRefreshState('fictional-owner', 'v1.previous', { reconnectRequired: true })).rejects.toMatchObject({ code: 'GOOGLE_CONNECTION_CHANGED' })
    }
  })
})
