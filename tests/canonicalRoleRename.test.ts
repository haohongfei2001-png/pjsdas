import { describe, expect, it } from 'vitest'
import { createJobPostingEvidence } from '../src/jobPosting.js'
import { parseProgressUpdate, type CanonicalJobReference } from '../src/progressUpdate.js'
import type { Opportunity } from '../src/model.js'

const now = new Date(2026, 8, 13, 12, 0, 0)

function opportunity(id: string, company: string, role: string): Opportunity {
  const observedAt = '2026-09-10T00:00:00.000Z'
  const sourceUrl = `https://careers.example.com/${id}`
  return {
    id,
    company,
    role,
    currentStageLabel: '筛选中',
    processStage: 'screening',
    roleType: 'core',
    early: false,
    opportunityValue: 80,
    fitScore: 70,
    detail: {
      discovery: {
        sourceUrl,
        sourceTitle: role,
        rationale: 'test source',
        discoveredAt: observedAt,
        fitConfidence: 'high',
        opportunityValueConfidence: 'high',
        posting: createJobPostingEvidence({ company, role, sourceUrl, sourceTitle: role, observedAt }),
      },
    },
    importedAt: observedAt,
  }
}

const oldJob = opportunity('old-ai-pm', '甲公司', 'AI产品经理')
const canonicalTarget: CanonicalJobReference = {
  opportunityId: 'candidate-ai-fullstack',
  company: '甲公司',
  role: 'AI全栈产品研发培训生',
  sourceBacked: true,
  sourceLabel: 'https://careers.example.com/ai-fullstack',
}

describe('canonical role rename guard', () => {
  it('rejects a manually typed role-transfer target when no source-backed canonical title exists', () => {
    const plan = parseProgressUpdate('甲公司AI产品经理岗位转变为AI全栈产品研发培训生。', [oldJob], now)

    expect(plan.operations.some((item) => item.kind === 'rename_opportunity')).toBe(false)
    expect(plan.unresolved).toHaveLength(1)
    expect(plan.unresolved[0]?.reason).toContain('新名称没有官网/来源支持')
  })

  it('rewrites a role-transfer target to the source-backed canonical title', () => {
    const plan = parseProgressUpdate(
      '甲公司AI产品经理岗位转变为AI全栈产品研发培训。',
      [oldJob],
      now,
      [canonicalTarget],
    )
    const rename = plan.operations.find((item) => item.kind === 'rename_opportunity')

    expect(plan.unresolved).toHaveLength(0)
    expect(rename).toMatchObject({
      kind: 'rename_opportunity',
      opportunityId: 'old-ai-pm',
      company: '甲公司',
      oldRole: 'AI产品经理',
      newRole: 'AI全栈产品研发培训生',
      confidence: 'high',
    })
  })

  it('fails closed instead of renaming into a canonical job that already exists as another Opportunity', () => {
    const existingTarget = opportunity('existing-ai-fullstack', '甲公司', 'AI全栈产品研发培训生')
    const plan = parseProgressUpdate(
      '甲公司AI产品经理岗位转变为AI全栈产品研发培训生。',
      [oldJob, existingTarget],
      now,
      [canonicalTarget],
    )

    expect(plan.operations.some((item) => item.kind === 'rename_opportunity')).toBe(false)
    expect(plan.unresolved).toHaveLength(1)
    expect(plan.unresolved[0]?.reason).toContain('已经作为另一个 Opportunity 存在')
    expect(plan.unresolved[0]?.candidates?.[0]?.id).toBe('existing-ai-fullstack')
  })
})
