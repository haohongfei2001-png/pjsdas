export interface DecisionWeights {
  opportunity: number
  fit: number
  urgency: number
  stage: number
  leverage: number
  delayCost: number
  timeEfficiency: number
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
  updatedAt: string
}

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
  updatedAt: '1970-01-01T00:00:00.000Z',
}

export function cloneDecisionRules(rules: DecisionRules = DEFAULT_DECISION_RULES): DecisionRules {
  return { ...rules, weights: { ...rules.weights } }
}

export function createDefaultDecisionRules(now = new Date().toISOString()): DecisionRules {
  return { ...DEFAULT_DECISION_RULES, weights: { ...DEFAULT_DECISION_RULES.weights }, updatedAt: now }
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

  if (!(rules.riskCriticalHours <= rules.riskHighHours &&
    rules.riskHighHours <= rules.riskNearHours &&
    rules.riskNearHours <= rules.riskWatchHours)) {
    errors.push('风险阈值必须按 极高风险 ≤ 高风险 ≤ 临近 ≤ 需准备 递增。')
  }

  const weights = Object.values(rules.weights)
  if (weights.some((value) => !Number.isFinite(value) || value < 0 || value > 100)) {
    errors.push('高级排序权重必须位于 0–100。')
  }
  if (weights.reduce((sum, value) => sum + value, 0) <= 0) {
    errors.push('高级排序权重不能全部为 0。')
  }
  return errors
}
