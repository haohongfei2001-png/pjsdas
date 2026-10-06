import { actionDeadline, deadlineHasPassed } from './deadlineOrder.js'
import type { Action, ScheduleNode } from './model.js'

export function isUnresolvedPastProcessEvent(action: Action, now: Date, node?: ScheduleNode, timezone = 'UTC') {
  if (!action.processEventId) return false
  if (action.status !== 'todo' && action.status !== 'doing') return false
  return deadlineHasPassed(actionDeadline(action, node), now, timezone)
}

// Compatibility predicate retained for the original fixed-event regression.
export function isUnresolvedPastFixed(action: Action, now: Date) {
  return action.timingMode === 'fixed' && isUnresolvedPastProcessEvent(action, now)
}
