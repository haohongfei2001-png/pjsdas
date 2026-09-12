import { describe, expect, it } from 'vitest'
import { decisionRulesEquivalent } from '../src/changeSet.js'
import {
  cloneDecisionRules,
  DEFAULT_DECISION_RULES,
  decisionRulesForSnapshot,
  validateDecisionRules,
  type DecisionRules,
} from '../src/decisionRules.js'

describe('v1.6 Round 1 portfolio Decision Rules', () => {
  it('normalizes older rules without portfolio fields to recommended defaults', () => {
    const legacy = cloneDecisionRules(DEFAULT_DECISION_RULES) as DecisionRules
    delete legacy.portfolioWeights
    delete legacy.portfolioMinimumCandidateScore
    const normalized = decisionRulesForSnapshot(legacy)
    expect(normalized.portfolioWeights).toMatchObject({ opportunityValue: 28, fit: 28, overlapPenalty: 18 })
    expect(normalized.portfolioMinimumCandidateScore).toBe(62)
  })

  it('does not create a phantom rule change only because an older snapshot omitted portfolio defaults', () => {
    const legacy = cloneDecisionRules(DEFAULT_DECISION_RULES) as DecisionRules
    delete legacy.portfolioWeights
    delete legacy.portfolioMinimumCandidateScore
    expect(decisionRulesEquivalent(legacy, cloneDecisionRules(DEFAULT_DECISION_RULES))).toBe(true)
  })

  it('rejects unusable portfolio policy', () => {
    const invalid = cloneDecisionRules(DEFAULT_DECISION_RULES)
    invalid.portfolioWeights = {
      opportunityValue: 0,
      fit: 0,
      rolePriority: 0,
      deadline: 0,
      applicationEfficiency: 0,
      evidenceConfidence: 0,
      overlapPenalty: 0,
    }
    invalid.portfolioMinimumCandidateScore = 101
    const errors = validateDecisionRules(invalid)
    expect(errors.join(' ')).toContain('申请组合决策权重')
    expect(errors.join(' ')).toContain('组合决策最低候选分')
  })
})
