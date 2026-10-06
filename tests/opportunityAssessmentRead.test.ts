import { describe, expect, it } from 'vitest'
import { getOpportunityAssessment } from '../src/ai/assessmentRead.js'
import { createOpportunityAssessment } from '../src/opportunityAssessment.js'
import { createSnapshot } from '../src/snapshot.js'
import { cloneDecisionRules, DEFAULT_DECISION_RULES } from '../src/decisionRules.js'
import type { Opportunity } from '../src/model.js'

function opportunity(withAssessment = true): Opportunity {
  return {
    id: withAssessment ? 'component-job' : 'legacy-job',
    company: '示例公司',
    role: 'AI 产品经理',
    currentStageLabel: '待投',
    processStage: 'not_applied',
    roleType: 'core',
    early: false,
    opportunityValue: 80,
    fitScore: 80,
    importedAt: '2026-09-12T00:00:00.000Z',
    detail: withAssessment ? {
      assessment: createOpportunityAssessment({
        fit: {
          roleDirection: { score: 95, confidence: 'high', rationale: '方向高度匹配。' },
          skills: { score: 65, confidence: 'medium', rationale: '部分技能匹配。' },
        },
        opportunityValue: {
          companyQuality: { score: 90, confidence: 'high', rationale: '公司平台较强。' },
          compensation: { score: 70, confidence: 'medium', rationale: '薪资有吸引力但信息有限。' },
        },
      }, '2026-09-12T00:00:00.000Z'),
    } : undefined,
  }
}

function snapshot(opportunities: Opportunity[], currentRules = cloneDecisionRules(DEFAULT_DECISION_RULES)) {
  return createSnapshot({
    opportunities,
    processes: [],
    processEvents: [],
    actions: [],
    prep: [],
    applicationGroups: [],
    decisionRules: currentRules,
  }, '2026-09-12T01:00:00.000Z')
}

describe('retired assessment read', () => {
  it('returns an explicit retirement instead of projecting legacy scores', () => {
    expect(() => getOpportunityAssessment({} as any, { opportunityId: 'old' })).toThrow(/retired/)
  })
})
