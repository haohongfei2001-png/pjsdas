import { describe, expect, it } from 'vitest'
import { parseProgressUpdate } from '../src/progressUpdate.js'
import type { Opportunity } from '../src/model.js'

const now = new Date(2026, 8, 13, 10, 0, 0)

function opportunity(id: string, company: string, role: string, stage: Opportunity['processStage'] = 'screening'): Opportunity {
  return {
    id,
    company,
    role,
    currentStageLabel: stage === 'assessment' ? '测评' : stage === 'closed' ? '流程结束' : '筛选中',
    processStage: stage,
    roleType: 'core',
    early: false,
    opportunityValue: 80,
    fitScore: 70,
    detail: {
      discovery: {
        sourceUrl: `https://careers.example.com/${id}`,
        sourceTitle: role,
        rationale: 'test source',
        discoveredAt: '2026-09-10T00:00:00.000Z',
        fitConfidence: 'high',
        opportunityValueConfidence: 'high',
      },
    },
    importedAt: '2026-09-10T00:00:00.000Z',
  }
}

describe('natural-language input classification v2', () => {
  it('stores an explicit non-job item as a manual task even with no opportunity baseline', () => {
    const plan = parseProgressUpdate('待办：修改论文图表。', [], now)
    expect(plan.unresolved).toHaveLength(0)
    expect(plan.operations[0]).toMatchObject({
      kind: 'manual_action',
      title: '修改论文图表',
      confidence: 'high',
    })
    expect(plan.operations.some((item) => item.kind === 'upsert_opportunity')).toBe(false)
  })

  it('does not mistake a product-development test for a recruiting assessment', () => {
    const jobs = [opportunity('xpeng-ai-pm', '小鹏汽车', 'AI产品经理培训生')]
    const plan = parseProgressUpdate('测试 PAIA 网站。', jobs, now)
    expect(plan.operations[0]).toMatchObject({ kind: 'manual_action', title: '测试 PAIA 网站' })
    expect(plan.operations.some((item) => item.kind === 'process_event')).toBe(false)
  })

  it('interprets company + 测试 as the unique active job assessment', () => {
    const jobs = [opportunity('xpeng-ai-pm', '小鹏汽车', 'AI产品经理培训生')]
    const plan = parseProgressUpdate('小鹏测试。', jobs, now)
    expect(plan.unresolved).toHaveLength(0)
    expect(plan.operations[0]).toMatchObject({
      kind: 'process_event',
      opportunityId: 'xpeng-ai-pm',
      company: '小鹏汽车',
      role: 'AI产品经理培训生',
      eventType: 'assessment_invite',
    })
  })

  it('interprets company + 测试完成 as completion of the existing job assessment', () => {
    const jobs = [opportunity('xpeng-ai-pm', '小鹏汽车', 'AI产品经理培训生', 'assessment')]
    const plan = parseProgressUpdate('小鹏测试完成。', jobs, now)
    expect(plan.unresolved).toHaveLength(0)
    expect(plan.operations[0]).toMatchObject({
      kind: 'process_event',
      opportunityId: 'xpeng-ai-pm',
      eventType: 'assessment_invite',
      completed: true,
    })
  })

  it('uses the one assessment-stage role when the same company has several jobs', () => {
    const jobs = [
      opportunity('xpeng-strategy', '小鹏汽车', '战略规划AI培训生', 'screening'),
      opportunity('xpeng-ai-pm', '小鹏汽车', 'AI产品经理培训生', 'assessment'),
    ]
    const plan = parseProgressUpdate('小鹏测试。', jobs, now)
    expect(plan.operations[0]).toMatchObject({
      kind: 'process_event',
      opportunityId: 'xpeng-ai-pm',
    })
  })

  it('keeps company + 测试 unresolved when several active roles are equally plausible', () => {
    const jobs = [
      opportunity('xpeng-strategy', '小鹏汽车', '战略规划AI培训生'),
      opportunity('xpeng-ai-pm', '小鹏汽车', 'AI产品经理培训生'),
    ]
    const plan = parseProgressUpdate('小鹏测试。', jobs, now)
    expect(plan.executable).toHaveLength(0)
    expect(plan.unresolved).toHaveLength(1)
    expect(plan.unresolved[0]?.reason).toContain('公司 + 测试')
    expect(plan.unresolved[0]?.candidates?.map((item) => item.id).sort()).toEqual(['xpeng-ai-pm', 'xpeng-strategy'])
  })

  it('uses the role touched immediately before company + 测试 in the same batch', () => {
    const jobs = [
      opportunity('xpeng-strategy', '小鹏汽车', '战略规划AI培训生'),
      opportunity('xpeng-ai-pm', '小鹏汽车', 'AI产品经理培训生'),
    ]
    const plan = parseProgressUpdate('投递小鹏AI产品经理。\n小鹏测试。', jobs, now)
    const event = plan.operations.find((item) => item.kind === 'process_event')
    expect(event).toMatchObject({ kind: 'process_event', opportunityId: 'xpeng-ai-pm' })
  })
})
