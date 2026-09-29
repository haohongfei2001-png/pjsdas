import { applySemanticIntake } from '../src/semanticIntake.js'
import { describe, expect, it } from 'vitest'
import { denseDecision, denseDecisionWorkspace, DENSE_NOW } from './fixtures/denseDecisionWorkspace.js'
import { decisionNeedsToday, groupOpenDecisions, presentDecision, presentChoice } from '../src/decisionPresentation.js'
import { partitionDecisions } from '../src/decisionActionability.js'
import { selectTodayWeb } from '../src/today/todayWebSelector.js'
import { buildScheduleStream } from '../src/schedule/scheduleStream.js'
const zone = 'Asia/Shanghai'
describe('dense owner decision and schedule membership', () => {
  it('quarantines the production aggregate shape without deleting any of its 363 source records', () => {
    const snapshot = denseDecisionWorkspace()
    const reasons = [
      ...Array(173).fill('missing_required_field'),
      ...Array(117).fill('ambiguous_target'),
      ...Array(69).fill('low_confidence'),
      ...Array(4).fill('ambiguous_occurrence'),
    ] as Array<NonNullable<typeof snapshot.data.decisionRequests>[number]['reason']>
    snapshot.data.decisionRequests = reasons.map((reason, index) => ({
      ...denseDecision(index), reason,
    }))
    const before = JSON.stringify(snapshot.data.decisionRequests)
    const classified = partitionDecisions(snapshot.data.decisionRequests, {
      opportunities: snapshot.data.opportunities, scheduleNodes: snapshot.data.scheduleNodes, now: DENSE_NOW,
    })
    expect(classified.actionable).toHaveLength(0)
    expect(classified.dataQuality).toHaveLength(363)
    const today = selectTodayWeb(snapshot, {}, { now: DENSE_NOW, timezone: zone })
    expect(today.decisionCount).toBe(0)
    expect(today.openDecisionCount).toBe(0)
    expect(today.actionCount).toBeLessThan(20)
    expect(JSON.stringify(snapshot.data.decisionRequests)).toBe(before)
  })
  it('keeps a bounded reminder cancellation selectable when every choice names an active reminder', () => {
    const snapshot = denseDecisionWorkspace()
    const request = denseDecision(500)
    request.reason = 'missing_required_field'
    request.payloadBinding.candidate = {
      id: 'fragment:0', kind: 'reminder_cancelled', purpose: 'upcoming',
      objectConfidence: 'low', eventConfidence: 'high', evidenceRefs: [], sourceVersionRefs: [],
    }
    const reminders = [0, 1].map(index => ({
      id: `reminder-${index}`, scheduleNodeId: `dense-node-${index}`, scheduleNodeVersion: 1,
      purpose: 'upcoming' as const, triggerAt: '2026-09-29T01:00:00Z',
      deliveryOwner: 'pjsdas' as const, channel: 'in_product' as const,
      state: 'active' as const, dedupeKey: `reminder-${index}`,
      createdAt: DENSE_NOW.toISOString(), updatedAt: DENSE_NOW.toISOString(),
    }))
    request.choices = reminders.map(item => ({
      id: item.id, label: item.id, consequence: 'Cancel only this reminder.',
      resolution: { reminderIntentId: item.id },
    }))
    const context = { opportunities: snapshot.data.opportunities, scheduleNodes: snapshot.data.scheduleNodes,
      reminderIntents: reminders, now: DENSE_NOW }
    expect(partitionDecisions([request], context).actionable).toHaveLength(1)
    request.payloadBinding.candidate.eventConfidence = 'low'
    expect(partitionDecisions([request], context).dataQuality).toHaveLength(1)
    request.payloadBinding.candidate.eventConfidence = 'high'
    reminders[1].state = 'cancelled' as const
    expect(partitionDecisions([request], context).dataQuality).toHaveLength(1)
  })
  it('removes stale occurrence choices even when the plausible count stays the same', () => {
    const snapshot = denseDecisionWorkspace()
    const nodes = snapshot.data.scheduleNodes!
    for (const node of nodes.slice(0, 3)) node.kind = 'interview'
    const request = denseDecision(502)
    request.reason = 'ambiguous_occurrence'
    request.payloadBinding.candidate.target = { occurrenceKind: 'interview' }
    request.choices = nodes.slice(0, 3).map(node => ({
      id: `occurrence:${node.occurrenceId}`, label: node.occurrenceId,
      consequence: 'Update only this interview.', resolution: { occurrenceId: node.occurrenceId },
    }))
    const context = { opportunities: snapshot.data.opportunities, scheduleNodes: nodes, now: DENSE_NOW }
    expect(partitionDecisions([request], context).actionable).toHaveLength(1)
    nodes[2]!.kind = 'written_test'
    nodes[3]!.kind = 'interview'
    expect(partitionDecisions([request], context).dataQuality).toHaveLength(1)
  })
  it('uses the same normalized company identity as semantic resolution', () => {
    const snapshot = denseDecisionWorkspace()
    snapshot.data.opportunities[0]!.company = '京东'
    snapshot.data.opportunities[1]!.company = '京东'
    const request = denseDecision(501)
    request.payloadBinding.candidate.target = { company: '京东招聘' }
    request.choices = [0, 1].map(index => ({
      id: `opportunity:${snapshot.data.opportunities[index]!.id}`,
      label: `京东 · 机会${index}`,
      consequence: 'Only this opportunity will be updated.',
      resolution: { opportunityId: snapshot.data.opportunities[index]!.id },
    }))
    expect(partitionDecisions([request], {
      opportunities: snapshot.data.opportunities, now: DENSE_NOW,
    }).actionable).toHaveLength(1)
  })
  it('preserves all records but does not mistake 358 undated email decisions for Today tasks', () => {
    const snapshot = denseDecisionWorkspace(), before = JSON.stringify(snapshot)
    const selected = selectTodayWeb(snapshot, {}, { now: DENSE_NOW, timezone: zone })
    expect(snapshot.data.actions.filter(a => a.status === 'todo')).toHaveLength(361)
    expect(snapshot.data.scheduleNodes).toHaveLength(300)
    expect(selected.actionCount).toBeGreaterThan(0); expect(selected.actionCount).toBeLessThan(20)
    expect(selected.decisionCount).toBe(0); expect(selected.openDecisionCount).toBe(0)
    expect(snapshot.data.decisionRequests).toHaveLength(358)
    const schedule = buildScheduleStream(snapshot, { now: DENSE_NOW, timezone: zone, accountKey: 'synthetic', workspaceRevision: '1' })
    expect(schedule.sections.upcoming.every(n => !n.date || n.date >= '2026-09-29')).toBe(true)
    expect(schedule.sections.unresolved).toHaveLength(98)
    expect(JSON.stringify(snapshot)).toBe(before)
  })
  it('keeps all seven genuine same-day decisions without a count cap, excludes old and future timing', () => {
    const snapshot = denseDecisionWorkspace()
    snapshot.data.opportunities[0]!.company = 'Shared company'
    snapshot.data.opportunities[1]!.company = 'Shared company'
    snapshot.data.opportunities[1]!.role = 'Analyst'
    for (let i = 0; i < 7; i++) {
      const candidate = snapshot.data.decisionRequests![i].payloadBinding.candidate
      candidate.target = { company: 'Shared company' }
      snapshot.data.decisionRequests![i].choices = [0, 1].map(j => ({
        id: `opportunity:${snapshot.data.opportunities[j]!.id}`,
        label: `Shared company｜${snapshot.data.opportunities[j]!.role}`,
        consequence: 'Only this opportunity will be updated.',
        resolution: { opportunityId: snapshot.data.opportunities[j]!.id },
      }))
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
