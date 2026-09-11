import { buildTimePlan, processNeedsReview, rankAction, rankActions } from '../decisionV3.js'
import { decisionRulesForSnapshot, type DecisionRules, type DecisionWeights } from '../decisionRules.js'
import { discoveryProfileForSnapshot, type DiscoveryProfile } from '../discoveryProfile.js'
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
import type {
  Action,
  Opportunity,
  ProcessEvent,
  ProcessRecord,
  ProcessStage,
  RankedAction,
  TimelineCategory,
} from '../model.js'

const DEFAULT_LIMIT = 30
const MAX_LIMIT = 100
const DEFAULT_AVAILABLE_MINUTES = 180

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
  defaultAvailableMinutes?: number
}

export type BridgeErrorCode =
  | 'WORKSPACE_INVALID'
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'

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
  availableMinutes: number
  plannedMinutes: number
  capacityConflict: boolean
  startableActions: Array<{
    actionId: string
    title: string
    company?: string
    role?: string
    kind: string
    estimatedMinutes: number
    priority: number
    dueAt?: string
    rationale: string[]
  }>
  fixedEvents: Array<{
    eventId: string
    company: string
    role: string
    label: string
    occursAt: string
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
    opportunityValue: number
    fitScore: number
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

export interface GetDecisionRulesOutput {
  meta: BridgeMeta
  rulesVersion: number
  updatedAt: string
  weights: DecisionWeights
  planning: Record<string, number | boolean | string>
  deadlines: Record<string, number | boolean | string>
  visibility: Record<string, number | boolean | string>
  humanSummary: string[]
}

export interface GetDiscoveryContextOutput {
  meta: BridgeMeta
  configured: boolean
  profile: DiscoveryProfile
  decisionWeights: DecisionWeights
  existingOpportunities: Array<{
    opportunityId: string
    company: string
    role: string
    stage: string
    roleType: Opportunity['roleType']
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

export interface ExplainPriorityOutput {
  meta: BridgeMeta
  target: {
    id: string
    type: 'action' | 'opportunity'
    label: string
  }
  score?: number
  components: Array<{
    key: string
    label: string
    contribution?: number
    value?: number | string | boolean
    explanation: string
  }>
  guardrails: Array<{
    key: string
    effect: string
    explanation: string
  }>
  comparison?: {
    targetId: string
    label: string
    score?: number
    decisiveDifferences: string[]
  }
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
  rules: DecisionRules
}

function resolvedContext(context: BridgeReadContext) {
  const now = context.now ?? new Date()
  const timezone = context.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
  return {
    now,
    timezone,
    workspaceVersion: context.workspaceVersion,
    defaultAvailableMinutes: context.defaultAvailableMinutes ?? DEFAULT_AVAILABLE_MINUTES,
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
      caught instanceof Error ? caught.message : 'PJSDAS workspace validation failed.',
    )
  }

  const processEvents = snapshot.data.processEvents
  const opportunities = overlayProcessEventsOnOpportunities(
    snapshot.data.opportunities,
    processEvents,
    snapshot.data.processes,
  )
  const reconciledActions = reconcileProcessEventActions(snapshot.data.actions, processEvents)
  const actions = suppressSupersededActions(reconciledActions, opportunities)
  const processes = overlayProcessEventsOnProcesses(
    snapshot.data.processes,
    opportunities,
    processEvents,
    actions,
  )

  return {
    opportunities,
    processes,
    processEvents,
    actions,
    rules: decisionRulesForSnapshot(snapshot.data.decisionRules),
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

function localDateKey(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function nowForRequestedDate(value: string | undefined, fallback: Date) {
  if (!value) return fallback
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BridgeReadError('INVALID_ARGUMENT', 'date must use local YYYY-MM-DD format.')
  }
  const [year, month, day] = value.split('-').map(Number)
  const result = new Date(fallback)
  result.setFullYear(year, month - 1, day)
  result.setHours(0, 0, 0, 0)
  if (result.getFullYear() !== year || result.getMonth() !== month - 1 || result.getDate() !== day) {
    throw new BridgeReadError('INVALID_ARGUMENT', 'date is not a valid calendar date.')
  }
  return result
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
  const now = nowForRequestedDate(input.date, context.now)
  const availableMinutes = input.availableMinutes ?? context.defaultAvailableMinutes
  if (!Number.isFinite(availableMinutes) || availableMinutes < 30 || availableMinutes > 24 * 60) {
    throw new BridgeReadError('INVALID_ARGUMENT', 'availableMinutes must be between 30 and 1440.')
  }

  const ranked = rankActions(workspace.actions, workspace.opportunities, now, workspace.rules)
  const plan = buildTimePlan(ranked, availableMinutes, now, workspace.rules)

  const startableActions = plan.planned.map((item) => {
    const identity = companyRoleForAction(item.action, workspace.opportunities, workspace.processEvents)
    return {
      actionId: item.action.id,
      title: item.action.title,
      company: identity.company,
      role: identity.role,
      kind: item.action.kind,
      estimatedMinutes: item.action.estimatedMinutes,
      priority: item.score,
      dueAt: item.action.dueAt,
      rationale: [...item.reasons],
    }
  })

  const fixedEvents = plan.upcomingFixedEvents.flatMap((item) => {
    if (!item.action.dueAt) return []
    const event = eventForAction(item.action, workspace.processEvents)
    const identity = companyRoleForAction(item.action, workspace.opportunities, workspace.processEvents)
    if (!identity.company || !identity.role) return []
    return [{
      eventId: event?.id ?? item.action.id,
      company: identity.company,
      role: identity.role,
      label: event ? processEventStageLabel(event) : item.action.title,
      occursAt: item.action.dueAt,
    }]
  })

  const recovery = workspace.actions
    .filter((action) => isUnresolvedPastProcessEvent(action, now))
    .map((action) => ({
      id: action.id,
      label: action.title,
      reason: '流程节点已过但仍未确认结果，需要先确认完成状态或采取恢复动作。',
    }))

  const blocked = plan.nearDeadlineUnplanned.map((item) => ({
    id: item.action.id,
    label: item.action.title,
    reason: `该硬截止位于 ${workspace.rules.hardDeadlineHorizonHours} 小时保护窗口内，但当前时间预算无法完整容纳。`,
  }))

  const blockedIds = new Set<string>()
  const blockedOrRecoveryItems = [...recovery, ...blocked].filter((item) => {
    if (blockedIds.has(item.id)) return false
    blockedIds.add(item.id)
    return true
  })

  return {
    meta: meta({ ...context, now }),
    date: localDateKey(now),
    availableMinutes: plan.budgetMinutes,
    plannedMinutes: plan.totalMinutes,
    capacityConflict: plan.overBudgetMinutes > 0 || plan.nearDeadlineUnplanned.length > 0,
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

  const filtered = workspace.opportunities
    .filter((item) => !input.stage || item.processStage === input.stage)
    .filter((item) => !input.roleType || item.roleType === input.roleType)
    .filter((item) => !company || item.company.toLocaleLowerCase().includes(company))
    .filter((item) => !query || `${item.company} ${item.role}`.toLocaleLowerCase().includes(query))
    .filter((item) => {
      if (!deadlineBefore) return true
      return Boolean(item.deadline && new Date(item.deadline).getTime() <= deadlineBefore.getTime())
    })
    .sort((a, b) => {
      const aDeadline = a.deadline ? new Date(a.deadline).getTime() : Number.POSITIVE_INFINITY
      const bDeadline = b.deadline ? new Date(b.deadline).getTime() : Number.POSITIVE_INFINITY
      return aDeadline - bDeadline || (a.order ?? Number.POSITIVE_INFINITY) - (b.order ?? Number.POSITIVE_INFINITY) ||
        b.opportunityValue - a.opportunityValue || b.fitScore - a.fitScore || a.id.localeCompare(b.id)
    })

  return {
    meta: meta(context),
    opportunities: filtered.slice(0, limit).map((item) => ({
      opportunityId: item.id,
      company: item.company,
      role: item.role,
      stage: item.processStage,
      stageLabel: item.currentStageLabel,
      applicationDeadline: item.deadline,
      opportunityValue: item.opportunityValue,
      fitScore: item.fitScore,
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

export function getDecisionRules(
  snapshot: PJSDASSnapshot,
  bridgeContext: BridgeReadContext = {},
): GetDecisionRulesOutput {
  const context = resolvedContext(bridgeContext)
  const rules = readWorkspace(snapshot).rules

  return {
    meta: meta(context),
    rulesVersion: rules.version,
    updatedAt: rules.updatedAt,
    weights: { ...rules.weights },
    planning: {
      nearDeadlineStretchMinutes: rules.nearDeadlineStretchMinutes,
      followUpDailyCap: rules.followUpDailyCap,
      prepDailyCap: rules.prepDailyCap,
    },
    deadlines: {
      hardDeadlineHorizonHours: rules.hardDeadlineHorizonHours,
      fixedEventHorizonHours: rules.fixedEventHorizonHours,
    },
    visibility: {
      upcomingHorizonDays: rules.upcomingHorizonDays,
      upcomingNodeLimit: rules.upcomingNodeLimit,
      riskCriticalHours: rules.riskCriticalHours,
      riskHighHours: rules.riskHighHours,
      riskNearHours: rules.riskNearHours,
      riskWatchHours: rules.riskWatchHours,
    },
    humanSummary: [
      `硬截止保护窗口：${rules.hardDeadlineHorizonHours} 小时。`,
      `固定时间事件预告窗口：${rules.fixedEventHorizonHours} 小时。`,
      `每日最多纳入 ${rules.followUpDailyCap} 个复核任务和 ${rules.prepDailyCap} 个准备任务。`,
      `排序权重最高项：${highestWeightLabel(rules.weights)}。`,
    ],
  }
}

function discoveryProfileConfigured(profile: DiscoveryProfile) {
  return Boolean(
    profile.targetRoleQueries.length ||
    profile.preferredLocations.length ||
    profile.locationNotes ||
    profile.minimumAnnualCompensationWan !== undefined ||
    profile.mustHave.length ||
    profile.mustNotHave.length ||
    profile.strengths.length ||
    profile.notes
  )
}

export function getDiscoveryContext(
  snapshot: PJSDASSnapshot,
  bridgeContext: BridgeReadContext = {},
): GetDiscoveryContextOutput {
  const context = resolvedContext(bridgeContext)
  const workspace = readWorkspace(snapshot)
  const profile = discoveryProfileForSnapshot(snapshot.data.discoveryProfile)
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
    configured: discoveryProfileConfigured(profile),
    profile,
    decisionWeights: { ...workspace.rules.weights },
    existingOpportunities: active.map((item) => ({
      opportunityId: item.id,
      company: item.company,
      role: item.role,
      stage: item.processStage,
      roleType: item.roleType,
      deadline: item.deadline,
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
      'Search public job sources outside PJSDAS, and keep unknown salary, deadline or location fields unknown instead of inventing them.',
      'Do not rediscover an obviously identical company+role already present in existingOpportunities.',
      'Avoid recentlyRejected roles unless the user explicitly asks to reconsider them; the quality gate also suppresses highly similar recent rejections.',
      'Do not repeatedly surface roles already present in discoveryInbox with new, seen or later status; dismissed inbox items are suppressed for 120 days.',
      'Use propose_changes for any candidate the user wants to add; never claim discovery results were added before ChangeSet review and Apply.',
    ],
  }
}

const componentLabels: Record<keyof DecisionWeights, string> = {
  opportunity: '机会价值',
  fit: '匹配度',
  urgency: '紧迫度',
  stage: '流程阶段',
  leverage: '行动杠杆',
  delayCost: '延误成本',
  timeEfficiency: '时间效率',
}

function highestWeightLabel(weights: DecisionWeights) {
  const [key, value] = (Object.entries(weights) as Array<[keyof DecisionWeights, number]>)
    .sort((a, b) => b[1] - a[1])[0]
  return `${componentLabels[key]}（${value}）`
}

function rankedForTarget(
  workspace: EffectiveWorkspace,
  now: Date,
  input: Pick<ExplainPriorityInput, 'actionId' | 'opportunityId'>,
): { ranked?: RankedAction; target: ExplainPriorityOutput['target'] } {
  if (input.actionId) {
    const action = workspace.actions.find((item) => item.id === input.actionId)
    if (!action) throw new BridgeReadError('NOT_FOUND', `Action ${input.actionId} was not found.`)
    const opportunity = opportunityForAction(action, workspace.opportunities)
    return {
      ranked: rankAction(action, opportunity, now, workspace.rules),
      target: { id: action.id, type: 'action', label: action.title },
    }
  }

  const opportunity = workspace.opportunities.find((item) => item.id === input.opportunityId)
  if (!opportunity) throw new BridgeReadError('NOT_FOUND', `Opportunity ${input.opportunityId} was not found.`)
  const ranked = rankActions(workspace.actions, workspace.opportunities, now, workspace.rules)
    .find((item) => item.action.opportunityId === opportunity.id)
  return {
    ranked,
    target: { id: opportunity.id, type: 'opportunity', label: `${opportunity.company}｜${opportunity.role}` },
  }
}

function componentsForRanked(item: RankedAction | undefined, rules: DecisionRules) {
  if (!item) return []
  const totalWeight = Math.max(1, Object.values(rules.weights).reduce((sum, value) => sum + value, 0))
  return (Object.entries(item.breakdown) as Array<[keyof DecisionWeights, number]>).map(([key, value]) => ({
    key,
    label: componentLabels[key],
    value,
    contribution: Math.round((value * rules.weights[key] / totalWeight) * 100) / 100,
    explanation: `${componentLabels[key]}当前值 ${Math.round(value)}，规则权重 ${rules.weights[key]}。`,
  }))
}

function decisiveDifferences(primary: RankedAction | undefined, other: RankedAction | undefined, rules: DecisionRules) {
  if (!primary || !other) return []
  const totalWeight = Math.max(1, Object.values(rules.weights).reduce((sum, value) => sum + value, 0))
  return (Object.keys(primary.breakdown) as Array<keyof DecisionWeights>)
    .map((key) => {
      const delta = (primary.breakdown[key] - other.breakdown[key]) * rules.weights[key] / totalWeight
      return { key, delta }
    })
    .filter((item) => Math.abs(item.delta) >= 0.5)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 3)
    .map(({ key, delta }) => `${componentLabels[key]}使主目标${delta >= 0 ? '领先' : '落后'}约 ${Math.abs(delta).toFixed(1)} 分。`)
}

export function explainPriority(
  snapshot: PJSDASSnapshot,
  input: ExplainPriorityInput,
  bridgeContext: BridgeReadContext = {},
): ExplainPriorityOutput {
  const context = resolvedContext(bridgeContext)
  const workspace = readWorkspace(snapshot)
  const primaryCount = Number(Boolean(input.actionId)) + Number(Boolean(input.opportunityId))
  if (primaryCount !== 1) {
    throw new BridgeReadError('INVALID_ARGUMENT', 'Provide exactly one of actionId or opportunityId.')
  }

  const primary = rankedForTarget(workspace, context.now, input)
  const result: ExplainPriorityOutput = {
    meta: meta(context),
    target: primary.target,
    score: primary.ranked?.score,
    components: componentsForRanked(primary.ranked, workspace.rules),
    guardrails: primary.ranked?.reasons.map((reason, index) => ({
      key: `reason_${index + 1}`,
      effect: 'active',
      explanation: reason,
    })) ?? [],
  }

  if (input.compareWithOpportunityId) {
    const comparison = rankedForTarget(workspace, context.now, { opportunityId: input.compareWithOpportunityId })
    result.comparison = {
      targetId: comparison.target.id,
      label: comparison.target.label,
      score: comparison.ranked?.score,
      decisiveDifferences: decisiveDifferences(primary.ranked, comparison.ranked, workspace.rules),
    }
  }

  return result
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
    .filter((item) => !input.opportunityId || item.opportunityId === input.opportunityId)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.recordedAt.localeCompare(a.recordedAt) || a.id.localeCompare(b.id))

  return {
    meta: meta(context),
    records: records.slice(0, limit).map((item) => ({
      timelineId: item.id,
      occurredAt: item.occurredAt,
      recordedAt: item.recordedAt,
      category: item.category,
      source: item.source,
      title: item.title,
      company: item.company,
      role: item.role,
      opportunityId: item.opportunityId,
      summary: item.detail,
    })),
    truncated: records.length > limit,
  }
}
