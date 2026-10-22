import { describe, expect, it } from 'vitest'
import { aiCaptureProviderOutputSchema } from '../gateway/aiCaptureContract.js'

const text = 'Acme 工程师的面试原定2026年10月25日14:30，请改到2026年10月26日15:30。'
const evidence = (quote: string) => ({ start: text.indexOf(quote), end: text.indexOf(quote) + quote.length, quote })
const proposal = () => ({ kind: 'occurrence_rescheduled', occurrenceKind: 'interview', target: { company: 'Acme', role: '工程师' },
  previousStartAt: '2026-10-25T14:30:00+08:00', previousTimeEvidence: evidence('2026年10月25日14:30'),
  newTimeEvidence: evidence('2026年10月26日15:30'),
  temporal: { shape: 'fixed_range', precision: 'datetime', timezone: 'Asia/Shanghai', startAt: '2026-10-26T15:30:00+08:00' },
  confidence: 'high', evidence: evidence(text) })
const output = (candidate: unknown) => ({ contractVersion: 1, candidates: [candidate], clarifications: [] })

describe('default-off AI interview reschedule contract', () => {
  it('admits an explicit factual reschedule proposal without granting IDs or write authority', () => {
    expect(aiCaptureProviderOutputSchema.safeParse(output(proposal())).success).toBe(true)
  })
  it.each(['occurrenceId', 'scheduleNodeId', 'expectedScheduleNodeId', 'ownerKey'])('rejects provider-selected %s', field => {
    expect(aiCaptureProviderOutputSchema.safeParse(output({ ...proposal(), [field]: 'forged' })).success).toBe(false)
  })
  it.each(['occurrence_completed', 'occurrence_cancelled'])('does not expose %s or manufacture its actual timestamp', kind => {
    expect(aiCaptureProviderOutputSchema.safeParse(output({ kind, target: { company: 'Acme', role: '工程师' }, confidence: 'high', evidence: evidence(text) })).success).toBe(false)
  })
})

// Synthetic protocol fixtures, not model-quality or production activation evidence.
import { createAiCaptureContractSession, verifiedAiInterviewReschedules, type AiCaptureTrustedContext } from '../gateway/aiCaptureContract.js'
import { createSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'
import { buildWebSemanticInterpretation } from '../src/webSemanticInterpretation.js'
import { applySemanticIntake, applySemanticCompensation } from '../src/semanticIntake.js'
import { applyUserDomainCommand } from '../src/domainCommands.js'
import { opportunity } from '../e2e/fixtures/todayWorkspace.js'
import { latestScheduleOccurrence } from '../src/scheduleNodes.js'

const NOW = new Date('2026-10-22T00:00:00Z')
const wrap = (body: string) => `请导入以下转发的面试通知。\n-----Forwarded message-----\n${body}`
const NOTICE = wrap('Acme 工程师 面试通知：2026年10月25日14:30')
const CHANGE = wrap('Acme 工程师 面试改期通知：原定2026年10月25日14:30，改为2026年10月26日15:30')
function fixture() {
  const base = createSnapshot({ opportunities: [opportunity('job-a', 'Acme', '工程师'), opportunity('job-b', 'Other', 'Designer')],
    processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [] })
  const candidates = buildWebSemanticInterpretation(NOTICE, base.data.opportunities, base, [], NOW, 'Asia/Shanghai').candidates
  return applySemanticIntake(base, { contractVersion: 1, inputId: 'initial-notice', statementMode: 'assertion', candidates,
    source: { kind: 'web', sourceId: 'todayaction-web', sourceRecordId: 'initial-notice', observedAt: NOW.toISOString(), timezone: 'Asia/Shanghai' } },
    { authorized: true, now: NOW }).snapshot
}
const current = (snapshot: PJSDASSnapshot) => latestScheduleOccurrence(snapshot.data.scheduleNodes!, snapshot.data.scheduleNodes![0]!.occurrenceId)!
function trusted(snapshot = fixture(), text = CHANGE, contextRefs = ['opportunity:job-a']): AiCaptureTrustedContext {
  return { trigger: 'explicit_user_request', ownerKey: 'synthetic-owner', inputId: 'ai-change-notice', receiptId: 'trusted-receipt', text,
    timezone: 'Asia/Shanghai', referenceTime: NOW.toISOString(), workspaceRevision: 'txn:4', statementMode: 'current_intent', temporalResolutionBasis: 'source_explicit',
    source: { kind: 'web', sourceId: 'todayaction-web', sourceRecordId: 'trusted-record', observedAt: NOW.toISOString(), timezone: 'Asia/Shanghai' },
    opportunities: snapshot.data.opportunities.map(job => ({ opportunityId: job.id, company: job.company, role: job.role })), contextRefs,
    verifiedInterviewReschedules: verifiedAiInterviewReschedules(text, snapshot, NOW.toISOString(), 'Asia/Shanghai') }
}
function change(input: AiCaptureTrustedContext) {
  const span = (quote: string) => ({ start: input.text.indexOf(quote), end: input.text.indexOf(quote) + quote.length, quote })
  return { ...proposal(), previousTimeEvidence: span('2026年10月25日14:30'), newTimeEvidence: span('2026年10月26日15:30'), evidence: span(input.text) }
}
function review(input: AiCaptureTrustedContext, candidates: unknown[] = [change(input)]) {
  const session = createAiCaptureContractSession(input)
  const result = session.evaluate({ contractVersion: 1, candidates, clarifications: [] }, input)
  return { result, confirmed: session.confirm(result, input, 'explicit_user_confirmation') }
}
describe('AI preview existing-interview parity with whole-notice proof', () => {
  it('binds only trusted latest occurrence/preconditions, applies once, and supports Undo', () => {
    const base = fixture(), input = trusted(base)
    expect(input.verifiedInterviewReschedules).toHaveLength(1)
    const { result, confirmed } = review(input)
    expect(result.status).toBe('ready_for_review')
    expect(confirmed.status).toBe('confirmed_candidates')
    if (confirmed.status !== 'confirmed_candidates') throw new Error('Expected reviewed candidates')
    expect(confirmed.observation.contextRefs).toEqual(['opportunity:job-a'])
    expect(confirmed.observation.candidates[0]).toMatchObject({ kind: 'occurrence_rescheduled', expectedScheduleNodeId: current(base).id,
      expectedStartAt: current(base).temporal.startAt, target: { opportunityId: 'job-a', occurrenceId: current(base).occurrenceId } })
    expect(confirmed.observation.candidates[0]).not.toHaveProperty('previousTimeEvidence')
    const applied = applySemanticIntake(base, confirmed.observation, { authorized: true, now: NOW })
    expect(applied.status).toBe('APPLIED')
    expect(current(applied.snapshot).temporal.startAt).toBe('2026-10-26T15:30:00+08:00')
    expect(current(applied.snapshot).occurrenceId).toBe(current(base).occurrenceId)
    expect(applied.snapshot.data.actions.map(item => item.id)).toEqual(base.data.actions.map(item => item.id))
    expect(applied.snapshot.data.processEvents.map(item => item.id)).toEqual(base.data.processEvents.map(item => item.id))
    const replay = applySemanticIntake(applied.snapshot, confirmed.observation, { authorized: true, now: NOW })
    expect(replay.changed).toBe(false)
    expect(replay.snapshot.data).toEqual(applied.snapshot.data)
    const undone = applySemanticCompensation(applied.snapshot, applied.compensation!, NOW)
    expect(current(undone).id).toBe(current(base).id)
  })
  it.each([
    CHANGE.replace('改为', '可能改为'), CHANGE.replace('改为', '不要改为'), CHANGE + '，时区 PST',
    CHANGE + '，或2026年10月27日15:30', CHANGE + '，这是举例', CHANGE + '，不是我的面试',
    CHANGE.replace('2026年10月26日15:30', '明天15:30'),
  ])('does not launder omitted clause qualifiers through plausible model spans: %s', text => {
    const input = trusted(fixture(), text)
    expect(input.verifiedInterviewReschedules).toEqual([])
    expect(review(input).confirmed.status).toBe('blocked')
  })
  it('cannot retarget a selected other job or infer IDs from a missing source identity', () => {
    const wrong = trusted(fixture(), CHANGE, ['opportunity:job-b'])
    expect(review(wrong).confirmed.status).toBe('blocked')
    const input = trusted()
    expect(review(input, [{ ...change(input), target: {} }]).confirmed.status).toBe('blocked')
  })
  it('refuses completed, stale or ambiguous occurrences without modifying a different live appointment', () => {
    const base = fixture()
    const completed = applyUserDomainCommand(base, { kind: 'complete_occurrence', commandId: 'fixture-complete', occurrenceId: current(base).occurrenceId }, NOW).snapshot
    expect(trusted(completed).verifiedInterviewReschedules).toEqual([])
    const moved = applyUserDomainCommand(base, { kind: 'reschedule_occurrence', commandId: 'fixture-move', occurrenceId: current(base).occurrenceId,
      temporal: { shape: 'fixed_range', precision: 'datetime', timezone: 'Asia/Shanghai', startAt: '2026-10-27T15:30:00+08:00', resolutionBasis: 'user_explicit' } }, NOW).snapshot
    expect(trusted(moved).verifiedInterviewReschedules).toEqual([])
    const ambiguous = structuredClone(base), first = current(base)
    ambiguous.data.scheduleNodes!.push({ ...first, id: 'second-node', occurrenceId: 'second-occurrence' })
    expect(trusted(ambiguous).verifiedInterviewReschedules).toEqual([])
    const result = review(trusted(base))
    if (result.confirmed.status !== 'confirmed_candidates') throw new Error('Expected fixture preview')
    const stale = applySemanticIntake(moved, result.confirmed.observation, { authorized: true, now: NOW })
    expect(stale.status).toBe('NO_WRITE'); expect(stale.snapshot.data).toEqual(moved.data)
  })
  it('blocks the entire review when one candidate is invented or competing, including an otherwise valid manual action', () => {
    const input = trusted(), valid = change(input)
    const manual = { kind: 'manual_action', title: 'synthetic note', confidence: 'high', evidence: valid.evidence }
    const invented = { ...valid, temporal: { ...valid.temporal, startAt: '2026-10-27T15:30:00+08:00' } }
    expect(review(input, [manual, invented]).confirmed.status).toBe('blocked')
    expect(review(input, [manual, valid]).confirmed.status).toBe('blocked')
    expect(review(input, [manual]).confirmed.status).toBe('blocked')
    expect(review(input, [{ kind: 'process_event', eventType: 'interview_invite', target: valid.target, temporal: valid.temporal, confidence: 'high', evidence: valid.evidence }]).confirmed.status).toBe('blocked')
    expect(review(input, [valid, valid]).confirmed.status).toBe('blocked')
  })
})

import { prepareAiCapturePreview } from '../gateway/aiCapturePreview.js'
it('real preview preparation preserves source provenance despite generic handler user-explicit context', async () => {
  const input = trusted(), request = { text: input.text, requestId: input.inputId, timezone: input.timezone, expectedRevision: 4, contextRefs: input.contextRefs }
  const transport = async (modelRequest: { system: string; prompt: string }, before: () => Promise<void>) => {
    expect(modelRequest.prompt).not.toContain('job-a')
    expect(modelRequest.prompt).not.toContain(current(fixture()).id)
    await before()
    return JSON.stringify({ statementMode: 'current_intent', interpretation: output(change(input)) })
  }
  const prepared = await prepareAiCapturePreview(request, { ...input, temporalResolutionBasis: 'user_explicit' }, transport, async () => {})
  expect(prepared.review.status).toBe('ready_for_review')
  expect(prepared.observation?.contextRefs).toEqual(['opportunity:job-a'])
  expect(prepared.observation?.candidates[0]).toMatchObject({ kind: 'occurrence_rescheduled', temporal: { resolutionBasis: 'source_explicit' } })
})
