import { describe, expect, it } from 'vitest'
import { cloneDecisionRules, DEFAULT_DECISION_RULES } from '../src/decisionRules.js'
import {
  assessmentWarnings,
  createOpportunityAssessment,
  scoreOpportunityAssessment,
  validateOpportunityAssessment,
} from '../src/opportunityAssessment.js'

describe('v1.5 Round 2 component assessment model', () => {
  it('aggregates only known components instead of imputing missing components', () => {
    const assessment = createOpportunityAssessment({
      fit: {
        roleDirection: { score: 90, confidence: 'high', rationale: '方向直接匹配 AI 产品。' },
        skills: { score: 70, confidence: 'high', rationale: '分析能力较强，但产品工具经验有限。' },
      },
      opportunityValue: {
        companyQuality: { score: 90, confidence: 'high', rationale: '公司平台较强。' },
        roleGrowth: { score: 80, confidence: 'high', rationale: '岗位成长路径清晰。' },
      },
    }, '2026-09-12T00:00:00.000Z')

    const scored = scoreOpportunityAssessment(assessment, cloneDecisionRules(DEFAULT_DECISION_RULES))
    expect(scored.fit.score).toBe(81.4)
    expect(scored.fit.coveragePercent).toBe(42)
    expect(scored.fit.missingComponents).toContain('education')
    expect(scored.fit.confidence).toBe('medium')
    expect(scored.opportunityValue.score).toBe(85)
    expect(scored.opportunityValue.coveragePercent).toBe(36)
    expect(assessmentWarnings(assessment, cloneDecisionRules(DEFAULT_DECISION_RULES)).join(' ')).toContain('覆盖')
  })

  it('changes explicit current-rules projection deterministically without mutating component data', () => {
    const assessment = createOpportunityAssessment({
      fit: {
        roleDirection: { score: 95, confidence: 'high', rationale: '方向高度匹配。' },
        skills: { score: 60, confidence: 'medium', rationale: '技能部分匹配。' },
      },
      opportunityValue: {
        companyQuality: { score: 75, confidence: 'high', rationale: '平台质量较高。' },
        compensation: { score: 95, confidence: 'high', rationale: '薪资明显有吸引力。' },
      },
    }, '2026-09-12T00:00:00.000Z')
    const baseline = scoreOpportunityAssessment(assessment, cloneDecisionRules(DEFAULT_DECISION_RULES))
    const changedRules = cloneDecisionRules(DEFAULT_DECISION_RULES)
    changedRules.fitComponentWeights = { ...changedRules.fitComponentWeights!, roleDirection: 0, skills: 100 }
    changedRules.opportunityValueComponentWeights = {
      ...changedRules.opportunityValueComponentWeights!,
      companyQuality: 0,
      compensation: 100,
    }
    const changed = scoreOpportunityAssessment(assessment, changedRules)

    expect(baseline.fit.score).not.toBe(changed.fit.score)
    expect(changed.fit.score).toBe(60)
    expect(changed.opportunityValue.score).toBe(95)
    expect(assessment.fit.roleDirection?.score).toBe(95)
  })

  it('keeps low-confidence and sparse evidence visible as uncertainty rather than a hidden score penalty', () => {
    const assessment = createOpportunityAssessment({
      fit: {
        roleDirection: { score: 92, confidence: 'low', rationale: '岗位标题看起来匹配，但职责证据不足。' },
      },
      opportunityValue: {
        roleGrowth: { score: 88, confidence: 'low', rationale: '成长性判断仍主要依赖有限公开信息。' },
      },
    })
    const scored = scoreOpportunityAssessment(assessment, cloneDecisionRules(DEFAULT_DECISION_RULES))
    expect(scored.fit.score).toBe(92)
    expect(scored.fit.confidence).toBe('low')
    expect(scored.opportunityValue.score).toBe(88)
    expect(scored.opportunityValue.confidence).toBe('low')
  })

  it('rejects malformed component assessment data', () => {
    const invalid = createOpportunityAssessment({
      fit: { skills: { score: 80, confidence: 'high', rationale: '' } },
      opportunityValue: { companyQuality: { score: 80, confidence: 'medium', rationale: '平台信息可验证。' } },
    })
    expect(validateOpportunityAssessment(invalid).join(' ')).toContain('缺少有效依据')
  })
})
