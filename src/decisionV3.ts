export * from './decisionCoreV3'

import { rankActions as rankActionsCore } from './decisionCoreV3'
import { isUnresolvedPastProcessEvent } from './fixedEventGuardLogic'
import type { Action, Opportunity } from './model'
import { DEFAULT_DECISION_RULES, type DecisionRules } from './decisionRules'

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
    leverage: Math.min(action.leverage, 72),
    delayCost: Math.min(action.delayCost, 70),
    sourceLabel: '计划执行日',
  }
}

export function rankActions(actions: Action[], opportunities: Opportunity[], now = new Date(), rules: DecisionRules = DEFAULT_DECISION_RULES) {
  const actionable = actions.filter((action) => !isUnresolvedPastProcessEvent(action, now))
  const scheduledIds = new Set(
    actionable.filter(isNaturalLanguageScheduledAssessment).map((action) => action.id),
  )
  const normalized = actionable.map(normalizeScheduledAssessment)

  return rankActionsCore(normalized, opportunities, now, rules).map((item) => {
    if (!scheduledIds.has(item.action.id)) return item
    const reasons = ['计划执行日', ...item.reasons.filter((reason) => reason !== '真实流程通知')]
    return { ...item, reasons: [...new Set(reasons)].slice(0, 3) }
  })
}
