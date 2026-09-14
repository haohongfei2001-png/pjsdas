import { describe, expect, it } from 'vitest'
import { buildApplicationPortfolioDecision } from '../src/applicationPortfolio.js'
import { cloneDecisionRules, DEFAULT_DECISION_RULES } from '../src/decisionRules.js'
import type { ApplicationGroup, Opportunity } from '../src/model.js'

function opportunity(
  id: string,
  role: string,
  fit: number,
  value: number,
  options: Partial<Opportunity> = {},
): Opportunity {
  return {
    id,
    company: '示例科技',
    role,
    currentStageLabel: '待投递',
    processStage: 'not_applied',
    roleType: 'core',
    early: false,
    applicationGroupId: 'GROUP-1',
    prepEstimateMinutes: 45,
    opportunityValue: value,
    fitScore: fit,
    importedAt: '2026-09-12T00:00:00.000Z',
    ...options,
  }
}

function group(overrides: Partial<ApplicationGroup> = {}): ApplicationGroup {
  return {
    id: 'GROUP-1',
    company: '示例科技',
    total: 3,
    used: 0,
    remaining: 3,
    ...overrides,
  }
}

describe('application portfolio decision engine', () => {
  it('uses canonical process state rather than Chinese presentation text to decide pending eligibility', () => {
    const result = buildApplicationPortfolioDecision(group({ remaining: 1 }), [
      opportunity('pending', 'AI 产品经理', 90, 92, { currentStageLabel: '待投递' }),
    ], cloneDecisionRules(DEFAULT_DECISION_RULES), new Date('2026-09-12T08:00:00+08:00'))

    expect(result.recommended.map((item) => item.opportunityId)).toEqual(['pending'])
    expect(result.notRecommended).toHaveLength(0)
  })

  it('treats capacity as a maximum and does not fill weak slots merely because they exist', () => {
    const rules = cloneDecisionRules(DEFAULT_DECISION_RULES)
    const result = buildApplicationPortfolioDecision(group(), [
      opportunity('strong', 'AI 产品经理', 90, 92),
      opportunity('weak', '产品运营', 35, 45, { roleType: 'practice', prepEstimateMinutes: 120 }),
    ], rules, new Date('2026-09-12T08:00:00+08:00'))

    expect(result.status).toBe('ready')
    expect(result.capacity).toBe(3)
    expect(result.recommended.map((item) => item.opportunityId)).toEqual(['strong'])
    expect(result.notRecommended.find((item) => item.opportunityId === 'weak')?.disposition).toBe('below_minimum')
  })

  it('can leave a redundant similar role unselected when overlap destroys marginal portfolio value', () => {
    const rules = cloneDecisionRules(DEFAULT_DECISION_RULES)
    rules.portfolioMinimumCandidateScore = 62
    const result = buildApplicationPortfolioDecision(group({ remaining: 2 }), [
      opportunity('primary', 'AI 产品经理', 86, 90),
      opportunity('redundant', 'AI 产品经理', 64, 67, { roleType: 'backup', prepEstimateMinutes: 90 }),
    ], rules, new Date('2026-09-12T08:00:00+08:00'))

    expect(result.recommended.map((item) => item.opportunityId)).toEqual(['primary'])
    const redundant = result.notRecommended.find((item) => item.opportunityId === 'redundant')
    expect(redundant?.disposition).toBe('overlap')
    expect(redundant?.maxSimilarityToRecommended).toBe(1)
    expect(redundant?.reasons.some((reason) => reason.code === 'high_overlap')).toBe(true)
  })

  it('fails closed to ranking-only output when remaining capacity cannot be determined', () => {
    const rules = cloneDecisionRules(DEFAULT_DECISION_RULES)
    const result = buildApplicationPortfolioDecision(group({ total: undefined, used: undefined, remaining: undefined }), [
      opportunity('a', 'AI 产品经理', 88, 90),
      opportunity('b', '战略规划', 82, 86),
    ], rules, new Date('2026-09-12T08:00:00+08:00'))

    expect(result.status).toBe('needs_rule_confirmation')
    expect(result.capacity).toBeUndefined()
    expect(result.recommended).toHaveLength(0)
    expect(result.notRecommended[0].baseScore).toBeGreaterThanOrEqual(result.notRecommended[1].baseScore)
    expect(result.warnings.some((warning) => warning.code === 'capacity_unknown')).toBe(true)
  })

  it('respects locked groups and never proposes replacement selections', () => {
    const result = buildApplicationPortfolioDecision(group({ locked: true, currentOrder: 'AI 产品经理优先' }), [
      opportunity('a', 'AI 产品经理', 90, 92),
      opportunity('b', '战略规划', 85, 88),
    ], cloneDecisionRules(DEFAULT_DECISION_RULES), new Date('2026-09-12T08:00:00+08:00'))

    expect(result.status).toBe('locked')
    expect(result.recommended).toHaveLength(0)
    expect(result.warnings.some((warning) => warning.code === 'group_locked')).toBe(true)
    expect(result.warnings.some((warning) => warning.code === 'current_order_context')).toBe(true)
  })

  it('excludes already-submitted or expired roles from portfolio selection', () => {
    const result = buildApplicationPortfolioDecision(group({ remaining: 2 }), [
      opportunity('submitted', '商业分析', 90, 90, { currentStageLabel: '筛选中', processStage: 'screening' }),
      opportunity('expired', '战略规划', 90, 90, { deadline: '2026-09-01T23:59:59+08:00' }),
      opportunity('live', 'AI 产品经理', 88, 91),
    ], cloneDecisionRules(DEFAULT_DECISION_RULES), new Date('2026-09-12T08:00:00+08:00'))

    expect(result.recommended.map((item) => item.opportunityId)).toEqual(['live'])
    expect(result.notRecommended.find((item) => item.opportunityId === 'submitted')?.disposition).toBe('not_pending')
    expect(result.notRecommended.find((item) => item.opportunityId === 'expired')?.disposition).toBe('expired')
  })
})
