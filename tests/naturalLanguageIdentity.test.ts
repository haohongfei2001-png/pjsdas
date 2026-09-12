import { describe, expect, it } from 'vitest'
import { parseProgressUpdate } from '../src/progressUpdate.js'
import type { Opportunity } from '../src/model.js'

function opportunity(id: string, company: string, role: string): Opportunity {
  return {
    id,
    company,
    role,
    currentStageLabel: '待投',
    processStage: 'not_applied',
    roleType: 'core',
    early: false,
    opportunityValue: 80,
    fitScore: 70,
    importedAt: '2026-09-10T00:00:00.000Z',
  }
}

const now = new Date(2026, 8, 13, 1, 0, 0)

describe('natural-language opportunity identity guard', () => {
  it('reuses an existing job for brand alias + same role instead of creating JDS/JD duplicate', () => {
    const existing = opportunity('jd-pm', '京东', '技术产品经理')
    const plan = parseProgressUpdate('投递 JDS技术产品经理。', [existing], now)
    const upsert = plan.operations.find((item) => item.kind === 'upsert_opportunity')

    expect(plan.unresolved).toHaveLength(0)
    expect(upsert).toMatchObject({
      kind: 'upsert_opportunity',
      opportunityId: 'jd-pm',
      company: '京东',
      role: '技术产品经理',
      confidence: 'high',
      mode: 'submitted',
    })
  })

  it('reuses the unique high-confidence role when formatting or suffix text differs', () => {
    const existing = opportunity('example-ai-pm', 'Example Tech', 'AI 产品经理（数据平台）')
    const plan = parseProgressUpdate('投递 Example Tech AI产品经理。', [existing], now)
    const upsert = plan.operations.find((item) => item.kind === 'upsert_opportunity')

    expect(plan.unresolved).toHaveLength(0)
    expect(upsert).toMatchObject({ opportunityId: 'example-ai-pm', company: 'Example Tech', role: 'AI 产品经理（数据平台）' })
  })

  it('does not accept the old parser first-match behavior when one company has multiple equally similar roles', () => {
    const current = [
      opportunity('growth', '甲公司', '产品经理-增长'),
      opportunity('commercial', '甲公司', '产品经理-商业化'),
    ]
    const plan = parseProgressUpdate('投递 甲公司产品经理。', current, now)

    expect(plan.executable).toHaveLength(0)
    expect(plan.unresolved).toHaveLength(1)
    expect(plan.unresolved[0].reason).toContain('多个高度相似')
    expect(plan.unresolved[0].candidates?.map((item) => item.id).sort()).toEqual(['commercial', 'growth'])
  })

  it('keeps a genuinely different role as a new opportunity', () => {
    const existing = opportunity('strategy', '甲公司', '战略分析')
    const plan = parseProgressUpdate('投递 甲公司产品经理。', [existing], now)
    const upsert = plan.operations.find((item) => item.kind === 'upsert_opportunity')

    expect(plan.unresolved).toHaveLength(0)
    expect(upsert?.kind).toBe('upsert_opportunity')
    if (upsert?.kind === 'upsert_opportunity') expect(upsert.opportunityId).not.toBe(existing.id)
  })
})
