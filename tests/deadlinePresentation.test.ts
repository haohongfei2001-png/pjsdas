import { describe, expect, it } from 'vitest'
import { countdownMeta, priorityStepLabel, selectUpcomingDeadlineNodes } from '../src/deadlinePresentation'
import type { RankedAction } from '../src/model'

function ranked(id: string, dueAt: string, timingMode: 'deadline' | 'fixed' = 'deadline'): RankedAction {
  return {
    action: {
      id,
      kind: 'manual',
      title: id,
      dueAt,
      timingMode,
      estimatedMinutes: 30,
      leverage: 70,
      delayCost: 70,
      status: 'todo',
      createdAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:00:00.000Z',
    },
    score: 80,
    breakdown: {
      opportunity: 80,
      fit: 70,
      urgency: 80,
      stage: 80,
      leverage: 70,
      delayCost: 70,
      timeEfficiency: 70,
    },
    reasons: [],
  }
}

describe('Today presentation helpers', () => {
  it('uses human priority labels instead of exposing numeric ranking scores', () => {
    expect(priorityStepLabel(0)).toBe('第一要做')
    expect(priorityStepLabel(2)).toBe('第三要做')
  })

  it('formats deadline risk as remaining time', () => {
    const now = new Date('2026-09-10T23:00:00+08:00')
    const meta = countdownMeta('2026-09-12T06:00:00+08:00', now, 'deadline')
    expect(meta.label).toBe('距截止 1 天 7 小时')
    expect(meta.risk).toBe('soon')
  })

  it('shows future deadline nodes even when they are not part of the current Today plan', () => {
    const now = new Date('2026-09-10T23:00:00+08:00')
    const items = [
      ranked('tomorrow', '2026-09-11T23:59:00+08:00'),
      ranked('jd', '2026-09-12T06:00:00+08:00'),
      ranked('interview', '2026-09-12T10:00:00+08:00', 'fixed'),
      ranked('later', '2026-09-20T10:00:00+08:00'),
    ]
    expect(selectUpcomingDeadlineNodes(items, now).map((item) => item.action.id)).toEqual([
      'tomorrow',
      'jd',
    ])
  })
})
