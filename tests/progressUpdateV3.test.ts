import { describe, expect, it } from 'vitest'
import { parseProgressUpdate } from '../src/progressUpdate'
import type { Opportunity } from '../src/model'

function opportunity(
  id: string,
  company: string,
  role: string,
  stage: Opportunity['processStage'] = 'screening',
): Opportunity {
  return {
    id,
    company,
    role,
    currentStageLabel: stage === 'closed' ? '流程结束' : stage === 'not_applied' ? '待投' : '筛选中',
    processStage: stage,
    roleType: 'core',
    early: false,
    opportunityValue: 90,
    fitScore: 70,
    importedAt: '2026-09-01T00:00:00.000Z',
  }
}

const now = new Date(2026, 8, 10, 20, 0, 0)

describe('progress v3 correction layer', () => {
  it('does not confuse a short brand with a longer company sharing its prefix', () => {
    const current = [opportunity('BOE-PM', '京东方 BOE', '产品经理', 'not_applied')]
    const plan = parseProgressUpdate('9月10日，投递京东技术产品经理。', current, now)
    const submitted = plan.operations.find((item) => item.kind === 'upsert_opportunity')
    expect(submitted).toMatchObject({
      kind: 'upsert_opportunity',
      company: '京东',
      role: '技术产品经理',
      mode: 'submitted',
    })
  })

  it('uses a later explicit role for a later company-only assessment', () => {
    const current = [
      opportunity('D-OPS', '丁公司', '研发运营'),
      opportunity('D-STRATEGY', '丁公司', '战略分析', 'not_applied'),
    ]
    const plan = parseProgressUpdate(
      '9月4日，丁公司研发运营AI面试。\n9月9日，投丁公司战略分析。\n9月11日，丁公司在线测评。',
      current,
      now,
    )
    const event = plan.operations.find(
      (item) => item.kind === 'process_event' && item.eventType === 'assessment_invite',
    )
    expect(event).toMatchObject({ kind: 'process_event', opportunityId: 'D-STRATEGY' })
  })

  it('ignores clock text when matching a role for an interview', () => {
    const current = [
      opportunity('E-RD', '戊公司', '产学研合作工程师-园区'),
      opportunity('E-PLAN', '戊公司', '生产计划工程师'),
    ]
    const plan = parseProgressUpdate('9月22日，戊公司产学研合作工程师10点面试。', current, now)
    const event = plan.operations.find(
      (item) => item.kind === 'process_event' && item.eventType === 'interview_invite',
    )
    expect(event).toMatchObject({ kind: 'process_event', opportunityId: 'E-RD' })
    if (event?.kind === 'process_event') {
      expect(new Date(event.dueAt!).getDate()).toBe(22)
      expect(new Date(event.dueAt!).getHours()).toBe(10)
    }
  })

  it('turns an unknown historical company+role closure into a local closed opportunity sequence', () => {
    const plan = parseProgressUpdate(
      '9月6日，NOVA（27届 ASP）AI产品经理培训生流程终止。',
      [],
      now,
    )
    expect(plan.unresolved).toHaveLength(0)
    expect(plan.operations.some((item) =>
      item.kind === 'upsert_opportunity' && item.company === 'NOVA' && item.role === 'AI产品经理培训生'
    )).toBe(true)
    expect(plan.operations.some((item) =>
      item.kind === 'close_opportunity' && item.company === 'NOVA' && item.role === 'AI产品经理培训生'
    )).toBe(true)
  })

  it('does not force a company-only old closure into manual repair', () => {
    const plan = parseProgressUpdate('9月4日，ZS流程结束。', [], now)
    expect(plan.unresolved).toHaveLength(0)
    expect(plan.ignored).toHaveLength(1)
  })

  it('turns a dated standalone administrative task into a manual action', () => {
    const current = [opportunity('A', '甲公司', '产品经理')]
    const plan = parseProgressUpdate('9月11日，2027届毕业生源信息校对。', current, now)
    expect(plan.operations[0]).toMatchObject({
      kind: 'manual_action',
      title: '2027届毕业生源信息校对',
    })
  })
})
