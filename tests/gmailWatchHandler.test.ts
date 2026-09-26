import { describe, expect, it, vi } from 'vitest'
import { createGmailWatchHandler } from '../gateway/gmailWatchHandler.js'

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function request(token = 'worker-token') {
  return new Request('https://gateway.example/api/automation-gmail-watch', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  })
}

describe('Gmail watch renewal worker', () => {
  it('renews only explicit UU06 bindings and persists bounded watch metadata', async () => {
    const calls: Array<{ rpc: string; body: Record<string, unknown> }> = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const rpc = String(input).split('/').at(-1) ?? ''
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      calls.push({ rpc, body })
      if (rpc === 'pjsdas_claim_gmail_automation_bindings_v5') {
        return json([{
          user_id: 'user-a',
          google_subject: 'subject-a',
          google_email: 'a@example.com',
          refresh_token_ciphertext: 'cipher',
          granted_scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
          gmail_intake_consent_version: 'uu06-v1',
          gmail_pending_message_ids: [],
        }, {
          user_id: 'legacy-user',
          google_subject: 'subject-b',
          refresh_token_ciphertext: 'cipher-b',
          granted_scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
          gmail_intake_consent_version: null,
          gmail_pending_message_ids: [],
        }])
      }
      if (rpc === 'pjsdas_update_gmail_watch_state') return json(null)
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch
    const registerGmailWatchImpl = vi.fn(async () => ({
      historyId: '777',
      expiresAt: '2026-09-27T00:00:00.000Z',
      renewedAt: '2026-09-21T00:00:00.000Z',
    }))

    const response = await createGmailWatchHandler({
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'publishable',
      tokenEncryptionKey: 'unused',
      googleClientId: 'unused',
      googleClientSecret: 'unused',
      topicName: 'projects/test/topics/gmail',
      deliveryMode: 'push',
      fetchImpl,
      registerGmailWatchImpl,
    })(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ eligibleUsers: 1, renewedUsers: 1, failedUsers: 0 })
    expect(registerGmailWatchImpl).toHaveBeenCalledTimes(1)
    expect(calls.map((call) => call.rpc)).toEqual([
      'pjsdas_claim_gmail_automation_bindings_v5',
      'pjsdas_update_gmail_watch_state',
    ])
    expect(calls[1]?.body).toMatchObject({
      target_user_id: 'user-a',
      watch_history_id: '777',
      set_watch: true,
      set_last_error: true,
    })
  })

  it('requires the existing Vault worker bearer', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const response = await createGmailWatchHandler({
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'publishable',
      tokenEncryptionKey: 'unused',
      googleClientId: 'unused',
      googleClientSecret: 'unused',
      topicName: 'projects/test/topics/gmail',
      deliveryMode: 'push',
      fetchImpl,
    })(new Request('https://gateway.example/api/automation-gmail-watch', { method: 'POST' }))
    expect(response.status).toBe(401)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
