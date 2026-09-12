import { describe, expect, it } from 'vitest'
import { parseProgressUpdate, type CanonicalJobReference } from '../src/progressUpdate.js'
import type { Opportunity } from '../src/model.js'

function opportunity(id: string, company: string, role: string, sourceBacked = true): Opportunity {
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
    detail: sourceBacked ? {
      discovery: {
        sourceUrl: `https://careers.example.com/${id}`,
        sourceTitle: role,
        rationale: 'test source',
        discoveredAt: '2026-09-10T00:00:00.000Z',
        fitConfidence: 'high',
        opportunityValueConfidence: 'high',
      },
    } : undefined,
    importedAt: '2026-09-10T00:00:00.000Z',
  }
}

const now = new Date(2026, 8, 13, 1, 0, 0)

describe('natural-language opportunity identity guard', () => {
  it('reuses a source-backed existing job for brand alias + same role instead of creating JDS/JD duplicate', () => {
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

  it('reuses the source-backed canonical existing role when suffix text differs', () => {
    const existing = opportunity('example-ai-pm', 'Example Tech', 'AI 产品经理（数据平台）')
    const plan = parseProgressUpdate('投递 Example Tech AI产品经理。', [existing], now)
    const upsert = plan.operations.find((item) => item.kind === 'upsert_opportunity')

    expect(plan.unresolved).toHaveLength(0)
    expect(upsert).toMatchObject({ opportunityId: 'example-ai-pm', company: 'Example Tech', role: 'AI 产品经理（数据平台）' })
  })

  it('tolerates one missing character when the source-backed canonical existing role is unique', () => {
    const existing = opportunity('strategy', '甲公司', '战略分析师')
    const plan = parseProgressUpdate('投递 甲公司战略分析。', [existing], now)
    const upsert = plan.operations.find((item) => item.kind === 'upsert_opportunity')

    expect(plan.unresolved).toHaveLength(0)
    expect(upsert).toMatchObject({ opportunityId: 'strategy', role: '战略分析师' })
  })

  it('does not accept the old parser first-match behavior when one company has multiple equally similar source-backed roles', () => {
    const current = [
      opportunity('growth', '甲公司', '产品经理-增长'),
      opportunity('commercial', '甲公司', '产品经理-商业化'),
    ]
    const plan = parseProgressUpdate('投递 甲公司产品经理。', current, now)

    expect(plan.executable).toHaveLength(0)
    expect(plan.unresolved).toHaveLength(1)
    expect(plan.unresolved[0]?.reason).toContain('多个来源支持')
    expect(plan.unresolved[0]?.candidates?.map((item) => item.id).sort()).toEqual(['commercial', 'growth'])
  })

  it('does not create a genuinely new manually typed role without a canonical source reference', () => {
    const existing = opportunity('strategy', '甲公司', '战略分析', false)
    const plan = parseProgressUpdate('投递 甲公司产品经理。', [existing], now)

    expect(plan.executable).toHaveLength(0)
    expect(plan.unresolved).toHaveLength(1)
    expect(plan.unresolved[0]?.reason).toContain('官网/来源支持的统一岗位名')
  })

  it('does not let an unsourced legacy Opportunity define the canonical title even on an exact match', () => {
    const existing = opportunity('legacy-strategy', '甲公司', '战略分析师', false)
    const plan = parseProgressUpdate('投递 甲公司战略分析师。', [existing], now)

    expect(plan.executable).toHaveLength(0)
    expect(plan.unresolved).toHaveLength(1)
    expect(plan.unresolved[0]?.reason).toContain('没有官网/来源证据')
    expect(plan.unresolved[0]?.candidates?.[0]?.id).toBe('legacy-strategy')
  })

  it('uses a source-backed reference to normalize a legacy Opportunity while preserving its ID', () => {
    const existing = opportunity('legacy-ai-pm', '甲公司', 'AI产品经理', false)
    const references: CanonicalJobReference[] = [{
      opportunityId: 'candidate-ai-pm',
      company: '甲公司',
      role: 'AI产品经理培训生',
      sourceBacked: true,
      sourceLabel: 'https://careers.example.com/ai-pm',
    }]
    const plan = parseProgressUpdate('投递 甲公司AI产品经理。', [existing], now, references)
    const upsert = plan.operations.find((item) => item.kind === 'upsert_opportunity')

    expect(plan.unresolved).toHaveLength(0)
    expect(upsert).toMatchObject({
      kind: 'upsert_opportunity',
      opportunityId: 'legacy-ai-pm',
      company: '甲公司',
      role: 'AI产品经理培训生',
      confidence: 'high',
    })
  })

  it('converts a shorthand manual role to the source-backed canonical role name', () => {
    const references: CanonicalJobReference[] = [{
      opportunityId: 'candidate-ai-pm',
      company: '甲公司',
      role: 'AI产品经理培训生',
      sourceBacked: true,
      sourceLabel: 'https://careers.example.com/ai-pm',
    }]
    const plan = parseProgressUpdate('投递 甲公司AI产品经理。', [], now, references)
    const upsert = plan.operations.find((item) => item.kind === 'upsert_opportunity')

    expect(plan.unresolved).toHaveLength(0)
    expect(upsert).toMatchObject({
      kind: 'upsert_opportunity',
      opportunityId: 'candidate-ai-pm',
      company: '甲公司',
      role: 'AI产品经理培训生',
      confidence: 'high',
    })
  })
})
