import type {
  Action,
  Opportunity,
  PriorityBreakdown,
  PriorityLevel,
  ProcessRecord,
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

function hoursUntil(dueAt: string | undefined, now: Date) {
  if (!dueAt) return undefined
  return (new Date(dueAt).getTime() - now.getTime()) / HOUR
}

function localDayStart(iso: string) {
  const date = new Date(iso)
  date.setHours(0, 0, 0, 0)
  return date
}

function followUpHoursUntil(dueAt: string | undefined, now: Date) {
  if (!dueAt) return undefined
  return (localDayStart(dueAt).getTime() - now.getTime()) / HOUR
}

function isProcessEventAction(action: Action) {
  return Boolean(action.processEventId)
}

export function processNeedsReview(process: ProcessRecord, now = new Date()) {
  if (!process.nextCheckAt) return false
  return localDayStart(process.nextCheckAt).getTime() <= now.getTime()
}

export function processReviewLabel(process: ProcessRecord, now = new Date()) {
  return processNeedsReview(process, now) ? '需复核' : '正常等待'
}

function urgencyScore(action: Action, now: Date) {
  const hours = action.kind === 'follow_up'
    ? followUpHoursUntil(action.dueAt, now)
    : hoursUntil(action.dueAt, now)
  const processTask = isProcessEventAction(action)

  if (hours === undefined) {
    if (processTask) return 65
    if (action.kind === 'prep') return 30
    if (action.kind === 'group_decision') return 38
    return 18
  }

  if (hours <= 0) {
    if (processTask) return 96
    if (action.kind === 'apply' || action.kind === 'group_decision') return 0
    if (action.kind === 'follow_up') return 72
    return 70
  }

  if (action.kind === 'follow_up') {
    if (hours <= 24) return 72
    if (hours <= 72) return 60
    if (hours <= 168) return 48
    return 34
  }

  if (hours <= 6) return 100
  if (hours <= 12) return 96
  if (hours <= 24) return 92
  if (hours <= 48) return 82
  if (hours <= 72) return 72
  if (hours <= 168) return 55
  if (hours <= 336) return 40
  return processTask ? 46 : 24
}

function stageScore(stage: ProcessStage | undefined, kind: Action['kind'], processTask: boolean) {
  if (processTask) {
    const processScores: Partial<Record<ProcessStage, number>> = {
      assessment: 90,
      written_test: 94,
      interview: 100,
    }
    return stage ? (processScores[stage] ?? 88) : 88
  }
  if (kind === 'follow_up') return 68
  if (kind === 'prep') return 52
  if (kind === 'group_decision') return 78
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
  const hours = action.kind === 'follow_up'
    ? followUpHoursUntil(action.dueAt, now)
    : hoursUntil(action.dueAt, now)
  const followUpDue = action.kind === 'follow_up' && hours !== undefined && hours <= 0
  const processTask = isProcessEventAction(action)

  const dynamicLeverage = followUpDue ? Math.max(action.leverage, 72) : action.leverage
  const dynamicDelayCost = followUpDue ? Math.max(action.delayCost, 74) : action.delayCost

  const breakdown: PriorityBreakdown = {
    opportunity: clamp(
      opportunity?.opportunityValue ??
        (action.kind === 'prep' ? 68 : action.kind === 'group_decision' ? 82 : processTask ? 88 : 55),
    ),
    fit: clamp(opportunity?.fitScore ?? (action.kind === 'group_decision' ? 62 : 55)),
    urgency: urgencyScore(action, now),
    stage: stageScore(action.processStage ?? opportunity?.processStage, action.kind, processTask),
    leverage: clamp(dynamicLeverage),
    delayCost: clamp(dynamicDelayCost),
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
  const hardDeadlineAction =
    action.kind === 'apply' || action.kind === 'group_decision' || processTask

  if (processTask && hours !== undefined && hours < 0) {
    reasons.push('流程节点已过，立即确认')
  } else if (hardDeadlineAction && hours !== undefined && hours >= 0 && hours <= 24) {
    reasons.push(processTask ? '流程节点今天到期' : '今天硬截止')
  } else if (hardDeadlineAction && hours !== undefined && hours <= 48) {
    reasons.push(processTask ? '流程节点48小时内' : '明天硬截止')
  } else if (breakdown.urgency >= 90) {
    reasons.push('节点非常近')
  } else if (breakdown.urgency >= 70) {
    reasons.push('近期节点')
  }

  if (processTask) reasons.push('真实流程通知')
  if (action.kind === 'group_decision') reasons.push('共享志愿/名额约束')
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
    .filter((action) => {
      if ((action.kind === 'apply' || action.kind === 'group_decision') && action.dueAt) {
        return new Date(action.dueAt).getTime() >= now.getTime()
      }
      if (action.kind === 'follow_up' && action.dueAt) {
        return localDayStart(action.dueAt).getTime() <= now.getTime()
      }
      return true
    })
    .map((action) =>
      rankAction(
        action,
        action.opportunityId ? opportunityMap.get(action.opportunityId) : undefined,
        now,
      ),
    )
    .sort((a, b) => b.score - a.score || a.action.estimatedMinutes - b.action.estimatedMinutes)
}

function rankedIsHardDeadlineAction(item: RankedAction) {
  return item.action.kind === 'apply' ||
    item.action.kind === 'group_decision' ||
    Boolean(item.action.processEventId)
}

export function selectTodayActions(ranked: RankedAction[], now = new Date(), limit = 10) {
  const selected: RankedAction[] = []
  const selectedIds = new Set<string>()

  const hardDeadlines = ranked
    .filter((item) => {
      if (!rankedIsHardDeadlineAction(item)) return false
      const hours = hoursUntil(item.action.dueAt, now)
      return hours !== undefined && hours >= 0 && hours <= 48
    })
    .sort((a, b) => {
      const aDue = new Date(a.action.dueAt!).getTime()
      const bDue = new Date(b.action.dueAt!).getTime()
      return aDue - bDue || b.score - a.score
    })

  for (const item of hardDeadlines) {
    if (selected.length >= limit) break
    selected.push(item)
    selectedIds.add(item.action.id)
  }

  let followUps = 0
  let prepItems = 0

  for (const item of ranked) {
    if (selected.length >= limit) break
    if (selectedIds.has(item.action.id)) continue

    if (item.action.kind === 'follow_up') {
      if (followUps >= 2) continue
      followUps += 1
    }

    if (item.action.kind === 'prep') {
      if (prepItems >= 2) continue
      prepItems += 1
    }

    selected.push(item)
    selectedIds.add(item.action.id)
  }

  return selected
}

export type TimePlanOverrunReason = 'today_deadlines' | 'near_deadline_stretch'

export interface TimePlan {
  budgetMinutes: number
  planned: RankedAction[]
  totalMinutes: number
  requiredTodayMinutes: number
  overBudgetMinutes: number
  overrunReason?: TimePlanOverrunReason
  remainingMinutes: number
  nearDeadlineUnplanned: RankedAction[]
}

function isHardDeadlineAction(item: RankedAction) {
  return rankedIsHardDeadlineAction(item)
}

export function buildTimePlan(
  ranked: RankedAction[],
  budgetMinutes: number,
  now = new Date(),
): TimePlan {
  const budget = Math.max(30, Math.round(budgetMinutes))
  const endOfToday = new Date(now)
  endOfToday.setHours(23, 59, 59, 999)

  const hardWithin48h = ranked
    .filter((item) => {
      if (!isHardDeadlineAction(item) || !item.action.dueAt) return false
      const hours = hoursUntil(item.action.dueAt, now)
      return hours !== undefined && hours >= 0 && hours <= 48
    })
    .sort((a, b) =>
      new Date(a.action.dueAt!).getTime() - new Date(b.action.dueAt!).getTime() ||
      b.score - a.score,
    )

  const requiredToday = hardWithin48h.filter(
    (item) => new Date(item.action.dueAt!).getTime() <= endOfToday.getTime(),
  )

  const planned = [...requiredToday]
  const selectedIds = new Set(planned.map((item) => item.action.id))
  const requiredTodayMinutes = requiredToday.reduce(
    (total, item) => total + item.action.estimatedMinutes,
    0,
  )
  let totalMinutes = requiredTodayMinutes
  let blockOptionalPacking = false

  if (totalMinutes <= budget) {
    const nextHardDeadlines = hardWithin48h.filter((item) => !selectedIds.has(item.action.id))

    for (const item of nextHardDeadlines) {
      const nextTotal = totalMinutes + item.action.estimatedMinutes
      if (nextTotal <= budget) {
        planned.push(item)
        selectedIds.add(item.action.id)
        totalMinutes = nextTotal
        continue
      }

      const extraNeeded = nextTotal - budget
      if (extraNeeded <= 30) {
        planned.push(item)
        selectedIds.add(item.action.id)
        totalMinutes = nextTotal
      } else {
        blockOptionalPacking = true
      }
      break
    }
  }

  if (totalMinutes <= budget && !blockOptionalPacking) {
    const candidates = selectTodayActions(ranked, now, 24)
    let followUps = 0
    let prepItems = 0

    for (const item of candidates) {
      if (selectedIds.has(item.action.id)) continue
      if (totalMinutes + item.action.estimatedMinutes > budget) continue

      if (item.action.kind === 'follow_up') {
        if (followUps >= 2) continue
        followUps += 1
      }

      if (item.action.kind === 'prep') {
        if (prepItems >= 2) continue
        prepItems += 1
      }

      planned.push(item)
      selectedIds.add(item.action.id)
      totalMinutes += item.action.estimatedMinutes
    }
  }

  const nearDeadlineUnplanned = hardWithin48h.filter(
    (item) => !selectedIds.has(item.action.id),
  )
  const overBudgetMinutes = Math.max(0, totalMinutes - budget)
  const overrunReason: TimePlanOverrunReason | undefined =
    requiredTodayMinutes > budget
      ? 'today_deadlines'
      : overBudgetMinutes > 0
        ? 'near_deadline_stretch'
        : undefined

  return {
    budgetMinutes: budget,
    planned,
    totalMinutes,
    requiredTodayMinutes,
    overBudgetMinutes,
    overrunReason,
    remainingMinutes: Math.max(0, budget - totalMinutes),
    nearDeadlineUnplanned,
  }
}
