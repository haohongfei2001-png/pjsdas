import { buildOpportunityDecisionList } from '../opportunityDecisionRead.js'
import { resolveApplicationDeadline } from '../applicationDeadline.js'
import { todayCapacity } from '../today/localDayCapacity.js'
import { compareDeadlines, actionDeadline, actionNodesById, deadlineBoundaryMs } from '../deadlineOrder.js'
import { canonicalOpportunityId } from '../opportunityCanonicalization.js'
import { processNeedsReview, rankActions } from '../decisionV3.js'
import { discoverySearchScope, isDiscoveryProfileConfigured, isDiscoverySearchScopeConfirmed, discoveryProfileForSnapshot, type DiscoverySearchScope } from '../discoveryProfile.js'
import { discoveryFeedbackSummary, recentRejectedDiscoveryFeedback } from '../discoveryFeedback.js'
import { isUnresolvedPastProcessEvent } from '../fixedEventGuardLogic.js'
import {
  overlayProcessEventsOnOpportunities,
  overlayProcessEventsOnProcesses,
  processEventStageLabel,
  reconcileProcessEventActions,
  suppressSupersededActions,
} from '../processEvents.js'
import { validateSnapshot, type PJSDASSnapshot } from '../snapshot.js'
import { validPlanningDate } from '../timePlanningPreferences.js'
import { localDateKey as displayDateKey } from '../todayBrief.js'
import { buildConsumerTimePlan } from '../today/consumerTimePlan.js'
import { calendarNodeProjection, scheduleNodeEligible } from '../scheduleEligibility.js'
import type {
  Action,
  Opportunity,
  ProcessEvent,
  ProcessRecord,
  ProcessStage,
  TimelineCategory,
} from '../model.js'

const DEFAULT_LIMIT = 30
const MAX_LIMIT = 100

export interface BridgeMeta {
  workspaceVersion?: string
  generatedAt: string
  timezone: string
  source: 'pjsdas'
}

export interface BridgeReadContext {
  now?: Date
  timezone?: string
  workspaceVersion?: string
  workspaceOwnerUserId?: string
  defaultAvailableMinutes?: number
}

export type BridgeErrorCode =
  | 'WORKSPACE_INVALID'
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'SCORING_RETIRED'

export class BridgeReadError extends Error {
  readonly code: BridgeErrorCode
  readonly retryable = false

  constructor(code: BridgeErrorCode, message: string) {
    super(message)
    this.name = 'BridgeReadError'
    this.code = code
  }
}

export interface GetTodayPlanInput {
  date?: string
  availableMinutes?: number
}

export interface GetTodayPlanOutput {
  meta: BridgeMeta
  date: string
  availableMinutes: number | null
  plannedMinutes: number
  capacityConflict: boolean
  startableActions: Array<{
    actionId: string
    title: string
    company?: string
    role?: string
    kind: string
    estimatedMinutes: number
    dueAt?: string
    duePrecision?: Action['duePrecision']
    timezone?: string
    timingMode?: Action['timingMode']
    rationale: string[]
  }>
  fixedEvents: Array<{
    eventId: string
    company?: string
    role?: string
    label: string
    occursAt: string
    precision?: Action['duePrecision']
    timezone?: string
  }>
  blockedOrRecoveryItems: Array<{
    id: string
    label: string
    reason: string
  }>
}

export interface ListOpportunitiesInput {
  query?: string
  stage?: ProcessStage
  company?: string
  roleType?: Opportunity['roleType']
  deadlineBefore?: string
  limit?: number
}

export interface ListOpportunitiesOutput {
  meta: BridgeMeta
  opportunities: Array<{
    opportunityId: string
    company: string
    role: string
    stage: string
    stageLabel: string
    applicationDeadline?: string
    applicationDeadlinePrecision?: Action['duePrecision']
    applicationDeadlineTimezone?: string
    currentActionDueAt?: string
    currentActionDuePrecision?: Action['duePrecision']
    currentActionTimingMode?: Action['timingMode']
    participationStatus: string
    applicationGroupId?: string
    locallyManaged: boolean
  }>
  truncated: boolean
}

export interface GetPipelineInput {
  stage?: ProcessStage
  attentionOnly?: boolean
  company?: string
  limit?: number
}

export interface GetPipelineOutput {
  meta: BridgeMeta
  processes: Array<{
    processId: string
    opportunityId?: string
    company: string
    role: string
    stage: string
    stageLabel: string
    lastProgressAt?: string
    nextCheckAt?: string
    silenceRisk?: string
    currentAction?: string
    upcomingEvent?: {
      eventId: string
      label: string
      timingSemantics: 'deadline' | 'fixed'
      occursOrDueAt: string
    }
  }>
  truncated: boolean
}

export interface GetDiscoveryContextOutput {
  scopeConfirmed: boolean
  meta: BridgeMeta
  configured: boolean
  profile: DiscoverySearchScope
  existingOpportunities: Array<{
    opportunityId: string
    company: string
    role: string
    stage: string
    deadline?: string
  }>
  recentlyClosed: Array<{
    opportunityId: string
    company: string
    role: string
  }>
  recentlyRejected: Array<{
    company: string
    role: string
    rejectedAt: string
    reasonCode?: string
    reason?: string
  }>
  discoveryHistorySummary: {
    accepted: number
    rejected: number
    filtered: number
    duplicate: number
    deferred: number
  }
  discoveryInboxSummary: { new: number; seen: number; later: number; dismissed: number; promoted: number }
  discoveryInbox: Array<{
    inboxId: string
    company: string
    role: string
    status: string
    updatedAt: string
    sourceUrl: string
  }>
  instructions: string[]
}

export interface ExplainPriorityInput {
  actionId?: string
  opportunityId?: string
  compareWithOpportunityId?: string
}

export interface GetRecentTimelineInput {
  since?: string
  until?: string
  categories?: TimelineCategory[]
  company?: string
  opportunityId?: string
  limit?: number
}

export interface GetRecentTimelineOutput {
  meta: BridgeMeta
  records: Array<{
    timelineId: string
    occurredAt: string
    recordedAt: string
    category: string
    source: string
    title: string
    company?: string
    role?: string
    opportunityId?: string
    summary?: string
  }>
  truncated: boolean
}

interface EffectiveWorkspace {
  opportunities: Opportunity[]
  processes: ProcessRecord[]
  processEvents: ProcessEvent[]
  actions: Action[]
}

function resolvedContext(context: BridgeReadContext) {
  const now = context.now ?? new Date()
  const timezone = context.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
  return {
    now,
    timezone,
    workspaceVersion: context.workspaceVersion,
    defaultAvailableMinutes: context.defaultAvailableMinutes,
  }
}

function meta(context: ReturnType<typeof resolvedContext>): BridgeMeta {
  return {
    workspaceVersion: context.workspaceVersion,
    generatedAt: context.now.toISOString(),
    timezone: context.timezone,
    source: 'pjsdas',
  }
}

function readWorkspace(snapshot: PJSDASSnapshot): EffectiveWorkspace {
  try {
    validateSnapshot(snapshot)
  } catch (caught) {
    throw new BridgeReadError(
      'WORKSPACE_INVALID',
      caught instanceof Error ? caught.message : 'TodayAction workspace validation failed.',
    )
  }

  const processEvents = snapshot.data.processEvents.filter(event => !event.invalidation)
  // Process Action status is part of the effective recruiting state. Reconcile
  // every event Action before projecting Opportunities so list_opportunities and
  // get_pipeline cannot disagree about an already completed assessment/test/interview.
  const reconciledActions = reconcileProcessEventActions(snapshot.data.actions, processEvents)
  const opportunities = overlayProcessEventsOnOpportunities(
    snapshot.data.opportunities,
    processEvents,
    snapshot.data.processes,
    reconciledActions,
  )
  const actions = suppressSupersededActions(reconciledActions, opportunities)
  const processes = overlayProcessEventsOnProcesses(
    snapshot.data.processes,
    opportunities,
    processEvents,
    reconciledActions,
  )

  return {
    opportunities,
    processes,
    processEvents,
    actions,
  }
}

function normalizeLimit(limit: number | undefined) {
  if (limit === undefined) return DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new BridgeReadError('INVALID_ARGUMENT', `limit must be an integer between 1 and ${MAX_LIMIT}.`)
  }
  return limit
}

function parseDate(value: string | undefined, label: string) {
  if (!value) return undefined
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) throw new BridgeReadError('INVALID_ARGUMENT', `${label} is not a valid date.`)
  return parsed
}

function nowForRequestedDate(value: string | undefined, fallback: Date, timezone: string) {
  if (!value) return fallback
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BridgeReadError('INVALID_ARGUMENT', 'date must use local YYYY-MM-DD format.')
  }
  if (!validPlanningDate(value)) {
    throw new BridgeReadError('INVALID_ARGUMENT', 'date is not a valid calendar date.')
  }
  const noon = new Date(`${value}T12:00:00.000Z`).getTime()
  let lower = noon - 48 * 3_600_000, upper = noon + 48 * 3_600_000
  while (upper - lower > 1) {
    const middle = Math.floor((lower + upper) / 2)
    if (displayDateKey(new Date(middle), timezone) < value) lower = middle
    else upper = middle
  }
  return new Date(upper)
}

function opportunityForAction(action: Action, opportunities: Opportunity[]) {
  return action.opportunityId ? opportunities.find((item) => item.id === action.opportunityId) : undefined
}

function eventForAction(action: Action, events: ProcessEvent[]) {
  return action.processEventId ? events.find((item) => item.id === action.processEventId) : undefined
}

function companyRoleForAction(action: Action, opportunities: Opportunity[], events: ProcessEvent[]) {
  const opportunity = opportunityForAction(action, opportunities)
  const event = eventForAction(action, events)
  return {
    company: opportunity?.company ?? event?.company,
    role: opportunity?.role ?? event?.role,
  }
}

export function getTodayPlan(
  snapshot: PJSDASSnapshot,
  input: GetTodayPlanInput = {},
  bridgeContext: BridgeReadContext = {},
): GetTodayPlanOutput {
  const context = resolvedContext(bridgeContext)
  const workspace = readWorkspace(snapshot)
  const now = nowForRequestedDate(input.date, context.now, context.timezone)
  const today = displayDateKey(now, context.timezone)
  const availableMinutes = input.availableMinutes
  if (availableMinutes !== undefined && (!Number.isInteger(availableMinutes) || availableMinutes < 0 || availableMinutes > 24 * 60)) {
    throw new BridgeReadError('INVALID_ARGUMENT', 'availableMinutes must be between 0 and 1440.')
  }

  const ranked = rankActions(workspace.actions, workspace.opportunities, now, undefined, context.timezone, snapshot.data.scheduleNodes ?? [])
  const consumerPlan = buildConsumerTimePlan({ ranked, nodes: snapshot.data.scheduleNodes ?? [], opportunities: workspace.opportunities, processEvents: workspace.processEvents,
    preferences: snapshot.data.timePlanning, availableMinutes, now, timezone: context.timezone, useRemainingDayDefault: true })
  const capacityMinutes = consumerPlan.capacityMinutes ?? todayCapacity(snapshot.data.timePlanning, now, context.timezone, availableMinutes).minutes

  const nodes = snapshot.data.scheduleNodes ?? []
  const activeNodes = actionNodesById(nodes, workspace.actions, workspace.opportunities, workspace.processEvents)
  const linkedActions = new Set(nodes.flatMap(node => node.relatedActionIds))
  const timingFor = (action: Action) => {
    const node = activeNodes.get(action.id)
    const timing = node ? actionDeadline(action, node) : linkedActions.has(action.id) ? { id: action.id } : actionDeadline(action)
    const timingMode = !timing.deadline ? undefined : node && 'completionDeadline' in node ? 'deadline' as const : node?.temporal.shape === 'fixed_range' ? 'fixed' as const
      : node?.temporal.shape === 'deadline' ? 'deadline' as const : action.timingMode
    return { ...timing, timingMode }
  }

  const startableActions = consumerPlan.planned.map((item) => {
    const identity = companyRoleForAction(item.action, workspace.opportunities, workspace.processEvents)
    const timing = timingFor(item.action)
    return {
      actionId: item.action.id,
      title: item.action.title,
      company: identity.company,
      role: identity.role,
      kind: item.action.kind,
      estimatedMinutes: item.action.estimatedMinutes,
      dueAt: timing.deadline,
      duePrecision: timing.precision,
      timezone: timing.timezone,
      timingMode: timing.timingMode,
      rationale: [...item.reasons],
    }
  })

  const fixedEvents = ranked.flatMap((item) => {
    const node = activeNodes.get(item.action.id)
    if (!node || node.timingUnknown || !['scheduled', 'in_progress'].includes(node.state) || !scheduleNodeEligible(node, workspace)) return []
    const temporal = calendarNodeProjection(node).temporal
    const timing = { id: item.action.id, deadline: temporal.startAt ?? temporal.date, precision: temporal.precision, timezone: temporal.timezone }
    if (!timing.deadline || (deadlineBoundaryMs(timing, context.timezone) ?? -Infinity) < now.getTime()) return []
    const event = eventForAction(item.action, workspace.processEvents)
    const identity = companyRoleForAction(item.action, workspace.opportunities, workspace.processEvents)
    return [{
      eventId: event?.id ?? item.action.id,
      company: identity.company,
      role: identity.role,
      label: event ? processEventStageLabel(event) : item.action.title,
      occursAt: timing.deadline,
      precision: timing.precision,
      timezone: timing.timezone,
    }]
  })

  const recovery = workspace.actions
    .filter((action) => isUnresolvedPastProcessEvent(action, now, activeNodes.get(action.id), context.timezone))
    .map((action) => ({
      id: action.id,
      label: action.title,
      reason: '流程节点已过但仍未确认结果，需要先确认完成状态或采取恢复动作。',
    }))

  const blocked = consumerPlan.conflicts.flatMap(conflict => conflict.relatedIds.map(id => ({
    id,
    label: workspace.actions.find(action => action.id === id)?.title ?? id,
    reason: conflict.kind === 'fixed_overlap' ? '两个固定安排时间重叠。' : '硬截止事项无法在剩余时间内全部完成。',
  })))

  const blockedIds = new Set<string>()
  const blockedOrRecoveryItems = [...recovery, ...blocked].filter((item) => {
    if (blockedIds.has(item.id)) return false
    blockedIds.add(item.id)
    return true
  })

  return {
    meta: meta({ ...context, now }),
    date: today,
    availableMinutes: capacityMinutes,
    plannedMinutes: consumerPlan.plannedMinutes,
    capacityConflict: consumerPlan.conflicts.length > 0 || consumerPlan.overBudgetMinutes > 0,
    startableActions,
    fixedEvents,
    blockedOrRecoveryItems,
  }
}

export function listOpportunities(
  snapshot: PJSDASSnapshot,
  input: ListOpportunitiesInput = {},
  bridgeContext: BridgeReadContext = {},
): ListOpportunitiesOutput {
  const context = resolvedContext(bridgeContext)
  const workspace = readWorkspace(snapshot)
  const limit = normalizeLimit(input.limit)
  const query = input.query?.trim().toLocaleLowerCase()
  const company = input.company?.trim().toLocaleLowerCase()
  const deadlineBefore = parseDate(input.deadlineBefore, 'deadlineBefore')
  const decisions = buildOpportunityDecisionList(snapshot, context).all
  const decisionById = new Map(decisions.map(item => [item.opportunityId, item]))
  const order = new Map(decisions.map((item, index) => [item.opportunityId, index]))

  const filtered = workspace.opportunities
    .map(item => { const deadline = resolveApplicationDeadline(item, snapshot.data); return { ...item, deadline: deadline.deadline, deadlinePrecision: deadline.precision, deadlineTimezone: deadline.timezone } })
    .filter((item) => !input.stage || item.processStage === input.stage)
    .filter((item) => !input.roleType || item.roleType === input.roleType)
    .filter((item) => !company || item.company.toLocaleLowerCase().includes(company))
    .filter((item) => !query || `${item.company} ${item.role}`.toLocaleLowerCase().includes(query))
    .filter((item) => {
      if (!deadlineBefore) return true
      return Boolean(item.deadline && compareDeadlines({ id: '', deadline: item.deadline, precision: item.deadlinePrecision, timezone: item.deadlineTimezone },
        { id: '', deadline: input.deadlineBefore }, context.timezone) <= 0)
    })
    .sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id))

  return {
    meta: meta(context),
    opportunities: filtered.slice(0, limit).map((item) => ({
      opportunityId: item.id,
      company: item.company,
      role: item.role,
      stage: item.processStage,
      stageLabel: item.currentStageLabel,
      applicationDeadline: item.deadline,
      applicationDeadlinePrecision: item.deadlinePrecision,
      applicationDeadlineTimezone: item.deadlineTimezone,      currentActionDueAt: decisionById.get(item.id)?.nextAction?.dueAt,
      currentActionDuePrecision: decisionById.get(item.id)?.nextAction?.duePrecision,
      currentActionTimingMode: decisionById.get(item.id)?.nextAction?.timingMode,
      participationStatus: item.participationStatus ?? 'active',
      applicationGroupId: item.applicationGroupId,
      locallyManaged: Boolean(item.locallyManaged),
    })),
    truncated: filtered.length > limit,
  }
}

function upcomingEventForProcess(process: ProcessRecord, events: ProcessEvent[], now: Date) {
  if (!process.opportunityId) return undefined
  return events
    .filter((event) => event.opportunityId === process.opportunityId && event.dueAt)
    .filter((event) => new Date(event.dueAt!).getTime() >= now.getTime())
    .sort((a, b) => new Date(a.dueAt!).getTime() - new Date(b.dueAt!).getTime())[0]
}

export function getPipeline(
  snapshot: PJSDASSnapshot,
  input: GetPipelineInput = {},
  bridgeContext: BridgeReadContext = {},
): GetPipelineOutput {
  const context = resolvedContext(bridgeContext)
  const workspace = readWorkspace(snapshot)
  const limit = normalizeLimit(input.limit)
  const company = input.company?.trim().toLocaleLowerCase()

  const entries = workspace.processes.map((process) => ({
    process,
    upcomingEvent: upcomingEventForProcess(process, workspace.processEvents, context.now),
  }))
    .filter(({ process }) => !input.stage || process.stage === input.stage)
    .filter(({ process }) => !company || process.company.toLocaleLowerCase().includes(company))
    .filter(({ process, upcomingEvent }) => !input.attentionOnly ||
      processNeedsReview(process, context.now) || Boolean(process.currentAction) || Boolean(process.silenceRisk) || Boolean(upcomingEvent))
    .sort((a, b) => {
      const aAttention = processNeedsReview(a.process, context.now) || a.process.currentAction ? 0 : 1
      const bAttention = processNeedsReview(b.process, context.now) || b.process.currentAction ? 0 : 1
      const aNext = a.upcomingEvent?.dueAt ? new Date(a.upcomingEvent.dueAt).getTime() : Number.POSITIVE_INFINITY
      const bNext = b.upcomingEvent?.dueAt ? new Date(b.upcomingEvent.dueAt).getTime() : Number.POSITIVE_INFINITY
      return aAttention - bAttention || aNext - bNext || a.process.company.localeCompare(b.process.company) || a.process.id.localeCompare(b.process.id)
    })

  return {
    meta: meta(context),
    processes: entries.slice(0, limit).map(({ process, upcomingEvent }) => ({
      processId: process.id,
      opportunityId: process.opportunityId,
      company: process.company,
      role: process.role,
      stage: process.stage,
      stageLabel: process.stageLabel,
      lastProgressAt: process.lastProgressAt,
      nextCheckAt: process.nextCheckAt,
      silenceRisk: process.silenceRisk,
      currentAction: process.currentAction,
      upcomingEvent: upcomingEvent?.dueAt ? {
        eventId: upcomingEvent.id,
        label: processEventStageLabel(upcomingEvent),
        timingSemantics: upcomingEvent.timingMode ?? (upcomingEvent.type === 'assessment_invite' ? 'deadline' : 'fixed'),
        occursOrDueAt: upcomingEvent.dueAt,
      } : undefined,
    })),
    truncated: entries.length > limit,
  }
}

export function getDecisionRules(_snapshot: PJSDASSnapshot, _context: BridgeReadContext = {}): never {
  throw new BridgeReadError('SCORING_RETIRED', 'Decision scoring and user score policies have been retired. Read Today actions or factual deadlines instead.')
}

export function getDiscoveryContext(
  snapshot: PJSDASSnapshot,
  bridgeContext: BridgeReadContext = {},
): GetDiscoveryContextOutput {
  const context = resolvedContext(bridgeContext)
  const workspace = readWorkspace(snapshot)
  const profile = discoverySearchScope(snapshot.data.discoveryProfile)
  const active = workspace.opportunities
    .filter((item) => item.processStage !== 'closed')
    .sort((a, b) => a.company.localeCompare(b.company) || a.role.localeCompare(b.role))
    .slice(0, 150)
  const recentlyClosed = workspace.opportunities
    .filter((item) => item.processStage === 'closed')
    .sort((a, b) => b.importedAt.localeCompare(a.importedAt))
    .slice(0, 60)
  const history = snapshot.data.timeline ?? []
  const recentlyRejected = recentRejectedDiscoveryFeedback(history, context.now).slice(0, 40)
  const historySummary = discoveryFeedbackSummary(history)
  const inbox = [...(snapshot.data.discoveryInbox ?? [])]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const inboxSummary = { new: 0, seen: 0, later: 0, dismissed: 0, promoted: 0 }
  for (const item of inbox) inboxSummary[item.status] += 1

  return {
    meta: meta(context),
    configured: isDiscoveryProfileConfigured(discoveryProfileForSnapshot(snapshot.data.discoveryProfile)),
    scopeConfirmed: isDiscoverySearchScopeConfirmed(discoveryProfileForSnapshot(snapshot.data.discoveryProfile)),
    profile,
    existingOpportunities: active.map((item) => ({
      opportunityId: item.id,
      company: item.company,
      role: item.role,
      stage: item.processStage,
      deadline: resolveApplicationDeadline(item, snapshot.data).deadline,
      participationStatus: item.participationStatus ?? 'active',
    })),
    recentlyClosed: recentlyClosed.map((item) => ({
      opportunityId: item.id,
      company: item.company,
      role: item.role,
    })),
    recentlyRejected: recentlyRejected.map((item) => ({
      company: item.company,
      role: item.role,
      rejectedAt: item.occurredAt,
      reasonCode: item.discoveryReasonCode,
      reason: item.detail,
    })),
    discoveryHistorySummary: historySummary,
    discoveryInboxSummary: inboxSummary,
    discoveryInbox: inbox.slice(0, 100).map((item) => ({
      inboxId: item.id,
      company: item.company,
      role: item.role,
      status: item.status,
      updatedAt: item.updatedAt,
      sourceUrl: item.sourceUrl,
    })),
    instructions: [
      'Use the explicit Discovery Profile as durable search preferences; do not silently infer or rewrite it.',
      'Search public job sources outside TodayAction, and keep unknown salary, deadline or location fields unknown instead of inventing them.',
      'A configured historical profile may still have scopeConfirmed=false. Confirm the complete current scope before any new automatic discovery; preserve historical preferences.',
      'Deduplicate by verified publisher, tenant and native posting identity; matching company/title alone never proves two postings are the same.',
      'Avoid recentlyRejected roles unless the user explicitly asks to reconsider them; the quality gate also suppresses highly similar recent rejections.',
      'Do not repeatedly surface roles already present in discoveryInbox with new, seen or later status; dismissed inbox items are suppressed for 120 days.',
      'Use propose_changes for any candidate the user wants to add; never claim discovery results were added before ChangeSet review and Apply.',
    ],
  }
}

export function explainPriority(_snapshot: PJSDASSnapshot, _input: ExplainPriorityInput, _context: BridgeReadContext = {}): never {
  throw new BridgeReadError('SCORING_RETIRED', 'Priority scores and score comparisons have been retired. Today actions are ordered by actual deadlines.')
}

export function getRecentTimeline(
  snapshot: PJSDASSnapshot,
  input: GetRecentTimelineInput = {},
  bridgeContext: BridgeReadContext = {},
): GetRecentTimelineOutput {
  const context = resolvedContext(bridgeContext)
  readWorkspace(snapshot)
  const limit = normalizeLimit(input.limit)
  const since = parseDate(input.since, 'since')
  const until = parseDate(input.until, 'until')
  if (since && until && since.getTime() > until.getTime()) {
    throw new BridgeReadError('INVALID_ARGUMENT', 'since must be earlier than or equal to until.')
  }
  const categories = input.categories ? new Set(input.categories) : undefined
  const company = input.company?.trim().toLocaleLowerCase()

  const records = (snapshot.data.timeline ?? [])
    .filter((item) => item.kind !== 'baseline_backfill')
    .filter((item) => !since || new Date(item.occurredAt).getTime() >= since.getTime())
    .filter((item) => !until || new Date(item.occurredAt).getTime() <= until.getTime())
    .filter((item) => !categories || categories.has(item.category))
    .filter((item) => !company || item.company?.toLocaleLowerCase().includes(company))
    .filter((item) => !input.opportunityId || Boolean(item.opportunityId && canonicalOpportunityId(snapshot, item.opportunityId) === canonicalOpportunityId(snapshot, input.opportunityId)))
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.recordedAt.localeCompare(a.recordedAt) || a.id.localeCompare(b.id))

  return {
    meta: meta(context),
    records: records.slice(0, limit).map((item) => ({
      timelineId: item.id,
      occurredAt: item.occurredAt,
      recordedAt: item.recordedAt,
      category: item.category,
      source: item.source,
      title: item.processEventId && snapshot.data.processEvents.find(event => event.id === item.processEventId)?.invalidation ? `已失效 · ${item.title}` : item.title,
      company: item.company,
      role: item.role,
      opportunityId: item.opportunityId,
      summary: item.detail,
    })),
    truncated: records.length > limit,
  }
}
