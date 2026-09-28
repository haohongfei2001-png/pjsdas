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
    for (const change of ['choices', 'target', 'source'] as const) {
      const changed = structuredClone(b)
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
  it('provides Chinese event/source context without inventing a candidate employer', () => {
    const request = denseDecision(42)
    const copy = presentDecision(request, [], true)
    expect(copy.title).toBe('确认对应岗位 · 面试邀请')
    expect(copy.context).toContain('对应岗位待确认'); expect(copy.context).toContain('2026-09-20'); expect(copy.context).toContain('片段 1')
    expect(copy.title).not.toContain('Several')
    expect(presentChoice(request.choices[0], true).label).toBe('确认这条信息')
  })
})
