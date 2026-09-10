import { describe, expect, it } from 'vitest'
import { parseProgressUpdate } from '../src/progressUpdate'
import type { Opportunity } from '../src/model'

const opportunity: Opportunity = {
  id: 'ASSESSMENT-ROLE',
  company: '甲存储',
  role: '产品经理',
  currentStageLabel: '筛选中',
  processStage: 'screening',
  roleType: 'core',
  early: false,
  opportunityValue: 90,
  fitScore: 70,
  importedAt: '2026-09-01T00:00:00.000Z',
}

describe('progress inbox assessment duration', () => {
  it('preserves a stated 25-30 minute duration and explicit expiry time', () => {
    const now = new Date(2026, 8, 10, 23, 0, 0)
    const plan = parseProgressUpdate(
      '感谢您关注并投递甲存储职位，现诚挚邀请您参加在线人才测评-作答时间约25-30分钟。作答链接将在2026年09月12日 周六 08:10失效，请充分准备后及时完成。',
      [opportunity],
      now,
    )
    const event = plan.operations.find((item) => item.kind === 'process_event')
    expect(event?.kind).toBe('process_event')
    if (event?.kind !== 'process_event') return
    expect(event.eventType).toBe('assessment_invite')
    expect(event.timingMode).toBe('deadline')
    expect(event.estimatedMinutes).toBe(30)
    const due = new Date(event.dueAt!)
    expect(due.getFullYear()).toBe(2026)
    expect(due.getMonth()).toBe(8)
    expect(due.getDate()).toBe(12)
    expect(due.getHours()).toBe(8)
    expect(due.getMinutes()).toBe(10)
  })
})
