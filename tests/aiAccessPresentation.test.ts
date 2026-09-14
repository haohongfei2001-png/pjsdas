import { describe, expect, it } from 'vitest'
import { aiAccessConnectedMessage, aiAccessErrorMessage } from '../src/aiAccess/AiAccessContext.js'

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
})
