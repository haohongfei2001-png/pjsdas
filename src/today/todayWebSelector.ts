import { buildTimePlan, rankActions } from '../decisionV3.js'
import { decisionRulesForSnapshot } from '../decisionRules.js'
import type { DecisionRequest, RankedAction, ScheduleNode } from '../model.js'
import { upgradeSnapshotToLatest, type PJSDASSnapshot } from '../snapshot.js'
import {
  actionView,
  dueSortValue,
  latestByOccurrence,
  localDateKey,
  nodeForAction,
  protectedByLatestStart,
  resolvedContext,
  type TodayBriefAction,
  type TodayBriefCoverageWarning,
  type TodayBriefContext,
} from '../todayBrief.js'

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
  decisions: TodayWebDecision[]
  actionCount: number
  decisionCount: number
  overBudgetMinutes: number
  protectedActionIds: string[]
  criticalWarnings: TodayBriefCoverageWarning[]
}

function dueToday(item: RankedAction, timezone: string, today: string) {
  const { dueAt, duePrecision } = item.action
  if (!dueAt) return false
  if (duePrecision === 'date') return dueAt.slice(0, 10) === today
  const parsed = new Date(dueAt)
  return Number.isFinite(parsed.getTime()) && localDateKey(parsed, timezone) === today
}

function explicitlyScheduledToday(item: RankedAction, nodes: ScheduleNode[], timezone: string, today: string) {
  const node = nodeForAction(item.action, nodes)
  if (!node || node.state === 'cancelled' || node.state === 'superseded' || node.state === 'completed') return false
  if (node.temporal.resolutionBasis !== 'source_explicit' && node.temporal.resolutionBasis !== 'user_explicit') return false
  if (node.temporal.shape === 'fixed_range') return false
  if (node.temporal.date) return node.temporal.date === today
  const start = node.temporal.startAt
  if (!start) return false
  const parsed = new Date(start)
  return Number.isFinite(parsed.getTime()) && localDateKey(parsed, timezone) === today
}

/** Complete Web membership. TodayBrief v1 remains a capped external contract. */
export function selectTodayWeb(
  rawSnapshot: PJSDASSnapshot,
  input: TodayWebInput = {},
  rawContext: TodayBriefContext = {},
): TodayWebSelection {
  const context = resolvedContext(rawContext)
  const availableMinutes = input.availableMinutes ?? context.defaultAvailableMinutes
  if (!Number.isFinite(availableMinutes) || availableMinutes < 30 || availableMinutes > 1440) {
    throw new Error('Today availableMinutes must be between 30 and 1440.')
  }
  const snapshot = upgradeSnapshotToLatest(rawSnapshot)
  const rules = decisionRulesForSnapshot(snapshot.data.decisionRules)
  const nodes = latestByOccurrence(snapshot.data.scheduleNodes ?? [])
  const opportunities = new Map(snapshot.data.opportunities.map((item) => [item.id, item]))
  const ranked = rankActions(snapshot.data.actions, snapshot.data.opportunities, context.now, rules, context.timezone)
  const plan = buildTimePlan(ranked, availableMinutes, context.now, rules)
  const today = localDateKey(context.now, context.timezone)
  const protectedRanked = ranked
    .filter((item) => item.action.timingMode !== 'fixed')
    .filter((item) => protectedByLatestStart(
      item.action,
      nodeForAction(item.action, nodes),
      context.now,
      context.timezone,
      rules.hardDeadlineHorizonHours,
    ))
    .sort((a, b) => dueSortValue(a.action, nodeForAction(a.action, nodes))
      - dueSortValue(b.action, nodeForAction(b.action, nodes))
      || b.score - a.score
      || a.action.id.localeCompare(b.action.id))

  const ordered = new Map<string, RankedAction>()
  const protectedIds = new Set(protectedRanked.map((item) => item.action.id))
  const plannedIds = new Set(plan.planned.map((item) => item.action.id))
  for (const item of [...protectedRanked, ...plan.planned, ...ranked]) {
    if (ordered.has(item.action.id)) continue
    const required = protectedIds.has(item.action.id)
      || plannedIds.has(item.action.id)
      || item.action.status === 'doing'
      || (item.action.timingMode !== 'fixed' && dueToday(item, context.timezone, today))
      || explicitlyScheduledToday(item, nodes, context.timezone, today)
    if (required && item.action.timingMode !== 'fixed') ordered.set(item.action.id, item)
  }
  const actions = [...ordered.values()].map((item) => actionView(
    item,
    nodes,
    opportunities,
    context.now,
    context.timezone,
    rules.hardDeadlineHorizonHours,
  ))
  const decisions = (snapshot.data.decisionRequests ?? [])
    .filter((item) => item.state === 'open' && (!item.expiresAt || new Date(item.expiresAt) >= context.now))
    .sort((a, b) => (a.expiresAt ?? '9999').localeCompare(b.expiresAt ?? '9999')
      || a.createdAt.localeCompare(b.createdAt)
      || a.id.localeCompare(b.id))
    .map((request) => ({ id: `decision:${request.id}`, deepLink: `/decisions/${encodeURIComponent(request.id)}`, request }))
  const protectedOutsidePlan = protectedRanked.filter((item) => !plannedIds.has(item.action.id))
  const protectedOutsideMinutes = protectedOutsidePlan.reduce((sum, item) => sum + item.action.estimatedMinutes, 0)
  const protectedUnplanned = [...plan.nearDeadlineUnplanned, ...protectedOutsidePlan]
    .filter((item, index, items) => items.findIndex((candidate) => candidate.action.id === item.action.id) === index)
  const criticalWarnings: TodayBriefCoverageWarning[] = protectedUnplanned.length ? [{
    code: 'hard_deadline_unplanned', severity: 'critical',
    title: 'A protected hard deadline is not covered by the current plan.',
    detail: `${protectedUnplanned.length} protected deadline action(s) do not fit the current plan.`,
    relatedIds: protectedUnplanned.map((item) => item.action.id),
  }] : []

  return {
    workspaceRevision: context.workspaceVersion ?? `snapshot:${rawSnapshot.exportedAt}`,
    evaluatedAt: context.now.toISOString(),
    displayTimezone: context.timezone,
    actions,
    decisions,
    actionCount: actions.length,
    decisionCount: decisions.length,
    overBudgetMinutes: Math.max(0, plan.totalMinutes + protectedOutsideMinutes - Math.round(availableMinutes)),
    protectedActionIds: protectedRanked.map((item) => item.action.id),
    criticalWarnings,
  }
}
