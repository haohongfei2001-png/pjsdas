import { applySemanticIntake } from '../src/semanticIntake.js'
import { describe, expect, it } from 'vitest'
import { denseDecision, denseDecisionWorkspace, DENSE_NOW } from './fixtures/denseDecisionWorkspace.js'
import { decisionNeedsToday, groupOpenDecisions, presentDecision, presentChoice } from '../src/decisionPresentation.js'
import { selectTodayWeb } from '../src/today/todayWebSelector.js'
import { buildScheduleStream } from '../src/schedule/scheduleStream.js'
const zone = 'Asia/Shanghai'
describe('dense owner decision and schedule membership', () => {
  it('preserves all records but does not mistake 358 undated email decisions for Today tasks', () => {
    const snapshot = denseDecisionWorkspace(), before = JSON.stringify(snapshot)
    const selected = selectTodayWeb(snapshot, {}, { now: DENSE_NOW, timezone: zone })
    expect(snapshot.data.actions.filter(a => a.status === 'todo')).toHaveLength(361)
    expect(snapshot.data.scheduleNodes).toHaveLength(300)
    expect(selected.actionCount).toBeGreaterThan(0); expect(selected.actionCount).toBeLessThan(20)
    expect(selected.decisionCount).toBe(0); expect(selected.openDecisionCount).toBe(358)
    const schedule = buildScheduleStream(snapshot, { now: DENSE_NOW, timezone: zone, accountKey: 'synthetic', workspaceRevision: '1' })
    expect(schedule.sections.upcoming.every(n => !n.date || n.date >= '2026-09-29')).toBe(true)
    expect(schedule.sections.unresolved).toHaveLength(98)
    expect(JSON.stringify(snapshot)).toBe(before)
  })
  it('keeps all seven genuine same-day decisions without a count cap, excludes old and future timing', () => {
    const snapshot = denseDecisionWorkspace()
    for (let i = 0; i < 7; i++) {
      const candidate = snapshot.data.decisionRequests![i].payloadBinding.candidate
      if (candidate.kind === 'process_event') { candidate.dueAt = '2026-09-29'; candidate.duePrecision = 'date' }
    }
    const selected = selectTodayWeb(snapshot, {}, { now: DENSE_NOW, timezone: zone })
    expect(selected.decisionCount).toBe(7)
    const item = denseDecision(999)
    if (item.payloadBinding.candidate.kind !== 'process_event') throw Error('fixture')
    for (const dueAt of ['2026-09-28', '2026-09-30']) {
      item.payloadBinding.candidate.dueAt = dueAt
      expect(decisionNeedsToday(item, DENSE_NOW, zone)).toBe(false)
    }
    item.payloadBinding.statementMode = 'current_intent'; item.payloadBinding.source.kind = 'web'; item.createdAt = DENSE_NOW.toISOString()
    expect(decisionNeedsToday(item, DENSE_NOW, zone)).toBe(true)
    item.expiresAt = '2026-09-28T00:00:00Z'
    expect(decisionNeedsToday(item, DENSE_NOW, zone)).toBe(false)
  })
  it('groups only exact replays, retaining every resolution identity and changed alternatives', () => {
    const a = denseDecision(1), b = structuredClone(a)
    b.id = 'replayed'; b.payloadBinding.inputId = 'new-input'; b.payloadBinding.source.sourceVersion = 'new'
    b.payloadBinding.candidate.sourceVersionRefs = ['new']
    const before = JSON.stringify([a, b])
    expect(groupOpenDecisions([a, b])).toEqual([[a, b]])
    expect(JSON.stringify([a, b])).toBe(before)
    for (const change of ['choices', 'target', 'source', 'question'] as const) {
      const changed = structuredClone(b)
      if (change === 'question') changed.question = 'A different correction warning.'
      if (change === 'choices') changed.choices[0].resolution = { opportunityId: 'another-job' }
      if (change === 'target') changed.payloadBinding.candidate.target = { company: 'Another company' }
      if (change === 'source') changed.payloadBinding.source.sourceRecordId = 'another-source'
      expect(groupOpenDecisions([a, changed])).toHaveLength(2)
    }
  })
  it('groups fourteen exact cross-version replays in 358 records without deleting any', () => {
    const requests = Array.from({ length: 358 }, (_, i) => denseDecision(i))
    for (let i = 0; i < 14; i++) {
      const replay = structuredClone(requests[i]); replay.id = `replay-${i}`
      replay.payloadBinding.source.sourceVersion = 'new'
      replay.payloadBinding.candidate.sourceVersionRefs = ['new']
      requests[344 + i] = replay
    }
    const groups = groupOpenDecisions(requests)
    expect(groups).toHaveLength(344)
    expect(groups.flat()).toHaveLength(358)
  })
  it('uses display timezone only for floating dates and keeps explicit UTC semantics', () => {
    const snapshot = denseDecisionWorkspace()
    snapshot.data.scheduleNodes![0].temporal.timezone = 'UTC'
    const stream = buildScheduleStream(snapshot, { now: DENSE_NOW, timezone: zone, accountKey: 'synthetic', workspaceRevision: '2' })
    expect(stream.sections.upcoming.some(n => n.nodeId === snapshot.data.scheduleNodes![0].id)).toBe(true)
    expect(stream.sections.unresolved).toHaveLength(97)
  })
  it('keeps an explicit UTC date decision during its source calendar day across local midnight', () => {
    const request = denseDecision(50)
    if (request.payloadBinding.candidate.kind !== 'process_event') throw Error('fixture')
    request.payloadBinding.candidate.temporal = { shape: 'date_only', precision: 'date', timezone: 'UTC', date: '2026-09-28', resolutionBasis: 'source_explicit' }
    expect(decisionNeedsToday(request, DENSE_NOW, zone)).toBe(true)
    request.payloadBinding.candidate.temporal.timezone = 'floating-date'
    expect(decisionNeedsToday(request, DENSE_NOW, zone)).toBe(false)
  })
  it.each([
    ['America/Los_Angeles', '2026-09-29T19:00:00Z', '2026-09-29T00:00:00Z', '2026-09-28T19:00:00Z'],
    ['Asia/Shanghai', '2026-09-29T12:00:00Z', '2026-09-29T23:00:00Z', '2026-09-30T12:00:00Z'],
  ])('preserves ISO-backed calendar precision in %s without shifting datetime semantics', (timezone, now, value, shiftedNow) => {
    for (const kind of ['opportunity_deadline', 'manual_action', 'process_event'] as const) {
      const request = denseDecision(900)
      const common = { id: 'date-fact', objectConfidence: 'low' as const, eventConfidence: 'high' as const, evidenceRefs: [], sourceVersionRefs: [] }
      request.payloadBinding.candidate = kind === 'opportunity_deadline'
        ? { ...common, kind, deadline: value, precision: 'date' }
        : kind === 'manual_action' ? { ...common, kind, title: 'Calendar task', dueAt: value, duePrecision: 'date' }
        : { ...common, kind, eventType: 'interview_invite', dueAt: value, duePrecision: 'date' }
      expect(decisionNeedsToday(request, new Date(now), timezone)).toBe(true)
      expect(decisionNeedsToday(request, new Date(shiftedNow), timezone)).toBe(false)
      if (request.payloadBinding.candidate.kind === 'opportunity_deadline') request.payloadBinding.candidate.precision = 'datetime'
      else request.payloadBinding.candidate.duePrecision = 'datetime'
      expect(decisionNeedsToday(request, new Date(now), timezone)).toBe(false)
      expect(decisionNeedsToday(request, new Date(shiftedNow), timezone)).toBe(true)
    }
  })
  it('provides Chinese event/source context without inventing a candidate employer', () => {
    const request = denseDecision(42)
    const copy = presentDecision(request, [], true)
    expect(copy.title).toBe('确认对应岗位 · 面试邀请')
    expect(copy.context).toContain('对应岗位待确认'); expect(copy.context).toContain('2026-09-20'); expect(copy.context).toContain('片段 1')
    expect(copy.title).not.toContain('Several')
    expect(presentChoice(request.choices[0], true).label).toBe('确认这条信息')
  })
})

it('preserves actual semantic producer clarification choices and old-observation correction warning', () => {
  const snapshot = denseDecisionWorkspace()
  snapshot.data.opportunities[0].effectiveProcessEventAt = '2026-09-27T00:00:00Z'
  const observation = { contractVersion: 1 as const, inputId: 'old-real-producer', statementMode: 'assertion' as const,
    source: { kind: 'web' as const, sourceId: 'web', sourceRecordId: 'old-note', observedAt: DENSE_NOW.toISOString(), assertedAt: '2026-09-20T00:00:00Z', timezone: 'Asia/Shanghai' },
    candidates: [{ id: 'fact', kind: 'application_submitted' as const, target: { opportunityId: snapshot.data.opportunities[0].id }, occurredAt: '2026-09-20T00:00:00Z', objectConfidence: 'high' as const, eventConfidence: 'high' as const, evidenceRefs: [], sourceVersionRefs: [] }] }
  const result = applySemanticIntake(snapshot, observation, { authorized: true, now: DENSE_NOW })
  const warning = result.snapshot.data.decisionRequests!.find(r => r.payloadBinding.inputId === observation.inputId)!
  expect(warning.reason).toBe('material_conflict')
  expect(presentDecision(warning, snapshot.data.opportunities, true).explanation).toContain('早于')
  expect(presentDecision(warning, snapshot.data.opportunities, true).explanation).toContain('有意纠正')
  const missing = applySemanticIntake(snapshot, { ...observation, inputId: 'missing-real-producer', candidates: [{ ...observation.candidates[0], target: undefined }] }, { authorized: true, now: DENSE_NOW })
  const request = missing.snapshot.data.decisionRequests!.find(r => r.payloadBinding.inputId === 'missing-real-producer')!
  expect(request.choices.map(c => c.id)).toEqual(['ignore', 'clarify'])
  const choices = request.choices.map(c => presentChoice(c, true))
  expect(choices[0].label).not.toBe(choices[1].label)
  expect(choices[1].consequence).toContain('公司')
  expect(choices[1].consequence).toContain('岗位')
})
