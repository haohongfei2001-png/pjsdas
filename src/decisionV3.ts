import { actionNodesById } from './deadlineOrder.js'
export * from './decisionCoreV3.js'

import { computePriority as computePriorityCore, rankActions as rankActionsCore } from './decisionCoreV3.js'
import { isUnresolvedPastProcessEvent } from './fixedEventGuardLogic.js'
import type { Action, Opportunity, ScheduleNode } from './model.js'
import { type DecisionRules } from './decisionRules.js'

/**
 * Product-facing priority must follow canonical process state, not a localized
 * presentation label. The legacy core helper still understands the old “待投”
 * label, so normalize only the transient projection passed to it.
 */
export function computePriority(opportunity: Opportunity, now = new Date()) {
  if (opportunity.participationStatus === 'abandoned') return 'none' as const
  if (opportunity.processStage !== 'not_applied') return 'none' as const
  return computePriorityCore({ ...opportunity, currentStageLabel: '待投' }, now)
}

function isNaturalLanguageScheduledAssessment(action: Action) {
  if (!action.processEventId || action.processStage !== 'assessment' || !action.dueAt) return false
  if (!action.processEventId.startsWith('progress-event:nl3:event:')) return false

  const due = new Date(action.dueAt)
  return due.getHours() === 23 && due.getMinutes() === 59
}

function normalizeScheduledAssessment(action: Action): Action {
  if (!isNaturalLanguageScheduledAssessment(action)) return action

  // A future sentence such as “9月11日，在线测评” states when the user plans
  // to do the assessment; it does not establish a recruiter-imposed deadline.
  // Keep the underlying Process Event in the database/Pipeline, but rank its
  // Today action as a soft scheduled task rather than a protected hard deadline.
  return {
    ...action,
    processEventId: undefined,
    sourceLabel: '计划执行日',
  }
}

export function rankActions(
  actions: Action[], opportunities: Opportunity[], now = new Date(),
  rules?: DecisionRules, timezone?: string, nodes: ScheduleNode[] = [],
) {
  // Follow-up/review reminders are passive observation state, not work the user
  // should repeatedly see in Today. Keep them in Pipeline/history, but do not
  // let them compete with applications, real recruiting events, prep, or manual
  // tasks for the user's primary action surface.
  const ended = new Set(
    opportunities.filter((item) => item.participationStatus === 'abandoned' || item.processStage === 'closed').map((item) => item.id),
  )
  const nodeMap = actionNodesById(nodes, actions, opportunities)
  const actionable = actions
    .filter((action) => action.kind !== 'follow_up')
    .filter((action) => !(action.kind === 'apply' && opportunities.find(item => item.id === action.opportunityId)?.processStage === 'unknown'))
    .filter((action) => !action.opportunityId || !ended.has(action.opportunityId))
    .filter(action => !isUnresolvedPastProcessEvent(action, now, nodeMap.get(action.id), timezone))
  const scheduledIds = new Set(
    actionable.filter(isNaturalLanguageScheduledAssessment).map((action) => action.id),
  )
  const normalized = actionable.map(normalizeScheduledAssessment)
  return rankActionsCore(normalized, opportunities, now, rules, timezone, nodes).map(item => scheduledIds.has(item.action.id)
    ? { ...item, reasons: ['计划执行日', ...item.reasons] } : item)
}
