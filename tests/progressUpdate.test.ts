import { describe, expect, it } from 'vitest'
import { parseProgressUpdate } from '../src/progressUpdate'
import type { Opportunity } from '../src/model'

function opportunity(id: string, company: string, role: string, stage: Opportunity['processStage'] = 'screening'): Opportunity {
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

const current = [
  opportunity('A-PM', '甲公司', '产品经理'),
  opportunity('B-OLD', '乙公司', '战略规划AI培训生', 'closed'),
  opportunity('B-PM', '乙公司', 'AI产品经理'),
  opportunity('C-PM', '丙公司', '产品经理', 'not_applied'),
]

const now = new Date(2026, 8, 10, 20, 0, 0)

describe('natural-language progress planner', () => {
  it('handles short applications, rename, relative assessment deadline, closure and fixed interview in one batch', () => {
    const plan = parseProgressUpdate(
      [
        '9月9日，投乙公司战略分析。乙公司AI产品经理岗位转变为AI全栈产品研发培训生，同时收到AI测评，14点收到，72小时完成。',
        '9月10日，甲公司产品经理流程结束。',
        '9月22日，乙公司AI全栈产品研发培训生10点面试。',
      ].join('\n'),
      current,
      now,
    )

    const submitted = plan.operations.find(
      (item) => item.kind === 'upsert_opportunity' && item.role === '战略分析',
    )
    expect(submitted).toMatchObject({ kind: 'upsert_opportunity', mode: 'submitted', company: '乙公司' })

    const renamed = plan.operations.find((item) => item.kind === 'rename_opportunity')
    expect(renamed).toMatchObject({
      kind: 'rename_opportunity',
      opportunityId: 'B-PM',
      newRole: 'AI全栈产品研发培训生',
    })

    const assessment = plan.operations.find(
      (item) => item.kind === 'process_event' && item.eventType === 'assessment_invite',
    )
    expect(assessment?.kind).toBe('process_event')
    if (assessment?.kind === 'process_event') {
      expect(assessment.timingMode).toBe('deadline')
      expect(new Date(assessment.dueAt!).getTime() - new Date(assessment.occurredAt).getTime()).toBe(72 * 60 * 60 * 1000)
    }

    expect(plan.operations.some(
      (item) => item.kind === 'close_opportunity' && item.opportunityId === 'A-PM',
    )).toBe(true)

    const interview = plan.operations.find(
      (item) => item.kind === 'process_event' && item.eventType === 'interview_invite',
    )
    expect(interview?.kind).toBe('process_event')
    if (interview?.kind === 'process_event') {
      expect(interview.timingMode).toBe('fixed')
      expect(new Date(interview.dueAt!).getDate()).toBe(22)
      expect(new Date(interview.dueAt!).getHours()).toBe(10)
    }
  })

  it('adds two planned roles when one company is shared explicitly', () => {
    const plan = parseProgressUpdate(
      '9月11日，准备投递丙公司PMO经理和产品经理。',
      current,
      now,
    )
    const planned = plan.operations.filter((item) => item.kind === 'upsert_opportunity')
    expect(planned).toHaveLength(2)
    expect(planned.map((item) => item.kind === 'upsert_opportunity' ? item.role : '')).toEqual(['PMO经理', '产品经理'])
    expect(planned.every((item) => item.kind === 'upsert_opportunity' && item.mode === 'planned')).toBe(true)
  })

  it('uses the most recently touched role in the same company for a later company-only process event', () => {
    const plan = parseProgressUpdate(
      '9月9日，投乙公司战略分析。\n9月11日，乙公司在线测评。',
      current,
      now,
    )
    const submitted = plan.operations.find(
      (item) => item.kind === 'upsert_opportunity' && item.role === '战略分析',
    )
    const assessment = plan.operations.find(
      (item) => item.kind === 'process_event' && item.eventType === 'assessment_invite',
    )
    expect(submitted?.kind).toBe('upsert_opportunity')
    expect(assessment?.kind).toBe('process_event')
    if (submitted?.kind === 'upsert_opportunity' && assessment?.kind === 'process_event') {
      expect(assessment.opportunityId).toBe(submitted.opportunityId)
    }
  })

  it('fails closed when a process event cannot be mapped to one role', () => {
    const plan = parseProgressUpdate(
      '9月12日，乙公司收到面试通知，10点参加。',
      current,
      now,
    )
    expect(plan.unresolved.length).toBeGreaterThan(0)
    expect(plan.operations.some((item) => item.kind === 'process_event')).toBe(false)
  })
})
