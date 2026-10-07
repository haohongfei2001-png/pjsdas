import { readModelSnapshot } from '../readModelSnapshot.js'
import { decisionNeedsToday, groupOpenDecisions } from '../decisionPresentation.js'
import { partitionDecisions } from '../decisionActionability.js'
import { rankActions } from '../decisionV3.js'
import { compareActionDeadlines, latestActionNode } from '../deadlineOrder.js'
import type { DecisionRequest } from '../model.js'
import { type PJSDASSnapshot } from '../snapshot.js'
import {
  localDateKey,
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
  actions: TodayBriefAction[]
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
  const plan = buildConsumerTimePlan({ ranked, nodes, opportunities: snapshot.data.opportunities, processEvents: snapshot.data.processEvents, preferences: snapshot.data.timePlanning,
    availableMinutes: input.availableMinutes, useRemainingDayDefault: true, now: context.now, timezone: context.timezone })
  const todayActionIds = new Set([...plan.planned, ...plan.deferredHard].map(item => item.action.id))
  const today = localDateKey(context.now, context.timezone)
  const protectedRanked = ranked.filter(item => item.action.plannedDate === today || todayActionIds.has(item.action.id))
    .filter((item) => item.action.timingMode !== 'fixed')
    .filter((item) => protectedByLatestStart(
      item.action,
      latestActionNode(item.action, nodes, snapshot.data.opportunities, snapshot.data.processEvents),
      context.now,
      context.timezone,
      48,
    ))
    .sort((a, b) => compareActionDeadlines(a.action, b.action, context.timezone, latestActionNode(a.action, nodes), latestActionNode(b.action, nodes)))

  const actions = plan.planned.map((item) => actionView(
    item,
    nodes,
    opportunities,
    context.now,
    context.timezone,
    48,
    snapshot.data.processEvents,
  ))
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
    notSelectedHardActions: plan.deferredHard.map(item => actionView(item, nodes, opportunities, context.now,
      context.timezone, 48, snapshot.data.processEvents)),
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
