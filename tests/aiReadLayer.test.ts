import { describe, expect, it } from 'vitest'
import {
  BridgeReadError,
  explainPriority,
  getDecisionRules,
  getPipeline,
  getRecentTimeline,
  getTodayPlan,
  listOpportunities,
} from '../src/ai/readLayer'
import { createSnapshot } from '../src/snapshot'
import { createDefaultDecisionRules } from '../src/decisionRules'
import type { Action, Opportunity, ProcessEvent, ProcessRecord, TimelineRecord } from '../src/model'

const NOW = new Date('2026-09-11T08:00:00.000Z')

function opportunity(id: string, company: string, role: string, deadline?: string): Opportunity {
  return {
    id,
    company,
    role,
    currentStageLabel: '待投',
    processStage: 'not_applied',
    roleType: 'core',
    early: false,
    deadline,
    opportunityValue: id === 'opp-a' ? 90 : 70,
    fitScore: id === 'opp-a' ? 80 : 60,
    importedAt: '2026-09-10T00:00:00.000Z',
  }
}

function applyAction(id: string, opportunityId: string, title: string, dueAt?: string): Action {
  return {
    id,
    kind: 'apply',
    title,
    opportunityId,
    processStage: 'not_applied',
    dueAt,
    estimatedMinutes: 45,
    leverage: 80,
    delayCost: 80,
    status: 'todo',
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
  }
}

function baseSnapshot(options: {
  opportunities?: Opportunity[]
  processes?: ProcessRecord[]
  processEvents?: ProcessEvent[]
  actions?: Action[]
  timeline?: TimelineRecord[]
} = {}) {
  return createSnapshot({
    opportunities: options.opportunities ?? [],
    processes: options.processes ?? [],
    processEvents: options.processEvents ?? [],
    actions: options.actions ?? [],
    prep: [],
    applicationGroups: [],
    decisionRules: createDefaultDecisionRules('2026-09-10T12:00:00.000Z'),
    timeline: options.timeline ?? [],
    changeSets: [],
  }, '2026-09-11T08:00:00.000Z')
}

describe('AI Bridge read layer', () => {
  it('returns bounded opportunity DTOs without leaking internal detail', () => {
    const a = { ...opportunity('opp-a', 'Alpha', 'Product Manager', '2026-09-12T12:00:00.000Z'), detail: { jdSummary: 'private raw detail' } }
    const b = opportunity('opp-b', 'Beta', 'Strategy', '2026-09-20T12:00:00.000Z')
    const result = listOpportunities(baseSnapshot({ opportunities: [a, b] }), { query: 'product', limit: 1 }, { now: NOW, timezone: 'Asia/Shanghai' })

    expect(result.opportunities).toHaveLength(1)
    expect(result.opportunities[0].opportunityId).toBe('opp-a')
    expect(result.opportunities[0]).not.toHaveProperty('detail')
    expect(result.meta.source).toBe('pjsdas')
    expect(result.meta.timezone).toBe('Asia/Shanghai')
  })

  it('uses the existing deterministic Today planner and keeps hypothetical time read-only', () => {
    const a = opportunity('opp-a', 'Alpha', 'Product Manager', '2026-09-11T12:00:00.000Z')
    const action = applyAction('apply-a', a.id, '投递 Alpha｜Product Manager', '2026-09-11T12:00:00.000Z')
    const snapshot = baseSnapshot({ opportunities: [a], actions: [action] })
    const originalRules = JSON.stringify(snapshot.data.decisionRules)

    const result = getTodayPlan(snapshot, { availableMinutes: 60 }, { now: NOW, timezone: 'Asia/Shanghai' })

    expect(result.availableMinutes).toBe(60)
    expect(result.startableActions[0].actionId).toBe('apply-a')
    expect(result.startableActions[0].priority).toBeGreaterThan(0)
    expect(result.startableActions[0].rationale.length).toBeGreaterThan(0)
    expect(JSON.stringify(snapshot.data.decisionRules)).toBe(originalRules)
  })

  it('projects Process Events into the effective pipeline instead of exposing stale imported state', () => {
    const a = { ...opportunity('opp-a', 'Alpha', 'Product Manager'), processStage: 'screening' as const, currentStageLabel: '筛选中' }
    const process: ProcessRecord = {
      id: 'process-a',
      opportunityId: a.id,
      company: a.company,
      role: a.role,
      stage: 'screening',
      stageLabel: '筛选中',
      lastProgressAt: '2026-09-10T02:00:00.000Z',
    }
    const event: ProcessEvent = {
      id: 'event-a',
      opportunityId: a.id,
      company: a.company,
      role: a.role,
      type: 'interview_invite',
      occurredAt: '2026-09-11T07:00:00.000Z',
      dueAt: '2026-09-12T02:00:00.000Z',
      timingMode: 'fixed',
      estimatedMinutes: 90,
      source: 'manual',
      createdAt: '2026-09-11T07:00:00.000Z',
      updatedAt: '2026-09-11T07:00:00.000Z',
    }

    const result = getPipeline(baseSnapshot({ opportunities: [a], processes: [process], processEvents: [event] }), {}, { now: NOW })

    expect(result.processes).toHaveLength(1)
    expect(result.processes[0].stage).toBe('interview')
    expect(result.processes[0].stageLabel).toBe('面试')
    expect(result.processes[0].currentAction).toContain('面试')
    expect(result.processes[0].upcomingEvent?.eventId).toBe('event-a')
    expect(result.processes[0].upcomingEvent?.timingSemantics).toBe('fixed')
  })

  it('exposes persisted decision policy in semantic groups', () => {
    const result = getDecisionRules(baseSnapshot(), { now: NOW })

    expect(result.rulesVersion).toBe(1)
    expect(result.weights.urgency).toBe(23)
    expect(result.deadlines.hardDeadlineHorizonHours).toBe(48)
    expect(result.planning.followUpDailyCap).toBe(2)
    expect(result.visibility.upcomingHorizonDays).toBe(7)
    expect(result.humanSummary.length).toBeGreaterThan(0)
  })

  it('explains opportunity priority from the existing ranking engine and supports comparison', () => {
    const a = opportunity('opp-a', 'Alpha', 'Product Manager', '2026-09-11T12:00:00.000Z')
    const b = opportunity('opp-b', 'Beta', 'Strategy', '2026-09-18T12:00:00.000Z')
    const snapshot = baseSnapshot({
      opportunities: [a, b],
      actions: [
        applyAction('apply-a', a.id, '投递 Alpha', a.deadline),
        applyAction('apply-b', b.id, '投递 Beta', b.deadline),
      ],
    })

    const result = explainPriority(snapshot, { opportunityId: 'opp-a', compareWithOpportunityId: 'opp-b' }, { now: NOW })

    expect(result.target.type).toBe('opportunity')
    expect(result.score).toBeGreaterThan(0)
    expect(result.components.map((item) => item.key)).toContain('urgency')
    expect(result.comparison?.targetId).toBe('opp-b')
    expect(result.comparison?.decisiveDifferences.length).toBeGreaterThan(0)
  })

  it('filters Timeline history and reports truncation without exposing raw source input', () => {
    const records: TimelineRecord[] = [
      {
        id: 'timeline-1',
        kind: 'application_submitted',
        category: 'opportunity',
        source: 'natural_language',
        occurredAt: '2026-09-11T07:00:00.000Z',
        recordedAt: '2026-09-11T07:01:00.000Z',
        title: '已投递 Alpha',
        detail: '状态更新为筛选中',
        company: 'Alpha',
        role: 'Product Manager',
        opportunityId: 'opp-a',
      },
      {
        id: 'timeline-2',
        kind: 'rules_changed',
        category: 'rules',
        source: 'rules',
        occurredAt: '2026-09-10T07:00:00.000Z',
        recordedAt: '2026-09-10T07:01:00.000Z',
        title: '调整决策规则',
      },
    ]
    const a = opportunity('opp-a', 'Alpha', 'Product Manager')

    const result = getRecentTimeline(baseSnapshot({ opportunities: [a], timeline: records }), { since: '2026-09-11T00:00:00.000Z', limit: 1 }, { now: NOW })

    expect(result.records).toHaveLength(1)
    expect(result.records[0].timelineId).toBe('timeline-1')
    expect(result.records[0].summary).toBe('状态更新为筛选中')
    expect(result.records[0]).not.toHaveProperty('rawInput')
    expect(result.truncated).toBe(false)
  })

  it('fails closed on invalid bounded-list arguments', () => {
    expect(() => listOpportunities(baseSnapshot(), { limit: 101 }, { now: NOW }))
      .toThrow(BridgeReadError)
  })
})
