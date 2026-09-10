import type { Action, Opportunity, PriorityBreakdown, RankedAction } from './model'

const clamp = (value: number, min = 0, max = 100) => Math.min(max, Math.max(min, value))

function urgencyScore(dueAt: string | undefined, now: Date) {
  if (!dueAt) return 15
  const hours = (new Date(dueAt).getTime() - now.getTime()) / 3_600_000
  if (hours <= 0) return 100
  if (hours <= 12) return 95
  if (hours <= 24) return 90
  if (hours <= 48) return 75
  if (hours <= 72) return 60
  if (hours <= 168) return 40
  return 20
}

export function rankAction(
  action: Action,
  opportunity?: Opportunity,
  now = new Date(),
): RankedAction {
  const breakdown: PriorityBreakdown = {
    opportunity: clamp(opportunity?.opportunityValue ?? 50),
    fit: clamp(opportunity?.fitScore ?? 50),
    urgency: urgencyScore(action.dueAt ?? opportunity?.deadline, now),
    leverage: clamp(action.leverage),
    delayCost: clamp(action.delayCost),
    timeEfficiency: clamp(100 - Math.max(0, action.estimatedMinutes - 15) * 0.55),
  }

  const score =
    breakdown.opportunity * 0.24 +
    breakdown.fit * 0.14 +
    breakdown.urgency * 0.24 +
    breakdown.leverage * 0.16 +
    breakdown.delayCost * 0.14 +
    breakdown.timeEfficiency * 0.08

  return {
    action,
    score: Math.round(clamp(score)),
    breakdown,
  }
}

export function rankActions(actions: Action[], opportunities: Opportunity[], now = new Date()) {
  const opportunityMap = new Map(opportunities.map((item) => [item.id, item]))

  return actions
    .filter((action) => action.status === 'todo' || action.status === 'doing')
    .map((action) => rankAction(action, action.opportunityId ? opportunityMap.get(action.opportunityId) : undefined, now))
    .sort((a, b) => b.score - a.score)
}
