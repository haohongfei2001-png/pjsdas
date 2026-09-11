import { describe, expect, it } from 'vitest'
import { actionNodePrefix, formatTimeRemaining, timeRisk, upcomingNodes } from '../src/timeRisk.js'
import type { Action, RankedAction } from '../src/model.js'

function ranked(id: string, dueAt: string, overrides: Partial<Action> = {}): RankedAction {
  return {
    score: 80,
    reasons: [],
    breakdown: {
      opportunity: 80,
      fit: 70,
      urgency: 80,
      stage: 70,
      leverage: 70,
      delayCost: 70,
      timeEfficiency: 70,
    },
    action: {
      id,
      kind: 'apply',
      title: id,
      dueAt,
      estimatedMinutes: 30,
      leverage: 70,
      delayCost: 70,
      status: 'todo',
      createdAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:00:00.000Z',
      ...overrides,
    },
  }
}

describe('deadline countdown display', () => {
  const now = new Date('2026-09-10T16:00:00.000Z')

  it('shows precise short-horizon remaining time', () => {
    expect(formatTimeRemaining('2026-09-10T18:30:00.000Z', now)).toBe('剩 2 小时 30 分钟')
    expect(formatTimeRemaining('2026-09-11T20:00:00.000Z', now)).toBe('剩 1 天 4 小时')
  })

  it('maps time remaining to risk bands', () => {
    expect(timeRisk('2026-09-10T20:00:00.000Z', now).level).toBe('critical')
    expect(timeRisk('2026-09-11T08:00:00.000Z', now).level).toBe('high')
    expect(timeRisk('2026-09-12T00:00:00.000Z', now).level).toBe('near')
  })

  it('uses the right semantic prefix for deadline, fixed and planned nodes', () => {
    expect(actionNodePrefix(ranked('a', '2026-09-11T00:00:00.000Z').action)).toBe('距失效')
    expect(actionNodePrefix(ranked('b', '2026-09-11T00:00:00.000Z', { timingMode: 'fixed' }).action)).toBe('距开始')
    expect(actionNodePrefix(ranked('c', '2026-09-11T00:00:00.000Z', { sourceLabel: '计划执行日' }).action)).toBe('距计划')
  })

  it('returns future actionable nodes in chronological order and ignores follow-ups', () => {
    const items = [
      ranked('later', '2026-09-13T00:00:00.000Z'),
      ranked('soon', '2026-09-11T00:00:00.000Z'),
      ranked('follow', '2026-09-10T20:00:00.000Z', { kind: 'follow_up' }),
    ]
    expect(upcomingNodes(items, now).map((item) => item.action.id)).toEqual(['soon', 'later'])
  })
})
