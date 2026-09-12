import { describe, expect, it } from 'vitest'
import { normalizeGmailMessagesForWorkspace } from '../gateway/ingestSources.js'
import type { GmailMessageObservation } from '../src/autonomousIngestion.js'
import type { Opportunity } from '../src/model.js'

function opportunity(id: string, company: string, role: string, stage: Opportunity['processStage'] = 'screening'): Opportunity {
  return {
    id,
    company,
    role,
    currentStageLabel: stage === 'screening' ? '筛选中' : stage,
    processStage: stage,
    roleType: 'core',
    early: false,
    opportunityValue: 80,
    fitScore: 75,
    locallyManaged: true,
    importedAt: '2026-09-10T00:00:00.000Z',
  }
}

function message(overrides: Partial<GmailMessageObservation> = {}): GmailMessageObservation {
  return {
    sourceRecordId: '1a088311d8864599',
    receivedAt: '2026-09-10T06:01:50+08:00',
    classification: 'recruiting',
    confidence: 'high',
    sender: 'campus@jd.com',
    subject: '【京东校招】2027 JDS测评通知',
    company: '京东',
    eventType: 'assessment_invite',
    dueAt: '2026-09-12T06:01:50+08:00',
    timingMode: 'deadline',
    estimatedMinutes: 45,
    ...overrides,
  }
}

describe('Gmail trusted-write entity resolution', () => {
  it('links a JDS assessment mail without a role only when the company has one active Opportunity', () => {
    const normalized = normalizeGmailMessagesForWorkspace(
      [message()],
      [opportunity('jd-jds', '京东', '技术产品经理')],
    )

    expect(normalized[0]).toMatchObject({
      confidence: 'high',
      company: '京东',
      role: '技术产品经理',
    })
    expect(normalized[0]?.notes).toContain('唯一活跃 Opportunity')
  })

  it('refuses to guess when one company has multiple active applications and the mail omits the role', () => {
    const normalized = normalizeGmailMessagesForWorkspace(
      [message()],
      [
        opportunity('jd-jds', '京东', '技术产品经理'),
        opportunity('jd-tet', '京东', 'TET产品方向'),
      ],
    )

    expect(normalized[0]?.confidence).toBe('medium')
    expect(normalized[0]?.role).toBeUndefined()
    expect(normalized[0]?.notes).toContain('多个活跃 Opportunity')
  })

  it('uses an explicit exact role to disambiguate multiple same-company opportunities', () => {
    const normalized = normalizeGmailMessagesForWorkspace(
      [message({ role: 'AI产品经理' })],
      [
        opportunity('xp-ai', '小鹏汽车', 'AI产品经理'),
        opportunity('xp-strategy', '小鹏汽车', '战略规划AI培训生'),
      ],
    )

    expect(normalized[0]).toMatchObject({ confidence: 'high', role: 'AI产品经理' })
  })

  it('downgrades a generic overlapping role when multiple same-company matches remain plausible', () => {
    const normalized = normalizeGmailMessagesForWorkspace(
      [message({ company: 'Example Tech', role: '产品经理', subject: '在线测评邀请' })],
      [
        opportunity('ex-tech', 'Example Tech', '技术产品经理'),
        opportunity('ex-user', 'Example Tech', '用户产品经理'),
      ],
    )

    expect(normalized[0]?.confidence).toBe('medium')
    expect(normalized[0]?.notes).toContain('多个高度相似')
  })

  it('does not reinterpret a recruiting newsletter or campus talk that upstream classified as ignored', () => {
    const normalized = normalizeGmailMessagesForWorkspace([
      message({
        sourceRecordId: '1a092f8c2944d98c',
        classification: 'ignored',
        company: '中国银行天津市分行',
        subject: '中国银行天津市分行2027届校园招聘-南开大学专场',
        eventType: undefined,
      }),
    ], [opportunity('boc', '中国银行天津市分行', '管理培训生')])

    expect(normalized[0]).toMatchObject({ classification: 'ignored', confidence: 'high' })
    expect(normalized[0]?.role).toBeUndefined()
  })
})
