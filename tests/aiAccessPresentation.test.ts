import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { aiAccessConnectedMessage, aiAccessErrorMessage } from '../src/aiAccess/AiAccessContext.js'

const source = readFileSync(new URL('../src/aiAccess/AiAccessContext.tsx', import.meta.url), 'utf8')

describe('AI Access status presentation', () => {
  it('localizes a successful durable Google link and preserves the account identity', () => {
    expect(aiAccessConnectedMessage('user@example.com', 'zh')).toBe('AI 读取授权已连接：user@example.com')
    expect(aiAccessConnectedMessage('user@example.com', 'en')).toBe('AI read access connected: user@example.com')
  })

  it('localizes the missing durable Google authorization error', () => {
    const error = new Error('AI_ACCESS_GOOGLE_OFFLINE_AUTH_MISSING')
    expect(aiAccessErrorMessage(error, 'zh')).toContain('持续授权')
    expect(aiAccessErrorMessage(error, 'en')).toContain('durable authorization')
  })

  it('preserves unexpected provider/backend errors instead of inventing a translation', () => {
    const error = new Error('Provider temporarily unavailable')
    expect(aiAccessErrorMessage(error, 'en')).toBe('Provider temporarily unavailable')
    expect(aiAccessErrorMessage(error, 'zh')).toBe('Provider temporarily unavailable')
  })

  it('terminates one-time OAuth callback state after success or failure instead of retrying stale intent', () => {
    expect(source).toContain('function clearPendingGoogleLinkState()')
    expect(source).toContain('window.sessionStorage.removeItem(PENDING_KEY)')
    expect(source).toContain('clearCallbackUrl()')

    const persistIndex = source.indexOf('await persistGoogleLink(session)')
    expect(persistIndex).toBeGreaterThan(-1)
    const successClearIndex = source.indexOf('clearPendingGoogleLinkState()', persistIndex)
    expect(successClearIndex).toBeGreaterThan(persistIndex)

    expect(source).toMatch(/catch \(caught\) \{\n\s+clearPendingGoogleLinkState\(\)\n\s+setError\(aiAccessErrorMessage\(caught, lang\)\)/)
    expect(source).toContain('clearPendingGoogleLinkState()\n        setError(aiAccessErrorMessage(caught, lang))')
  })
})

import { gmailConsentForPending } from '../src/aiAccess/AiAccessContext.js'

describe('UU06 pending consent across OAuth upgrades', () => {
  it('does not upgrade old or URL-only Gmail pending intent', () => {
    expect(gmailConsentForPending('gmail', null)).toBeUndefined()
    expect(gmailConsentForPending(null, 'uu06-v1')).toBeUndefined()
    expect(gmailConsentForPending('drive', 'uu06-v1')).toBeUndefined()
  })
  it('consumes only the version captured at the new explicit Gmail enable interaction', () => {
    expect(gmailConsentForPending('gmail', 'uu06-v1')).toBe('uu06-v1')
    expect(gmailConsentForPending('gmail', 'unknown')).toBeUndefined()
  })
})
