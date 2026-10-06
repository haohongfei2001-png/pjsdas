export const SCORING_RETIRED_MESSAGE = 'Scoring, fit/value assessments and score policies have been retired. Submit source facts and actual deadlines without scores.'
export class ScoringRetiredError extends Error {
  readonly code = 'SCORING_RETIRED'
  readonly retryable = false
  constructor() { super(SCORING_RETIRED_MESSAGE); this.name = 'ScoringRetiredError' }
}
const retiredFields = new Set(['fitScore', 'opportunityValue', 'fitConfidence', 'opportunityValueConfidence', 'assessment',
  'leverage', 'delayCost', 'decisionRulesPatch', 'weights', 'fitComponentWeights', 'opportunityValueComponentWeights', 'portfolioWeights',
  'portfolioMinimumCandidateScore', 'minimumFitScore', 'minimumOpportunityValue'])
/** Only apply to a new bounded write request, never a snapshot or historical receipt. */
export function assertNoScoringInput(value: unknown): void {
  if (!value || typeof value !== 'object') return
  if (!Array.isArray(value) && ['patch_decision_rules', 'reset_decision_rules', 'replace_decision_rules'].includes(String((value as Record<string, unknown>).kind))) throw new ScoringRetiredError()
  if (Array.isArray(value)) { for (const item of value) assertNoScoringInput(item); return }
  for (const [key, item] of Object.entries(value)) {
    if (retiredFields.has(key) && item !== undefined) throw new ScoringRetiredError()
    assertNoScoringInput(item)
  }
}

export function assertNoNewOpportunityRating(opportunity: { fitScore?: number; opportunityValue?: number; detail?: { assessment?: unknown } }) {
  if (opportunity.fitScore || opportunity.opportunityValue || opportunity.detail?.assessment) throw new ScoringRetiredError()
}

export function preserveRetiredProfileFields<T extends { minimumFitScore?: number; minimumOpportunityValue?: number }>(incoming: T, previous?: T): T {
  for (const key of ['minimumFitScore', 'minimumOpportunityValue'] as const) {
    if (incoming[key] !== undefined && incoming[key] !== previous?.[key]) throw new ScoringRetiredError()
  }
  return { ...incoming, ...(previous?.minimumFitScore === undefined ? {} : { minimumFitScore: previous.minimumFitScore }),
    ...(previous?.minimumOpportunityValue === undefined ? {} : { minimumOpportunityValue: previous.minimumOpportunityValue }) }
}

const retiredReadFields = new Set([...retiredFields, 'assessmentStatus'])
type RetiredReadField = 'fitScore' | 'opportunityValue' | 'fitConfidence' | 'opportunityValueConfidence' | 'assessment'
  | 'assessmentStatus' | 'leverage' | 'delayCost' | 'decisionRulesPatch' | 'weights' | 'fitComponentWeights'
  | 'opportunityValueComponentWeights' | 'portfolioWeights' | 'portfolioMinimumCandidateScore' | 'minimumFitScore' | 'minimumOpportunityValue'
export type ScoringFreeRead<T> = T extends readonly (infer Item)[] ? ScoringFreeRead<Item>[]
  : T extends object ? { [Key in keyof T as Key extends RetiredReadField ? never : Key]: ScoringFreeRead<T[Key]> } : T
/** Only the returned read projection changes. Raw rows still own fingerprints and Undo evidence. */
export function withoutRetiredScoring<T>(value: T): ScoringFreeRead<T> {
  if (!value || typeof value !== 'object') return value as ScoringFreeRead<T>
  if (Array.isArray(value)) return value.map(withoutRetiredScoring) as ScoringFreeRead<T>
  return Object.fromEntries(Object.entries(value).filter(([key]) => !retiredReadFields.has(key))
    .map(([key, item]) => [key, withoutRetiredScoring(item)])) as ScoringFreeRead<T>
}
