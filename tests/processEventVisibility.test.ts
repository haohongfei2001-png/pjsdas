import { describe, expect, it } from 'vitest'
import {
  actionForProcessEvent,
  reconcileProcessEventActions,
  suppressSupersededActions,
} from '../src/processEvents'
import { rankActions } from '../src/decisionV3'
import { upcomingNodes } from '../src/timeRisk'
import type { Action, Opportunity, ProcessEvent } from '../src/model'

const event: ProcessEvent = {
  id: 'jd-assessment',
  opportunityId: 'jd-role',
  company: '京东',
  role: '技术产品经理',
  type: 'assessment_invite',
  occurredAt: '2026-09-10T12:00:00.000Z',
  dueAt: '2026-09-11T22:00:00.000Z',
  timingMode: 'deadline',
  estimatedMinutes: 45,
  source: 'manual',
  createdAt: '2026-09-10T12:00:00.000Z',
  updatedAt: '2026-09-10T12:00:00.000Z',
}

const opportunity: Opportunity = {
  id: 'jd-role',
  company: '京东',
  role: '技术产品经理',
  currentStageLabel: '筛选/测评',
  processStage: 'assessment',
  roleType: 'reach',
  early: false,
  opportunityValue: 90,
  fitScore: 43,
  importedAt: '2026-09-10T12:00:00.000Z',
}

describe('process-event action visibility', () => {
  it('rebuilds a missing actionable event action from the Process Event itself', () => {
    const reconciled = reconcileProcessEventActions([], [event])
    expect(reconciled).toHaveLength(1)
    expect(reconciled[0]).toMatchObject({
      id: 'event-action:jd-assessment',
      dueAt: '2026-09-11T22:00:00.000Z',
      processStage: 'assessment',
      status: 'todo',
    })
  })

  it('preserves an existing completion state while refreshing event metadata', () => {
    const generated = actionForProcessEvent(event)!
    const done: Action = {
      ...generated,
      status: 'done',
      updatedAt: '2026-09-10T13:00:00.000Z',
    }
    const reconciled = reconcileProcessEventActions([done], [{ ...event, estimatedMinutes: 30 }])
    expect(reconciled[0].status).toBe('done')
    expect(reconciled[0].estimatedMinutes).toBe(30)
  })

  it('keeps a concrete local deadline visible when the imported baseline is already at the same stage', () => {
    const generated = actionForProcessEvent(event)!
    const visible = suppressSupersededActions([generated], [opportunity])
    expect(visible).toHaveLength(1)

    const now = new Date('2026-09-10T16:00:00.000Z')
    const ranked = rankActions(visible, [opportunity], now)
    expect(upcomingNodes(ranked, now).map((item) => item.action.id)).toContain('event-action:jd-assessment')
  })

  it('suppresses the old assessment deadline after the opportunity advances to interview', () => {
    const generated = actionForProcessEvent(event)!
    const advanced: Opportunity = {
      ...opportunity,
      processStage: 'interview',
      currentStageLabel: '面试',
    }
    expect(suppressSupersededActions([generated], [advanced])).toHaveLength(0)
  })
})
