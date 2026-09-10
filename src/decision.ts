import type {
  Action,
  Opportunity,
  PriorityBreakdown,
  PriorityLevel,
  ProcessStage,
  RankedAction,
} from './model'

const clamp = (value: number, min = 0, max = 100) => Math.min(max, Math.max(min, value))
const HOUR = 3_600_000
const DAY = 86_400_000

export function computePriority(opportunity: Opportunity, now = new Date()): PriorityLevel {
  if (opportunity.currentStageLabel !== '待投') return 'none'

  if (opportunity.deadline) {
    const deadline = new Date(opportunity.deadline)
    if (deadline.getTime() < now.getTime()) return 'expired'
    const days = (deadline.getTime() - now.getTime()) / DAY
    if (days <= 3) return 'P0'
    if (days <= 14) return 'P1'
  }

  return opportunity.early ? 'P1' : 'P2'
}

function urgencyScore(action: Action, now: Date) {
  if (!action.dueAt) return action.kind === 'prep' ? 30 : 18
  const hours = (new Date(action.dueAt).getTime() - now.getTime()) / HOUR

  if (hours <= 0) return action.kind === 'apply' ? 0 : 100
  if (hours <= 6) return 100
  if (hours <= 12) return 96
  if (hours <= 24) return 92
  if (hours <= 48) return 82
  if (hours <= 72) return 72
  if (hours <= 168) return 55
  if (hours <= 336) return 40
  return 24
}

function stageScore(stage: ProcessStage | undefined, kind: Action['kind']) {
  if (kind === 'follow_up') return 68
  if (kind === 'prep') return 52
  if (!stage) return 55
  const scores: Record<ProcessStage, number> = {
    not_applied: 62,
    screening: 68,
    assessment: 82,
    written_test: 84,
    interview: 95,
    offer: 72,
    waiting_release: 34,
    closed: 0,
  }
  return scores[stage]
}

function timeEfficiency(minutes: number) {
  const safeMinutes = Math.max(10, minutes)
  return clamp(115 - Math.sqrt(safeMinutes / 20) * 28)
}

export function rankAction(
  action: Action,
  opportunity?: Opportunity,
  now = new Date(),
): RankedAction {
  const breakdown: PriorityBreakdown = {
    opportunity: clamp(opportunity?.opportunityValue ?? (action.kind === 'prep' ? 68 : 55)),
    fit: clamp(opportunity?.fitScore ?? 55),
    urgency: urgencyScore(action, now),
    stage: stageScore(opportunity?.processStage, action.kind),
    leverage: clamp(action.leverage),
    delayCost: clamp(action.delayCost),
    timeEfficiency: timeEfficiency(action.estimatedMinutes),
  }

  const score =
    breakdown.opportunity * 0.19 +
    breakdown.fit * 0.12 +
    breakdown.urgency * 0.23 +
    breakdown.stage * 0.12 +
    breakdown.leverage * 0.15 +
    breakdown.delayCost * 0.12 +
    breakdown.timeEfficiency * 0.07

  const reasons: string[] = []
  if (breakdown.urgency >= 90) reasons.push('节点非常近')
  else if (breakdown.urgency >= 70) reasons.push('近期节点')
  if (opportunity?.roleType === 'core') reasons.push('核心机会')
  if (opportunity?.early) reasons.push('早投有收益')
  if (breakdown.fit >= 72) reasons.push('现实成功率较高')
  if (action.kind === 'follow_up') reasons.push('流程已到复核节点')
  if (action.kind === 'prep') reasons.push('可复用于多个岗位')
  if (action.estimatedMinutes <= 30) reasons.push('完成成本低')

  return {
    action,
    score: Math.round(clamp(score)),
    breakdown,
    reasons: reasons.slice(0, 3),
  }
}

export function rankActions(actions: Action[], opportunities: Opportunity[], now = new Date()) {
  const opportunityMap = new Map(opportunities.map((item) => [item.id, item]))

  return actions
    .filter((action) => action.status === 'todo' || action.status === 'doing')
    .filter((action) => !(action.kind === 'apply' && action.dueAt && new Date(action.dueAt) < now))
    .map((action) =>
      rankAction(
        action,
        action.opportunityId ? opportunityMap.get(action.opportunityId) : undefined,
        now,
      ),
    )
    .sort((a, b) => b.score - a.score || a.action.estimatedMinutes - b.action.estimatedMinutes)
}
