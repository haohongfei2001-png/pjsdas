import {
  type DecisionRules,
} from './decisionRules.js'
import type {
  DiscoveryInboxItem,
  FitAssessmentComponentKey,
  Opportunity,
  OpportunityAssessment,
  OpportunityAssessmentComponent,
  OpportunityValueAssessmentComponentKey,
} from './model.js'

export const FIT_ASSESSMENT_COMPONENT_KEYS: FitAssessmentComponentKey[] = [
  'roleDirection',
  'skills',
  'education',
  'experience',
  'industry',
  'language',
  'location',
]

export const OPPORTUNITY_VALUE_ASSESSMENT_COMPONENT_KEYS: OpportunityValueAssessmentComponentKey[] = [
  'companyQuality',
  'roleGrowth',
  'compensation',
  'careerOptionality',
  'brandValue',
  'industryGrowth',
  'locationValue',
]

export interface OpportunityAssessmentInput {
  fit: Partial<Record<FitAssessmentComponentKey, OpportunityAssessmentComponent>>
  opportunityValue: Partial<Record<OpportunityValueAssessmentComponentKey, OpportunityAssessmentComponent>>
}

function cleanComponent(component: OpportunityAssessmentComponent): OpportunityAssessmentComponent {
  return {
    score: Math.round(Math.max(0, Math.min(100, component.score)) * 10) / 10,
    confidence: component.confidence,
    rationale: component.rationale.trim().replace(/\s+/g, ' ').slice(0, 500),
  }
}

export function createOpportunityAssessment(input: OpportunityAssessmentInput, assessedAt = new Date().toISOString()): OpportunityAssessment {
  const fit: OpportunityAssessment['fit'] = {}
  const opportunityValue: OpportunityAssessment['opportunityValue'] = {}
  for (const key of FIT_ASSESSMENT_COMPONENT_KEYS) {
    const component = input.fit[key]
    if (component) fit[key] = cleanComponent(component)
  }
  for (const key of OPPORTUNITY_VALUE_ASSESSMENT_COMPONENT_KEYS) {
    const component = input.opportunityValue[key]
    if (component) opportunityValue[key] = cleanComponent(component)
  }
  return { version: 1, mode: 'component', fit, opportunityValue, assessedAt }
}

function validateComponents<K extends string>(
  label: string,
  keys: K[],
  components: Partial<Record<K, OpportunityAssessmentComponent>>,
  errors: string[],
) {
  let count = 0
  for (const key of keys) {
    const component = components[key]
    if (!component) continue
    count += 1
    if (!Number.isFinite(component.score) || component.score < 0 || component.score > 100) errors.push(`${label}组件 ${key} 分数必须位于 0–100。`)
    if (!['high', 'medium', 'low'].includes(component.confidence)) errors.push(`${label}组件 ${key} 置信度无效。`)
    if (!component.rationale?.trim() || component.rationale.length > 500) errors.push(`${label}组件 ${key} 缺少有效依据。`)
  }
  if (count === 0) errors.push(`${label}至少需要一个组件。`)
}

export function validateOpportunityAssessment(assessment: OpportunityAssessment): string[] {
  const errors: string[] = []
  if (assessment.version !== 1 || assessment.mode !== 'component') errors.push('Opportunity Assessment 版本或模式无效。')
  if (Number.isNaN(new Date(assessment.assessedAt).getTime())) errors.push('Opportunity Assessment assessedAt 无效。')
  validateComponents('匹配度', FIT_ASSESSMENT_COMPONENT_KEYS, assessment.fit, errors)
  validateComponents('机会价值', OPPORTUNITY_VALUE_ASSESSMENT_COMPONENT_KEYS, assessment.opportunityValue, errors)
  const allowedFit = new Set(FIT_ASSESSMENT_COMPONENT_KEYS)
  const allowedOpportunity = new Set(OPPORTUNITY_VALUE_ASSESSMENT_COMPONENT_KEYS)
  for (const key of Object.keys(assessment.fit)) if (!allowedFit.has(key as FitAssessmentComponentKey)) errors.push(`未知匹配度组件 ${key}。`)
  for (const key of Object.keys(assessment.opportunityValue)) if (!allowedOpportunity.has(key as OpportunityValueAssessmentComponentKey)) errors.push(`未知机会价值组件 ${key}。`)
  return errors
}

export function mergeOpportunityAssessments(previous: OpportunityAssessment | undefined, incoming: OpportunityAssessment | undefined) {
  if (!previous) return incoming
  if (!incoming) return previous
  return createOpportunityAssessment({
    fit: { ...previous.fit, ...incoming.fit },
    opportunityValue: { ...previous.opportunityValue, ...incoming.opportunityValue },
  }, incoming.assessedAt >= previous.assessedAt ? incoming.assessedAt : previous.assessedAt)
}

// Compatibility projections are identity functions: never recalculate historical ratings.
export function projectOpportunityAssessment(opportunity: Opportunity, _rules?: DecisionRules): Opportunity { return opportunity }
export function projectDiscoveryInboxAssessment(item: DiscoveryInboxItem, _rules?: DecisionRules): DiscoveryInboxItem { return item }
