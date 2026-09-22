import { describe, expect, it, vi } from 'vitest'
import {
  fetchGmailAutomationBatch,
  gmailObservationFromMessage,
  UU06_MAX_MESSAGES_PER_RUN,
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
      if (url.endsWith('/profile')) return json({ historyId: '205' })
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
    expect(result.coverageComplete).toBe(true)
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
    expect(result.recoveryGapReason).toContain('cannot prove older mailbox coverage')
    expect(result.coverageComplete).toBe(true)
    expect(result.nextHistoryId).toBe('300')
    expect(result.messages.map((item) => item.id)).toEqual(['recent-1'])
    expect(calls.some((url) => new URL(url).searchParams.get('q') === 'newer_than:7d -in:spam -in:trash')).toBe(true)
    expect(calls.filter((url) => url.includes('/messages?')).every((url) => new URL(url).searchParams.get('labelIds') === 'INBOX')).toBe(true)
  })
  it('does not advance the durable history watermark until every Gmail history page is consumed', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('/profile')) return json({ historyId: '305' })
      if (url.includes('/history?') && !url.includes('pageToken=')) return json({
        historyId: '310',
        nextPageToken: 'page-2',
        history: [{ messagesAdded: [{ message: { id: 'msg-1' } }] }],
      })
      if (url.includes('/history?') && url.includes('pageToken=page-2')) return json({
        historyId: '315',
        history: [{ messagesAdded: [{ message: { id: 'msg-2' } }] }],
      })
      if (url.includes('/messages/msg-1?')) return json({ id: 'msg-1', internalDate: '1', payload: { headers: [] } })
      if (url.includes('/messages/msg-2?')) return json({ id: 'msg-2', internalDate: '2', payload: { headers: [] } })
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch

    const first = await fetchGmailAutomationBatch({
      accessToken: 'google-access',
      startHistoryId: '299',
      fetchImpl,
    })
    expect(first).toMatchObject({
      coverageComplete: false,
      usedFallbackScan: false,
      nextHistoryId: undefined,
      continuation: {
        mode: 'history',
        pageToken: 'page-2',
        pendingHistoryId: '305',
        pendingMessageIds: [],
      },
    })
    expect(first.messages.map((item) => item.id)).toEqual(['msg-1'])

    const second = await fetchGmailAutomationBatch({
      accessToken: 'google-access',
      startHistoryId: '299',
      continuation: first.continuation,
      fetchImpl,
    })
    expect(second).toMatchObject({
      coverageComplete: true,
      usedFallbackScan: false,
      nextHistoryId: '305',
      continuation: undefined,
    })
    expect(second.messages.map((item) => item.id)).toEqual(['msg-2'])
    expect(calls.some((url) => url.includes('pageToken=page-2'))).toBe(true)
  })

  it('persists message ids beyond the per-run budget instead of skipping them', async () => {
    const ids = Array.from({ length: 105 }, (_, index) => `msg-${index + 1}`)
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/profile')) return json({ historyId: '405' })
      if (url.includes('/history?')) return json({
        historyId: '405',
        history: [{
          messagesAdded: ids.map((id) => ({ message: { id } })),
        }],
      })
      const messageId = /\/messages\/([^?]+)\?/.exec(url)?.[1]
      if (messageId) return json({ id: messageId, internalDate: '1', payload: { headers: [] } })
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch

    const first = await fetchGmailAutomationBatch({
      accessToken: 'google-access',
      startHistoryId: '399',
      fetchImpl,
    })
    expect(first.coverageComplete).toBe(false)
    expect(first.messages).toHaveLength(100)
    expect(first.nextHistoryId).toBeUndefined()
    expect(first.continuation).toMatchObject({
      mode: 'history',
      pendingHistoryId: '405',
      pendingMessageIds: ids.slice(100),
    })

    const second = await fetchGmailAutomationBatch({
      accessToken: 'google-access',
      startHistoryId: '399',
      continuation: first.continuation,
      fetchImpl,
    })
    expect(second.coverageComplete).toBe(true)
    expect(second.nextHistoryId).toBe('405')
    expect(second.messages.map((item) => item.id)).toEqual(ids.slice(100))
  })
  it('keeps a 90-day archive-inclusive backfill query fixed across continuation runs', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); calls.push(url)
      if (url.endsWith('/profile')) return json({ historyId: '500' })
      if (url.includes('/messages?')) return new URL(url).searchParams.has('pageToken')
        ? json({ messages: [{ id: 'archived-2' }] })
        : json({ messages: [{ id: 'archived-1' }], nextPageToken: 'provider-page-2' })
      const id = /\/messages\/([^?]+)\?/.exec(url)?.[1]
      return json({ id, labelIds: [], internalDate: '1' })
    }) as unknown as typeof fetch
    const first = await fetchGmailAutomationBatch({ accessToken: 'test', coverage: 'uu06', fetchImpl, now: new Date('2026-09-21T00:00:00Z') })
    const second = await fetchGmailAutomationBatch({ accessToken: 'test', coverage: 'uu06', fetchImpl, continuation: first.continuation, now: new Date('2026-09-23T00:00:00Z') })
    const pages = calls.filter((url) => url.includes('/messages?')).map((url) => new URL(url))
    expect(pages[0]!.searchParams.get('q')).toBe(`after:${Date.parse('2026-06-23T00:00:00Z') / 1000} -in:spam -in:trash`)
    expect(pages.every((url) => url.searchParams.get('maxResults') === String(UU06_MAX_MESSAGES_PER_RUN))).toBe(true)
    expect(pages[1]!.searchParams.get('q')).toBe(pages[0]!.searchParams.get('q'))
    expect(pages.every((url) => !url.searchParams.has('labelIds'))).toBe(true)
    expect(pages[1]!.searchParams.get('pageToken')).toBe('provider-page-2')
    expect(first.nextHistoryId).toBeUndefined()
    expect(second.nextHistoryId).toBe('500')
    expect(second.messages[0]?.id).toBe('archived-2')
  })
  it('history includes newly archived recruiting messages without an INBOX label filter', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); calls.push(url)
      if (url.endsWith('/profile')) return json({ historyId: '502' })
      if (url.includes('/history?')) return json({ historyId: '502', history: [{ messagesAdded: [{ message: { id: 'archive' } }] }] })
      return json({ id: 'archive', labelIds: [], internalDate: '1' })
    }) as unknown as typeof fetch
    const batch = await fetchGmailAutomationBatch({ accessToken: 'test', coverage: 'uu06', startHistoryId: '500', fetchImpl })
    expect(batch.messages.map((message) => message.id)).toEqual(['archive'])
    const historyCalls = calls.filter((url) => url.includes('/history?')).map((url) => new URL(url))
    expect(historyCalls.every((url) => !url.searchParams.has('labelId'))).toBe(true)
    expect(historyCalls.every((url) => url.searchParams.get('maxResults') === String(UU06_MAX_MESSAGES_PER_RUN))).toBe(true)
  })

  it('classifies a disabled Gmail API without exposing provider error text', async () => {
    const fetchImpl = vi.fn(async () => json({
      error: {
        code: 403,
        message: 'Gmail API has not been used in project SECRET_PROJECT',
        errors: [{ reason: 'accessNotConfigured' }],
      },
    }, 403)) as unknown as typeof fetch

    await expect(fetchGmailAutomationBatch({ accessToken: 'test', fetchImpl }))
      .rejects.toMatchObject({
        code: 'GOOGLE_GMAIL_API_DISABLED',
        message: 'The Gmail API is not enabled for the Google Cloud project used by PJSDAS.',
        retryable: false,
      })
  })

  it('classifies an access token with insufficient Gmail scope as reconnect-required', async () => {
    const fetchImpl = vi.fn(async () => json({
      error: { errors: [{ reason: 'insufficientPermissions' }] },
    }, 403)) as unknown as typeof fetch

    await expect(fetchGmailAutomationBatch({ accessToken: 'test', fetchImpl }))
      .rejects.toMatchObject({ code: 'GOOGLE_GMAIL_SCOPE_MISSING', retryable: false })
  })

  it('treats Gmail 403 quota reasons as retryable instead of revoking authorization', async () => {
    const fetchImpl = vi.fn(async () => json({
      error: { errors: [{ reason: 'userRateLimitExceeded' }] },
    }, 403)) as unknown as typeof fetch

    await expect(fetchGmailAutomationBatch({ accessToken: 'test', fetchImpl }))
      .rejects.toMatchObject({ code: 'GMAIL_UNAVAILABLE', retryable: true })
  })

  it('keeps unknown Gmail 403 reasons fail-closed as forbidden', async () => {
    const fetchImpl = vi.fn(async () => json({
      error: { errors: [{ reason: 'someFutureReason' }] },
    }, 403)) as unknown as typeof fetch

    await expect(fetchGmailAutomationBatch({ accessToken: 'test', fetchImpl }))
      .rejects.toMatchObject({ code: 'GOOGLE_GMAIL_FORBIDDEN', retryable: false })
  })

})
