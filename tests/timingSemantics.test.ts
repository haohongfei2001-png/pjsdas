import { describe, expect, it } from 'vitest'
import { buildTimePlan, rankActions } from '../src/decisionV3.js'
import {
  actionForProcessEvent,
  createProcessEvent,
} from '../src/processEvents.js'
import type { Opportunity } from '../src/model.js'

const opportunity: Opportunity = {
  id: 'OPP-TIMING',
  company: '时间测试公司',
  role: '产品经理',
  currentStageLabel: '筛选中',
  processStage: 'screening',
  roleType: 'core',
  early: false,
  opportunityValue: 94,
  fitScore: 76,
  importedAt: '2026-09-01T00:00:00.000Z',
}

const now = new Date('2026-09-10T02:00:00.000Z')

describe('process-event timing semantics', () => {
  it('defaults assessment to deadline and written test/interview to fixed time', () => {
    const assessment = createProcessEvent({
      opportunity,
      type: 'assessment_invite',
      occurredAt: '2026-09-10T01:00:00.000Z',
      dueAt: '2026-09-11T10:00:00.000Z',
    })
    const written = createProcessEvent({
      opportunity,
      type: 'written_test_invite',
      occurredAt: '2026-09-10T01:00:00.000Z',
      dueAt: '2026-09-11T10:00:00.000Z',
    })
    const interview = createProcessEvent({
      opportunity,
      type: 'interview_invite',
      occurredAt: '2026-09-10T01:00:00.000Z',
      dueAt: '2026-09-11T10:00:00.000Z',
    })

    expect(assessment.timingMode).toBe('deadline')
    expect(written.timingMode).toBe('fixed')
    expect(interview.timingMode).toBe('fixed')
  })

  it('can schedule tomorrow deadline work into today when it fits', () => {
    const event = createProcessEvent({
      opportunity,
      type: 'assessment_invite',
      occurredAt: '2026-09-10T01:00:00.000Z',
      dueAt: '2026-09-11T10:00:00.000Z',
      timingMode: 'deadline',
      estimatedMinutes: 45,
    })
    const action = actionForProcessEvent(event)!
    const ranked = rankActions([action], [opportunity], now)
    const plan = buildTimePlan(ranked, 60, now)

    expect(plan.planned.map((item) => item.action.id)).toContain(action.id)
    expect(plan.totalMinutes).toBe(45)
    expect(plan.upcomingFixedEvents).toHaveLength(0)
  })

  it('does not pretend tomorrow fixed interview can be completed today', () => {
    const event = createProcessEvent({
      opportunity,
      type: 'interview_invite',
      occurredAt: '2026-09-10T01:00:00.000Z',
      dueAt: '2026-09-11T10:00:00.000Z',
      timingMode: 'fixed',
      estimatedMinutes: 90,
    })
    const action = actionForProcessEvent(event)!
    const ranked = rankActions([action], [opportunity], now)
    const plan = buildTimePlan(ranked, 180, now)

    expect(plan.planned.map((item) => item.action.id)).not.toContain(action.id)
    expect(plan.totalMinutes).toBe(0)
    expect(plan.fixedTodayMinutes).toBe(0)
    expect(plan.upcomingFixedEvents.map((item) => item.action.id)).toContain(action.id)
  })

  it('reserves today fixed event capacity without presenting it as startable work', () => {
    const event = createProcessEvent({
      opportunity,
      type: 'interview_invite',
      occurredAt: '2026-09-10T01:00:00.000Z',
      dueAt: '2026-09-10T08:00:00.000Z',
      timingMode: 'fixed',
      estimatedMinutes: 90,
    })
    const action = actionForProcessEvent(event)!
    const ranked = rankActions([action], [opportunity], now)
    const plan = buildTimePlan(ranked, 60, now)

    expect(plan.planned.map((item) => item.action.id)).not.toContain(action.id)
    expect(plan.upcomingFixedEvents.map((item) => item.action.id)).toContain(action.id)
    expect(plan.fixedTodayMinutes).toBe(90)
    expect(plan.requiredTodayMinutes).toBe(90)
    expect(plan.overrunReason).toBe('today_deadlines')
  })
})
