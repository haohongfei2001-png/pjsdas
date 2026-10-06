import { denseDecision } from './fixtures/denseDecisionWorkspace.js'
import { describe, expect, it } from 'vitest'
import type { Action, DecisionRequest, Opportunity, ScheduleNode, TimelineRecord } from '../src/model.js'
import { opportunity } from '../e2e/fixtures/todayWorkspace.js'
import { createSnapshot } from '../src/snapshot.js'
import { buildTodayBrief } from '../src/todayBrief.js'
import { selectTodayWeb } from '../src/today/todayWebSelector.js'
import { buildScheduleStream, readScheduleWindow } from '../src/schedule/scheduleStream.js'

const NOW = new Date('2026-09-25T04:00:00.000Z')
const TZ = 'Asia/Shanghai'
const CREATED = '2026-09-20T00:00:00.000Z'

function action(id: string, extra: Partial<Action> = {}): Action {
  return {
    id, kind: 'manual', title: `Task ${id}`, estimatedMinutes: 20,
    leverage: 80, delayCost: 60, status: 'todo', createdAt: CREATED, updatedAt: CREATED,
    ...extra,
  }
}

function node(occurrenceId: string, date: string, extra: Partial<ScheduleNode> = {}): ScheduleNode {
  return {
    id: `${occurrenceId}:v1`, occurrenceId, version: 1, kind: 'interview',
    state: 'scheduled', constraintKind: 'employer_hard',
    temporal: { shape: 'date_only', precision: 'date', timezone: TZ, date, resolutionBasis: 'source_explicit' },
    evidenceRefs: [], sourceVersionRefs: [], relatedActionIds: [], relatedPrepIds: [],
    createdAt: CREATED, updatedAt: CREATED, ...extra,
  }
}

function snapshot(actions: Action[] = [], nodes: ScheduleNode[] = [], timeline: TimelineRecord[] = [], decisions: DecisionRequest[] = [], opportunities: Opportunity[] = []) {
  return createSnapshot({
    opportunities, processes: [], processEvents: [], actions, scheduleNodes: nodes,
    prep: [], applicationGroups: [], timeline, changeSets: [], decisionRequests: decisions, semanticReceipts: [],
  }, NOW.toISOString())
}

describe('TSUI-01 complete Web read models', () => {
  it('keeps Web Today and external TodayBrief on the same feasible chronological list', () => {
    const actions = Array.from({ length: 8 }, (_, i) => action(`manual-${i}`))
    actions.push(action('doing', { status: 'doing', estimatedMinutes: 1000, leverage: 1, delayCost: 1 }))
    actions.push(action('due-today', {
      dueAt: '2026-09-25T10:00:00.000Z', duePrecision: 'datetime',
      estimatedMinutes: 1000, leverage: 1, delayCost: 1,
    }))
    actions.push(action('date-only-today', {
      kind: 'apply', dueAt: '2026-09-25', duePrecision: 'date',
      estimatedMinutes: 1000, leverage: 1, delayCost: 1,
    }))
    actions.push(action('future-backlog', { estimatedMinutes: 1000, leverage: 1, delayCost: 1 }))
    const source = snapshot(actions)
    const web = selectTodayWeb(source, { availableMinutes: 180 }, { now: NOW, timezone: TZ, workspaceVersion: 'r1' })
    const ids = web.actions.map((item) => item.actionId)
    expect(ids).not.toContain('date-only-today')
    expect(web.notSelectedHardActions.map(item => item.actionId)).toEqual(['date-only-today'])
    expect(web.actions.reduce((sum, item) => sum + item.estimatedMinutes, 0)).toBeLessThanOrEqual(180)
    expect(ids).not.toContain('doing')
    expect(ids).not.toContain('due-today')
    expect(ids).not.toContain('future-backlog')
    expect(new Set(ids).size).toBe(ids.length)
    expect(web.actionCount).toBe(ids.length)
    const brief = buildTodayBrief(source, { availableMinutes: 180 }, { now: NOW, timezone: TZ })
    expect([brief.nextAction, ...brief.nextActions].filter(Boolean).map(item => item!.actionId)).toEqual(ids)
    expect(web.criticalWarnings).toHaveLength(1)
    expect(web.criticalWarnings[0]?.relatedIds).toContain('date-only-today')
  })

  it('keeps every future node, ongoing window and unresolved past occurrence', () => {
    const future = Array.from({ length: 130 }, (_, i) => {
      const date = new Date(Date.UTC(2026, 8, 25 + i)).toISOString().slice(0, 10)
      return node(`future-${i}`, date)
    })
    const unresolved = Array.from({ length: 8 }, (_, i) => node(`past-${i}`, `2026-09-${String(10 + i).padStart(2, '0')}`))
    const window = node('window', '2026-09-24', {
      temporal: {
        shape: 'availability_window', precision: 'datetime', timezone: TZ,
        startAt: '2026-09-24T02:00:00.000Z', endAt: '2026-09-26T02:00:00.000Z',
        resolutionBasis: 'source_explicit',
      },
    })
    const stream = buildScheduleStream(snapshot([], [...future, ...unresolved, window]), {
      accountKey: 'account-A', workspaceRevision: 'r1', timezone: TZ, now: NOW,
    })
    expect(stream.counts.upcoming).toBe(131)
    expect(stream.counts.unresolved).toBe(8)
    expect(stream.sections.upcoming.find((item) => item.occurrenceId === 'window')?.date).toBe('2026-09-25')
    expect(stream.sections.upcoming.some((item) => item.occurrenceId === 'future-129')).toBe(true)
    const seen: string[] = []
    let cursor: ReturnType<typeof readScheduleWindow>['nextCursor']
    do {
      const page = readScheduleWindow(stream, 'upcoming', 17, cursor)
      seen.push(...page.entries.map((item) => item.id))
      cursor = page.nextCursor
    } while (cursor)
    expect(seen).toEqual(stream.sections.upcoming.map((item) => item.id))
    expect(new Set(seen).size).toBe(131)
  })

  it('uses only the latest occurrence for upcoming and rejects cross-revision cursors', () => {
    const old = node('interview-1', '2026-10-01', {
      state: 'superseded', supersededByNodeId: 'interview-1:v2', updatedAt: '2026-09-24T00:00:00.000Z',
    })
    const latest = node('interview-1', '2026-10-03', {
      id: 'interview-1:v2', version: 2, supersedesNodeId: old.id,
    })
    const source = snapshot([], [old, latest, node('other', '2026-11-01')])
    const a = buildScheduleStream(source, { accountKey: 'A', workspaceRevision: 'r1', timezone: TZ, now: NOW })
    const b = buildScheduleStream(source, { accountKey: 'B', workspaceRevision: 'r1', timezone: TZ, now: NOW })
    const changed = buildScheduleStream(source, { accountKey: 'A', workspaceRevision: 'r2', timezone: TZ, now: NOW })
    expect(a.sections.upcoming.filter((item) => item.occurrenceId === 'interview-1')).toHaveLength(1)
    expect(a.sections.history.some((item) => item.nodeId === old.id)).toBe(true)
    const cursor = readScheduleWindow(a, 'upcoming', 1).nextCursor!
    expect(() => readScheduleWindow(b, 'upcoming', 1, cursor)).toThrow(/different account/)
    expect(() => readScheduleWindow(changed, 'upcoming', 1, cursor)).toThrow(/different account/)
  })

  it('orders late backfills by occurredAt and never invents an action completion time', () => {
    const late: TimelineRecord = {
      id: 'late', kind: 'application_submitted', category: 'process', source: 'user_action',
      occurredAt: '2026-09-21T08:00:00.000Z', recordedAt: '2026-09-25T03:00:00.000Z',
      title: 'Applied', opportunityId: 'posting-1',
    }
    const recent: TimelineRecord = {
      ...late, id: 'recent', occurredAt: '2026-09-24T08:00:00.000Z', recordedAt: '2026-09-24T08:00:00.000Z',
      opportunityId: 'posting-2',
    }
    const source = snapshot([action('done-legacy', { status: 'done', updatedAt: NOW.toISOString() })], [], [recent, late])
    const stream = buildScheduleStream(source, { accountKey: 'A', workspaceRevision: 'r1', timezone: TZ, now: NOW })
    expect(stream.sections.history.map((item) => item.id)).toEqual(['fact:late', 'fact:recent'])
    const legacy = stream.sections.undated.find((item) => item.id === 'action:done-legacy')
    expect(legacy?.occurredAt).toBeUndefined()
    expect(legacy?.date).toBeUndefined()
  })

  it('keeps more than four actionable decisions as separate rows', () => {
    const jobs = [opportunity('role-a', 'Example', 'Engineer'), opportunity('role-b', 'Example', 'Analyst')]
    const decisions = Array.from({ length: 7 }, (_, index) => {
      const request = denseDecision(index)
      request.payloadBinding.candidate.target = { company: 'Example' }
      request.choices = jobs.map(job => ({
        id: `opportunity:${job.id}`, label: `${job.company}｜${job.role}`,
        consequence: 'Only this opportunity will be updated.', resolution: { opportunityId: job.id },
      }))
      if (request.payloadBinding.candidate.kind === 'process_event') {
        request.payloadBinding.candidate.dueAt = '2026-09-25'
        request.payloadBinding.candidate.duePrecision = 'date'
      }
      return request
    })
    const result = selectTodayWeb(snapshot([], [], [], decisions, jobs), {}, { now: NOW, timezone: TZ })
    expect(result.decisionCount).toBe(7)
    expect(result.decisions.map((item) => item.id)).toEqual(decisions.map((item) => `decision:${item.id}`))
    expect(result.actions).toEqual([])
  })

  it('dates completed legacy nodes from exact completion facts without creating duplicate history', () => {
    const completed = node('action:prep-1', '2026-09-24', {
      state: 'completed', completedAt: undefined, relatedActionIds: ['prep-1'],
      temporal: { shape: 'date_only', precision: 'date', timezone: TZ, date: '2026-09-24', resolutionBasis: 'legacy_projection' },
    })
    const log: TimelineRecord = {
      id: 'prep-done', kind: 'action_status_changed', category: 'action', source: 'user_action',
      occurredAt: '2026-09-24T08:00:00.000Z', recordedAt: '2026-09-25T03:00:00.000Z',
      title: 'Completed prep', actionId: 'prep-1', changes: { status: { before: 'todo', after: 'done' } },
    }
    const stream = buildScheduleStream(snapshot([action('prep-1', { status: 'done' })], [completed], [log]), {
      accountKey: 'A', workspaceRevision: 'r1', timezone: TZ, now: NOW,
    })
    expect(stream.sections.history).toHaveLength(1)
    expect(stream.sections.history[0].id).toBe('node:action:prep-1:v1')
    expect(stream.sections.history[0].occurredAt).toBe(log.occurredAt)
    expect(stream.sections.history[0].sourceRefs).toContain('timeline:prep-done')
    expect(stream.sections.undated).toHaveLength(0)
  })

  it('links a completed occurrence and its Action log as one primary history item', () => {
    const completed = node('assessment-1', '2026-09-24', {
      state: 'completed', completedAt: '2026-09-24T08:00:00.000Z', relatedActionIds: ['assessment-action'],
    })
    const log: TimelineRecord = {
      id: 'action-log', kind: 'action_status_changed', category: 'action', source: 'user_action',
      occurredAt: '2026-09-24T08:00:00.000Z', recordedAt: '2026-09-25T03:00:00.000Z',
      title: 'Completed assessment', actionId: 'assessment-action', changes: { status: { before: 'todo', after: 'done' } },
    }
    const stream = buildScheduleStream(snapshot([
      action('assessment-action', { status: 'done' }),
    ], [completed], [log]), { accountKey: 'A', workspaceRevision: 'r1', timezone: TZ, now: NOW })
    expect(stream.sections.history.map((item) => item.id)).toEqual([`node:${completed.id}`])
    expect(stream.sections.undated).toEqual([])
    expect(stream.sections.history[0].sourceRefs).toContain('timeline:action-log')
  })
  it('keeps a legacy completed action undated when its only timestamp is a system backfill', () => {
    const backfill: TimelineRecord = {
      id: 'timeline:backfill-action:legacy-done:done',
      kind: 'action_status_changed', category: 'action', source: 'system',
      occurredAt: '2026-09-20T00:00:00.000Z',
      recordedAt: '2026-09-25T03:00:00.000Z',
      title: 'Legacy done status', actionId: 'legacy-done',
      changes: { status: { before: 'todo', after: 'done' } },
    }
    const stream = buildScheduleStream(snapshot([
      action('legacy-done', { status: 'done', updatedAt: CREATED }),
    ], [], [backfill]), { accountKey: 'A', workspaceRevision: 'r1', timezone: TZ, now: NOW })
    expect(stream.sections.undated.map((entry) => entry.id)).toContain('action:legacy-done')
    expect(stream.sections.history.some((entry) => entry.id === 'fact:' + backfill.id)).toBe(false)
  })

})
