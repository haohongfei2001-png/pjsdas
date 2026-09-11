import { describe, expect, it } from 'vitest'
import { rankActions } from '../src/decisionV3.js'
import { isUnresolvedPastProcessEvent } from '../src/fixedEventGuardLogic.js'
import type { Action, Opportunity } from '../src/model.js'

const now = new Date('2026-09-10T05:00:00.000Z')

const opportunity: Opportunity = {
  id: 'OPP-001',
  company: '测试公司',
  role: '产品经理',
  currentStageLabel: '测评',
  processStage: 'assessment',
  roleType: 'core',
  early: false,
  opportunityValue: 90,
  fitScore: 75,
  importedAt: '2026-09-01T00:00:00.000Z',
}

function processAction(overrides: Partial<Action> = {}): Action {
  return {
    id: 'event-action:evt-1',
    kind: 'manual',
    title: '完成 测试公司｜测评',
    opportunityId: opportunity.id,
    processEventId: 'evt-1',
    processStage: 'assessment',
    dueAt: '2026-09-10T04:00:00.000Z',
    timingMode: 'deadline',
    estimatedMinutes: 45,
    leverage: 98,
    delayCost: 100,
    status: 'todo',
    sourceLabel: '流程事件',
    createdAt: '2026-09-09T00:00:00.000Z',
    updatedAt: '2026-09-09T00:00:00.000Z',
    ...overrides,
  }
}

describe('overdue process-event boundary', () => {
  it('flags both overdue deadline and fixed process events for confirmation', () => {
    expect(isUnresolvedPastProcessEvent(processAction(), now)).toBe(true)
    expect(isUnresolvedPastProcessEvent(processAction({ timingMode: 'fixed' }), now)).toBe(true)
    expect(isUnresolvedPastProcessEvent(processAction({ dueAt: '2026-09-10T06:00:00.000Z' }), now)).toBe(false)
    expect(isUnresolvedPastProcessEvent(processAction({ status: 'done' }), now)).toBe(false)
    expect(isUnresolvedPastProcessEvent(processAction({ processEventId: undefined }), now)).toBe(false)
  })

  it('removes overdue process events from the executable ranking while keeping future events', () => {
    const overdueDeadline = processAction({ id: 'overdue-deadline' })
    const overdueFixed = processAction({ id: 'overdue-fixed', timingMode: 'fixed' })
    const futureDeadline = processAction({
      id: 'future-deadline',
      dueAt: '2026-09-10T06:00:00.000Z',
    })

    const ranked = rankActions(
      [overdueDeadline, overdueFixed, futureDeadline],
      [opportunity],
      now,
    )

    expect(ranked.map((item) => item.action.id)).toEqual(['future-deadline'])
  })
})
