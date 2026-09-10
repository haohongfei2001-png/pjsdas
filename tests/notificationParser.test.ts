import { describe, expect, it } from 'vitest'
import {
  detectNotificationType,
  matchNotificationOpportunity,
  parseRecruitingNotification,
} from '../src/notificationParser'
import type { Opportunity } from '../src/model'

const opportunities: Opportunity[] = [
  {
    id: 'XPENG-STRATEGY',
    company: '小鹏汽车',
    role: '战略规划AI培训生',
    currentStageLabel: '筛选中',
    processStage: 'screening',
    roleType: 'core',
    early: false,
    opportunityValue: 94,
    fitScore: 76,
    importedAt: '2026-09-01T00:00:00.000Z',
  },
  {
    id: 'XPENG-PM',
    company: '小鹏汽车',
    role: '生态产品培训生（机器人方向）',
    currentStageLabel: '待投',
    processStage: 'not_applied',
    roleType: 'core',
    early: true,
    opportunityValue: 94,
    fitScore: 76,
    importedAt: '2026-09-01T00:00:00.000Z',
  },
  {
    id: 'SMIC-PM',
    company: '中芯国际',
    role: '产学研合作/政府项目管理',
    currentStageLabel: '测评',
    processStage: 'assessment',
    roleType: 'core',
    early: false,
    opportunityValue: 94,
    fitScore: 76,
    importedAt: '2026-09-01T00:00:00.000Z',
  },
]

const now = new Date(2026, 8, 10, 13, 0, 0)

describe('notification opportunity matching', () => {
  it('resolves one role when both company and role are present', () => {
    const result = matchNotificationOpportunity(
      '小鹏汽车战略规划AI培训生：恭喜进入AI面试环节',
      opportunities,
    )
    expect(result.selected?.id).toBe('XPENG-STRATEGY')
    expect(result.confidence).toBe('high')
  })

  it('does not auto-select when the message names only a company with multiple roles', () => {
    const result = matchNotificationOpportunity(
      '小鹏汽车校园招聘通知：请及时查看后续安排',
      opportunities,
    )
    expect(result.selected).toBeUndefined()
    expect(result.candidates[0].opportunity.company).toBe('小鹏汽车')
  })
})

describe('notification type detection', () => {
  it('distinguishes assessment, written test, interview, offer and rejection', () => {
    expect(detectNotificationType('请完成在线测评').type).toBe('assessment_invite')
    expect(detectNotificationType('请参加统一笔试').type).toBe('written_test_invite')
    expect(detectNotificationType('邀请您参加二面').type).toBe('interview_invite')
    expect(detectNotificationType('恭喜收到录用通知').type).toBe('offer')
    expect(detectNotificationType('很遗憾本次流程未通过').type).toBe('rejection')
  })

  it('does not mistake a polite assessment invitation for a rejection', () => {
    expect(
      detectNotificationType('感谢您关注并投递职位，现诚挚邀请您参加在线人才测评。').type,
    ).toBe('assessment_invite')
  })
})

describe('full notification parsing', () => {
  it('parses a deadline-style assessment that can be completed early', () => {
    const result = parseRecruitingNotification(
      '中芯国际 产学研合作/政府项目管理：请于9月11日23:59前完成在线测评。',
      opportunities,
      now,
    )
    expect(result.opportunity?.id).toBe('SMIC-PM')
    expect(result.type).toBe('assessment_invite')
    expect(result.timingMode).toBe('deadline')
    expect(result.dueAt).toBeDefined()
    const due = new Date(result.dueAt!)
    expect(due.getFullYear()).toBe(2026)
    expect(due.getMonth()).toBe(8)
    expect(due.getDate()).toBe(11)
    expect(due.getHours()).toBe(23)
    expect(due.getMinutes()).toBe(59)
    expect(result.confidence.time).toBe('high')
  })

  it('parses an expiring assessment link and reserves the upper bound of a stated duration range', () => {
    const target: Opportunity = {
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
    const result = parseRecruitingNotification(
      '感谢您关注并投递甲存储职位，现诚挚邀请您参加在线人才测评-作答时间约25-30分钟。作答链接将在2026年09月12日 周六 08:10失效，请充分准备后及时完成。',
      [target],
      now,
    )
    expect(result.opportunity?.id).toBe('ASSESSMENT-ROLE')
    expect(result.type).toBe('assessment_invite')
    expect(result.timingMode).toBe('deadline')
    expect(result.estimatedMinutes).toBe(30)
    const due = new Date(result.dueAt!)
    expect(due.getFullYear()).toBe(2026)
    expect(due.getMonth()).toBe(8)
    expect(due.getDate()).toBe(12)
    expect(due.getHours()).toBe(8)
    expect(due.getMinutes()).toBe(10)
  })

  it('parses a fixed interview and never converts it to deadline work', () => {
    const result = parseRecruitingNotification(
      '小鹏汽车 战略规划AI培训生面试通知：面试时间为明天19:30，请准时参加。',
      opportunities,
      now,
    )
    expect(result.opportunity?.id).toBe('XPENG-STRATEGY')
    expect(result.type).toBe('interview_invite')
    expect(result.timingMode).toBe('fixed')
    const due = new Date(result.dueAt!)
    expect(due.getDate()).toBe(11)
    expect(due.getHours()).toBe(19)
    expect(due.getMinutes()).toBe(30)
  })

  it('treats a unified written test as fixed time', () => {
    const result = parseRecruitingNotification(
      '小鹏汽车 战略规划AI培训生统一笔试安排：9月12日晚上7:00开考。',
      opportunities,
      now,
    )
    expect(result.type).toBe('written_test_invite')
    expect(result.timingMode).toBe('fixed')
    const due = new Date(result.dueAt!)
    expect(due.getDate()).toBe(12)
    expect(due.getHours()).toBe(19)
  })

  it('keeps a date-only fixed event unresolved rather than inventing a time', () => {
    const result = parseRecruitingNotification(
      '小鹏汽车 战略规划AI培训生面试安排在9月12日，请关注后续具体时间。',
      opportunities,
      now,
    )
    expect(result.type).toBe('interview_invite')
    expect(result.timingMode).toBe('fixed')
    expect(result.dueAt).toBeUndefined()
    expect(result.warnings.some((item) => item.includes('没有具体时刻'))).toBe(true)
  })

  it('warns instead of auto-selecting an ambiguous same-company role', () => {
    const result = parseRecruitingNotification(
      '小鹏汽车：邀请您于9月12日10:00参加面试。',
      opportunities,
      now,
    )
    expect(result.opportunity).toBeUndefined()
    expect(result.candidates.length).toBeGreaterThanOrEqual(2)
    expect(result.warnings.some((item) => item.includes('歧义'))).toBe(true)
  })
})
