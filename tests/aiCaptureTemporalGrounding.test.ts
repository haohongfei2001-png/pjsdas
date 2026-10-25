import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareAiCapturePreview } from '../gateway/aiCapturePreview.js'
import type { AiCaptureTrustedContext } from '../gateway/aiCaptureContract.js'

async function preview(text: string, facts: Record<string, unknown>, options: { timezone?: string; referenceTime?: string; quote?: string } = {}) {
  const at = options.referenceTime ?? '2026-10-25T08:00:00Z'
  const timezone = options.timezone ?? 'Asia/Shanghai'
  const quote = options.quote ?? text, start = text.indexOf(quote)
  const context: Omit<AiCaptureTrustedContext, 'statementMode'> = {
    trigger: 'explicit_user_request', ownerKey: 'synthetic-owner', inputId: 'synthetic-time-001', receiptId: 'receipt-time-001', text,
    timezone, referenceTime: at, workspaceRevision: 'txn:42', temporalResolutionBasis: 'user_explicit',
    source: { kind: 'web', sourceId: 'todayaction-web', sourceRecordId: 'record-time-001', sourceVersion: '1', observedAt: at, timezone },
    opportunities: [{ opportunityId: 'saved-job', company: 'Acme', role: 'Engineer' }],
  }
  return prepareAiCapturePreview({ text, timezone, requestId: 'preview-time-001', expectedRevision: 42 }, context,
    async () => JSON.stringify({ statementMode: 'current_intent', interpretation: { contractVersion: 1, candidates: [{ ...facts,
      evidence: { start, end: start + quote.length, quote }, confidence: 'high' }], clarifications: [] } }), async () => {})
}
const target = { company: 'Acme', role: 'Engineer' }
const fixed = (startAt: string, endAt?: string, timezone = 'Asia/Shanghai') => ({ shape: 'fixed_range', precision: 'datetime', timezone, startAt, ...(endAt ? { endAt } : {}) })
const interview = (temporal: Record<string, unknown>) => ({ kind: 'process_event', target, eventType: 'interview_invite', temporal, timingMode: 'fixed' })
const outbound = vi.fn(() => { throw new Error('Real network/model calls are not authorized.') })
beforeEach(() => { outbound.mockClear(); vi.stubGlobal('fetch', outbound) })
afterEach(() => { expect(outbound).not.toHaveBeenCalled(); vi.unstubAllGlobals() })
describe('AI temporal candidate evidence through production preview (all offline)', () => {
  it('control: permits exactly stated source deadline', async () => {
    const result = await preview('Acme Engineer 的申请截止日期是2026-11-30。', { kind: 'opportunity_deadline', target: { company: 'Acme', role: 'Engineer' }, deadline: '2026-11-30', precision: 'date' })
    expect(result.review.status).toBe('ready_for_review')
  })
  it('does not enable confirmation for a deadline contradicting the exact source sentence', async () => {
    const result = await preview('Acme Engineer 的申请截止日期是2026-11-30。', { kind: 'opportunity_deadline', target: { company: 'Acme', role: 'Engineer' }, deadline: '2030-01-01', precision: 'date' })
    expect(result.observation).toBeNull()
    expect(result.review.status).toBe('clarification_required')
  })
  it('does not enable confirmation for an invented day on an undated application intent', async () => {
    const result = await preview('我要申请 Acme Engineer。', { kind: 'application_action', target: { company: 'Acme', role: 'Engineer' }, plannedDate: '2030-01-01' })
    expect(result.observation).toBeNull()
    expect(result.review.status).toBe('clarification_required')
  })
  it('does not fabricate appointment duration absent from the exact input', async () => {
    const result = await preview('Acme Engineer 的面试是2026-11-01 15:00。', { kind: 'process_event', target: { company: 'Acme', role: 'Engineer' }, eventType: 'interview_invite',
      temporal: { shape: 'fixed_range', precision: 'datetime', timezone: 'Asia/Shanghai', startAt: '2026-11-01T15:00:00+08:00', endAt: '2026-11-01T16:00:00+08:00' }, timingMode: 'fixed' })
    expect(result.observation).toBeNull()
    expect(result.review.status).toBe('clarification_required')
  })

  it.each([
    ['2026年11月1日', '2026-11-01'], ['明天', '2026-10-26'], ['下周二', '2026-10-27'], ['tomorrow', '2026-10-26'],
  ])('grounds a date-only plan from %s without fabricating a clock', async (expression, plannedDate) => {
    const result = await preview(`${expression}我要申请 Acme Engineer。`, { kind: 'application_action', target, plannedDate })
    expect(result.review.status).toBe('ready_for_review')
    expect(result.observation?.candidates[0]).not.toHaveProperty('scheduledTemporal')
  })
  it('uses the original local day, not the current time or UTC day', async () => {
    const text = '明天申请 Acme Engineer。'
    const result = await preview(text, { kind: 'application_action', target, plannedDate: '2026-10-27' }, { referenceTime: '2026-10-25T23:55:00Z' })
    expect(result.review.status).toBe('ready_for_review')
    expect((await preview(text, { kind: 'application_action', target, plannedDate: '2026-10-26' }, { referenceTime: '2026-10-25T23:55:00Z' })).observation).toBeNull()
  })
  it('accepts an undated action only without an invented date or now fallback', async () => {
    const result = await preview('我要申请 Acme Engineer。', { kind: 'application_action', target })
    expect(result.review.status).toBe('ready_for_review')
    expect(result.observation?.candidates[0]).not.toHaveProperty('plannedDate')
    expect(result.observation?.candidates[0]).not.toHaveProperty('scheduledTemporal')
  })
  it.each([
    ['2026-11-01 15:00', fixed('2026-11-01T15:00:00+08:00')],
    ['2026-11-01 15点', fixed('2026-11-01T15:00:00+08:00')],
    ['明天下午3点半', fixed('2026-10-26T15:30:00+08:00')],
    ['明天 3:30 pm', fixed('2026-10-26T15:30:00+08:00')],
    ['2026-11-01 15:00', fixed('2026-11-01T07:00:00Z')],
    ['2026-11-01 15:00-16:00', fixed('2026-11-01T15:00:00+08:00', '2026-11-01T16:00:00+08:00')],
  ])('preserves a grounded appointment %s', async (expression, temporal) => {
    const result = await preview(`Acme Engineer 的面试是${expression}。`, interview(temporal))
    expect(result.review.status).toBe('ready_for_review')
    expect(result.observation?.candidates[0]).toMatchObject({ temporal })
  })
  it('accepts user-chosen action time and a manual date plan', async () => {
    expect((await preview('我要在2026-11-01 15:00申请 Acme Engineer。', { kind: 'application_action', target,
      scheduledTemporal: fixed('2026-11-01T15:00:00+08:00') })).review.status).toBe('ready_for_review')
    expect((await preview('明天买咖啡。', { kind: 'manual_action', title: '买咖啡', plannedDate: '2026-10-26' })).review.status).toBe('ready_for_review')
    expect((await preview('买咖啡。', { kind: 'manual_action', title: '买咖啡', plannedDate: '2026-10-26' })).observation).toBeNull()
  })
  it('grounds source deadlines for both saved and new jobs, with URL text excluded as time evidence', async () => {
    expect((await preview('Acme Engineer 截止2026-11-01 15:00。', { kind: 'opportunity_deadline', target,
      deadline: '2026-11-01T15:00:00+08:00', precision: 'datetime' })).review.status).toBe('ready_for_review')
    const sourceUrl = 'https://example.test/jobs/2026-12-01'
    const facts = { kind: 'user_opportunity', company: 'New Co', role: 'Designer', sourceUrl, deadline: '2026-11-30' }
    expect((await preview(`新增 New Co Designer ${sourceUrl} 截止2026-11-30。`, facts)).review.status).toBe('ready_for_review')
    expect((await preview(`新增 New Co Designer ${sourceUrl}`, { ...facts, deadline: '2026-12-01' })).observation).toBeNull()
    expect((await preview('新增 New Co Designer，截止2026-11-30。', { ...facts, sourceUrl: undefined, deadline: '2030-01-01' })).observation).toBeNull()
  })
  it.each(['application_submitted', 'process_event'])('grounds %s occurredAt instead of inventing a timestamp', async kind => {
    const facts = { kind, target, ...(kind === 'process_event' ? { eventType: 'offer' } : {}), occurredAt: '2026-10-24T09:00:00+08:00' }
    expect((await preview('Acme Engineer 于2026-10-24 09:00已投递/收到offer。', facts)).review.status).toBe('ready_for_review')
    expect((await preview('Acme Engineer 已投递/收到offer。', facts)).observation).toBeNull()
    expect((await preview('Acme Engineer 于2026-10-24 09:00已投递/收到offer。', { ...facts, occurredAt: '2030-01-01T09:00:00+08:00' })).observation).toBeNull()
  })
  it('preserves all explicit window bounds and latest-start constraints', async () => {
    const text = 'Acme Engineer 笔试开放2026-11-01 15:00-17:00，最晚16:00进入。'
    const temporal = { shape: 'availability_window', precision: 'datetime', timezone: 'Asia/Shanghai', startAt: '2026-11-01T15:00:00+08:00', endAt: '2026-11-01T17:00:00+08:00', latestStartAt: '2026-11-01T16:00:00+08:00' }
    const facts = { kind: 'process_event', target, eventType: 'written_test_invite', temporal }
    expect((await preview(text, facts)).review.status).toBe('ready_for_review')
    for (const changed of [{ endAt: '2026-11-01T18:00:00+08:00' }, { latestStartAt: '2026-11-01T16:30:00+08:00' }, { latestStartAt: undefined }]) {
      expect((await preview(text, { ...facts, temporal: { ...temporal, ...changed } })).observation).toBeNull()
    }
  })
  it('retains supported cross-date availability windows', async () => {
    const result = await preview('Acme Engineer 笔试开放2026-11-01 15:00至2026-11-02 16:00。', { kind: 'process_event', target, eventType: 'written_test_invite',
      temporal: { shape: 'availability_window', precision: 'datetime', timezone: 'Asia/Shanghai', startAt: '2026-11-01T15:00:00+08:00', endAt: '2026-11-02T16:00:00+08:00' } })
    expect(result.review.status).toBe('ready_for_review')
  })
  it('does not project date-only input to an end-of-day deadline or appointment', async () => {
    const text = 'Acme Engineer 截止2026-11-01。'
    expect((await preview(text, { kind: 'opportunity_deadline', target, deadline: '2026-11-01T23:59:00+08:00', precision: 'datetime' })).observation).toBeNull()
    expect((await preview(text, interview(fixed('2026-11-01T09:00:00+08:00')))).observation).toBeNull()
  })
  it('keeps the existing single-plan representation and does not discard an explicit clock', async () => {
    const text = '明天15:00申请 Acme Engineer。', facts = { kind: 'application_action', target, plannedDate: '2026-10-26' }
    expect((await preview(text, facts)).observation).toBeNull()
    expect((await preview(text, { ...facts, scheduledTemporal: fixed('2026-10-26T15:00:00+08:00') })).observation).toBeNull()
  })
  it('uses the trusted user timezone and preserves DST ambiguity as clarification', async () => {
    const options = { timezone: 'America/New_York' }
    expect((await preview('Acme Engineer 面试2026-11-01 03:30。', interview(fixed('2026-11-01T03:30:00-05:00', undefined, options.timezone)), options)).review.status).toBe('ready_for_review')
    for (const [expression, instant] of [['2026-11-01 01:30', '2026-11-01T01:30:00-04:00'], ['2026-03-08 02:30', '2026-03-08T02:30:00-05:00']]) {
      expect((await preview(`Acme Engineer 面试${expression}。`, interview(fixed(instant, undefined, options.timezone)), options)).observation).toBeNull()
    }
    expect((await preview('Acme Engineer 面试2026-11-01 15:00。', interview(fixed('2026-11-01T15:00:00+08:00', undefined, 'America/New_York')))).observation).toBeNull()
  })
  it.each(['UTC', 'PST', 'America/New_York', '+03:00'])('keeps the shared resolver’s unsupported explicit source zone %s as clarification', async zone => {
    expect((await preview(`Acme Engineer 面试2026-11-01 15:00 ${zone}。`, interview(fixed('2026-11-01T15:00:00+08:00')))).observation).toBeNull()
  })
  it('does not borrow a date outside this candidate’s evidence', async () => {
    const quote = '我要申请 Acme Engineer。', text = `${quote}明天买咖啡。`
    expect((await preview(text, { kind: 'application_action', target, plannedDate: '2026-10-26' }, { quote })).observation).toBeNull()
  })
  it.each(['。', '，', '; ', '. ', '\n'])('does not borrow another activity’s time even from an exact broad evidence span separated by %s', async separator => {
    expect((await preview(`我要申请 Acme Engineer${separator}明天买咖啡。`, { kind: 'application_action', target, plannedDate: '2026-10-26' })).observation).toBeNull()
  })
  it.each(['Acme Engineer 面试，明天下午3点。', 'Acme Engineer 面试已安排。时间是明天下午3点。', 'Acme Engineer interview arranged. Time is tomorrow 3:00 pm.'])('keeps a complete time-only qualifier: %s', async text => {
    expect((await preview(text, interview(fixed('2026-10-26T15:00:00+08:00')))).review.status).toBe('ready_for_review')
  })
  it.each(['Acme Engineer interview on 2026-11-01 at 15:00, hosted by Sam.', 'Acme Engineer interview with Front-End team on 2026-11-01 at 15:00.'])('does not confuse unrelated by/end words with time-bound roles: %s', async text => {
    expect((await preview(text, interview(fixed('2026-11-01T15:00:00+08:00')))).review.status).toBe('ready_for_review')
  })
  it.each(['北京时间', '中国标准时间', '纽约当地时间', '当地时间', 'local time'])('does not silently reinterpret a named source zone %s as the user timezone', async zone => {
    expect((await preview(`Acme Engineer 面试2026-11-01 ${zone}15:00。`, interview(fixed('2026-11-01T15:00:00Z', undefined, 'UTC')), { timezone: 'UTC' })).observation).toBeNull()
  })
  it('does not use a capture timestamp as an unstated original email receipt time', async () => {
    expect((await preview('Acme Engineer 测评需收到本邮件后24小时内完成。', { kind: 'process_event', target, eventType: 'assessment_invite', temporal: {
      shape: 'deadline', precision: 'datetime', timezone: 'Asia/Shanghai', deadlineAt: '2026-10-26T08:00:00Z' } })).observation).toBeNull()
    expect((await preview('Acme Engineer 于2026-10-24 09:00收到offer邮件。', { kind: 'process_event', target, eventType: 'offer',
      occurredAt: '2026-10-24T09:00:00+08:00' })).review.status).toBe('ready_for_review')
  })
  it.each(['测评截止', '面试于'])('does not turn an explicit deadline or end into an appointment start: %s', async label => {
    const text = `Acme Engineer ${label}2026-11-01 15:00${label === '面试于' ? '结束' : ''}。`
    expect((await preview(text, interview(fixed('2026-11-01T15:00:00+08:00')))).observation).toBeNull()
  })
  it('does not turn a job deadline into a personally chosen application day', async () => {
    expect((await preview('Acme Engineer 申请截止明天。', { kind: 'application_action', target, plannedDate: '2026-10-26' })).observation).toBeNull()
  })
  it('does not evade the deadline/start distinction through a date-only event', async () => {
    const text = 'Acme Engineer 测评截止明天。'
    const facts = { kind: 'process_event', target, eventType: 'assessment_invite', temporal: { shape: 'date_only', precision: 'date', timezone: 'Asia/Shanghai', date: '2026-10-26' } }
    expect((await preview(text, { ...facts, timingMode: 'deadline' })).review.status).toBe('ready_for_review')
    expect((await preview(text, { ...facts, timingMode: 'fixed' })).observation).toBeNull()
  })
  it('requires deadline-role evidence rather than converting a fixed meeting to a job deadline', async () => {
    expect((await preview('Acme Engineer 面试明天15:00。', { kind: 'opportunity_deadline', target,
      deadline: '2026-10-26T15:00:00+08:00', precision: 'datetime' })).observation).toBeNull()
    expect((await preview('New Co Designer 面试明天15:00。', { kind: 'user_opportunity', company: 'New Co', role: 'Designer',
      deadline: '2026-10-26T15:00:00+08:00' })).observation).toBeNull()
    expect((await preview('Acme Engineer 面试明天15:00。', { kind: 'process_event', target, eventType: 'interview_invite', temporal: {
      shape: 'deadline', precision: 'datetime', timezone: 'Asia/Shanghai', deadlineAt: '2026-10-26T15:00:00+08:00' } })).observation).toBeNull()
  })
  it('does not turn a deadline, future plan, or interview end into a completed application timestamp', async () => {
    for (const [text, occurredAt] of [
      ['Acme Engineer 申请截止明天15:00。', '2026-10-26T15:00:00+08:00'],
      ['Acme Engineer 申请截止2026-10-24 15:00。', '2026-10-24T15:00:00+08:00'],
      ['Acme Engineer 面试于2026-10-24 15:00结束。', '2026-10-24T15:00:00+08:00'],
      ['Acme Engineer 于明天15:00已经提交。', '2026-10-26T15:00:00+08:00'],
    ]) expect((await preview(text, { kind: 'application_submitted', target, occurredAt })).observation).toBeNull()
    expect((await preview('Acme Engineer 面试于2026-10-24 15:00结束。', { kind: 'process_event', target, eventType: 'status_update',
      occurredAt: '2026-10-24T15:00:00+08:00' })).review.status).toBe('ready_for_review')
  })
  it('requires the temporal role to qualify this timestamp, not an unrelated clause', async () => {
    expect((await preview('Acme Engineer 面试于2026-10-24 15:00结束。此前已投递。', { kind: 'application_submitted', target,
      occurredAt: '2026-10-24T15:00:00+08:00' })).observation).toBeNull()
    expect((await preview('Acme Engineer 面试明天15:00。申请截止时间未定。', { kind: 'opportunity_deadline', target,
      deadline: '2026-10-26T15:00:00+08:00', precision: 'datetime' })).observation).toBeNull()
    expect((await preview('Acme Engineer 的申请截止时间。明天15:00。', { kind: 'opportunity_deadline', target,
      deadline: '2026-10-26T15:00:00+08:00', precision: 'datetime' })).review.status).toBe('ready_for_review')
  })
  it('does not turn an explicit fixed appointment range into an availability window', async () => {
    expect((await preview('Acme Engineer 面试2026-11-01 15:00-16:00。', { kind: 'process_event', target, eventType: 'interview_invite', temporal: {
      ...fixed('2026-11-01T15:00:00+08:00', '2026-11-01T16:00:00+08:00'), shape: 'availability_window' } })).observation).toBeNull()
  })
  it.each(['Acme Engineer I had not submitted on 2026-10-24 at 15:00.', 'Acme Engineer 不是已提交于2026-10-24 15:00。',
    'Acme Engineer I haven’t submitted on 2026-10-24 at 15:00.', "Acme Engineer I don't think I submitted on 2026-10-24 at 15:00."])(
    'does not promote negated submission evidence: %s', async text => {
    expect((await preview(text, { kind: 'application_submitted', target, occurredAt: '2026-10-24T15:00:00+08:00' })).observation).toBeNull()
    expect((await preview(text, { kind: 'application_submitted', target })).observation).toBeNull()
  })
  it('does not bypass completed-fact evidence by omitting occurredAt', async () => {
    for (const text of ['Acme Engineer 申请截止明天15:00。', 'Acme Engineer 面试于2026-10-24 15:00结束。', 'Acme Engineer 尚未提交。']) {
      expect((await preview(text, { kind: 'application_submitted', target })).observation).toBeNull()
    }
    for (const text of ['Acme Engineer 已经投递。', 'I already applied for Acme Engineer.', 'Acme Engineer。我已提交。']) {
      const result = await preview(text, { kind: 'application_submitted', target })
      expect(result.review.status).toBe('ready_for_review')
      expect(result.observation?.candidates[0]).not.toHaveProperty('occurredAt')
    }
  })
  it('does not silently omit a stated historical time and let the domain use the receipt timestamp', async () => {
    expect((await preview('Acme Engineer 于2026-10-24 09:00已投递。', { kind: 'application_submitted', target })).observation).toBeNull()
    expect((await preview('Acme Engineer 于2026-10-24 09:00收到offer。', { kind: 'process_event', eventType: 'offer', target })).observation).toBeNull()
    expect((await preview('Acme Engineer 昨天已经投递。', { kind: 'application_submitted', target })).observation).toBeNull()
    expect((await preview('Acme Engineer 收到offer。', { kind: 'process_event', eventType: 'offer', target })).review.status).toBe('ready_for_review')
  })
  it.each([
    ['2026-11-01 15:00:30', fixed('2026-11-01T15:00:00+08:00')],
    ['2026-11-01 15点30秒', fixed('2026-11-01T15:00:00+08:00')],
    ['2026-11-01 下午3点一刻', fixed('2026-11-01T15:00:00+08:00')],
    ['2026-11-01 下午3点三十分', fixed('2026-11-01T15:00:00+08:00')],
    ['2026-11-01 3:00 p.m.', fixed('2026-11-01T03:00:00+08:00')],
    ['2026-11-01 15:00或16:00', fixed('2026-11-01T15:00:00+08:00')],
    ['明天或后天15:00', fixed('2026-10-26T15:00:00+08:00')],
    ['2026-11-01 15:00-16:00，或2026-11-02 18:00', fixed('2026-11-01T15:00:00+08:00', '2026-11-01T16:00:00+08:00')],
    ['2026-11-01 15:00-16:00，或11月2日', fixed('2026-11-01T15:00:00+08:00', '2026-11-01T16:00:00+08:00')],
    ['2026-11-01 3:00-4:00 pm', fixed('2026-11-01T03:00:00+08:00', '2026-11-01T04:00:00+08:00')],
  ])('does not silently accept only a prefix of the complete time expression: %s', async (expression, temporal) => {
    expect((await preview(`Acme Engineer 面试${expression}。`, interview(temporal))).observation).toBeNull()
  })
})
