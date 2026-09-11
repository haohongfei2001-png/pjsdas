import { decisionRulesForSnapshot } from '../decisionRules.js'
import {
  FIT_ASSESSMENT_COMPONENT_KEYS,
  OPPORTUNITY_VALUE_ASSESSMENT_COMPONENT_KEYS,
  scoreOpportunityAssessment,
} from '../opportunityAssessment.js'
import { validateSnapshot, type PJSDASSnapshot } from '../snapshot.js'
import type {
  FitAssessmentComponentKey,
  OpportunityAssessmentComponent,
  OpportunityValueAssessmentComponentKey,
} from '../model.js'

export interface GetOpportunityAssessmentInput {
  opportunityId: string
}

export interface AssessmentComponentRead {
  key: string
  score: number
  confidence: string
  rationale: string
  weight: number
}

export interface GetOpportunityAssessmentOutput {
  opportunityId: string
  company: string
  role: string
  mode: 'component' | 'legacy'
  stored: {
    fitScore: number
    opportunityValue: number
  }
  currentProjection?: {
    fitScore: number
    fitConfidence: string
    fitCoveragePercent: number
    opportunityValue: number
    opportunityValueConfidence: string
    opportunityValueCoveragePercent: number
  }
  fitComponents: AssessmentComponentRead[]
  opportunityValueComponents: AssessmentComponentRead[]
  assessedAt?: string
  projectionDiffersFromStored: boolean
}

function componentRows<K extends string>(
  keys: K[],
  components: Partial<Record<K, OpportunityAssessmentComponent>>,
  weights: Record<K, number>,
) {
  return keys.flatMap((key) => {
    const component = components[key]
    if (!component) return []
    return [{
      key,
      score: component.score,
      confidence: component.confidence,
      rationale: component.rationale,
      weight: weights[key] ?? 0,
    }]
  })
}

export function getOpportunityAssessment(
  snapshot: PJSDASSnapshot,
  input: GetOpportunityAssessmentInput,
): GetOpportunityAssessmentOutput {
  validateSnapshot(snapshot)
  const opportunity = snapshot.data.opportunities.find((item) => item.id === input.opportunityId)
  if (!opportunity) throw new Error(`Opportunity ${input.opportunityId} was not found.`)
  const assessment = opportunity.detail?.assessment
  if (!assessment) {
    return {
      opportunityId: opportunity.id,
      company: opportunity.company,
      role: opportunity.role,
      mode: 'legacy',
      stored: { fitScore: opportunity.fitScore, opportunityValue: opportunity.opportunityValue },
      fitComponents: [],
      opportunityValueComponents: [],
      projectionDiffersFromStored: false,
    }
  }

  const rules = decisionRulesForSnapshot(snapshot.data.decisionRules)
  const scored = scoreOpportunityAssessment(assessment, rules)
  const fitWeights = rules.fitComponentWeights! as Record<FitAssessmentComponentKey, number>
  const opportunityWeights = rules.opportunityValueComponentWeights! as Record<OpportunityValueAssessmentComponentKey, number>
  const projectionDiffersFromStored = Math.abs(scored.fit.score - opportunity.fitScore) >= 0.1 ||
    Math.abs(scored.opportunityValue.score - opportunity.opportunityValue) >= 0.1

  return {
    opportunityId: opportunity.id,
    company: opportunity.company,
    role: opportunity.role,
    mode: 'component',
    stored: { fitScore: opportunity.fitScore, opportunityValue: opportunity.opportunityValue },
    currentProjection: {
      fitScore: scored.fit.score,
      fitConfidence: scored.fit.confidence,
      fitCoveragePercent: scored.fit.coveragePercent,
      opportunityValue: scored.opportunityValue.score,
      opportunityValueConfidence: scored.opportunityValue.confidence,
      opportunityValueCoveragePercent: scored.opportunityValue.coveragePercent,
    },
    fitComponents: componentRows(FIT_ASSESSMENT_COMPONENT_KEYS, assessment.fit, fitWeights),
    opportunityValueComponents: componentRows(OPPORTUNITY_VALUE_ASSESSMENT_COMPONENT_KEYS, assessment.opportunityValue, opportunityWeights),
    assessedAt: assessment.assessedAt,
    projectionDiffersFromStored,
  }
}
