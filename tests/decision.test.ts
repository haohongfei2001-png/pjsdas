import { describe, expect, it } from 'vitest'
import {
  buildTimePlan,
  processNeedsReview,
  rankActions,
  selectTodayActions,
} from '../src/decisionV2'
import type { Action, Opportunity, ProcessRecord } from '../src/model'

function opportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    id: 'opp',
    company: 'Test Co',
    role: 'Test Role',
    currentStageLabel: '待投',
    processStage: 'not_applied',
    roleType: 'core',
    early: false,
    opportunityValue: 90,
    fitScore: 75,
    importedAt: new Date(2026, 8, 10, 9, 0).toISOString(),
    ...overrides,
  }
}

function action(overrides: Partial<Action> = {}): Action {
  return {
    id: 'action',
    kind: 'apply',
    title: 'Test action',
    estimatedMinutes: 30,
    leverage: 80,
    delayCost: 70,
    status: 'todo',
    createdAt: new Date(2026, 8, 10, 9, 0).toISOString(),
    updatedAt: new Date(2026, 8, 10, 9, 0).toISOString(),
    ...overrides,
  }
}

function process(overrides: Partial<ProcessRecord> = {}): ProcessRecord {
  return {
    id: 'process',
    company: 'Test Co',
    role: 'Test Role',
    stage: 'screening',
    stageLabel: '简历筛选',
    ...overrides,
  }
}

describe('pipeline review semantics', () => {
  it('treats a review date as due from the start of that local calendar day', () => {
    const now = new Date(2026, 8, 10, 11, 36)
    const review = process({ nextCheckAt: new Date(2026, 8, 10, 23, 59, 59).toISOString() })

    expect(processNeedsReview(review, now)).toBe(true)
  })

  it('does not surface future follow-ups in Today', () => {
    const now = new Date(2026, 8, 10, 11, 36)
    const opportunities = [opportunity({ id: 'opp-1' })]
    const actions = [
      action({
        id: 'follow-today',
        kind: 'follow_up',
        opportunityId: 'opp-1',
        dueAt: new Date(2026, 8, 10, 23, 59, 59).toISOString(),
        estimatedMinutes: 10,
      }),
      action({
        id: 'follow-tomorrow',
        kind: 'follow_up',
        opportunityId: 'opp-1',
        dueAt: new Date(2026, 8, 11, 23, 59, 59).toISOString(),
        estimatedMinutes: 10,
      }),
    ]

    const ranked = rankActions(actions, opportunities, now)
    expect(ranked.map((item) => item.action.id)).toEqual(['follow-today'])
  })
})

describe('Today queue constraints', () => {
  it('caps due pipeline follow-ups at two in the curated queue', () => {
    const now = new Date(2026, 8, 10, 11, 36)
    const opportunities = [opportunity({ id: 'opp-1' })]
    const actions = Array.from({ length: 4 }, (_, index) =>
      action({
        id: `follow-${index}`,
        kind: 'follow_up',
        opportunityId: 'opp-1',
        dueAt: new Date(2026, 8, 9, 23, 59, 59).toISOString(),
        estimatedMinutes: 10,
      }),
    )

    const ranked = rankActions(actions, opportunities, now)
    const selected = selectTodayActions(ranked, now, 10)
    expect(selected.filter((item) => item.action.kind === 'follow_up')).toHaveLength(2)
  })

  it('never hides same-day hard deadlines when the requested time budget is too small', () => {
    const now = new Date(2026, 8, 10, 11, 36)
    const opportunities = [
      opportunity({ id: 'urgent-1' }),
      opportunity({ id: 'urgent-2' }),
      opportunity({ id: 'tomorrow' }),
    ]
    const actions = [
      action({
        id: 'deadline-14',
        opportunityId: 'urgent-1',
        dueAt: new Date(2026, 8, 10, 14, 0).toISOString(),
        estimatedMinutes: 20,
      }),
      action({
        id: 'deadline-eod',
        opportunityId: 'urgent-2',
        dueAt: new Date(2026, 8, 10, 23, 59, 59).toISOString(),
        estimatedMinutes: 90,
      }),
      action({
        id: 'deadline-tomorrow',
        opportunityId: 'tomorrow',
        dueAt: new Date(2026, 8, 11, 23, 59, 59).toISOString(),
        estimatedMinutes: 90,
      }),
    ]

    const plan = buildTimePlan(rankActions(actions, opportunities, now), 60, now)
    expect(plan.planned.map((item) => item.action.id)).toEqual(['deadline-14', 'deadline-eod'])
    expect(plan.requiredTodayMinutes).toBe(110)
    expect(plan.overBudgetMinutes).toBe(50)
    expect(plan.overrunReason).toBe('today_deadlines')
    expect(plan.nearDeadlineUnplanned.map((item) => item.action.id)).toEqual(['deadline-tomorrow'])
  })

  it('prefers a small overrun for the next 48h hard deadline over packing lower-value short tasks', () => {
    const now = new Date(2026, 8, 10, 11, 36)
    const opportunities = [
      opportunity({ id: 'today-1' }),
      opportunity({ id: 'today-2' }),
      opportunity({ id: 'tomorrow' }),
      opportunity({ id: 'later' }),
    ]
    const actions = [
      action({
        id: 'today-20',
        opportunityId: 'today-1',
        dueAt: new Date(2026, 8, 10, 14, 0).toISOString(),
        estimatedMinutes: 20,
      }),
      action({
        id: 'today-90',
        opportunityId: 'today-2',
        dueAt: new Date(2026, 8, 10, 23, 59, 59).toISOString(),
        estimatedMinutes: 90,
      }),
      action({
        id: 'tomorrow-90',
        opportunityId: 'tomorrow',
        dueAt: new Date(2026, 8, 11, 23, 59, 59).toISOString(),
        estimatedMinutes: 90,
      }),
      action({
        id: 'later-30',
        opportunityId: 'later',
        dueAt: new Date(2026, 8, 20, 23, 59, 59).toISOString(),
        estimatedMinutes: 30,
      }),
    ]

    const plan = buildTimePlan(rankActions(actions, opportunities, now), 180, now)
    expect(plan.planned.map((item) => item.action.id)).toEqual([
      'today-20',
      'today-90',
      'tomorrow-90',
    ])
    expect(plan.totalMinutes).toBe(200)
    expect(plan.overBudgetMinutes).toBe(20)
    expect(plan.overrunReason).toBe('near_deadline_stretch')
  })
})
