import { describe, expect, it } from 'vitest'
import { isUnresolvedPastFixed } from '../src/fixedEventGuardLogic'
import type { Action } from '../src/model'

const now = new Date('2026-09-10T05:00:00.000Z')

function action(overrides: Partial<Action> = {}): Action {
  return {
    id: 'event-action:evt-fixed',
    kind: 'manual',
    title: '参加 测试公司｜面试',
    opportunityId: 'OPP-001',
    processEventId: 'evt-fixed',
    processStage: 'interview',
    dueAt: '2026-09-10T04:00:00.000Z',
    timingMode: 'fixed',
    estimatedMinutes: 90,
    leverage: 98,
    delayCost: 100,
    status: 'todo',
    sourceLabel: '流程事件',
    createdAt: '2026-09-09T00:00:00.000Z',
    updatedAt: '2026-09-09T00:00:00.000Z',
    ...overrides,
  }
}

describe('fixed-event confirmation guard', () => {
  it('alerts only for unresolved fixed process events whose time has passed', () => {
    expect(isUnresolvedPastFixed(action(), now)).toBe(true)
    expect(isUnresolvedPastFixed(action({ dueAt: '2026-09-10T06:00:00.000Z' }), now)).toBe(false)
    expect(isUnresolvedPastFixed(action({ timingMode: 'deadline' }), now)).toBe(false)
    expect(isUnresolvedPastFixed(action({ status: 'done' }), now)).toBe(false)
    expect(isUnresolvedPastFixed(action({ processEventId: undefined }), now)).toBe(false)
  })
})
