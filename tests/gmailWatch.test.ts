import { describe, expect, it, vi } from 'vitest'
import { registerGmailWatch } from '../gateway/gmailWatch.js'
import { encryptSecret } from '../gateway/tokenCrypto.js'

const KEY = Buffer.alloc(32, 21).toString('base64url')
const TOPIC = 'projects/pjsdas-test/topics/pjsdas-gmail-events'

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

describe('Gmail users.watch registration', () => {
  it('uses the existing encrypted refresh token and watches the whole mailbox without an INBOX filter', async () => {
    const encrypted = await encryptSecret('refresh-secret', KEY)
    const calls: Array<{ url: string; auth: string | null; body: string }> = []
    const now = new Date('2026-09-21T00:00:00.000Z')
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      const body = String(init?.body ?? '')
      calls.push({ url, auth: headers.get('authorization'), body })
      if (url === 'https://oauth2.googleapis.com/token') return json({ access_token: 'gmail-access-token' })
      if (url.endsWith('/gmail/v1/users/me/watch')) {
        return json({ historyId: '123456', expiration: String(now.getTime() + 6 * 86400_000) })
      }
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch

    const result = await registerGmailWatch({
      refreshTokenCiphertext: encrypted,
      tokenEncryptionKey: KEY,
      googleClientId: 'client-id',
      googleClientSecret: 'client-secret',
      topicName: TOPIC,
      fetchImpl,
      now: () => now,
    })

    expect(result).toMatchObject({
      historyId: '123456',
      renewedAt: now.toISOString(),
    })
    expect(calls).toHaveLength(2)
    expect(calls[1]?.auth).toBe('Bearer gmail-access-token')
    expect(JSON.parse(calls[1]?.body ?? '{}')).toEqual({ topicName: TOPIC })
    expect(calls[1]?.body).not.toContain('labelIds')
    expect(calls[1]?.body).not.toContain('INBOX')
  })

  it('rejects an invalid topic before contacting Google', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    await expect(registerGmailWatch({
      refreshTokenCiphertext: 'unused',
      tokenEncryptionKey: KEY,
      googleClientId: 'client-id',
      googleClientSecret: 'client-secret',
      topicName: 'not-a-topic',
      fetchImpl,
    })).rejects.toMatchObject({ code: 'GMAIL_PUSH_NOT_CONFIGURED' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
