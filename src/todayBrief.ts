import { buildTimePlan, rankActions } from './decisionV3.js'
import { decisionRulesForSnapshot } from './decisionRules.js'
import { expectedSourcesFromRegistry, summarizeCoverage } from './ingestion.js'
import type {
  Action,
  DecisionRequest,
  Opportunity,
  RankedAction,
  ScheduleNode,
  ScheduleNodeTemporal,
} from './model.js'
import { effectiveScheduleNodeState } from './scheduleNodes.js'
import { upgradeSnapshotToLatest, type PJSDASSnapshot } from './snapshot.js'

const HOUR = 3_600_000
const DAY = 86_400_000

export interface TodayBriefContext {
  now?: Date
  timezone?: string
  workspaceVersion?: string
  defaultAvailableMinutes?: number
}

export interface TodayBriefInput {
  availableMinutes?: number
  agendaHorizonDays?: number
}

export type TodayExecutionState = 'executable_now' | 'context_only' | 'blocked_missing_target'
export type TodayOperationKind =
  | 'open_application'
  | 'open_process'
  | 'start_prep'
  | 'open_group_decision'
  | 'open_action'

export interface TodayBriefActionTiming {
  nodeId?: string
  occurrenceId?: string
  shape?: ScheduleNodeTemporal['shape']
  precision?: ScheduleNodeTemporal['precision']
  timezone?: string
  date?: string
  startAt?: string
  endAt?: string
  deadlineAt?: string
  latestStartAt?: string
  latestStartDate?: string
}

export interface TodayBriefAction {
  actionId: string
  opportunityId?: string
  title: string
  company?: string
  role?: string
  kind: Action['kind']
  score: number
  estimatedMinutes: number
  whyNow: string[]
  timing?: TodayBriefActionTiming
  protectedByLatestStart: boolean
  execution: {
    state: TodayExecutionState
    operation: TodayOperationKind
    deepLink: string
    externalUrl?: string
    realActionAvailable: boolean
  }
}

export interface TodayBriefAgendaNode {
  nodeId: string
  occurrenceId: string
  version: number
  opportunityId?: string
  company?: string
  role?: string
  kind: ScheduleNode['kind']
  state: ReturnType<typeof effectiveScheduleNodeState>
  temporal: ScheduleNodeTemporal
  constraintKind: ScheduleNode['constraintKind']
  relatedActionIds: string[]
  within48Hours: boolean
  requiresResolution: boolean
}

export interface TodayBriefAgendaGroup {
  key: string
  relation: 'unresolved' | 'today' | 'tomorrow' | 'later'
  date?: string
  nodes: TodayBriefAgendaNode[]
}

export interface TodayBriefDecisionRequest {
  id: string
  reason: DecisionRequest['reason']
  question: string
  choices: DecisionRequest['choices']
  recommendedChoiceId?: string
  recommendationBasis?: string
  evidenceRefs: string[]
  affectedObjects: DecisionRequest['affectedObjects']
  expiresAt?: string
}

export interface TodayBriefRecentChange {
  id: string
  status: 'committed' | 'decision_required' | 'undone'
  summary: string
  updatedAt: string
  affectedObjectCount: number
  decisionRequestCount: number
  undoAvailable: boolean
}

export interface TodayBriefCoverageWarning {
  code:
    | 'coverage_missing_sources'
    | 'coverage_stale_sources'
    | 'coverage_unresolved_inputs'
    | 'capacity_conflict'
    | 'hard_deadline_unplanned'
    | 'execution_target_missing'
  severity: 'warning' | 'critical'
  title: string
  detail: string
  relatedIds: string[]
}

export interface TodayBrief {
  contractVersion: 1
  workspaceRevision: string
  evaluatedAt: string
  displayTimezone: string
  rules: {
    version: number
    updatedAt: string
  }
  availableMinutes: number
  plannedMinutes: number
  nextAction?: TodayBriefAction
  nextActions: TodayBriefAction[]
  agendaGroups: TodayBriefAgendaGroup[]
  relevantDecisionRequests: TodayBriefDecisionRequest[]
  recentChanges: TodayBriefRecentChange[]
  materialCoverageWarnings: TodayBriefCoverageWarning[]
  internalDiagnostics: {
    rankedActionCount: number
    protectedActionIds: string[]
    nearDeadlineUnplannedActionIds: string[]
    agendaNodeCount: number
    openDecisionRequestCount: number
    coverage: {
      allCaughtUp: boolean
      expectedSourceCount: number
      missingSourceCount: number
      staleSourceCount: number
      unresolvedCount: number
    }
  }
}

export function resolvedContext(context: TodayBriefContext) {
  const now = context.now ?? new Date()
  if (Number.isNaN(now.getTime())) throw new Error('TodayBrief clock is invalid.')
  const timezone = context.timezone?.trim()
    || Intl.DateTimeFormat().resolvedOptions().timeZone
    || 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(now)
  } catch {
    throw new Error(`TodayBrief timezone is invalid: ${timezone}`)
  }
  return {
    now,
    timezone,
    workspaceVersion: context.workspaceVersion,
    defaultAvailableMinutes: context.defaultAvailableMinutes ?? 180,
  }
}

export function localDateKey(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function addCalendarDays(dateKey: string, days: number) {
  const base = new Date(`${dateKey}T12:00:00.000Z`)
  base.setUTCDate(base.getUTCDate() + days)
  return base.toISOString().slice(0, 10)
}

function timestampDateKey(value: string, timezone: string) {
  return localDateKey(new Date(value), timezone)
}

function temporalDateKey(temporal: ScheduleNodeTemporal, displayTimezone: string) {
  if ((temporal.shape === 'date_only' || temporal.shape === 'estimated_date') && temporal.date) return temporal.date
  const instant = temporal.startAt ?? temporal.deadlineAt ?? temporal.endAt
  return instant ? timestampDateKey(instant, displayTimezone) : undefined
}

function temporalBoundaryMs(temporal: ScheduleNodeTemporal) {
  if (temporal.shape === 'deadline') {
    return temporal.deadlineAt ? new Date(temporal.deadlineAt).getTime() : undefined
  }
  if (temporal.shape === 'fixed_range') {
    return temporal.startAt ? new Date(temporal.startAt).getTime() : undefined
  }
  if (temporal.shape === 'availability_window') {
    return temporal.endAt ? new Date(temporal.endAt).getTime() : temporal.startAt ? new Date(temporal.startAt).getTime() : undefined
  }
  return undefined
}

export function latestByOccurrence(nodes: ScheduleNode[]) {
  const latest = new Map<string, ScheduleNode>()
  for (const node of nodes) {
    const current = latest.get(node.occurrenceId)
    if (!current || node.version > current.version) latest.set(node.occurrenceId, node)
  }
  return [...latest.values()]
}

function opportunityMap(opportunities: Opportunity[]) {
  return new Map(opportunities.map((item) => [item.id, item]))
}

export function nodeForAction(action: Action, nodes: ScheduleNode[]) {
  return nodes
    .filter((node) => node.relatedActionIds.includes(action.id))
    .sort((a, b) => {
      const aTerminal = ['cancelled', 'superseded'].includes(a.state) ? 1 : 0
      const bTerminal = ['cancelled', 'superseded'].includes(b.state) ? 1 : 0
      return aTerminal - bTerminal || b.version - a.version
    })[0]
}

function latestStartFor(action: Action, node: ScheduleNode | undefined): Pick<TodayBriefActionTiming, 'latestStartAt' | 'latestStartDate'> {
  if (!node) {
    if (!action.dueAt) return {}
    if (action.duePrecision === 'date') return { latestStartDate: action.dueAt.slice(0, 10) }
    const dueMs = new Date(action.dueAt).getTime()
    if (!Number.isFinite(dueMs)) return {}
    return { latestStartAt: new Date(dueMs - action.estimatedMinutes * 60_000).toISOString() }
  }

  const temporal = node.temporal
  if (temporal.precision === 'date') {
    return temporal.date ? { latestStartDate: temporal.date } : {}
  }

  const boundary = temporal.shape === 'deadline'
    ? temporal.deadlineAt
    : temporal.shape === 'availability_window'
      ? temporal.endAt
      : undefined
  if (!boundary) return {}
  return {
    latestStartAt: new Date(new Date(boundary).getTime() - action.estimatedMinutes * 60_000).toISOString(),
  }
}

function timingForAction(action: Action, node: ScheduleNode | undefined): TodayBriefActionTiming | undefined {
  if (!node && !action.dueAt) return undefined
  const latest = latestStartFor(action, node)
  if (!node) {
    return {
      precision: action.duePrecision,
      shape: action.timingMode === 'fixed' ? 'fixed_range' : 'deadline',
      ...(action.duePrecision === 'date'
        ? { date: action.dueAt?.slice(0, 10) }
        : action.timingMode === 'fixed'
          ? { startAt: action.dueAt }
          : { deadlineAt: action.dueAt }),
      ...latest,
    }
  }
  return {
    nodeId: node.id,
    occurrenceId: node.occurrenceId,
    shape: node.temporal.shape,
    precision: node.temporal.precision,
    timezone: node.temporal.timezone,
    date: node.temporal.date,
    startAt: node.temporal.startAt,
    endAt: node.temporal.endAt,
    deadlineAt: node.temporal.deadlineAt,
    ...latest,
  }
}

function applicationUrl(opportunity: Opportunity | undefined) {
  return opportunity?.detail?.userFacts?.applicationUrl
    ?? opportunity?.detail?.facts?.application.applicationUrl
}

function executionFor(action: Action, opportunity: Opportunity | undefined): TodayBriefAction['execution'] {
  const opportunityDeepLink = opportunity ? `/opportunities/${encodeURIComponent(opportunity.id)}` : '/today'
  if (action.kind === 'apply') {
    const externalUrl = applicationUrl(opportunity)
    return {
      state: externalUrl ? 'executable_now' : 'context_only',
      operation: 'open_application',
      deepLink: opportunityDeepLink,
      externalUrl,
      realActionAvailable: Boolean(externalUrl),
    }
  }
  if (action.processEventId) {
    return {
      state: action.timingMode === 'fixed' ? 'context_only' : 'executable_now',
      operation: 'open_process',
      deepLink: opportunityDeepLink,
      realActionAvailable: action.timingMode !== 'fixed',
    }
  }
  if (action.kind === 'prep') {
    return {
      state: 'executable_now',
      operation: 'start_prep',
      deepLink: opportunityDeepLink,
      realActionAvailable: true,
    }
  }
  if (action.kind === 'group_decision') {
    return {
      state: 'executable_now',
      operation: 'open_group_decision',
      deepLink: '/opportunities',
      realActionAvailable: true,
    }
  }
  return {
    state: 'executable_now',
    operation: 'open_action',
    deepLink: opportunityDeepLink,
    realActionAvailable: true,
  }
}

function isHardConstraint(action: Action, node: ScheduleNode | undefined) {
  if (node) return node.constraintKind === 'employer_hard'
  return action.kind === 'apply' || action.kind === 'group_decision' || Boolean(action.processEventId)
}

export function protectedByLatestStart(
  action: Action,
  node: ScheduleNode | undefined,
  now: Date,
  displayTimezone: string,
  horizonHours: number,
) {
  if (!isHardConstraint(action, node)) return false
  const latest = latestStartFor(action, node)
  if (latest.latestStartAt) {
    const delta = new Date(latest.latestStartAt).getTime() - now.getTime()
    return delta <= horizonHours * HOUR
  }
  if (latest.latestStartDate) {
    const today = localDateKey(now, displayTimezone)
    const horizonDate = addCalendarDays(today, Math.max(1, Math.ceil(horizonHours / 24)))
    return latest.latestStartDate <= horizonDate
  }
  return false
}

export function dueSortValue(action: Action, node: ScheduleNode | undefined) {
  const latest = latestStartFor(action, node)
  if (latest.latestStartAt) return new Date(latest.latestStartAt).getTime()
  if (latest.latestStartDate) return new Date(`${latest.latestStartDate}T12:00:00.000Z`).getTime()
  const temporal = node?.temporal
  if (temporal) {
    const boundary = temporalBoundaryMs(temporal)
    if (boundary !== undefined) return boundary
  }
  return action.dueAt ? new Date(action.dueAt).getTime() : Number.POSITIVE_INFINITY
}

export function actionView(
  ranked: RankedAction,
  nodes: ScheduleNode[],
  opportunities: Map<string, Opportunity>,
  now: Date,
  timezone: string,
  hardDeadlineHorizonHours: number,
): TodayBriefAction {
  const node = nodeForAction(ranked.action, nodes)
  const opportunity = ranked.action.opportunityId ? opportunities.get(ranked.action.opportunityId) : undefined
  return {
    actionId: ranked.action.id,
    opportunityId: ranked.action.opportunityId,
    title: ranked.action.title,
    company: opportunity?.company,
    role: opportunity?.role,
    kind: ranked.action.kind,
    score: ranked.score,
    estimatedMinutes: ranked.action.estimatedMinutes,
    whyNow: [...ranked.reasons],
    timing: timingForAction(ranked.action, node),
    protectedByLatestStart: protectedByLatestStart(
      ranked.action,
      node,
      now,
      timezone,
      hardDeadlineHorizonHours,
    ),
    execution: executionFor(ranked.action, opportunity),
  }
}

function relationForDate(date: string, today: string) {
  if (date === today) return 'today' as const
  if (date === addCalendarDays(today, 1)) return 'tomorrow' as const
  return 'later' as const
}

function agendaNode(
  node: ScheduleNode,
  opportunities: Map<string, Opportunity>,
  now: Date,
  timezone: string,
): TodayBriefAgendaNode {
  const opportunity = node.opportunityId ? opportunities.get(node.opportunityId) : undefined
  const boundary = temporalBoundaryMs(node.temporal)
  const today = localDateKey(now, timezone)
  const nodeDate = temporalDateKey(node.temporal, timezone)
  const dateOnlyWithin48Hours = boundary === undefined
    && Boolean(nodeDate && nodeDate >= today && nodeDate <= addCalendarDays(today, 2))
  return {
    nodeId: node.id,
    occurrenceId: node.occurrenceId,
    version: node.version,
    opportunityId: node.opportunityId,
    company: opportunity?.company,
    role: opportunity?.role,
    kind: node.kind,
    state: effectiveScheduleNodeState(node, now),
    temporal: structuredClone(node.temporal),
    constraintKind: node.constraintKind,
    relatedActionIds: [...node.relatedActionIds],
    within48Hours: (boundary !== undefined && boundary >= now.getTime() && boundary - now.getTime() <= 48 * HOUR)
      || dateOnlyWithin48Hours,
    requiresResolution: effectiveScheduleNodeState(node, now) === 'elapsed_unresolved',
  }
}

function buildAgendaGroups(
  nodes: ScheduleNode[],
  opportunities: Map<string, Opportunity>,
  now: Date,
  timezone: string,
  horizonDays: number,
): TodayBriefAgendaGroup[] {
  const today = localDateKey(now, timezone)
  const horizonDate = addCalendarDays(today, horizonDays - 1)
  const latest = latestByOccurrence(nodes)
    .filter((node) => node.state !== 'cancelled' && node.state !== 'superseded' && node.state !== 'completed')
    .map((node) => agendaNode(node, opportunities, now, timezone))

  const unresolved = latest
    .filter((node) => node.state === 'elapsed_unresolved')
    .sort((a, b) => (temporalBoundaryMs(b.temporal) ?? 0) - (temporalBoundaryMs(a.temporal) ?? 0))
    .slice(0, 6)

  const future = latest
    .filter((node) => node.state !== 'elapsed_unresolved')
    .filter((node) => {
      const date = temporalDateKey(node.temporal, timezone)
      return Boolean(date && date >= today && date <= horizonDate)
    })
    .sort((a, b) => {
      const aDate = temporalDateKey(a.temporal, timezone) ?? '9999-12-31'
      const bDate = temporalDateKey(b.temporal, timezone) ?? '9999-12-31'
      const aTime = temporalBoundaryMs(a.temporal) ?? Number.POSITIVE_INFINITY
      const bTime = temporalBoundaryMs(b.temporal) ?? Number.POSITIVE_INFINITY
      return aDate.localeCompare(bDate) || aTime - bTime || a.nodeId.localeCompare(b.nodeId)
    })

  const groups: TodayBriefAgendaGroup[] = []
  if (unresolved.length) groups.push({ key: 'unresolved', relation: 'unresolved', nodes: unresolved })

  const byDate = new Map<string, TodayBriefAgendaNode[]>()
  for (const node of future) {
    const date = temporalDateKey(node.temporal, timezone)!
    const bucket = byDate.get(date) ?? []
    bucket.push(node)
    byDate.set(date, bucket)
  }
  for (const [date, dateNodes] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    groups.push({
      key: date,
      relation: relationForDate(date, today),
      date,
      nodes: dateNodes,
    })
  }
  return groups
}

function activeDecisionRequests(snapshot: PJSDASSnapshot, now: Date): DecisionRequest[] {
  return (snapshot.data.decisionRequests ?? [])
    .filter((item) => item.state === 'open')
    .filter((item) => !item.expiresAt || new Date(item.expiresAt).getTime() >= now.getTime())
}

function relevantDecisions(
  snapshot: PJSDASSnapshot,
  opportunityIds: Set<string>,
  agendaNodeIds: Set<string>,
  now: Date,
): TodayBriefDecisionRequest[] {
  const open = activeDecisionRequests(snapshot, now)
  return [...open]
    .sort((a, b) => {
      const aRelevant = a.affectedObjects.some((item) =>
        (item.type === 'schedule_node' && agendaNodeIds.has(item.id))
        || (item.type === 'opportunity' && opportunityIds.has(item.id)),
      )
      const bRelevant = b.affectedObjects.some((item) =>
        (item.type === 'schedule_node' && agendaNodeIds.has(item.id))
        || (item.type === 'opportunity' && opportunityIds.has(item.id)),
      )
      const aExpiry = a.expiresAt ? new Date(a.expiresAt).getTime() : Number.POSITIVE_INFINITY
      const bExpiry = b.expiresAt ? new Date(b.expiresAt).getTime() : Number.POSITIVE_INFINITY
      return Number(bRelevant) - Number(aRelevant) || aExpiry - bExpiry || a.createdAt.localeCompare(b.createdAt)
    })
    .slice(0, 4)
    .map((item) => ({
      id: item.id,
      reason: item.reason,
      question: item.question,
      choices: structuredClone(item.choices),
      recommendedChoiceId: item.recommendedChoiceId,
      recommendationBasis: item.recommendationBasis,
      evidenceRefs: [...item.evidenceRefs],
      affectedObjects: structuredClone(item.affectedObjects),
      expiresAt: item.expiresAt,
    }))
}

function recentSemanticChanges(snapshot: PJSDASSnapshot): TodayBriefRecentChange[] {
  return (snapshot.data.semanticReceipts ?? [])
    .filter((item) => item.status === 'committed' || item.status === 'decision_required' || item.status === 'undone')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
    .slice(0, 3)
    .map((item) => ({
      id: item.id,
      status: item.status as TodayBriefRecentChange['status'],
      summary: item.summary,
      updatedAt: item.updatedAt,
      affectedObjectCount: item.affectedObjects.length,
      decisionRequestCount: item.decisionRequestIds.length,
      undoAvailable: item.undoAvailable,
    }))
}

function warning(
  code: TodayBriefCoverageWarning['code'],
  severity: TodayBriefCoverageWarning['severity'],
  title: string,
  detail: string,
  relatedIds: string[] = [],
): TodayBriefCoverageWarning {
  return { code, severity, title, detail, relatedIds }
}

export function buildTodayBrief(
  rawSnapshot: PJSDASSnapshot,
  input: TodayBriefInput = {},
  rawContext: TodayBriefContext = {},
): TodayBrief {
  const context = resolvedContext(rawContext)
  const availableMinutes = input.availableMinutes ?? context.defaultAvailableMinutes
  if (!Number.isFinite(availableMinutes) || availableMinutes < 30 || availableMinutes > 1440) {
    throw new Error('TodayBrief availableMinutes must be between 30 and 1440.')
  }
  const agendaHorizonDays = input.agendaHorizonDays ?? 7
  if (!Number.isInteger(agendaHorizonDays) || agendaHorizonDays < 1 || agendaHorizonDays > 30) {
    throw new Error('TodayBrief agendaHorizonDays must be an integer between 1 and 30.')
  }

  const snapshot = upgradeSnapshotToLatest(rawSnapshot)
  const rules = decisionRulesForSnapshot(snapshot.data.decisionRules)
  const opportunities = opportunityMap(snapshot.data.opportunities)
  const activeNodes = latestByOccurrence(snapshot.data.scheduleNodes ?? [])
  const ranked = rankActions(snapshot.data.actions, snapshot.data.opportunities, context.now, rules)
  const plan = buildTimePlan(ranked, availableMinutes, context.now, rules)

  const rankedById = new Map(ranked.map((item) => [item.action.id, item]))
  const protectedRanked = ranked
    .filter((item) => {
      if (item.action.timingMode === 'fixed') return false
      return protectedByLatestStart(
        item.action,
        nodeForAction(item.action, activeNodes),
        context.now,
        context.timezone,
        rules.hardDeadlineHorizonHours,
      )
    })
    .sort((a, b) => {
      const aNode = nodeForAction(a.action, activeNodes)
      const bNode = nodeForAction(b.action, activeNodes)
      return dueSortValue(a.action, aNode) - dueSortValue(b.action, bNode)
        || b.score - a.score
        || a.action.id.localeCompare(b.action.id)
    })

  const planIds = new Set(plan.planned.map((item) => item.action.id))
  const protectedOutsidePlan = protectedRanked.filter((item) => !planIds.has(item.action.id))
  const protectedOutsidePlanMinutes = protectedOutsidePlan.reduce(
    (sum, item) => sum + item.action.estimatedMinutes,
    0,
  )
  const effectivePlannedMinutes = plan.totalMinutes + protectedOutsidePlanMinutes
  const effectiveOverBudgetMinutes = Math.max(0, effectivePlannedMinutes - Math.round(availableMinutes))

  const ordered: RankedAction[] = []
  const seen = new Set<string>()
  for (const item of [...protectedRanked, ...plan.planned]) {
    if (seen.has(item.action.id)) continue
    seen.add(item.action.id)
    ordered.push(rankedById.get(item.action.id) ?? item)
  }
  const visibleActions = ordered.slice(0, 4).map((item) =>
    actionView(item, activeNodes, opportunities, context.now, context.timezone, rules.hardDeadlineHorizonHours),
  )

  const agendaGroups = buildAgendaGroups(
    snapshot.data.scheduleNodes ?? [],
    opportunities,
    context.now,
    context.timezone,
    agendaHorizonDays,
  )
  const agendaNodes = agendaGroups.flatMap((group) => group.nodes)
  const opportunityIds = new Set(
    visibleActions.flatMap((item) => item.opportunityId ? [item.opportunityId] : []),
  )
  const agendaNodeIds = new Set(agendaNodes.map((item) => item.nodeId))
  const decisions = relevantDecisions(snapshot, opportunityIds, agendaNodeIds, context.now)

  const coverage = summarizeCoverage(snapshot.data.timeline, {
    now: context.now,
    expectedSources: expectedSourcesFromRegistry(snapshot.data.timeline),
  })
  const warnings: TodayBriefCoverageWarning[] = []
  if (coverage.missingSourceCount > 0) {
    warnings.push(warning(
      'coverage_missing_sources',
      'warning',
      'Some automated sources have no completed coverage record.',
      `${coverage.missingSourceCount} enabled source(s) have not reported a completed run.`,
      coverage.missingSources.map((item) => `${item.sourceKind}:${item.sourceId}`),
    ))
  }
  if (coverage.staleSourceCount > 0) {
    warnings.push(warning(
      'coverage_stale_sources',
      'warning',
      'Some automated sources are stale.',
      `${coverage.staleSourceCount} enabled source(s) are beyond their freshness SLA.`,
      coverage.sources.filter((item) => item.stale).map((item) => `${item.sourceKind}:${item.sourceId}`),
    ))
  }
  if (coverage.unresolvedCount > 0) {
    warnings.push(warning(
      'coverage_unresolved_inputs',
      'warning',
      'Some source inputs still need resolution.',
      `${coverage.unresolvedCount} source record(s) remain unresolved.`,
      coverage.exceptions.map((item) => item.id).slice(0, 12),
    ))
  }
  if (effectiveOverBudgetMinutes > 0) {
    warnings.push(warning(
      'capacity_conflict',
      'critical',
      'Today contains more protected work than the available-time budget.',
      `Protected work exceeds the budget by ${effectiveOverBudgetMinutes} minute(s).`,
      protectedRanked.map((item) => item.action.id),
    ))
  }
  const protectedUnplanned = [
    ...plan.nearDeadlineUnplanned,
    ...protectedOutsidePlan,
  ].filter((item, index, items) =>
    items.findIndex((candidate) => candidate.action.id === item.action.id) === index,
  )
  if (protectedUnplanned.length > 0) {
    warnings.push(warning(
      'hard_deadline_unplanned',
      'critical',
      'A protected hard deadline is not covered by the current plan.',
      `${protectedUnplanned.length} protected deadline action(s) do not fit the current plan.`,
      protectedUnplanned.map((item) => item.action.id),
    ))
  }
  const missingTargets = visibleActions.filter((item) =>
    item.execution.state === 'context_only' && item.kind === 'apply',
  )
  if (missingTargets.length) {
    warnings.push(warning(
      'execution_target_missing',
      'warning',
      'An application action lacks a verified direct application target.',
      'PJSDAS can open the opportunity context but must not pretend that opening a page equals applying.',
      missingTargets.map((item) => item.actionId),
    ))
  }

  return {
    contractVersion: 1,
    workspaceRevision: context.workspaceVersion ?? `snapshot:${rawSnapshot.exportedAt}`,
    evaluatedAt: context.now.toISOString(),
    displayTimezone: context.timezone,
    rules: {
      version: rules.version,
      updatedAt: rules.updatedAt,
    },
    availableMinutes: Math.round(availableMinutes),
    plannedMinutes: effectivePlannedMinutes,
    nextAction: visibleActions[0],
    nextActions: visibleActions.slice(1),
    agendaGroups,
    relevantDecisionRequests: decisions,
    recentChanges: recentSemanticChanges(snapshot),
    materialCoverageWarnings: warnings,
    internalDiagnostics: {
      rankedActionCount: ranked.length,
      protectedActionIds: protectedRanked.map((item) => item.action.id),
      nearDeadlineUnplannedActionIds: protectedUnplanned.map((item) => item.action.id),
      agendaNodeCount: agendaNodes.length,
      openDecisionRequestCount: activeDecisionRequests(snapshot, context.now).length,
      coverage: {
        allCaughtUp: coverage.allCaughtUp,
        expectedSourceCount: coverage.expectedSourceCount,
        missingSourceCount: coverage.missingSourceCount,
        staleSourceCount: coverage.staleSourceCount,
        unresolvedCount: coverage.unresolvedCount,
      },
    },
  }
}
