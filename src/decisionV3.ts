export * from './decisionCoreV3.js'

import { rankActions as rankActionsCore } from './decisionCoreV3.js'
import { isUnresolvedPastProcessEvent } from './fixedEventGuardLogic.js'
import { buildPrepGraph, enrichPrepActionsWithGraph, prepGraphReasonFromAction } from './prepGraph.js'
import type { Action, Opportunity, Prep } from './model.js'
import { DEFAULT_DECISION_RULES, type DecisionRules } from './decisionRules.js'

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

function prepItemsFromActions(actions: Action[], now: Date): Prep[] {
  return actions.flatMap((action) => {
    if (action.kind !== 'prep') return []
    const title = action.title.replace(/^准备[｜|]\s*/, '').trim() || action.title
    return [{
      id: action.prepId ?? `derived:${action.id}`,
      title,
      minimumOutput: title,
      estimatedMinutes: action.estimatedMinutes,
      sourceStatus: 'active',
      createdAt: action.createdAt ?? now.toISOString(),
      updatedAt: action.updatedAt ?? now.toISOString(),
    }]
  })
}

function projectPrepGraphIntoActions(actions: Action[], opportunities: Opportunity[], now: Date) {
  const prep = prepItemsFromActions(actions, now)
  if (!prep.length) return actions
  // Today has Action + Opportunity data but not the full Prep records. This
  // projection therefore uses only exact structured requirement/gap matches
  // available from the action title. The full Prep Graph read/UI additionally
  // uses Prep.triggeredBy and Process.prepPack explicit links.
  return enrichPrepActionsWithGraph(actions, buildPrepGraph(prep, opportunities, [], now))
}

export function rankActions(actions: Action[], opportunities: Opportunity[], now = new Date(), rules: DecisionRules = DEFAULT_DECISION_RULES) {
  const actionable = actions.filter((action) => !isUnresolvedPastProcessEvent(action, now))
  const scheduledIds = new Set(
    actionable.filter(isNaturalLanguageScheduledAssessment).map((action) => action.id),
  )
  const normalized = projectPrepGraphIntoActions(actionable.map(normalizeScheduledAssessment), opportunities, now)

  return rankActionsCore(normalized, opportunities, now, rules).map((item) => {
    const graphReason = prepGraphReasonFromAction(item.action)
    const baseReasons = item.action.kind === 'prep'
      ? item.reasons.filter((reason) => reason !== '可复用于多个岗位')
      : item.reasons
    if (scheduledIds.has(item.action.id)) {
      const reasons = ['计划执行日', ...baseReasons.filter((reason) => reason !== '真实流程通知')]
      return { ...item, reasons: [...new Set(reasons)].slice(0, 3) }
    }
    if (graphReason) return { ...item, reasons: [...new Set([graphReason, ...baseReasons])].slice(0, 3) }
    if (item.action.kind === 'prep') return { ...item, reasons: [...new Set(['准备任务', ...baseReasons])].slice(0, 3) }
    return item
  })
}
