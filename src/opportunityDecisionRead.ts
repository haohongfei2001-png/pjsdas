import { decisionRulesForSnapshot } from './decisionRules.js'
import { computePriority, rankActions } from './decisionV3.js'
import { jobPostingFreshness } from './jobPosting.js'
import type {
  Action,
  ApplicationGroup,
  Opportunity,
  ProcessRecord,
  RankedAction,
  ScheduleNode,
  ScheduleNodeKind,
  ScheduleNodeState,
  ScheduleNodeTemporal,
} from './model.js'
import { effectiveScheduleNodeState } from './scheduleNodes.js'
import { upgradeSnapshotToLatest, type PJSDASSnapshot } from './snapshot.js'

const HOUR = 3_600_000

export type OpportunityDecisionBucket = 'in_progress' | 'worth_pursuing' | 'ended'
export type OpportunityConclusionKind =
  | 'continue_process'
  | 'review_offer'
  | 'worth_pursuing'
  | 'wait_for_opening'
  | 'application_window_closed'
  | 'not_pursuing'
  | 'process_ended'

export type OpportunityDecisionReasonCode =
  | 'active_recruiting_process'
  | 'offer_received'
  | 'core_opportunity'
  | 'early_window'
  | 'waiting_release'
  | 'deadline_near'
  | 'shared_application_constraint'
  | 'source_needs_refresh'
  | 'source_closed'
  | 'assessment_missing'
  | 'elapsed_node_unresolved'
  | 'user_not_pursuing'
  | 'process_closed'

export interface OpportunityDecisionReason {
  code: OpportunityDecisionReasonCode
  tone: 'reason' | 'risk' | 'info'
}

export interface OpportunityDecisionAction {
  actionId: string
  title: string
  kind: Action['kind']
  status: Action['status']
  estimatedMinutes: number
  dueAt?: string
  duePrecision?: Action['duePrecision']
  timingMode?: Action['timingMode']
  rankingReasons: string[]
  operation:
    | 'open_application'
    | 'open_today'
    | 'open_process'
    | 'start_prep'
    | 'compare_group'
  externalUrl?: string
}

export interface OpportunityDecisionNode {
  nodeId: string
  occurrenceId: string
  kind: ScheduleNodeKind
  state: ScheduleNodeState
  temporal: ScheduleNodeTemporal
  constraintKind: ScheduleNode['constraintKind']
  requiresResolution: boolean
}

export interface OpportunityDecisionRead {
  contractVersion: 1
  workspaceRevision: string
  evaluatedAt: string
  displayTimezone: string
  opportunityId: string
  company: string
  role: string
  bucket: OpportunityDecisionBucket
  conclusion: OpportunityConclusionKind
  reasons: OpportunityDecisionReason[]
  process: {
    stage: Opportunity['processStage']
    progress?: ProcessRecord['progress']
    result?: ProcessRecord['result']
    participation: 'active' | 'abandoned'
  }
  nextAction?: OpportunityDecisionAction
  nearestNode?: OpportunityDecisionNode
  sourceFreshness?: ReturnType<typeof jobPostingFreshness>
  applicationGroupId?: string
}

export interface OpportunityDecisionListRead {
  contractVersion: 1
  workspaceRevision: string
  evaluatedAt: string
  displayTimezone: string
  inProgress: OpportunityDecisionRead[]
  worthPursuing: OpportunityDecisionRead[]
  all: OpportunityDecisionRead[]
  endedCount: number
}

export interface OpportunityDecisionContext {
  now?: Date
  timezone?: string
  workspaceVersion?: string
}

function context(input: OpportunityDecisionContext) {
  const now = input.now ?? new Date()
  if (Number.isNaN(now.getTime())) throw new Error('Opportunity decision clock is invalid.')
  const timezone = input.timezone?.trim()
    || Intl.DateTimeFormat().resolvedOptions().timeZone
    || 'UTC'
  new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(now)
  return {
    now,
    timezone,
    workspaceVersion: input.workspaceVersion,
  }
}

function processFor(opportunity: Opportunity, processes: ProcessRecord[]) {
  return processes.find((item) => item.opportunityId === opportunity.id)
    ?? processes.find((item) => item.company === opportunity.company && item.role === opportunity.role)
}

function groupFor(opportunity: Opportunity, groups: ApplicationGroup[]) {
  return opportunity.applicationGroupId
    ? groups.find((item) => item.id === opportunity.applicationGroupId)
    : undefined
}

function latestNodes(nodes: ScheduleNode[]) {
  const latest = new Map<string, ScheduleNode>()
  for (const node of nodes) {
    const current = latest.get(node.occurrenceId)
    if (!current || node.version > current.version) latest.set(node.occurrenceId, node)
  }
  return [...latest.values()].filter((node) => node.state !== 'superseded' && node.state !== 'cancelled')
}

function localDateKey(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function nodeSortKey(node: ScheduleNode, now: Date, timezone: string) {
  const state = effectiveScheduleNodeState(node, now)
  if (state === 'elapsed_unresolved') return -1
  const temporal = node.temporal
  if ((temporal.shape === 'date_only' || temporal.shape === 'estimated_date') && temporal.date) {
    const today = localDateKey(now, timezone)
    const delta = Math.round((new Date(`${temporal.date}T12:00:00.000Z`).getTime() - new Date(`${today}T12:00:00.000Z`).getTime()) / (24 * HOUR))
    return Math.max(0, delta) * 24 * HOUR
  }
  const instant = temporal.startAt ?? temporal.deadlineAt ?? temporal.endAt
  if (!instant) return Number.POSITIVE_INFINITY
  const delta = new Date(instant).getTime() - now.getTime()
  return delta < 0 ? -1 : delta
}

function nearestNodeFor(
  opportunityId: string,
  nodes: ScheduleNode[],
  now: Date,
  timezone: string,
): OpportunityDecisionNode | undefined {
  const node = latestNodes(nodes)
    .filter((item) => item.opportunityId === opportunityId)
    .filter((item) => item.state !== 'completed')
    .sort((a, b) => nodeSortKey(a, now, timezone) - nodeSortKey(b, now, timezone) || a.id.localeCompare(b.id))[0]
  if (!node) return undefined
  const state = effectiveScheduleNodeState(node, now)
  return {
    nodeId: node.id,
    occurrenceId: node.occurrenceId,
    kind: node.kind,
    state,
    temporal: structuredClone(node.temporal),
    constraintKind: node.constraintKind,
    requiresResolution: state === 'elapsed_unresolved',
  }
}

function applicationUrl(opportunity: Opportunity) {
  return opportunity.detail?.userFacts?.applicationUrl
    ?? opportunity.detail?.facts?.application.applicationUrl
}

function actionRead(ranked: RankedAction | undefined, opportunity: Opportunity): OpportunityDecisionAction | undefined {
  if (!ranked) return undefined
  const action = ranked.action
  let operation: OpportunityDecisionAction['operation'] = 'open_today'
  let externalUrl: string | undefined
  if (action.kind === 'apply') {
    operation = 'open_application'
    externalUrl = applicationUrl(opportunity)
  } else if (action.kind === 'prep') {
    operation = 'start_prep'
  } else if (action.kind === 'group_decision') {
    operation = 'compare_group'
  } else if (action.processEventId) {
    operation = 'open_process'
  }
  return {
    actionId: action.id,
    title: action.title,
    kind: action.kind,
    status: action.status,
    estimatedMinutes: action.estimatedMinutes,
    dueAt: action.dueAt,
    duePrecision: action.duePrecision,
    timingMode: action.timingMode,
    rankingReasons: [...ranked.reasons].slice(0, 2),
    operation,
    externalUrl,
  }
}

function deadlineNear(opportunity: Opportunity, now: Date) {
  if (!opportunity.deadline) return false
  const delta = new Date(opportunity.deadline).getTime() - now.getTime()
  return delta >= 0 && delta <= 72 * HOUR
}

function isExpiredUnapplied(opportunity: Opportunity, now: Date) {
  return opportunity.processStage === 'not_applied'
    && Boolean(opportunity.deadline)
    && new Date(opportunity.deadline!).getTime() < now.getTime()
}

function bucket(opportunity: Opportunity, now: Date): OpportunityDecisionBucket {
  if (opportunity.participationStatus === 'abandoned') return 'ended'
  if (opportunity.processStage === 'closed') return 'ended'
  if (isExpiredUnapplied(opportunity, now)) return 'ended'
  if (['screening', 'assessment', 'written_test', 'interview', 'offer'].includes(opportunity.processStage)) return 'in_progress'
  return 'worth_pursuing'
}

function conclusion(opportunity: Opportunity, now: Date): OpportunityConclusionKind {
  if (opportunity.participationStatus === 'abandoned') return 'not_pursuing'
  if (opportunity.processStage === 'closed') return 'process_ended'
  if (isExpiredUnapplied(opportunity, now)) return 'application_window_closed'
  if (opportunity.processStage === 'offer') return 'review_offer'
  if (['screening', 'assessment', 'written_test', 'interview'].includes(opportunity.processStage)) return 'continue_process'
  if (opportunity.processStage === 'waiting_release') return 'wait_for_opening'
  return 'worth_pursuing'
}

function sourceFreshness(opportunity: Opportunity, now: Date) {
  const posting = opportunity.detail?.discovery?.posting
  return posting ? jobPostingFreshness(posting, now) : undefined
}

function reasonsFor(input: {
  opportunity: Opportunity
  process?: ProcessRecord
  group?: ApplicationGroup
  nearestNode?: OpportunityDecisionNode
  sourceFreshness?: ReturnType<typeof jobPostingFreshness>
  now: Date
}) {
  const reasons: OpportunityDecisionReason[] = []
  const push = (code: OpportunityDecisionReasonCode, tone: OpportunityDecisionReason['tone']) => {
    if (!reasons.some((item) => item.code === code)) reasons.push({ code, tone })
  }

  const { opportunity, group, nearestNode, sourceFreshness: freshness, now } = input
  if (opportunity.participationStatus === 'abandoned') push('user_not_pursuing', 'info')
  else if (opportunity.processStage === 'closed') push('process_closed', 'info')
  else if (opportunity.processStage === 'offer') push('offer_received', 'reason')
  else if (['screening', 'assessment', 'written_test', 'interview'].includes(opportunity.processStage)) push('active_recruiting_process', 'reason')
  else if (opportunity.processStage === 'waiting_release') push('waiting_release', 'info')
  else if (opportunity.roleType === 'core') push('core_opportunity', 'reason')

  if (opportunity.early) push('early_window', 'reason')
  if (deadlineNear(opportunity, now)) push('deadline_near', 'risk')
  if (group && (group.locked || group.remaining === 0)) push('shared_application_constraint', 'risk')
  if (freshness === 'stale' || freshness === 'aging' || freshness === 'unknown') push('source_needs_refresh', 'risk')
  if (freshness === 'closed') push('source_closed', 'risk')
  if ((opportunity.assessmentStatus ?? (opportunity.detail?.assessment ? 'assessed' : 'legacy')) === 'unassessed') push('assessment_missing', 'info')
  if (nearestNode?.requiresResolution) push('elapsed_node_unresolved', 'risk')

  return reasons.slice(0, 4)
}

function rankedActionsByOpportunity(
  snapshot: PJSDASSnapshot,
  now: Date,
) {
  const rules = decisionRulesForSnapshot(snapshot.data.decisionRules)
  const ranked = rankActions(snapshot.data.actions, snapshot.data.opportunities, now, rules)
  const map = new Map<string, RankedAction>()
  for (const item of ranked) {
    const opportunityId = item.action.opportunityId
    if (!opportunityId || map.has(opportunityId)) continue
    map.set(opportunityId, item)
  }
  return map
}

export function getOpportunityDecisionRead(
  rawSnapshot: PJSDASSnapshot,
  opportunityId: string,
  rawContext: OpportunityDecisionContext = {},
): OpportunityDecisionRead | undefined {
  const ctx = context(rawContext)
  const snapshot = upgradeSnapshotToLatest(rawSnapshot)
  const opportunity = snapshot.data.opportunities.find((item) => item.id === opportunityId)
  if (!opportunity) return undefined
  const process = processFor(opportunity, snapshot.data.processes)
  const group = groupFor(opportunity, snapshot.data.applicationGroups)
  const nearestNode = nearestNodeFor(opportunity.id, snapshot.data.scheduleNodes ?? [], ctx.now, ctx.timezone)
  const freshness = sourceFreshness(opportunity, ctx.now)
  const ranked = rankedActionsByOpportunity(snapshot, ctx.now).get(opportunity.id)

  return {
    contractVersion: 1,
    workspaceRevision: ctx.workspaceVersion ?? `snapshot:${rawSnapshot.exportedAt}`,
    evaluatedAt: ctx.now.toISOString(),
    displayTimezone: ctx.timezone,
    opportunityId: opportunity.id,
    company: opportunity.company,
    role: opportunity.role,
    bucket: bucket(opportunity, ctx.now),
    conclusion: conclusion(opportunity, ctx.now),
    reasons: reasonsFor({ opportunity, process, group, nearestNode, sourceFreshness: freshness, now: ctx.now }),
    process: {
      stage: process?.stage ?? opportunity.processStage,
      progress: process?.progress,
      result: process?.result,
      participation: opportunity.participationStatus === 'abandoned' ? 'abandoned' : 'active',
    },
    nextAction: actionRead(ranked, opportunity),
    nearestNode,
    sourceFreshness: freshness,
    applicationGroupId: opportunity.applicationGroupId,
  }
}

export function buildOpportunityDecisionList(
  rawSnapshot: PJSDASSnapshot,
  rawContext: OpportunityDecisionContext = {},
): OpportunityDecisionListRead {
  const ctx = context(rawContext)
  const snapshot = upgradeSnapshotToLatest(rawSnapshot)
  const ranked = rankedActionsByOpportunity(snapshot, ctx.now)
  const items = snapshot.data.opportunities.map((opportunity) => {
    const process = processFor(opportunity, snapshot.data.processes)
    const group = groupFor(opportunity, snapshot.data.applicationGroups)
    const nearestNode = nearestNodeFor(opportunity.id, snapshot.data.scheduleNodes ?? [], ctx.now, ctx.timezone)
    const freshness = sourceFreshness(opportunity, ctx.now)
    const read: OpportunityDecisionRead = {
      contractVersion: 1,
      workspaceRevision: ctx.workspaceVersion ?? `snapshot:${rawSnapshot.exportedAt}`,
      evaluatedAt: ctx.now.toISOString(),
      displayTimezone: ctx.timezone,
      opportunityId: opportunity.id,
      company: opportunity.company,
      role: opportunity.role,
      bucket: bucket(opportunity, ctx.now),
      conclusion: conclusion(opportunity, ctx.now),
      reasons: reasonsFor({ opportunity, process, group, nearestNode, sourceFreshness: freshness, now: ctx.now }),
      process: {
        stage: process?.stage ?? opportunity.processStage,
        progress: process?.progress,
        result: process?.result,
        participation: opportunity.participationStatus === 'abandoned' ? 'abandoned' : 'active',
      },
      nextAction: actionRead(ranked.get(opportunity.id), opportunity),
      nearestNode,
      sourceFreshness: freshness,
      applicationGroupId: opportunity.applicationGroupId,
    }
    return read
  })

  const sort = (a: OpportunityDecisionRead, b: OpportunityDecisionRead) => {
    const aHasAction = a.nextAction ? 0 : 1
    const bHasAction = b.nextAction ? 0 : 1
    const aDue = a.nextAction?.dueAt ? new Date(a.nextAction.dueAt).getTime() : Number.POSITIVE_INFINITY
    const bDue = b.nextAction?.dueAt ? new Date(b.nextAction.dueAt).getTime() : Number.POSITIVE_INFINITY
    return aHasAction - bHasAction || aDue - bDue || a.company.localeCompare(b.company) || a.role.localeCompare(b.role)
  }

  return {
    contractVersion: 1,
    workspaceRevision: ctx.workspaceVersion ?? `snapshot:${rawSnapshot.exportedAt}`,
    evaluatedAt: ctx.now.toISOString(),
    displayTimezone: ctx.timezone,
    inProgress: items.filter((item) => item.bucket === 'in_progress').sort(sort),
    worthPursuing: items.filter((item) => item.bucket === 'worth_pursuing').sort(sort),
    all: [...items].sort((a, b) => {
      const bucketOrder: Record<OpportunityDecisionBucket, number> = { in_progress: 0, worth_pursuing: 1, ended: 2 }
      return bucketOrder[a.bucket] - bucketOrder[b.bucket] || sort(a, b)
    }),
    endedCount: items.filter((item) => item.bucket === 'ended').length,
  }
}
