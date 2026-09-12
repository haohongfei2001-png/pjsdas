import { describe, expect, it } from 'vitest'
import { rankActions } from '../src/decisionV3.js'
import type { Action } from '../src/model.js'

const now = new Date('2026-09-13T10:00:00.000Z')

function action(id: string, kind: Action['kind'], title: string): Action {
  return {
    id,
    kind,
    title,
    dueAt: '2026-09-13T12:00:00.000Z',
    estimatedMinutes: 20,
    leverage: 70,
    delayCost: 70,
    status: 'todo',
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z',
  }
}

describe('review attention policy', () => {
  it('does not let passive follow-up/review reminders occupy Today ranking', () => {
    const ranked = rankActions([
      action('review', 'follow_up', '复核某公司流程'),
      action('task', 'manual', '提交材料'),
    ], [], now)

    expect(ranked.map((item) => item.action.id)).toEqual(['task'])
    expect(ranked.some((item) => item.action.kind === 'follow_up')).toBe(false)
  })
})