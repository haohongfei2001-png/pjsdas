import { describe, expect, it, vi } from 'vitest'
import {
  aiCaptureProviderOutputSchema,
  createAiCaptureContractSession,
  type AiCaptureTrustedContext,
} from '../gateway/aiCaptureContract.js'
import { semanticIntakeSchema } from '../gateway/semanticIntake.js'

function context(overrides: Partial<AiCaptureTrustedContext> = {}): AiCaptureTrustedContext {
  return {
    trigger: 'explicit_user_request', ownerKey: 'synthetic-owner', inputId: 'synthetic-capture-001', receiptId: 'trusted-receipt-001',
    text: '下周二替我安排投递 Acme 的工程师岗位；另记一条明天买咖啡。', timezone: 'Asia/Shanghai',
    referenceTime: '2026-10-19T08:00:00+08:00', workspaceRevision: 'txn:42', statementMode: 'current_intent',
    temporalResolutionBasis: 'user_explicit',
    source: { kind: 'web', sourceId: 'todayaction-web', sourceRecordId: 'trusted-record-001', sourceVersion: '1',
      observedAt: '2026-10-19T08:00:00+08:00', timezone: 'Asia/Shanghai' },
    opportunities: [{ opportunityId: 'trusted-job-1', company: 'Acme', role: '工程师' }],
    ...overrides,
  }
}
function span(input = context(), quote = input.text) {
  const start = input.text.indexOf(quote)
  return { start, end: start + quote.length, quote }
}
function application(input = context()) {
  return { kind: 'application_action', target: { company: 'Acme', role: '工程师' }, plannedDate: '2026-10-27', confidence: 'high', evidence: span(input, input.text.split('；')[0]) }
}
function output(candidates: unknown[] = [application()], clarifications: unknown[] = []) { return { contractVersion: 1, candidates, clarifications } }
function evaluate(raw: unknown, input = context()) {
  const session = createAiCaptureContractSession(input)
  const review = session.evaluate(raw, input)
  return { session, review, confirmed: session.confirm(review, input, 'explicit_user_confirmation') }
}

// These fixtures exercise protocol/binding invariants, not a model, prompt or quality score.
describe('offline AI capture candidate contract', () => {
  it('binds free-expression synthetic candidates to trusted IDs with no transport or mutation', () => {
    const outbound = vi.fn(() => { throw new Error('No network is authorized.') })
    vi.stubGlobal('fetch', outbound)
    try {
      const input = context()
      const original = structuredClone(input)
      const raw = output([application(), { kind: 'manual_action', title: '买咖啡', plannedDate: '2026-10-20', confidence: 'high', evidence: span(input, '另记一条明天买咖啡。') }])
      const before = structuredClone(raw)
      const { confirmed, review } = evaluate(raw, input)
      expect(review.status).toBe('ready_for_review')
      expect(confirmed.status).toBe('confirmed_candidates')
      if (confirmed.status !== 'confirmed_candidates') throw new Error('Expected candidate-only handoff.')
      expect(confirmed).toMatchObject({ ownerKey: input.ownerKey, receiptId: input.receiptId, expectedWorkspaceRevision: 'txn:42',
        observation: { inputId: input.inputId, source: input.source, statementMode: 'current_intent', originalText: input.text } })
      expect(confirmed.observation.candidates[0]).toMatchObject({ id: 'ai-capture:1', target: { opportunityId: 'trusted-job-1' }, evidenceRefs: [`trusted-record-001#text=0:${application(input).evidence.end}`], sourceVersionRefs: ['1'] })
      expect(semanticIntakeSchema.safeParse(confirmed.observation).success).toBe(true)
      expect(outbound).not.toHaveBeenCalled()
      expect(input).toEqual(original)
      expect(raw).toEqual(before)
    } finally { vi.unstubAllGlobals() }
  })

  it.each(['assertion', 'current_intent', 'question', 'quote', 'example', 'hypothetical', 'rewrite_request'] as const)(
    'preserves source statementMode %s instead of promoting candidates to intent', statementMode => {
      const { review, confirmed } = evaluate(output(), context({ statementMode }))
      expect(review.statementMode).toBe(statementMode)
      if (statementMode === 'assertion' || statementMode === 'current_intent') {
        expect(confirmed.status).toBe('confirmed_candidates')
        if (confirmed.status === 'confirmed_candidates') expect(confirmed.observation.statementMode).toBe(statementMode)
      } else {
        expect(review.status).toBe('no_write')
        expect(confirmed).toEqual({ status: 'blocked', reason: 'review_not_ready' })
        expect(confirmed).not.toHaveProperty('observation')
      }
    },
  )

  it.each([
    ['ownerKey', 'other-owner'], ['text', context().text + ' '], ['timezone', 'UTC'],
    ['workspaceRevision', 'txn:43'], ['referenceTime', '2026-10-20T08:00:00+08:00'],
    ['inputId', 'different-capture'], ['receiptId', 'different-receipt'], ['statementMode', 'assertion'],
    ['source', { ...context().source, sourceRecordId: 'different-source' }],
    ['opportunities', [{ ...context().opportunities[0], opportunityId: 'different-job' }]],
  ])('rejects stale %s both on response and confirmation', (field, value) => {
    const input = context(), changed = { ...input, [field]: value } as AiCaptureTrustedContext
    const session = createAiCaptureContractSession(input)
    const review = session.evaluate(output(), input)
    expect(session.confirm(review, changed, 'explicit_user_confirmation')).toEqual({ status: 'blocked', reason: 'stale' })
    expect(session.evaluate(output(), changed).status).toBe('stale')
    expect(session.confirm(review, input, 'explicit_user_confirmation').status).toBe('blocked')
  })

  it('requires separate explicit request and confirmation; automatic preview has no grant', () => {
    expect(() => createAiCaptureContractSession({ ...context(), trigger: 'automatic_preview' } as unknown as AiCaptureTrustedContext)).toThrow()
    const { session, review } = evaluate(output())
    expect(session.confirm(review, context(), 'automatic_preview' as 'explicit_user_confirmation'))
      .toEqual({ status: 'blocked', reason: 'explicit_confirmation_required' })
  })

  it('rejects forged, superseded and serialized reviews while repeat confirmations retain IDs', () => {
    const input = context(), session = createAiCaptureContractSession(input)
    const review = session.evaluate(output(), input)
    expect(session.confirm(structuredClone(review), context(), 'explicit_user_confirmation')).toEqual({ status: 'blocked', reason: 'unrecognized_review' })
    expect(Object.isFrozen(review.candidates[0].target)).toBe(true)
    session.evaluate(output([{ ...application(), plannedDate: '2026-10-28' }]), context())
    expect(session.confirm(review, context(), 'explicit_user_confirmation')).toEqual({ status: 'blocked', reason: 'unrecognized_review' })
    const latest = session.evaluate(output(), input)
    const confirmed = session.confirm(latest, input, 'explicit_user_confirmation')
    expect(session.confirm(latest, input, 'explicit_user_confirmation')).toEqual(confirmed)
    expect(() => session.evaluate(output(), input)).toThrow('new trusted input and receipt IDs')
  })

  it('preserves exact source whitespace and UTF-16 evidence offsets', () => {
    const input = context({ text: '  ☕ 买咖啡  ' })
    const raw = output([{ kind: 'manual_action', title: '买咖啡', confidence: 'high', evidence: span(input) }])
    const { confirmed } = evaluate(raw, input)
    expect(confirmed.status).toBe('confirmed_candidates')
    if (confirmed.status === 'confirmed_candidates') expect(confirmed.observation.originalText).toBe(input.text)
  })

  it.each([
    { ownerKey: 'model-owner' }, { receiptId: 'model-receipt' }, { source: context().source },
    { statementMode: 'current_intent' }, { authorizationGrantId: 'model-grant' }, { commands: [] },
  ])('rejects provider top-level authority injection %j', injected => {
    expect(evaluate({ ...output(), ...injected }).review.status).toBe('invalid_output')
  })

  it.each([
    { id: 'model-candidate' }, { evidenceRefs: ['model-source'] }, { sourceVersionRefs: ['model-version'] },
    { target: { company: 'Acme', role: '工程师', opportunityId: 'other-job' } },
    { target: { company: 'Acme', role: '工程师', occurrenceId: 'other-occurrence' } },
    { deliveryOwner: 'external_calendar' }, { authorizationGrantId: 'model-grant' }, { fitScore: 100 },
  ])('rejects candidate authority and unknown fields %j', injected => {
    expect(evaluate(output([{ ...application(), ...injected }])).review.status).toBe('invalid_output')
  })

  it.each([
    { target: {} }, { target: { company: 'Acme' } }, { target: { company: 'Acme', role: 'nonexistent' } },
    { confidence: 'medium' }, { evidence: { ...span(), quote: 'fabricated text' } },
  ])('blocks the whole mixed batch for unresolved identity/confidence/evidence %j', unresolved => {
    const { review, confirmed } = evaluate(output([application(), { ...application(), ...unresolved }]))
    expect(review.status).toBe('clarification_required')
    expect(confirmed).toEqual({ status: 'blocked', reason: 'review_not_ready' })
    expect(confirmed).not.toHaveProperty('observation')
  })

  it('blocks ambiguous same-label jobs rather than choosing a provider-friendly first match', () => {
    const input = context({ opportunities: [...context().opportunities, { opportunityId: 'trusted-job-2', company: 'Acme', role: '工程师' }] })
    expect(evaluate(output(), input).review.issues).toContainEqual(expect.objectContaining({ field: 'identity' }))
  })

  it('blocks an entire mixed batch when one invitation lacks essential time', () => {
    const missingTime = { kind: 'process_event', eventType: 'interview_invite', target: application().target, confidence: 'high', evidence: span() }
    const { review, confirmed } = evaluate(output([application(), missingTime]))
    expect(review.status).toBe('clarification_required')
    expect(review.issues).toContainEqual(expect.objectContaining({ candidateIndex: 1, field: 'time' }))
    expect(confirmed.status).toBe('blocked')
  })

  it('blocks explicit unresolved questions even if all proposed candidates look complete', () => {
    const raw = output([application()], [{ candidateIndex: null, field: 'time', question: '下午具体几点？' }])
    expect(evaluate(raw).review.status).toBe('clarification_required')
    expect(evaluate({ ...raw, clarifications: [{ candidateIndex: 4, field: 'time', question: '何时？' }] }).review.status).toBe('invalid_output')
  })

  it('preserves date precision and uses trusted temporal provenance', () => {
    const input = context({ text: 'Acme 工程师岗位的面试安排在下周二。' })
    const candidate = { kind: 'process_event', eventType: 'interview_invite', target: application().target, confidence: 'high', evidence: span(input),
      timingMode: 'fixed', temporal: { shape: 'date_only', precision: 'date', timezone: 'Asia/Shanghai', date: '2026-10-27' } }
    const { confirmed } = evaluate(output([candidate]), input)
    expect(confirmed.status).toBe('confirmed_candidates')
    if (confirmed.status === 'confirmed_candidates') {
      expect(confirmed.observation.candidates[0]).toMatchObject({ temporal: { ...candidate.temporal, resolutionBasis: 'user_explicit' } })
      expect(confirmed.observation.candidates[0]).not.toHaveProperty('temporal.startAt')
    }
    expect(evaluate(output([{ ...candidate, temporal: { ...candidate.temporal, resolutionBasis: 'system_estimate' } }])).review.status).toBe('invalid_output')
  })

  it.each([
    { shape: 'fixed_range', precision: 'datetime', timezone: 'Asia/Shanghai', startAt: '2026-02-30T10:00:00+08:00' },
    { shape: 'fixed_range', precision: 'datetime', timezone: 'Asia/Shanghai', startAt: '2026-10-27T10:00:00' },
    { shape: 'fixed_range', precision: 'datetime', timezone: 'invented/zone', startAt: '2026-10-27T10:00:00+08:00' },
    { shape: 'fixed_range', precision: 'datetime', timezone: 'Asia/Shanghai', startAt: '2026-10-27T10:00:00+08:00', endAt: '2026-10-27T09:00:00+08:00' },
    { shape: 'availability_window', precision: 'datetime', timezone: 'Asia/Shanghai', startAt: '2026-10-27T10:00:00+08:00', endAt: '2026-10-27T12:00:00+08:00', latestStartAt: '2026-10-27T13:00:00+08:00' },
    { shape: 'date_only', precision: 'date', timezone: 'Asia/Shanghai', date: '2026-02-29' },
    { shape: 'estimated_date', precision: 'date', timezone: 'Asia/Shanghai', date: '2026-10-27' },
  ])('rejects invalid or invented temporal structure %j', scheduledTemporal => {
    const { plannedDate: _, ...base } = application()
    expect(evaluate(output([{ ...base, scheduledTemporal }])).review.status).toBe('invalid_output')
  })

  it('rejects conflicting plan representations without partially confirming', () => {
    const raw = output([{ ...application(), scheduledTemporal: { shape: 'fixed_range', precision: 'datetime', timezone: 'Asia/Shanghai', startAt: '2026-10-28T09:00:00+08:00' } }])
    expect(evaluate(raw).review.status).toBe('clarification_required')
  })

  it.each(['manual_action', 'application_action'] as const)('requires user-chosen fixed times for %s arrangements', kind => {
    const input = context({ text: kind === 'manual_action' ? '下周二09:00买咖啡。' : '下周二09:00投递 Acme 的工程师岗位。' })
    const base = kind === 'manual_action' ? { kind, title: '买咖啡', confidence: 'high', evidence: span(input) }
      : { kind, target: application().target, confidence: 'high', evidence: span(input) }
    const fixed = { shape: 'fixed_range', precision: 'datetime', timezone: 'Asia/Shanghai', startAt: '2026-10-27T09:00:00+08:00' }
    expect(evaluate(output([{ ...base, scheduledTemporal: fixed }]), input).review.status).toBe('ready_for_review')
    expect(evaluate(output([{ ...base, scheduledTemporal: fixed }]), { ...input, temporalResolutionBasis: 'source_explicit' }).review.status).toBe('clarification_required')
    for (const time of [
      { shape: 'date_only', precision: 'date', timezone: 'Asia/Shanghai', date: '2026-10-27' },
      { shape: 'deadline', precision: 'datetime', timezone: 'Asia/Shanghai', deadlineAt: fixed.startAt },
      { shape: 'availability_window', precision: 'datetime', timezone: 'Asia/Shanghai', startAt: fixed.startAt, endAt: '2026-10-27T11:00:00+08:00' },
    ]) expect(evaluate(output([{ ...base, scheduledTemporal: time }])).review.status).toBe('invalid_output')
  })

  it('blocks competing plans, submissions, deadlines and new-job identities instead of applying last-write-wins', () => {
    const deadline = { kind: 'opportunity_deadline', target: application().target, deadline: '2026-10-27', precision: 'date', confidence: 'high', evidence: span() }
    const job = { kind: 'user_opportunity', company: 'Other Co', role: '设计师', confidence: 'high', evidence: span() }
    const submitted = { kind: 'application_submitted', target: application().target, occurredAt: '2026-10-19T09:00:00+08:00', confidence: 'high', evidence: span() }
    for (const candidates of [
      [application(), { ...application(), plannedDate: '2026-10-28' }],
      [deadline, { ...deadline, deadline: '2026-10-28' }],
      [submitted, { ...submitted, occurredAt: '2026-10-20T09:00:00+08:00' }],
      [job, { ...job, location: '上海' }],
    ]) {
      const { review, confirmed } = evaluate(output(candidates))
      expect(review.issues).toContainEqual(expect.objectContaining({ field: 'intent' }))
      expect(confirmed.status).toBe('blocked')
    }
  })

  it('requires date-only invitation intent and rejects contradictory or non-appointment temporal facts', () => {
    const input = context({ text: 'Acme 工程师岗位的测评日期是下周二。' })
    const candidate = { kind: 'process_event', eventType: 'assessment_invite', target: application().target, confidence: 'high', evidence: span(input),
      temporal: { shape: 'date_only', precision: 'date', timezone: 'Asia/Shanghai', date: '2026-10-27' } }
    expect(evaluate(output([candidate]), input).review.status).toBe('clarification_required')
    for (const timingMode of ['fixed', 'deadline']) {
      const specific = timingMode === 'fixed' ? input : context({ text: 'Acme 工程师岗位的测评截止日期是下周二。' })
      const { confirmed } = evaluate(output([{ ...candidate, timingMode, evidence: span(specific) }]), specific)
      expect(confirmed.status).toBe('confirmed_candidates')
      if (confirmed.status === 'confirmed_candidates') expect(confirmed.observation.candidates[0]).toMatchObject({ timingMode })
    }
    for (const eventType of ['offer', 'rejection', 'status_update', 'other']) {
      expect(evaluate(output([{ ...candidate, eventType, timingMode: 'fixed' }])).review.status).toBe('clarification_required')
    }
    expect(evaluate(output([{ ...candidate, timingMode: 'deadline', temporal: { shape: 'fixed_range', precision: 'datetime', timezone: 'Asia/Shanghai', startAt: '2026-10-27T09:00:00+08:00' } }])).review.status).toBe('clarification_required')
  })

  it('derives explicit fixed/window timing consistently for recruiting events', () => {
    for (const temporal of [
      { shape: 'fixed_range', precision: 'datetime', timezone: 'Asia/Shanghai', startAt: '2026-10-27T09:00:00+08:00' },
      { shape: 'availability_window', precision: 'datetime', timezone: 'Asia/Shanghai', startAt: '2026-10-27T09:00:00+08:00', endAt: '2026-10-27T11:00:00+08:00', latestStartAt: '2026-10-27T10:00:00+08:00' },
    ]) {
      const input = context({ text: temporal.shape === 'fixed_range' ? 'Acme 工程师岗位笔试是2026-10-27 09:00。'
        : 'Acme 工程师岗位笔试开放时间是2026-10-27 09:00-11:00，最晚10:00进入。' })
      const base = { kind: 'process_event', eventType: 'written_test_invite', target: application().target, confidence: 'high', evidence: span(input) }
      const { confirmed } = evaluate(output([{ ...base, temporal }]), input)
      expect(confirmed.status).toBe('confirmed_candidates')
      if (confirmed.status === 'confirmed_candidates') expect(confirmed.observation.candidates[0]).toMatchObject({ temporal, timingMode: temporal.shape === 'fixed_range' ? 'fixed' : 'deadline' })
    }
  })

  it('allows source-free new job facts without fabricating an application action', () => {
    const input = context({ text: '新增 Other Co 的设计师岗位。' })
    const raw = output([{ kind: 'user_opportunity', company: 'Other Co', role: '设计师', confidence: 'high', evidence: span(input) }])
    const { confirmed } = evaluate(raw, input)
    expect(confirmed.status).toBe('confirmed_candidates')
    if (confirmed.status === 'confirmed_candidates') expect(confirmed.observation.candidates.map(item => item.kind)).toEqual(['user_opportunity'])
  })

  it('requires clarification for potentially duplicate new jobs and invalid job URLs/deadlines', () => {
    for (const extra of [{ company: 'Acme', role: '工程师' }, { sourceUrl: 'javascript:alert(1)' }, { deadline: '2026-02-30' }]) {
      const raw = output([{ kind: 'user_opportunity', company: 'Other Co', role: '设计师', confidence: 'high', evidence: span(), ...extra }])
      expect(evaluate(raw).confirmed.status).toBe('blocked')
    }
  })

  it.each(['准备面试', 'Practice interview', '修改简历'])('does not restore retired Preparation task %s', title => {
    const { review, confirmed } = evaluate(output([{ kind: 'manual_action', title, confidence: 'high', evidence: span() }]))
    expect(review.issues).toContainEqual(expect.objectContaining({ field: 'unsupported' }))
    expect(confirmed.status).toBe('blocked')
  })

  it('rejects unsupported reminder/cancel/withdrawal commands and oversized batches', () => {
    for (const kind of ['reminder_intent', 'occurrence_cancelled', 'external_withdrawal', 'create_prep']) {
      expect(aiCaptureProviderOutputSchema.safeParse(output([{ ...application(), kind }])).success).toBe(false)
    }
    expect(evaluate(output(Array.from({ length: 13 }, () => application()))).review.status).toBe('invalid_output')
    expect(evaluate(output([])).review.status).toBe('no_write')
  })

  it('copies context rather than retaining caller-owned authority objects', () => {
    const input = context(), stable = structuredClone(input), session = createAiCaptureContractSession(input)
    input.ownerKey = 'changed'; input.opportunities[0].opportunityId = 'changed'
    const review = session.evaluate(output(), stable)
    const result = session.confirm(review, stable, 'explicit_user_confirmation')
    expect(result).toMatchObject({ ownerKey: stable.ownerKey, observation: { candidates: [{ target: { opportunityId: 'trusted-job-1' } }] } })
  })
})
