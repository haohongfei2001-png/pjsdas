import { createGmailWatchHandler } from '../gateway/gmailWatchHandler.js'
import { encryptSecret } from '../gateway/tokenCrypto.js'
import { refreshGoogleAccessToken } from '../gateway/googleOAuthTokens.js'
import { describe, expect, it, vi } from 'vitest'
import { createGoogleConnectionStore } from '../gateway/googleConnectionStore.js'
import { createAutomationConnectionStore } from '../gateway/automationConnectionStore.js'
import { automationGoogleRefreshLifecycle, googleRefreshLifecycle } from '../gateway/googleRefreshLifecycle.js'
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
  it('uses trusted backend authentication only for credential mutation, with source/subject/generation binding', async () => {
    const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
    const store = createAutomationConnectionStore({ supabaseUrl: 'https://fixture.invalid', supabasePublishableKey: 'fictional-public', workerToken: 'fictional-worker',
      supabaseServiceRoleKey: 'fictional-backend', refreshSource: 'gmail', fetchImpl: async (input, init) => {
        calls.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) })
        return Response.json(String(input).includes('claim_') ? [] : true)
      } })
    await store.listDiscoveryBindings()
    await store.updateGoogleRefreshState('fictional-owner', 'v1.previous', { nextCiphertext: 'v1.next' }, undefined, 'fictional-subject')
    expect(calls[0].headers.get('authorization')).toBeNull()
    expect(calls[0].headers.get('apikey')).toBe('fictional-public')
    expect(calls[1].headers.get('authorization')).toBe('Bearer fictional-backend')
    expect(calls[1].headers.get('apikey')).toBe('fictional-backend')
    expect(calls[1].body).toMatchObject({ source_kind: 'gmail', target_user_id: 'fictional-owner', expected_subject: 'fictional-subject', expected_ciphertext: 'v1.previous', next_ciphertext: 'v1.next' })
    expect(calls[1].body).not.toHaveProperty('worker_token')
    expect(JSON.stringify(calls[1].body)).not.toContain('fictional-backend')
  })
  it('fails before contacting Google if privileged storage is not configured', async () => {
    const fetchImpl = vi.fn()
    const store = createAutomationConnectionStore({ supabaseUrl: 'https://fixture.invalid', supabasePublishableKey: 'fictional-public', workerToken: 'fictional-worker', refreshSource: 'gmail', fetchImpl })
    const lifecycle = automationGoogleRefreshLifecycle(key, { userId: 'fictional-owner', googleSubject: 'fictional-subject', refreshTokenCiphertext: 'v1.previous' }, store)
    await expect(refreshGoogleAccessToken('fictional-refresh', { clientId: 'fictional-client', clientSecret: 'fictional-secret', fetchImpl, ...lifecycle })).rejects.toMatchObject({ code: 'GOOGLE_REFRESH_STORAGE_REQUIRED', retryable: false })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it('does not fall back to worker authorization when privileged storage is denied', async () => {
    const fetchImpl = vi.fn(async () => Response.json({}, { status: 403 }))
    const store = createAutomationConnectionStore({ supabaseUrl: 'https://fixture.invalid', supabasePublishableKey: 'fictional-public', workerToken: 'fictional-worker', supabaseServiceRoleKey: 'fictional-backend', refreshSource: 'gmail', fetchImpl })
    await expect(store.updateGoogleRefreshState('fictional-owner', 'v1.previous', { nextCiphertext: 'v1.next' }, undefined, 'fictional-subject')).rejects.toMatchObject({ code: 'GOOGLE_REFRESH_STORAGE_REQUIRED', retryable: false })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('never accepts caller-provided replacement ciphertext or subject at a worker endpoint', async () => {
    const previous = await encryptSecret('fictional-old-refresh', key)
    const writes: Record<string, unknown>[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('pjsdas_claim_gmail_automation_bindings_v5')) return Response.json([{ user_id: 'fictional-owner', google_subject: 'fictional-subject', refresh_token_ciphertext: previous,
        granted_scopes: ['https://www.googleapis.com/auth/gmail.readonly'], gmail_intake_consent_version: 'uu06-v1' }])
      if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'fictional-access', refresh_token: 'fictional-provider-replacement' })
      if (url.endsWith('/watch')) return Response.json({ historyId: '123', expiration: String(Date.parse('2026-10-12T00:00:00Z')) })
      if (url.endsWith('pjsdas_update_google_refresh_state')) {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fictional-backend')
        writes.push(JSON.parse(String(init?.body))); return Response.json(true)
      }
      if (url.endsWith('pjsdas_update_google_automation_state')) return Response.json(true)
      throw new Error('Unexpected synthetic request')
    }
    const handler = createGmailWatchHandler({ supabaseUrl: 'https://fixture.invalid', supabasePublishableKey: 'fictional-public', supabaseServiceRoleKey: 'fictional-backend',
      tokenEncryptionKey: key, googleClientId: 'fictional-client', googleClientSecret: 'fictional-secret', topicName: 'projects/fictional-project/topics/fictional-events',
      deliveryMode: 'push', now: () => new Date('2026-10-05T00:00:00Z'), fetchImpl })
    const response = await handler(new Request('https://fixture.invalid/watch', { method: 'POST', headers: { authorization: 'Bearer fictional-worker', 'content-type': 'application/json' },
      body: JSON.stringify({ nextCiphertext: 'v1.caller-forged', googleSubject: 'forged-subject', userId: 'forged-user', source_kind: 'discovery' }) }))
    expect(response.status).toBe(200)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ source_kind: 'gmail', target_user_id: 'fictional-owner', expected_subject: 'fictional-subject', expected_ciphertext: previous })
    expect(await decryptSecret(String(writes[0].next_ciphertext), key)).toBe('fictional-provider-replacement')
    expect(JSON.stringify(writes[0])).not.toContain('forged')
  })
  it('fences worker rotation and revocation and rejects malformed acknowledgments', async () => {
    for (const result of [false, null, {}, 'true']) {
      const fetchImpl = vi.fn(async () => Response.json(result))
      const store = createAutomationConnectionStore({ supabaseUrl: 'https://fixture.invalid', supabasePublishableKey: 'fixture', workerToken: 'fictional-worker', supabaseServiceRoleKey: 'fictional-backend', refreshSource: 'gmail', fetchImpl })
      await expect(store.updateGoogleRefreshState('fictional-owner', 'v1.previous', { reconnectRequired: true }, undefined, 'fictional-subject')).rejects.toMatchObject({ code: 'GOOGLE_CONNECTION_CHANGED' })
    }
  })
})
