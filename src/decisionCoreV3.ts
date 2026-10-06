import type { Action, Opportunity, PriorityLevel, ProcessRecord, RankedAction, ScheduleNode } from './model.js'
import type { DecisionRules } from './decisionRules.js'
import { actionDeadline, compareActionDeadlines, actionNodesById, deadlineHasPassed } from './deadlineOrder.js'

/** Deprecated read adapter for old snapshot consumers; no ranking policy is attached. */
export function computePriority(opportunity: Opportunity, now = new Date()): PriorityLevel {
  if (opportunity.processStage !== 'not_applied') return 'none'
  return opportunity.deadline && Date.parse(opportunity.deadline) < now.getTime() ? 'expired' : 'none'
}
function localDayStart(iso: string) { const date = new Date(iso); date.setHours(0, 0, 0, 0); return date }
export function processNeedsReview(process: ProcessRecord, now = new Date()) {
  return Boolean(process.nextCheckAt && localDayStart(process.nextCheckAt).getTime() <= now.getTime())
}
export function processReviewLabel(process: ProcessRecord, now = new Date()) { return processNeedsReview(process, now) ? '需复核' : '正常等待' }

/** Compatibility function name only: active output contains no scores or weights. */
export function rankAction(action: Action, _opportunity?: Opportunity, _now = new Date(), _rules?: DecisionRules): RankedAction {
  return { action,
    reasons: [action.dueAt ? (action.timingMode === 'fixed' ? '按固定事件时间排列' : '按截止日期排列') : '截止日期未明确，排在已知截止之后'] }
}
export function rankActions(actions: Action[], opportunities: Opportunity[], now = new Date(), _rules?: DecisionRules, timezone = 'UTC', nodes: ScheduleNode[] = []) {
  const nodeMap = actionNodesById(nodes, actions)
  return actions.filter(action => action.status === 'todo' || action.status === 'doing')
    .filter(action => {
      const deadline = actionDeadline(action, nodeMap.get(action.id))
      if ((action.kind === 'apply' || action.kind === 'group_decision') && deadline.deadline) {
        return !deadlineHasPassed(deadline, now, timezone)
      }
      return action.kind !== 'follow_up' || !action.dueAt || localDayStart(action.dueAt).getTime() <= now.getTime()
    })
    .sort((a, b) => compareActionDeadlines(a, b, timezone, nodeMap.get(a.id), nodeMap.get(b.id)))
    .map(action => ({ ...rankAction(action, opportunities.find(item => item.id === action.opportunityId), now),
      reasons: [actionDeadline(action, nodeMap.get(action.id)).deadline
        ? (action.timingMode === 'fixed' ? '按固定事件时间排列' : '按截止日期排列') : '截止日期未明确，排在已知截止之后'] }))
}
export function selectTodayActions(ranked: RankedAction[], _now = new Date(), limit = 10, _rules?: DecisionRules) {
  return ranked.filter(item => item.action.timingMode !== 'fixed').sort((a, b) => compareActionDeadlines(a.action, b.action)).slice(0, limit)
}
export type TimePlanOverrunReason = 'today_deadlines' | 'near_deadline_stretch'
export interface TimePlan { budgetMinutes: number; planned: RankedAction[]; totalMinutes: number; requiredTodayMinutes: number; fixedTodayMinutes: number; overBudgetMinutes: number; overrunReason?: TimePlanOverrunReason; remainingMinutes: number; nearDeadlineUnplanned: RankedAction[]; upcomingFixedEvents: RankedAction[] }
/** Compatibility adapter only. New product and external reads use the same consumer planner. */
export function buildTimePlan(ranked: RankedAction[], budgetMinutes: number, now = new Date(), _rules?: DecisionRules): TimePlan {
  const budget = Math.max(0, Math.round(budgetMinutes))
  const upcomingFixedEvents = ranked.filter(item => item.action.timingMode === 'fixed' && item.action.dueAt && Date.parse(item.action.dueAt) >= now.getTime())
    .sort((a, b) => compareActionDeadlines(a.action, b.action))
  const fixedTodayMinutes = upcomingFixedEvents.filter(item => new Date(item.action.dueAt!).toDateString() === now.toDateString()).reduce((sum, item) => sum + item.action.estimatedMinutes, 0)
  let totalMinutes = fixedTodayMinutes
  const planned: RankedAction[] = [], nearDeadlineUnplanned: RankedAction[] = []
  for (const item of selectTodayActions(ranked, now, ranked.length)) {
    if (totalMinutes + item.action.estimatedMinutes <= budget) { planned.push(item); totalMinutes += item.action.estimatedMinutes }
    else if (item.action.dueAt) nearDeadlineUnplanned.push(item)
  }
  return { budgetMinutes: budget, planned, totalMinutes, requiredTodayMinutes: fixedTodayMinutes, fixedTodayMinutes,
    overBudgetMinutes: Math.max(0, totalMinutes - budget), overrunReason: fixedTodayMinutes > budget ? 'today_deadlines' : undefined, remainingMinutes: Math.max(0, budget - totalMinutes), nearDeadlineUnplanned, upcomingFixedEvents }
}
