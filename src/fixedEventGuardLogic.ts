import type { Action } from './model'

export function isUnresolvedPastFixed(action: Action, now: Date) {
  if (!action.processEventId || action.timingMode !== 'fixed' || !action.dueAt) return false
  if (action.status !== 'todo' && action.status !== 'doing') return false
  return new Date(action.dueAt).getTime() < now.getTime()
}
