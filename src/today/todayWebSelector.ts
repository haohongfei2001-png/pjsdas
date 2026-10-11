import { todayProcessTimingOwner, type ProcessRecoveryItem } from '../fixedEventGuardLogic.js'
import { readModelSnapshot } from '../readModelSnapshot.js'
import { decisionNeedsToday, groupOpenDecisions } from '../decisionPresentation.js'
import { partitionDecisions } from '../decisionActionability.js'
import { rankActions } from '../decisionV3.js'
import { actionNodesById, compareActionDeadlines } from '../deadlineOrder.js'
import type { DecisionRequest } from '../model.js'
import { type PJSDASSnapshot } from '../snapshot.js'
import {
  actionView,
  latestByOccurrence,
  protectedByLatestStart,
  resolvedContext,
  type TodayBriefAction,
  type TodayBriefCoverageWarning,
  type TodayBriefContext,
} from '../todayBrief.js'
import { todayCapacity } from './localDayCapacity.js'
import { buildConsumerTimePlan, type ConsumerTimeConflict } from './consumerTimePlan.js'

export interface TodayWebInput {
  availableMinutes?: number
}

export interface TodayWebDecision {
  id: string
  deepLink: string
  request: DecisionRequest
}

export interface TodayWebSelection {
  workspaceRevision: string
  evaluatedAt: string
  displayTimezone: string
  /** Feasible recommendation, shared with MCP startableActions. */
  actions: TodayBriefAction[]
  /** All existing Today candidates remain accessible, regardless of capacity. */
  visibleActions: TodayBriefAction[]
  visibleActionCount: number
  insufficientTimeActionIds: string[]
  recoveryItems: ProcessRecoveryItem[]
  notSelectedHardActions: TodayBriefAction[]
  decisions: TodayWebDecision[]
  actionCount: number
  decisionCount: number
  openDecisionCount: number
  overBudgetMinutes: number
  capacityMinutes?: number
  capacitySource?: 'remaining_day' | 'manual'
  deferredActionCount: number
  businessConflicts: ConsumerTimeConflict[]
  protectedActionIds: string[]
  criticalWarnings: TodayBriefCoverageWarning[]
}

/** Capacity-aware consumer membership. TodayBrief v1 remains a separate external contract. */
export function selectTodayWeb(
  rawSnapshot: PJSDASSnapshot,
  input: TodayWebInput = {},
  rawContext: TodayBriefContext = {},
): TodayWebSelection {
  return selectTodayWebNormalized(readModelSnapshot(rawSnapshot), input, rawContext)
}

/** Shared normalized input for a consumer render; never mutates its entities. */
export function selectTodayWebNormalized(snapshot: PJSDASSnapshot, input: TodayWebInput = {}, rawContext: TodayBriefContext = {}): TodayWebSelection {
  const context = resolvedContext(rawContext)
  const nodes = latestByOccurrence(snapshot.data.scheduleNodes ?? [])
  const opportunities = new Map(snapshot.data.opportunities.map((item) => [item.id, item]))
  const ranked = rankActions(snapshot.data.actions, snapshot.data.opportunities, context.now, undefined, context.timezone, nodes)
  const plan = buildConsumerTimePlan({ ranked, actions: snapshot.data.actions, nodes, opportunities: snapshot.data.opportunities, processEvents: snapshot.data.processEvents, preferences: snapshot.data.timePlanning,
    availableMinutes: input.availableMinutes, useRemainingDayDefault: true, now: context.now, timezone: context.timezone })
  // Resolve the ranked projection once, including known absence of an owner.
  // Sorting and hundreds of visible cards must not rebuild the index per row.
  const owners = actionNodesById(nodes, ranked.map(item => item.action), snapshot.data.opportunities, snapshot.data.processEvents)
  const todayActionIds = new Set([...plan.planned, ...plan.deferredToday].map(item => item.action.id))
  const protectedRanked = ranked.filter(item => todayActionIds.has(item.action.id))
    .filter((item) => item.action.timingMode !== 'fixed')
    .filter((item) => protectedByLatestStart(
      item.action,
      owners.get(item.action.id),
      context.now,
      context.timezone,
      48,
    ))
  if (protectedRanked.length > 1) {
    // Preserve the existing protected list's context-free ordering separately
    // from its source-aware membership; neither projection is recomputed in sort.
    const sortOwners = actionNodesById(nodes, protectedRanked.map(item => item.action))
    protectedRanked.sort((a, b) => compareActionDeadlines(a.action, b.action, context.timezone,
      sortOwners.get(a.action.id), sortOwners.get(b.action.id)))
  }

  const actions = plan.planned.map((item) => actionView(
    item,
    nodes,
    opportunities,
    context.now,
    context.timezone,
    48,
    snapshot.data.processEvents,
    owners,
  ))
  // The planner already sorts the recommendation. Most renders have no excess
  // work, so avoid repeating canonical owner resolution and view projection.
  const actionViews = new Map(actions.map(action => [action.actionId, action]))
  const visibleRanked = plan.deferredToday.length ? [...new Map([...plan.planned, ...plan.deferredToday].map(item => [item.action.id, item])).values()]
    .sort((a, b) => compareActionDeadlines(a.action, b.action, context.timezone,
      todayProcessTimingOwner(a.action, owners.get(a.action.id)),
      todayProcessTimingOwner(b.action, owners.get(b.action.id)))) : []
  const visibleActions = plan.deferredToday.length ? visibleRanked.map(item => actionViews.get(item.action.id)
    ?? actionView(item, nodes, opportunities, context.now, context.timezone, 48, snapshot.data.processEvents, owners)) : actions
  for (const action of visibleActions) actionViews.set(action.actionId, action)
  const openGroups = groupOpenDecisions(partitionDecisions(snapshot.data.decisionRequests ?? [], {
    opportunities: snapshot.data.opportunities, scheduleNodes: nodes,
    reminderIntents: snapshot.data.reminderIntents, now: context.now,
  }).actionable)
  const decisions = openGroups
    .map(group => group.find(request => decisionNeedsToday(request, context.now, context.timezone)))
    .filter((request): request is DecisionRequest => Boolean(request))
    .sort((a, b) => (a.expiresAt ?? '9999').localeCompare(b.expiresAt ?? '9999')
      || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((request) => ({ id: `decision:${request.id}`, deepLink: `/decisions/${encodeURIComponent(request.id)}`, request }))
  const criticalWarnings: TodayBriefCoverageWarning[] = plan.conflicts.map(conflict => ({
    code: 'business_time_conflict', severity: 'critical',
    title: conflict.kind === 'fixed_overlap' ? 'Two fixed commitments overlap.' : 'Select the deadline work that fits the remaining time.',
    detail: conflict.kind === 'fixed_overlap'
      ? `The commitments ${conflict.relatedIds.join(' and ')} overlap in time.`
      : `Expected to fit: ${plan.planned.filter(item => conflict.selectedIds?.includes(item.action.id)).map(item => item.action.title).join(', ') || 'none'}. Not selected for today: ${plan.deferredHard.map(item => item.action.title).join(', ')}.`,
    relatedIds: conflict.relatedIds,
  }))

  return {
    workspaceRevision: context.workspaceVersion ?? `snapshot:${snapshot.exportedAt}`,
    evaluatedAt: context.now.toISOString(),
    displayTimezone: context.timezone,
    actions,
    visibleActions,
    visibleActionCount: visibleActions.length,
    insufficientTimeActionIds: plan.deferredToday.map(item => item.action.id),
    recoveryItems: plan.recoveryItems,
    notSelectedHardActions: plan.deferredHard.map(item => actionViews.get(item.action.id)!),
    decisions,
    actionCount: actions.length,
    decisionCount: decisions.length,
    openDecisionCount: openGroups.length,
    overBudgetMinutes: plan.overBudgetMinutes,
    capacityMinutes: plan.capacityMinutes,
    capacitySource: todayCapacity(snapshot.data.timePlanning, context.now, context.timezone, input.availableMinutes).source,
    deferredActionCount: plan.deferredCount,
    businessConflicts: plan.conflicts,
    protectedActionIds: protectedRanked.map((item) => item.action.id),
    criticalWarnings,
  }
}
