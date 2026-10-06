import { describe, expect, it } from 'vitest'
import * as legacy from '../src/opportunityAssessment.js'
import { createDefaultDecisionRules } from '../src/decisionRules.js'
import type { Opportunity } from '../src/model.js'
const assessment = legacy.createOpportunityAssessment({ fit: { skills: { score: 73, confidence: 'low', rationale: 'Historical evidence' } },
  opportunityValue: { roleGrowth: { score: 81, confidence: 'medium', rationale: 'Historical evidence' } } }, '2026-09-12T00:00:00Z')
describe('historical assessment compatibility only', () => {
  it('continues validating old snapshots without creating aggregate scores', () => {
    expect(legacy.validateOpportunityAssessment(assessment)).toEqual([])
    expect(legacy).not.toHaveProperty('scoreOpportunityAssessment')
    expect(legacy).not.toHaveProperty('assessmentWarnings')
  })
  it('never recalculates or mutates historical scores in read projections', () => {
    const opportunity = { id: 'old', fitScore: 31, opportunityValue: 47, detail: { assessment } } as Opportunity
    const before = structuredClone(opportunity)
    expect(legacy.projectOpportunityAssessment(opportunity, createDefaultDecisionRules())).toBe(opportunity)
    expect(opportunity).toEqual(before)
  })
  it('still rejects malformed stored components', () => {
    const invalid = structuredClone(assessment); invalid.fit.skills!.rationale = ''
    expect(legacy.validateOpportunityAssessment(invalid).join(' ')).toContain('缺少有效依据')
  })
})
