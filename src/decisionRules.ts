export interface DecisionWeights {
  opportunity: number
  fit: number
  urgency: number
  stage: number
  leverage: number
  delayCost: number
  timeEfficiency: number
}

export interface FitComponentWeights {
  roleDirection: number
  skills: number
  education: number
  experience: number
  industry: number
  language: number
  location: number
}

export interface OpportunityValueComponentWeights {
  companyQuality: number
  roleGrowth: number
  compensation: number
  careerOptionality: number
  brandValue: number
  industryGrowth: number
  locationValue: number
}

export interface PortfolioDecisionWeights {
  opportunityValue: number
  fit: number
  rolePriority: number
  deadline: number
  applicationEfficiency: number
  evidenceConfidence: number
  overlapPenalty: number
}

export interface DecisionRules {
  key: 'current'
  version: 1
  hardDeadlineHorizonHours: number
  fixedEventHorizonHours: number
  nearDeadlineStretchMinutes: number
  followUpDailyCap: number
  prepDailyCap: number
  upcomingHorizonDays: number
  upcomingNodeLimit: number
  riskCriticalHours: number
  riskHighHours: number
  riskNearHours: number
  riskWatchHours: number
  weights: DecisionWeights
  fitComponentWeights?: FitComponentWeights
  opportunityValueComponentWeights?: OpportunityValueComponentWeights
  portfolioWeights?: PortfolioDecisionWeights
  portfolioMinimumCandidateScore?: number
  updatedAt: string
}

export const DEFAULT_FIT_COMPONENT_WEIGHTS: FitComponentWeights = {
  roleDirection: 24,
  skills: 18,
  education: 10,
  experience: 14,
  industry: 8,
  language: 8,
  location: 18,
}

export const DEFAULT_OPPORTUNITY_VALUE_COMPONENT_WEIGHTS: OpportunityValueComponentWeights = {
  companyQuality: 18,
  roleGrowth: 18,
  compensation: 14,
  careerOptionality: 16,
  brandValue: 10,
  industryGrowth: 12,
  locationValue: 12,
}

export const DEFAULT_PORTFOLIO_DECISION_WEIGHTS: PortfolioDecisionWeights = {
  opportunityValue: 28,
  fit: 28,
  rolePriority: 14,
  deadline: 8,
  applicationEfficiency: 10,
  evidenceConfidence: 12,
  overlapPenalty: 18,
}

export const DEFAULT_PORTFOLIO_MINIMUM_CANDIDATE_SCORE = 62

export const DEFAULT_DECISION_RULES: DecisionRules = {
  key: 'current',
  version: 1,
  hardDeadlineHorizonHours: 48,
  fixedEventHorizonHours: 48,
  nearDeadlineStretchMinutes: 30,
  followUpDailyCap: 2,
  prepDailyCap: 2,
  upcomingHorizonDays: 7,
  upcomingNodeLimit: 12,
  riskCriticalHours: 6,
  riskHighHours: 24,
  riskNearHours: 48,
  riskWatchHours: 72,
  weights: {
    opportunity: 19,
    fit: 12,
    urgency: 23,
    stage: 12,
    leverage: 15,
    delayCost: 12,
    timeEfficiency: 7,
  },
  fitComponentWeights: { ...DEFAULT_FIT_COMPONENT_WEIGHTS },
  opportunityValueComponentWeights: { ...DEFAULT_OPPORTUNITY_VALUE_COMPONENT_WEIGHTS },
  portfolioWeights: { ...DEFAULT_PORTFOLIO_DECISION_WEIGHTS },
  portfolioMinimumCandidateScore: DEFAULT_PORTFOLIO_MINIMUM_CANDIDATE_SCORE,
  updatedAt: '1970-01-01T00:00:00.000Z',
}

export function resolvedFitComponentWeights(rules?: Pick<DecisionRules, 'fitComponentWeights'>) {
  return { ...DEFAULT_FIT_COMPONENT_WEIGHTS, ...(rules?.fitComponentWeights ?? {}) }
}

export function resolvedOpportunityValueComponentWeights(rules?: Pick<DecisionRules, 'opportunityValueComponentWeights'>) {
  return { ...DEFAULT_OPPORTUNITY_VALUE_COMPONENT_WEIGHTS, ...(rules?.opportunityValueComponentWeights ?? {}) }
}

export function resolvedPortfolioDecisionWeights(rules?: Pick<DecisionRules, 'portfolioWeights'>) {
  return { ...DEFAULT_PORTFOLIO_DECISION_WEIGHTS, ...(rules?.portfolioWeights ?? {}) }
}

export function resolvedPortfolioMinimumCandidateScore(rules?: Pick<DecisionRules, 'portfolioMinimumCandidateScore'>) {
  return rules?.portfolioMinimumCandidateScore ?? DEFAULT_PORTFOLIO_MINIMUM_CANDIDATE_SCORE
}

export function cloneDecisionRules(rules: DecisionRules = DEFAULT_DECISION_RULES): DecisionRules {
  return {
    key: 'current',
    version: 1,
    hardDeadlineHorizonHours: rules.hardDeadlineHorizonHours,
    fixedEventHorizonHours: rules.fixedEventHorizonHours,
    nearDeadlineStretchMinutes: rules.nearDeadlineStretchMinutes,
    followUpDailyCap: rules.followUpDailyCap,
    prepDailyCap: rules.prepDailyCap,
    upcomingHorizonDays: rules.upcomingHorizonDays,
    upcomingNodeLimit: rules.upcomingNodeLimit,
    riskCriticalHours: rules.riskCriticalHours,
    riskHighHours: rules.riskHighHours,
    riskNearHours: rules.riskNearHours,
    riskWatchHours: rules.riskWatchHours,
    weights: { ...rules.weights },
    fitComponentWeights: resolvedFitComponentWeights(rules),
    opportunityValueComponentWeights: resolvedOpportunityValueComponentWeights(rules),
    portfolioWeights: resolvedPortfolioDecisionWeights(rules),
    portfolioMinimumCandidateScore: resolvedPortfolioMinimumCandidateScore(rules),
    updatedAt: rules.updatedAt,
  }
}

export function createDefaultDecisionRules(now = new Date().toISOString()): DecisionRules {
  return { ...cloneDecisionRules(DEFAULT_DECISION_RULES), updatedAt: now }
}

export function decisionRulesForSnapshot(rules?: DecisionRules): DecisionRules {
  return rules ? cloneDecisionRules(rules) : cloneDecisionRules(DEFAULT_DECISION_RULES)
}

function validateWeightMap(label: string, weights: object, errors: string[]) {
  const values = Object.values(weights) as number[]
  if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 100)) {
    errors.push(`${label}必须位于 0–100。`)
  }
  if (values.reduce((sum, value) => sum + value, 0) <= 0) {
    errors.push(`${label}不能全部为 0。`)
  }
}

export function validateDecisionRules(rules: DecisionRules): string[] {
  const errors: string[] = []
  const integerRange = (label: string, value: number, min: number, max: number) => {
    if (!Number.isInteger(value) || value < min || value > max) errors.push(`${label} 必须是 ${min}–${max} 的整数。`)
  }

  integerRange('硬截止保护窗口', rules.hardDeadlineHorizonHours, 1, 336)
  integerRange('固定事件预告窗口', rules.fixedEventHorizonHours, 1, 336)
  integerRange('允许小幅超时', rules.nearDeadlineStretchMinutes, 0, 180)
  integerRange('每日复核上限', rules.followUpDailyCap, 0, 10)
  integerRange('每日准备上限', rules.prepDailyCap, 0, 10)
  integerRange('近期节点天数', rules.upcomingHorizonDays, 1, 30)
  integerRange('近期节点数量', rules.upcomingNodeLimit, 1, 50)
  integerRange('极高风险阈值', rules.riskCriticalHours, 1, 168)
  integerRange('高风险阈值', rules.riskHighHours, 1, 336)
  integerRange('临近阈值', rules.riskNearHours, 1, 504)
  integerRange('需准备阈值', rules.riskWatchHours, 1, 720)
  integerRange('组合决策最低候选分', resolvedPortfolioMinimumCandidateScore(rules), 0, 100)

  if (!(rules.riskCriticalHours <= rules.riskHighHours &&
    rules.riskHighHours <= rules.riskNearHours &&
    rules.riskNearHours <= rules.riskWatchHours)) {
    errors.push('风险阈值必须按 极高风险 ≤ 高风险 ≤ 临近 ≤ 需准备 递增。')
  }

  validateWeightMap('高级排序权重', rules.weights, errors)
  validateWeightMap('匹配度组件权重', resolvedFitComponentWeights(rules), errors)
  validateWeightMap('机会价值组件权重', resolvedOpportunityValueComponentWeights(rules), errors)
  validateWeightMap('申请组合决策权重', resolvedPortfolioDecisionWeights(rules), errors)
  return errors
}
