import { actionDeadline, actionNodesById, compareDeadlines, deadlineHasPassed, type DeadlineOrderValue, type ActionTimingOwner } from './deadlineOrder.js'
import type { Action, Opportunity, ProcessEvent, ScheduleNode } from './model.js'

export function isUnresolvedPastProcessEvent(action: Action, now: Date, node?: ScheduleNode, timezone = 'UTC') {
  if (!action.processEventId || (action.timingMode !== 'fixed' && node?.temporal.shape !== 'fixed_range')) return false
  if (action.status !== 'todo' && action.status !== 'doing') return false
  return deadlineHasPassed(actionDeadline(action, node), now, timezone)
}

// Compatibility predicate retained for the original fixed-event regression.
export function isUnresolvedPastFixed(action: Action, now: Date) {
  return action.timingMode === 'fixed' && isUnresolvedPastProcessEvent(action, now)
}

/** A read-only confirmation item, never a completion or abandonment decision. */
export interface ProcessRecoveryItem {
  actionId: string
  opportunityId?: string
  title: string
  deadline: DeadlineOrderValue
  deepLink: string
  reason: 'past_process_event'
}

/** An ended job or withdrawn process source cannot create Today work, including
 * legacy actions whose job is linked only through their ProcessEvent. */
export function inactiveProcessActionIds(input: { actions: Action[]; opportunities?: Opportunity[]; processEvents?: ProcessEvent[] }) {
  const opportunities = new Map(input.opportunities?.map(item => [item.id, item]))
  const events = new Map(input.processEvents?.map(item => [item.id, item]))
  return new Set(input.actions.filter(action => {
    if (!action.processEventId) return false
    const event = events.get(action.processEventId)
    const opportunityId = action.opportunityId ?? event?.opportunityId
    const opportunity = opportunityId ? opportunities.get(opportunityId) : undefined
    return !['todo', 'doing'].includes(action.status) || Boolean(event?.invalidation)
      || opportunity?.participationStatus === 'abandoned' || opportunity?.processStage === 'closed'
  }).map(action => action.id))
}

/** Shared Today classification; ordinary/application deadlines retain their policy. */
export function processRecoveryItems(input: {
  actions: Action[]
  nodes: ScheduleNode[]
  opportunities?: Opportunity[]
  processEvents?: ProcessEvent[]
  now: Date
  timezone: string
}): ProcessRecoveryItem[] {
  const inactiveIds = inactiveProcessActionIds(input)
  const owners = actionNodesById(input.nodes, input.actions, input.opportunities, input.processEvents)
  const events = new Map(input.processEvents?.map(item => [item.id, item]))
  return input.actions.flatMap(action => {
    if (inactiveIds.has(action.id) || !action.processEventId
      || action.kind === 'apply' || action.kind === 'group_decision' || action.kind === 'follow_up') return []
    const event = events.get(action.processEventId)
    const opportunityId = action.opportunityId ?? event?.opportunityId
    const owner = owners.get(action.id)
    // A terminal canonical occurrence is resolved history, even if raw action
    // dates/statuses were retained. Unknown timing is not evidence of expiry.
    if (owner && ['completed', 'cancelled', 'superseded'].includes(owner.state)) return []
    const deadline = actionDeadline(action, owner)
    if (!deadlineHasPassed(deadline, input.now, input.timezone)) return []
    return [{ actionId: action.id, opportunityId, title: action.title, deadline,
      deepLink: opportunityId ? `/opportunities/${encodeURIComponent(opportunityId)}` : '/schedule',
      reason: 'past_process_event' as const }]
  }).sort((a, b) => compareDeadlines(a.deadline, b.deadline, input.timezone))
}

/** A chosen Today task may outlive its recruiting occurrence. Its resolved
 * occurrence time is history, not a revived deadline or capacity obligation. */
export function todayProcessTimingOwner(action: Action, owner?: ActionTimingOwner): ActionTimingOwner | undefined {
  if (!action.processEventId || !owner || owner.constraintKind === 'user_plan'
    || !['assessment', 'written_test', 'interview'].includes(owner.kind)
    || !['completed', 'cancelled', 'superseded'].includes(owner.state)) return owner
  return { ...owner, timingUnknown: true, completionDeadline: { id: action.id } }
}
