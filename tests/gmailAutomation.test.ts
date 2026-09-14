import { describe, expect, it, vi } from 'vitest'
import {
  fetchGmailAutomationBatch,
  gmailObservationFromMessage,
} from '../gateway/gmailAutomation.js'
import type { Opportunity } from '../src/model.js'

function opportunity(id: string, company: string, role: string): Opportunity {
  return {
    id,
    company,
    role,
    currentStageLabel: '筛选中',
    processStage: 'screening',
    roleType: 'core',
    early: false,
    opportunityValue: 85,
    fitScore: 80,
    locallyManaged: true,
    importedAt: '2026-09-10T00:00:00.000Z',
  }
}

function encoded(text: string) {
  return Buffer.from(text, 'utf8').toString('base64url')
}

function gmailMessage(text: string, overrides: Record<string, unknown> = {}, subject = text) {
  return {
    id: 'msg-1',
    threadId: 'thread-1',
    internalDate: String(new Date('2026-09-15T01:00:00+08:00').getTime()),
    snippet: text,
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Subject', value: subject },
        { name: 'From', value: 'campus@example.com' },
      ],
      body: { data: encoded(text) },
    },
    ...overrides,
  }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('Gmail background automation', () => {
  it('turns a high-confidence interview mail into bounded structured facts without retaining raw body text', () => {
    const bodyOnlyMarker = 'BODY_ONLY_MARKER_7f31'
    const raw = `京东 AI产品经理 面试通知：请于2026年9月16日 14:30参加视频面试。${bodyOnlyMarker}`
    const observation = gmailObservationFromMessage(
      gmailMessage(raw, {}, '京东 AI产品经理 面试通知'),
      [opportunity('jd-ai-pm', '京东', 'AI产品经理')],
      new Date('2026-09-15T01:00:00+08:00'),
    )

    expect(observation).toMatchObject({
      sourceRecordId: 'msg-1',
      classification: 'recruiting',
      confidence: 'high',
      company: '京东',
      role: 'AI产品经理',
      eventType: 'interview_invite',
      timingMode: 'fixed',
      stage: 'interview',
      subject: '京东 AI产品经理 面试通知',
    })
    expect(observation?.dueAt).toBeTruthy()
    expect(JSON.stringify(observation)).not.toContain(bodyOnlyMarker)
  })

  it('downgrades a fixed-time recruiting event when the mail omits the actual time instead of guessing', () => {
    const observation = gmailObservationFromMessage(
      gmailMessage('京东 AI产品经理 面试通知，请及时参加。'),
      [opportunity('jd-ai-pm', '京东', 'AI产品经理')],
      new Date('2026-09-15T01:00:00+08:00'),
    )

    expect(observation).toMatchObject({
      classification: 'recruiting',
      confidence: 'medium',
      eventType: 'interview_invite',
    })
    expect(observation?.dueAt).toBeUndefined()
    expect(observation?.notes).toContain('真实截止或固定发生时间')
  })

  it('accounts unrelated inbox mail as ignored rather than fabricating a recruiting event', () => {
    const observation = gmailObservationFromMessage(
      gmailMessage('Your weekly product newsletter is ready'),
      [opportunity('jd-ai-pm', '京东', 'AI产品经理')],
      new Date('2026-09-15T01:00:00+08:00'),
    )

    expect(observation).toMatchObject({
      classification: 'ignored',
      confidence: 'high',
      sourceRecordId: 'msg-1',
    })
    expect(observation?.eventType).toBeUndefined()
  })

  it('uses Gmail history for incremental checks and advances to the returned history cursor', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('/profile')) return json({ historyId: '200' })
      if (url.includes('/history?')) return json({
        historyId: '205',
        history: [{ messagesAdded: [{ message: { id: 'msg-205' } }] }],
      })
      if (url.includes('/messages/msg-205?')) return json({ id: 'msg-205', internalDate: '1', payload: { headers: [] } })
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch

    const result = await fetchGmailAutomationBatch({
      accessToken: 'google-access',
      startHistoryId: '199',
      fetchImpl,
    })

    expect(result.usedFallbackScan).toBe(false)
    expect(result.nextHistoryId).toBe('205')
    expect(result.messages.map((item) => item.id)).toEqual(['msg-205'])
    expect(calls.some((url) => url.includes('startHistoryId=199'))).toBe(true)
  })

  it('falls back to a bounded recent scan if the Gmail history cursor has expired', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('/profile')) return json({ historyId: '300' })
      if (url.includes('/history?')) return json({ error: 'historyIdTooOld' }, 404)
      if (url.includes('/messages?')) return json({ messages: [{ id: 'recent-1' }] })
      if (url.includes('/messages/recent-1?')) return json({ id: 'recent-1', internalDate: '1', payload: { headers: [] } })
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch

    const result = await fetchGmailAutomationBatch({
      accessToken: 'google-access',
      startHistoryId: '1',
      fetchImpl,
    })

    expect(result.usedFallbackScan).toBe(true)
    expect(result.nextHistoryId).toBe('300')
    expect(result.messages.map((item) => item.id)).toEqual(['recent-1'])
    expect(calls.some((url) => url.includes('newer_than%3A7d'))).toBe(true)
  })
})
