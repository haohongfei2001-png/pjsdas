import type { Action } from './model'

export function isUnresolvedPastProcessEvent(action: Action, now: Date) {
  if (!action.processEventId || !action.dueAt) return false
  if (action.status !== 'todo' && action.status !== 'doing') return false
  return new Date(action.dueAt).getTime() < now.getTime()
}

// Compatibility predicate retained for the original fixed-event regression.
export function isUnresolvedPastFixed(action: Action, now: Date) {
  return action.timingMode === 'fixed' && isUnresolvedPastProcessEvent(action, now)
}
