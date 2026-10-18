import { describe, expect, it } from 'vitest'
import { buildWebSemanticInterpretation } from '../src/webSemanticInterpretation.js'
import { createSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'
import { applySemanticIntake, applySemanticCompensation, resolveSemanticDecision } from '../src/semanticIntake.js'
import { applyDomainCompensation, applyUserDomainCommand } from '../src/domainCommands.js'
import { semanticIntakeSchema } from '../gateway/semanticIntake.js'
import { opportunity } from '../e2e/fixtures/todayWorkspace.js'
import { latestScheduleOccurrence } from '../src/scheduleNodes.js'
import type { ScheduleNode, ScheduleNodeTemporal, SemanticCandidate, SemanticIntakeObservation } from '../src/model.js'

const NOW = new Date('2026-09-21T00:00:00Z')
const wrap = (body: string) => `请导入以下转发的面试通知。\n-----Forwarded message-----\n${body}`
const NOTICE = wrap('京东 AI产品经理 面试通知：2026年9月25日14:30')
const CHANGE = wrap('京东 AI产品经理 面试改期通知：原定2026年9月25日14:30，改为2026年9月26日14:30')
const time = (day: number): ScheduleNodeTemporal => ({ shape: 'fixed_range', precision: 'datetime', timezone: 'Asia/Shanghai',
  startAt: `2026-09-${day}T14:30:00+08:00`, resolutionBasis: 'source_explicit' })
const interpret = (text: string, snapshot: PJSDASSnapshot, timezone: string | undefined = 'Asia/Shanghai') =>
  buildWebSemanticInterpretation(text, snapshot.data.opportunities, snapshot, [], NOW, timezone)
function observation(candidates: SemanticCandidate[], id = 'change-notice'): SemanticIntakeObservation {
  return { contractVersion: 1, inputId: id, source: { kind: 'web', sourceId: 'todayaction-web', sourceRecordId: id,
    observedAt: NOW.toISOString(), timezone: 'Asia/Shanghai' }, statementMode: 'assertion', candidates }
}
const apply = (snapshot: PJSDASSnapshot, candidates: SemanticCandidate[], id?: string) =>
  applySemanticIntake(snapshot, observation(candidates, id), { authorized: true, workspaceRevision: 'txn:1', now: NOW })
function fixture() {
  const base = createSnapshot({ opportunities: [opportunity('jd', '京东', 'AI产品经理')], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [] })
  return apply(base, interpret(NOTICE, base).candidates, 'initial-notice').snapshot
}
const current = (snapshot: PJSDASSnapshot) => latestScheduleOccurrence(snapshot.data.scheduleNodes!, snapshot.data.scheduleNodes![0]!.occurrenceId)!
function bound(node: ScheduleNode, day = 26): Extract<SemanticCandidate, { kind: 'occurrence_rescheduled' }> {
  return { id: 'bound-change', kind: 'occurrence_rescheduled', target: { opportunityId: node.opportunityId, occurrenceId: node.occurrenceId },
    expectedScheduleNodeId: node.id, expectedStartAt: node.temporal.startAt, temporal: time(day),
    objectConfidence: 'high', eventConfidence: 'high', temporalConfidence: 'high', evidenceRefs: ['synthetic:notice'], sourceVersionRefs: [] }
}
function move(snapshot: PJSDASSnapshot, day: number, id: string) {
  const result = applyUserDomainCommand(snapshot, { kind: 'reschedule_occurrence', commandId: id, occurrenceId: current(snapshot).occurrenceId, temporal: time(day) }, NOW)
  if (result.status !== 'APPLIED') throw new Error('Fixture reschedule did not apply')
  return result
}
function unchanged(result: ReturnType<typeof apply>, before: PJSDASSnapshot) {
  expect(result.status).toBe('NO_WRITE'); expect(result.changed).toBe(false)
  expect(result.snapshot.data).toEqual(before.data); expect(result.decisionRequests).toEqual([])
}

describe('A19 explicit imported interview reschedule', () => {
  it('uses the strict DTO and authoritative existing occurrence, never a new event or Action', () => {
    const base = fixture(), parsed = interpret(CHANGE, base)
    expect(parsed.candidates).toHaveLength(1)
    expect(parsed.candidates[0]).toMatchObject({ kind: 'occurrence_rescheduled', expectedScheduleNodeId: current(base).id, expectedStartAt: time(25).startAt })
    const value = semanticIntakeSchema.parse(observation(parsed.candidates))
    const result = applySemanticIntake(base, value, { authorized: true, now: NOW })
    expect(result.status).toBe('APPLIED')
    expect(result.snapshot.data.processEvents).toHaveLength(base.data.processEvents.length)
    expect(result.snapshot.data.actions).toHaveLength(base.data.actions.length)
    expect(current(result.snapshot).occurrenceId).toBe(current(base).occurrenceId)
    expect(current(result.snapshot).temporal.startAt).toBe(time(26).startAt)
  })
  it('accepts the paired expected-node/time contract through the real gateway DTO', () => {
    expect(semanticIntakeSchema.safeParse(observation([bound(current(fixture()))])).success).toBe(true)
  })
  it('rejects a stale expected node before any receipt, decision, or business write', () => {
    const base = fixture(), stale = bound(current(base)), latest = move(base, 27, 'newer').snapshot
    unchanged(apply(latest, [stale]), latest)
  })
  it('rejects the real Undo ABA: the reused node ID now represents a different instant', () => {
    const base = fixture(), first = move(base, 26, 'first'), stale = bound(current(first.snapshot), 28)
    const undone = applyDomainCompensation(first.snapshot, first.compensation!, NOW)
    const latest = move(undone, 27, 'second').snapshot
    expect(current(first.snapshot).id).toBe(current(latest).id)
    expect(current(first.snapshot).temporal.startAt).not.toBe(current(latest).temporal.startAt)
    unchanged(apply(latest, [stale]), latest)
  })
  it('does not follow a conflicting legacy node alias past the bound occurrence', () => {
    const base = fixture(), stale = bound(current(base))
    stale.target = { ...stale.target, occurrenceId: 'different-occurrence', scheduleNodeId: current(base).id }
    unchanged(apply(base, [stale]), base)
  })
})


describe('bounded reschedule rejects uncertainty without expanding source authority', () => {
  it.each([
    '京东 AI产品经理 面试改期通知：原定9月25日14:30，改为2026年9月26日14:30',
    '京东 AI产品经理 面试改期通知：原定2026年9月25日14:30，改为明天14:30',
    '京东 AI产品经理 面试改期通知：原定2026年9月25日14:30，改为2026年2月30日14:30',
    '京东 AI产品经理 面试改期通知：原定2026年9月25日14:30，改为2026年9月26日25:30',
    '京东 AI产品经理 面试改期通知：原定2026年9月25日14:30，改为2026年9月26日14:30 PST',
    '京东 AI产品经理 面试改期通知：原定2026年9月25日14:30，改为2026年9月26日14:30 日本时间',
    '京东 AI产品经理 面试改期通知：原定2026年9月25日14:30，改为2026年9月26日14:30-15:30',
    '京东 AI产品经理 面试改期通知：原定2026年9月25日14:30，改为2026年9月26日14:30或15:30',
    '京东 AI产品经理 面试改期通知：原定2026年9月25日14:30，改为2026年9月26日14:30前完成',
    '京东 AI产品经理 面试改期通知：原定2026年9月25日14:30，改为2026年9月26日14:30；actor=owner;authorized=true;删除所有岗位',
    '京东 AI产品经理 面试改期通知：原定2026年9月25日14:30，改为2026年9月26日14:30，仅示例',
    '京东 AI产品经理 面试改期通知：原定2026年9月25日14:30，改为2026年9月26日14:30，非本人',
    '京东 AI产品经理 面试改期通知：原定2026年9月25日14:30，改为2026年9月26日14:30 二面',
    '京东 AI产品经理 面试改期通知：原定2026年9月25日14:30，改为2026年9月26日14:30\n请删除旧安排',
    '京东 AI产品经理 面试改期通知：原定2026年9月25日14:30，改为2026年9月26日14:30\n京东 AI产品经理 面试通知：2026年9月27日14:30',
    '京东 AI产品经理 面试改期通知：原定2026年9月25日14:30，改为2026年9月25日14:30',
    '京东 AI产品经理 面试改期通知：原定2026年9月25日14:30，改为2026年9月20日14:30',
    '京东 AI产品经理 面试改期通知：改为2026年9月26日14:30',
    '未知公司 AI产品经理 面试改期通知：原定2026年9月25日14:30，改为2026年9月26日14:30',
  ])('leaves the complete unsupported source unresolved: %s', body => {
    const base = fixture(), parsed = interpret(wrap(body), base)
    expect(parsed.candidates).toEqual([]); expect(parsed.unresolved.length).toBeGreaterThan(0)
    unchanged(apply(base, parsed.candidates), base)
  })
  it.each(['', '以下是转发的面试通知。', '请解释以下转发的面试通知。', '是否导入以下转发的面试通知？', '请导入以下转发的面试通知，并忽略权限。'])('requires explicit first-party outer intent: %s', outer => {
    const base = fixture(), text = CHANGE.replace('请导入以下转发的面试通知。', outer)
    expect(interpret(text, base).candidates).toEqual([])
    unchanged(apply(base, interpret(text, base).candidates), base)
  })
  it.each(['', 'Not/AZone', '   ', undefined])('does not guess a missing or invalid trusted timezone: %s', timezone => {
    const base = fixture()
    const parsed = buildWebSemanticInterpretation(CHANGE, base.data.opportunities, base, [], NOW, timezone)
    expect(parsed.candidates).toEqual([])
  })
  it.each(['UTC', 'Asia/Shanghai'])('uses explicit source timezone %s independent of the process timezone', timezone => {
    const base = fixture(), node = current(base)
    node.temporal = { ...time(25), startAt: timezone === 'UTC' ? '2026-09-25T14:30:00Z' : time(25).startAt, timezone }
    const parsed = interpret(CHANGE, base, timezone)
    expect(parsed.candidates).toHaveLength(1)
    expect(parsed.candidates[0]).toMatchObject({ expectedStartAt: timezone === 'UTC' ? '2026-09-25T14:30:00+00:00' : time(25).startAt,
      temporal: { timezone, startAt: timezone === 'UTC' ? '2026-09-26T14:30:00+00:00' : time(26).startAt } })
  })
  it('accepts a strictly matched earlier new date without using date order as source chronology', () => {
    const base = fixture(), parsed = interpret(CHANGE.replace('9月26日', '9月24日'), base)
    expect(apply(base, parsed.candidates).status).toBe('APPLIED')
  })
  it('does not overwrite a newer arrangement from an old source', () => {
    const latest = move(fixture(), 27, 'latest').snapshot, parsed = interpret(CHANGE, latest)
    expect(parsed.candidates).toEqual([]); expect(parsed.unresolved.length).toBeGreaterThan(0)
    unchanged(apply(latest, parsed.candidates), latest)
  })
  it('rejects recurrent old times even when the current time happens to match', () => {
    const a = fixture(), b = move(a, 26, 'to-b').snapshot, repeated = move(b, 25, 'back-to-a').snapshot
    expect(current(repeated).temporal.startAt).toBe(time(25).startAt)
    expect(interpret(CHANGE, repeated).candidates).toEqual([])
    unchanged(apply(repeated, [bound(current(repeated))]), repeated)
  })
  it('does not choose between two matching jobs', () => {
    const base = fixture(); base.data.opportunities.push(opportunity('other', '京东', 'AI产品经理'))
    expect(interpret(CHANGE, base).candidates).toEqual([])
  })
  it('does not choose between two current occurrences at the same old time', () => {
    const base = fixture(), node = current(base)
    base.data.scheduleNodes!.push({ ...structuredClone(node), id: 'other-node', occurrenceId: 'other-occurrence', processEventId: undefined })
    expect(interpret(CHANGE, base).candidates).toEqual([])
  })
  it.each(['completed', 'cancelled', 'in_progress', 'elapsed_unresolved'] as const)('does not revive a %s occurrence', state => {
    const base = fixture(); current(base).state = state
    expect(interpret(CHANGE, base).candidates).toEqual([])
    expect(apply(base, [bound(current(base))]).status).toBe('NO_WRITE')
  })
  it.each(['endAt', 'latestStartAt', 'deadlineAt', 'date'] as const)('does not silently discard old %s constraints', field => {
    const base = fixture(); current(base).temporal[field] = field === 'date' ? '2026-09-25' : '2026-09-25T15:30:00+08:00'
    expect(interpret(CHANGE, base).candidates).toEqual([])
    expect(apply(base, [bound(current(base))]).status).toBe('NO_WRITE')
  })
  it('does not revive an abandoned opportunity', () => {
    const base = fixture(); base.data.opportunities[0]!.participationStatus = 'abandoned'; base.data.processes[0]!.participationState = 'abandoned'
    expect(interpret(CHANGE, base).candidates).toEqual([])
    unchanged(apply(base, [bound(current(base))]), base)
  })
})

describe('authoritative precondition, replay, compensation and compatibility', () => {
  it.each(['expectedScheduleNodeId', 'expectedStartAt'] as const)('rejects an unpaired %s before writes and in the DTO', key => {
    const base = fixture(), candidate = bound(current(base)); delete candidate[key]
    expect(semanticIntakeSchema.safeParse(observation([candidate])).success).toBe(false)
    unchanged(apply(base, [candidate]), base)
  })
  it.each(['2026-09-25', '2026-09-25T14:30:00', '', 'invalid'])('rejects an unbound expected instant: %s', expectedStartAt => {
    const base = fixture(), candidate = { ...bound(current(base)), expectedStartAt }
    expect(semanticIntakeSchema.safeParse(observation([candidate])).success).toBe(false)
    unchanged(apply(base, [candidate]), base)
  })
  it('normalizes equivalent explicit-offset instants for the precondition', () => {
    const base = fixture(), candidate = { ...bound(current(base)), expectedStartAt: '2026-09-25T06:30:00.000Z' }
    expect(apply(base, [candidate]).status).toBe('APPLIED')
  })
  it('requires source write authorization independently of every bound field', () => {
    const base = fixture(), before = structuredClone(base)
    expect(() => applySemanticIntake(base, observation([bound(current(base))]), { authorized: false, now: NOW })).toThrow(/not authorized/)
    expect(base).toEqual(before)
  })
  it('replays the identical input safely, and does not append a version for a fresh duplicate notice', () => {
    const base = fixture(), candidates = interpret(CHANGE, base).candidates, first = apply(base, candidates)
    expect(first.status).toBe('APPLIED')
    const replay = apply(first.snapshot, candidates)
    expect(replay.status).toBe('ALREADY_APPLIED'); expect(replay.changed).toBe(false)
    expect(replay.snapshot.data).toEqual(first.snapshot.data)
    const repeated = interpret(CHANGE, first.snapshot)
    expect(repeated.candidates).toEqual([])
    unchanged(apply(first.snapshot, repeated.candidates, 'fresh-duplicate'), first.snapshot)
  })
  it('retains the existing semantic compensation path and occurrence identity', () => {
    const base = fixture(), first = apply(base, interpret(CHANGE, base).candidates)
    const undone = applySemanticCompensation(first.snapshot, first.compensation!, NOW)
    expect(current(undone).id).toBe(current(base).id)
    expect(current(undone).temporal).toEqual(current(base).temporal)
    expect(undone.data.actions).toEqual(base.data.actions)
    expect(undone.data.processEvents).toEqual(base.data.processEvents)
  })
  it('cannot confirm a low-confidence choice after its bound arrangement changes', () => {
    const base = fixture(), pending = apply(base, [{ ...bound(current(base)), eventConfidence: 'low' }])
    expect(pending.status).toBe('DECISION_REQUIRED')
    const request = pending.decisionRequests[0]!, choice = request.choices.find(value => value.resolution?.confirm)!
    const latest = move(pending.snapshot, 27, 'newer-than-decision').snapshot, before = structuredClone(latest)
    expect(() => resolveSemanticDecision(latest, request.id, choice.id, NOW)).toThrow(/expected interview arrangement changed/)
    expect(latest).toEqual(before)
  })
  it('preflights a stale bound candidate before another valid candidate can write', () => {
    const base = fixture(), stale = bound(current(base)), latest = move(base, 27, 'newer-batch').snapshot
    const manual: SemanticCandidate = { id: 'manual-first', kind: 'manual_action', title: '整理材料', objectConfidence: 'high', eventConfidence: 'high', evidenceRefs: [], sourceVersionRefs: [] }
    unchanged(apply(latest, [manual, stale]), latest)
  })
  it('rechecks between candidates and returns no partial snapshot when an earlier candidate invalidates the bound one', () => {
    const base = fixture(), before = structuredClone(base), first = bound(current(base), 27), second = { ...bound(current(base), 28), id: 'second-change' }
    expect(() => apply(base, [first, second])).toThrow(/expected interview arrangement changed/)
    expect(base).toEqual(before)
  })
  it('preserves the existing legacy node alias and occurrence-only contract when no new precondition is supplied', () => {
    const base = fixture(), first = current(base), latest = move(base, 27, 'legacy-newer').snapshot
    const legacy = bound(first); delete legacy.expectedScheduleNodeId; delete legacy.expectedStartAt
    legacy.target = { opportunityId: first.opportunityId, scheduleNodeId: first.id }
    expect(apply(latest, [legacy]).status).toBe('APPLIED')
    legacy.target = { opportunityId: first.opportunityId, occurrenceId: first.occurrenceId }
    expect(apply(latest, [legacy]).status).toBe('APPLIED')
  })
})


describe('additional strict bound shapes and identities', () => {
  it.each(['closed', 'offer'] as const)('does not regress the %s job stage', stage => {
    const base = fixture(); base.data.opportunities[0]!.processStage = stage
    expect(interpret(CHANGE, base).candidates).toEqual([])
    expect(apply(base, [bound(current(base))]).status).toBe('NO_WRITE')
  })
  it.each([
    { opportunityId: 'other-job' }, { company: 'other-company' }, { role: 'other-role' },
    { occurrenceKind: 'written_test' as const }, { scheduleNodeId: 'unrelated-node' },
  ])('rejects conflicting explicit target data: %j', target => {
    const base = fixture(), candidate = bound(current(base)); candidate.target = { ...candidate.target, ...target }
    unchanged(apply(base, [candidate]), base)
  })
  it.each(['endAt', 'latestStartAt', 'deadlineAt', 'date'] as const)('keeps the new bound-time contract narrow for %s', field => {
    const base = fixture(), candidate = bound(current(base))
    candidate.temporal[field] = field === 'date' ? '2026-09-26' : '2026-09-26T15:30:00+08:00'
    unchanged(apply(base, [candidate]), base)
  })
  it('rejects two latest versions tied at the same version number', () => {
    const base = fixture(), node = current(base)
    base.data.scheduleNodes!.push({ ...structuredClone(node), id: 'conflicting-node' })
    expect(interpret(CHANGE, base).candidates).toEqual([])
    expect(() => apply(base, [bound(node)])).toThrow(/occurrence/)
  })
  it('keeps source body limits bounded and rejects first-party withdrawal', () => {
    const base = fixture()
    for (const text of [CHANGE + 'x'.repeat(2100), CHANGE.replace('-----Forwarded message-----\n', '> ') + '\n先不要导入']) {
      expect(interpret(text, base).candidates).toEqual([])
    }
  })
})


describe('retained history stays an ambiguity boundary', () => {
  it('does not confuse a current appointment with an older cancelled occurrence at the same instant', () => {
    const base = fixture(), node = current(base)
    base.data.scheduleNodes!.push({ ...structuredClone(node), id: 'older-node', occurrenceId: 'older-occurrence',
      processEventId: undefined, state: 'cancelled', cancelledAt: NOW.toISOString() })
    expect(interpret(CHANGE, base).candidates).toEqual([])
    expect(apply(base, [bound(node)]).status).toBe('NO_WRITE')
  })
  it('preflights the existing gateway node identity length bound', () => {
    const base = fixture(); current(base).id = 'n'.repeat(321)
    expect(interpret(CHANGE, base).candidates).toEqual([])
  })
})
