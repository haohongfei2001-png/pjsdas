import { describe, expect, it } from 'vitest'
import {
  cloneDecisionRules,
  decisionRulesForSnapshot,
  DEFAULT_DECISION_RULES,
  DEFAULT_FIT_COMPONENT_WEIGHTS,
  DEFAULT_OPPORTUNITY_VALUE_COMPONENT_WEIGHTS,
  validateDecisionRules,
  type DecisionRules,
} from '../src/decisionRules.js'
import { decisionRulesEquivalent } from '../src/changeSet.js'

describe('v1.5 Round 2 component Decision Rules', () => {
  it('normalizes old rule snapshots without component weights to current defaults', () => {
    const legacy = cloneDecisionRules(DEFAULT_DECISION_RULES)
    delete legacy.fitComponentWeights
    delete legacy.opportunityValueComponentWeights
    const normalized = decisionRulesForSnapshot(legacy)
    expect(normalized.fitComponentWeights).toEqual(DEFAULT_FIT_COMPONENT_WEIGHTS)
    expect(normalized.opportunityValueComponentWeights).toEqual(DEFAULT_OPPORTUNITY_VALUE_COMPONENT_WEIGHTS)
    expect(validateDecisionRules(legacy)).toEqual([])
  })

  it('does not create a phantom rule difference merely because an old snapshot omitted default component weights', () => {
    const legacy = cloneDecisionRules(DEFAULT_DECISION_RULES) as DecisionRules
    delete legacy.fitComponentWeights
    delete legacy.opportunityValueComponentWeights
    expect(decisionRulesEquivalent(legacy, cloneDecisionRules(DEFAULT_DECISION_RULES))).toBe(true)
  })

  it('rejects component weight maps that have no active influence', () => {
    const invalid = cloneDecisionRules(DEFAULT_DECISION_RULES)
    invalid.fitComponentWeights = Object.fromEntries(
      Object.keys(invalid.fitComponentWeights!).map((key) => [key, 0]),
    ) as typeof invalid.fitComponentWeights
    expect(validateDecisionRules(invalid).join(' ')).toContain('匹配度组件权重不能全部为 0')
  })
})
