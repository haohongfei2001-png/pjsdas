import { validSourceDate, validSourceDeadline, validSourceInstant } from './sourceCalendar.js'
import { actionArrangementDate, isExplicitActionArrangement, isRecruitingAppointment, scheduleNodeEligible } from './scheduleEligibility.js'
import { applicationDeadlineNodes, deadlineNodeFacts, latestDeadlineCorrection, resolveApplicationDeadline } from './applicationDeadline.js'
import type {
  Action,
  DatePrecision,
  Opportunity,
  Prep,
  ProcessEvent,
  ProcessParticipationState,
  ProcessRecord,
  ProcessResult,
  ProcessStage,
  ProcessStageProgress,
  ScheduleNode,
  ScheduleNodeKind,
  ScheduleNodeState,
  ScheduleNodeTemporal,
} from './model.js'

export interface ScheduleContractData {
  opportunities: Opportunity[]
  processes: ProcessRecord[]
  processEvents: ProcessEvent[]
  actions: Action[]
  prep: Prep[]
  scheduleNodes?: ScheduleNode[]
}

const terminalStates = new Set<ScheduleNodeState>(['completed', 'cancelled', 'superseded', 'elapsed_unresolved'])

function validDateOnly(value: string) {
  return validSourceDate(value)
}

function hasExplicitOffset(value: string) {
  return /(Z|[+-]\d{2}:\d{2})$/i.test(value)
}

function validInstant(value: string) {
  return validSourceInstant(value)
}

function timezoneValid(value: string) {
  if (value === 'UTC' || value === 'source-offset' || value === 'floating-date') return true
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0))
    return true
  } catch {
    return false
  }
}

function timezoneForLegacy(value: string, precision: DatePrecision) {
  if (precision === 'date' || validDateOnly(value)) return 'floating-date'
  return /Z$/i.test(value) ? 'UTC' : 'source-offset'
}

function datePart(value: string) {
  return value.slice(0, 10)
}


function eventKind(type: ProcessEvent['type']): ScheduleNodeKind | undefined {
  if (type === 'assessment_invite') return 'assessment'
  if (type === 'written_test_invite') return 'written_test'
  if (type === 'interview_invite') return 'interview'
  return undefined
}

function stageForEvent(type: ProcessEvent['type']): ProcessStage | undefined {
  if (type === 'assessment_invite') return 'assessment'
  if (type === 'written_test_invite') return 'written_test'
  if (type === 'interview_invite') return 'interview'
  if (type === 'offer') return 'offer'
  if (type === 'rejection') return 'closed'
  return undefined
}

function scheduleStateForAction(action: Action | undefined, processBacked: boolean): ScheduleNodeState {
  if (!action) return 'scheduled'
  if (action.status === 'done') return 'completed'
  if (action.status === 'doing') return 'in_progress'
  if (action.status === 'skipped' && !processBacked) return 'cancelled'
  return 'scheduled'
}

function legacyTemporal(
  value: string,
  precision: DatePrecision | undefined,
  timingMode: Action['timingMode'],
  estimatedMinutes: number | undefined,
  basis: ScheduleNodeTemporal['resolutionBasis'],
): ScheduleNodeTemporal {
  const effectivePrecision: DatePrecision = precision ?? (validDateOnly(value) ? 'date' : 'datetime')
  if (effectivePrecision === 'date') {
    return {
      shape: 'date_only',
      precision: 'date',
      timezone: 'floating-date',
      date: datePart(value),
      resolutionBasis: basis,
      legacyProjectionAt: value,
    }
  }
  if (timingMode === 'fixed') {
    return {
      shape: 'fixed_range',
      precision: 'datetime',
      timezone: timezoneForLegacy(value, effectivePrecision),
      startAt: value,
      resolutionBasis: basis,
      legacyProjectionAt: value,
    }
  }
  return {
    shape: 'deadline',
    precision: 'datetime',
    timezone: timezoneForLegacy(value, effectivePrecision),
    deadlineAt: value,
    resolutionBasis: basis,
    legacyProjectionAt: value,
  }
}

function latestByVersion(nodes: ScheduleNode[], occurrenceId: string) {
  return nodes
    .filter((item) => item.occurrenceId === occurrenceId)
    .sort((a, b) => b.version - a.version)[0]
}

export function latestScheduleOccurrence(nodes: ScheduleNode[], occurrenceId: string) {
  return latestByVersion(nodes, occurrenceId)
}

function nextNodeId(occurrenceId: string, version: number) {
  return `schedule:${occurrenceId}:v${version}`
}

function unique(values: Array<string | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
}

function baseNode(input: {
  occurrenceId: string
  opportunityId?: string
  processId?: string
  processEventId?: string
  kind: ScheduleNodeKind
  state: ScheduleNodeState
  temporal: ScheduleNodeTemporal
  constraintKind: ScheduleNode['constraintKind']
  estimatedMinutes?: number
  estimateProvenance?: ScheduleNode['estimateProvenance']
  evidenceRefs?: string[]
  sourceVersionRefs?: string[]
  relatedActionIds?: string[]
  relatedPrepIds?: string[]
  createdAt: string
  updatedAt: string
}): ScheduleNode {
  return {
    id: nextNodeId(input.occurrenceId, 1),
    occurrenceId: input.occurrenceId,
    version: 1,
    opportunityId: input.opportunityId,
    processId: input.processId,
    processEventId: input.processEventId,
    kind: input.kind,
    state: input.state,
    temporal: input.temporal,
    constraintKind: input.constraintKind,
    estimatedMinutes: input.estimatedMinutes,
    estimateProvenance: input.estimateProvenance,
    evidenceRefs: unique(input.evidenceRefs ?? []),
    sourceVersionRefs: unique(input.sourceVersionRefs ?? []),
    relatedActionIds: unique(input.relatedActionIds ?? []),
    relatedPrepIds: unique(input.relatedPrepIds ?? []),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  }
}

export function scheduleNodeForProcessEvent(
  event: ProcessEvent,
  action?: Action,
  process?: ProcessRecord,
): ScheduleNode | undefined {
  const kind = eventKind(event.type)
  const at = event.temporal?.startAt ?? event.temporal?.date ?? event.dueAt
  if (!kind || !at || !isRecruitingAppointment(event)) return undefined
  return baseNode({
    occurrenceId: `process-event:${event.id}`,
    opportunityId: event.opportunityId,
    processId: process?.id,
    processEventId: event.id,
    kind,
    state: scheduleStateForAction(action, true),
    temporal: event.temporal ? structuredClone(event.temporal) : legacyTemporal(
      at,
      event.duePrecision,
      event.timingMode,
      event.estimatedMinutes,
      'legacy_projection',
    ),
    constraintKind: 'employer_hard',
    estimatedMinutes: event.estimatedMinutes,
    estimateProvenance: event.estimatedMinutes ? 'legacy_projection' : undefined,
    evidenceRefs: [`process-event:${event.id}`],
    sourceVersionRefs: [`process-event:${event.id}:${event.updatedAt}`],
    relatedActionIds: action ? [action.id] : [],
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  })
}

export function scheduleNodeForOpportunityDeadline(
  opportunity: Opportunity,
  actions: Action[],
): ScheduleNode | undefined {
  // Compatibility entry point: retained nodes still own historical deadline
  // facts, but a posting deadline never creates a new calendar occurrence.
  void opportunity
  void actions
  return undefined
}

export function scheduleNodeForAction(action: Action): ScheduleNode | undefined {
  if (action.processEventId || !isExplicitActionArrangement(action.scheduledTemporal)) return undefined
  return baseNode({
    occurrenceId: `action:${action.id}`,
    opportunityId: action.opportunityId,
    kind: action.kind === 'prep' ? 'prep_trigger' : 'follow_up',
    state: scheduleStateForAction(action, false),
    temporal: structuredClone(action.scheduledTemporal!),
    constraintKind: 'user_plan',
    estimatedMinutes: action.estimatedMinutes,
    estimateProvenance: 'user',
    evidenceRefs: [`action:${action.id}`],
    sourceVersionRefs: [`action:${action.id}:${action.updatedAt}`],
    relatedActionIds: [action.id],
    relatedPrepIds: action.prepId ? [action.prepId] : [],
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
  })
}

export function migrateLegacyScheduleNodes(data: ScheduleContractData): ScheduleNode[] {
  const nodes: ScheduleNode[] = []
  const processesByOpportunity = new Map(
    data.processes.flatMap((item) => item.opportunityId ? [[item.opportunityId, item] as const] : []),
  )
  const actionsByEvent = new Map(
    data.actions.flatMap((item) => item.processEventId ? [[item.processEventId, item] as const] : []),
  )

  for (const opportunity of data.opportunities) {
    const node = scheduleNodeForOpportunityDeadline(opportunity, data.actions)
    if (node) nodes.push(node)
  }
  for (const event of data.processEvents) {
    if (event.invalidation) continue
    const node = scheduleNodeForProcessEvent(
      event,
      actionsByEvent.get(event.id),
      processesByOpportunity.get(event.opportunityId),
    )
    if (node) nodes.push(node)
  }
  for (const action of data.actions) {
    const node = scheduleNodeForAction(action)
    if (!node) continue
    const existing = nodes.find((item) => item.occurrenceId === node.occurrenceId)
    if (existing) {
      existing.relatedActionIds = unique([...existing.relatedActionIds, ...node.relatedActionIds])
      existing.relatedPrepIds = unique([...existing.relatedPrepIds, ...node.relatedPrepIds])
      existing.evidenceRefs = unique([...existing.evidenceRefs, ...node.evidenceRefs])
      existing.sourceVersionRefs = unique([...existing.sourceVersionRefs, ...node.sourceVersionRefs])
    } else {
      nodes.push(node)
    }
  }
  return nodes
}

function latestEventForOpportunity(events: ProcessEvent[], opportunityId: string) {
  return events
    .filter((item) => !item.invalidation && item.opportunityId === opportunityId)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0]
}

function latestStageEvent(events: ProcessEvent[], opportunityId: string, stage: ProcessStage) {
  return events
    .filter((item) => !item.invalidation && item.opportunityId === opportunityId && stageForEvent(item.type) === stage)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0]
}

function processProgress(process: ProcessRecord, events: ProcessEvent[], actions: Action[]): ProcessStageProgress {
  if (process.stage === 'not_applied') return 'not_started'
  if (process.stage === 'unknown' || process.stage === 'screening' || process.stage === 'waiting_release') return 'waiting_result'
  if (process.stage === 'offer' || process.stage === 'closed') return 'completed'
  const event = process.opportunityId ? latestStageEvent(events, process.opportunityId, process.stage) : undefined
  const action = event ? actions.find((item) => item.processEventId === event.id) : undefined
  if (action?.status === 'done') return 'waiting_result'
  if (action?.status === 'doing') return 'in_progress'
  if (event?.dueAt) return 'scheduled'
  return 'action_required'
}

function processResult(process: ProcessRecord, events: ProcessEvent[]): ProcessResult {
  const latest = process.opportunityId ? latestEventForOpportunity(events, process.opportunityId) : undefined
  if (latest?.type === 'offer' || process.stage === 'offer') return 'offer'
  if (latest?.type === 'rejection') return 'rejected'
  if (process.stage === 'closed') return 'closed_other'
  return 'pending'
}

function participationForProcess(process: ProcessRecord, opportunities: Opportunity[]): ProcessParticipationState {
  const target = process.opportunityId
    ? opportunities.find((item) => item.id === process.opportunityId)
    : undefined
  return target?.participationStatus === 'abandoned' ? 'abandoned' : 'active'
}

export function normalizeProcessSemantics(
  processes: ProcessRecord[],
  opportunities: Opportunity[],
  events: ProcessEvent[],
  actions: Action[],
): ProcessRecord[] {
  return processes.map((process) => ({
    ...process,
    progress: processProgress(process, events, actions),
    result: processResult(process, events),
    participationState: participationForProcess(process, opportunities),
  }))
}

export function ensureScheduleContractInPlace(data: ScheduleContractData) {
  for (const opportunity of data.opportunities) {
    const correction = latestDeadlineCorrection(opportunity)
    if (!correction) continue
    const resolved = resolveApplicationDeadline(opportunity, data)
    opportunity.deadline = resolved.state === 'confirmed' ? resolved.deadline : undefined
    opportunity.deadlinePrecision = resolved.state === 'confirmed' ? resolved.precision : undefined
    for (const action of data.actions) {
      if (action.opportunityId !== opportunity.id || action.kind !== 'apply' || !['todo', 'doing'].includes(action.status)) continue
      action.dueAt = opportunity.deadline
      action.duePrecision = opportunity.deadlinePrecision
      action.timingMode = opportunity.deadline ? 'deadline' : undefined
    }
  }
  const existing = data.scheduleNodes ?? []
  const derived = migrateLegacyScheduleNodes(data)
  for (const candidate of derived) {
    const current = latestByVersion(existing, candidate.occurrenceId)
    if (!current) {
      // Canonical ownership survives a changed occurrence ID, cancellation or
      // estimate. Backfilling another legacy occurrence from retained raw dates
      // would revive time that the canonical record has already superseded.
      const alreadyOwned = existing.some(node => node.kind !== 'application_deadline' && candidate.relatedActionIds.some(id => node.relatedActionIds.includes(id))
        || Boolean(candidate.processEventId && node.processEventId === candidate.processEventId
          && (!candidate.opportunityId || !node.opportunityId || candidate.opportunityId === node.opportunityId))
        || Boolean(candidate.kind === 'application_deadline' && node.kind === 'application_deadline'
          && candidate.opportunityId && candidate.opportunityId === node.opportunityId))
      if (!alreadyOwned) existing.push(candidate)
      continue
    }
    current.relatedActionIds = unique([...current.relatedActionIds, ...candidate.relatedActionIds])
    current.relatedPrepIds = unique([...current.relatedPrepIds, ...candidate.relatedPrepIds])
    current.evidenceRefs = unique([...current.evidenceRefs, ...candidate.evidenceRefs])
    current.sourceVersionRefs = unique([...current.sourceVersionRefs, ...candidate.sourceVersionRefs])
  }
  data.scheduleNodes = existing
  data.processes = normalizeProcessSemantics(data.processes, data.opportunities, data.processEvents, data.actions)
  projectScheduleNodesToLegacyInPlace(data)
  return data
}

function legacyValue(node: ScheduleNode) {
  return node.temporal.legacyProjectionAt
    ?? node.temporal.deadlineAt
    ?? node.temporal.startAt
    ?? node.temporal.date
}

function latestOccurrenceNodes(nodes: ScheduleNode[]) {
  const latest = new Map<string, ScheduleNode>()
  for (const node of nodes) {
    const current = latest.get(node.occurrenceId)
    if (!current || node.version > current.version) latest.set(node.occurrenceId, node)
  }
  return [...latest.values()].filter((node) => node.state !== 'superseded' && node.state !== 'cancelled')
}

export function projectScheduleNodesToLegacyInPlace(data: ScheduleContractData) {
  const nodes = latestOccurrenceNodes(data.scheduleNodes ?? [])
  for (const opportunity of data.opportunities) {
    if (!latestDeadlineCorrection(opportunity) && !applicationDeadlineNodes(data, opportunity.id).length) continue
    const fact = resolveApplicationDeadline(opportunity, data)
    opportunity.deadline = fact.state === 'confirmed' ? fact.deadline : undefined
    opportunity.deadlinePrecision = fact.state === 'confirmed' ? fact.precision : undefined
  }
  for (const node of nodes) {
    const value = legacyValue(node)
    if (!value) continue
    if (node.kind === 'application_deadline' || !node.processEventId && !scheduleNodeEligible(node, data)) continue
    for (const actionId of node.relatedActionIds) {
      const action = data.actions.find((item) => item.id === actionId)
      if (!action) continue
      if (node.constraintKind === 'user_plan' && isExplicitActionArrangement(node.temporal)) {
        action.scheduledTemporal = structuredClone(node.temporal)
        action.plannedDate = actionArrangementDate(node.temporal)
      } else {
        action.dueAt = value
        action.duePrecision = node.temporal.precision
        action.timingMode = node.temporal.shape === 'fixed_range' || scheduleNodeEligible(node, data) ? 'fixed' : 'deadline'
      }
    }
    if (node.processEventId) {
      const event = data.processEvents.find((item) => item.id === node.processEventId)
      if (event) {
        event.dueAt = value
        event.duePrecision = node.temporal.precision
        event.timingMode = node.temporal.shape === 'fixed_range' || scheduleNodeEligible(node, data) ? 'fixed' : 'deadline'
      }
    }
  }
  // New application tasks inherit the job's resolved deadline fact independently
  // of their chosen day/arrangement. Reimport may change or clear that fact even
  // when the new importer correctly emits no implicit task or calendar node.
  for (const action of data.actions) {
    if (action.kind !== 'apply' || action.timingContractVersion !== 2 || !['todo', 'doing'].includes(action.status)) continue
    const opportunity = data.opportunities.find(item => item.id === action.opportunityId)
    if (!opportunity) continue
    const fact = resolveApplicationDeadline(opportunity, data)
    action.dueAt = fact.state === 'confirmed' ? fact.deadline : undefined
    action.duePrecision = fact.state === 'confirmed' ? fact.precision : undefined
    action.timingMode = action.dueAt ? 'deadline' : undefined
  }
  return data
}

export function supersedeScheduleOccurrence(
  nodes: ScheduleNode[],
  replacement: Omit<ScheduleNode, 'id' | 'version' | 'supersedesNodeId' | 'supersededByNodeId'>,
) {
  const current = latestByVersion(nodes, replacement.occurrenceId)
  const version = (current?.version ?? 0) + 1
  const next: ScheduleNode = {
    ...replacement,
    id: nextNodeId(replacement.occurrenceId, version),
    version,
    supersedesNodeId: current?.id,
  }
  if (current) {
    current.state = 'superseded'
    current.supersededByNodeId = next.id
    current.updatedAt = replacement.updatedAt
  }
  nodes.push(next)
  return next
}

export function setApplicationDeadlineScheduleNode(
  data: ScheduleContractData,
  opportunityId: string,
  deadline: string,
  precision: DatePrecision,
  updatedAt: string,
  commandId?: string,
) {
  if (!validSourceDeadline(deadline, precision)) throw new Error('Deadline requires valid source precision and an explicit timezone offset for a datetime.')
  const opportunity = data.opportunities.find((item) => item.id === opportunityId)
  if (!opportunity) throw new Error(`Opportunity ${opportunityId} was not found.`)
  const nodes = applicationDeadlineNodes(data, opportunityId)
  const previous = resolveApplicationDeadline(opportunity, data)
  const id = commandId ?? `user:deadline:${opportunityId}:${updatedAt}`
  if (opportunity.detail?.deadlineCorrections?.some(item => item.commandId === id)) return
  opportunity.detail = { ...opportunity.detail, deadlineCorrections: [
    ...(opportunity.detail?.deadlineCorrections ?? []), {
      commandId: id, state: 'confirmed', deadline, precision, sourceAuthority: 'user',
      evidence: 'Explicit user deadline', checkedAt: updatedAt, recordedAt: updatedAt,
      postingStatus: 'unknown', previousDeadline: previous.deadline,
      previousNodeIds: nodes.map(item => item.id), acknowledgedNodeFacts: deadlineNodeFacts(nodes),
    },
  ] }
  opportunity.deadline = deadline
  opportunity.deadlinePrecision = precision

}

export function syncScheduleNodeForActionStatus(
  data: ScheduleContractData,
  actionId: string,
  status: Action['status'],
  updatedAt: string,
) {
  ensureScheduleContractInPlace(data)
  for (const node of data.scheduleNodes ?? []) {
    if (!scheduleNodeEligible(node, data) || !node.relatedActionIds.includes(actionId) || node.state === 'superseded' || node.state === 'cancelled') continue
    // A task checkbox does not confirm participation in a historical occurrence.
    // Keep unknown legacy completion times unknown, and preserve prior completions.
    if (terminalStates.has(effectiveScheduleNodeState(node, new Date(updatedAt)))) continue
    if (status === 'done') {
      node.state = 'completed'
      node.completedAt = updatedAt
    } else if (status === 'doing') {
      node.state = 'in_progress'
      node.completedAt = undefined
    } else if (status === 'todo') {
      node.state = 'scheduled'
      node.completedAt = undefined
    } else if (!node.processEventId) {
      node.state = 'cancelled'
      node.cancelledAt = updatedAt
    }
    node.updatedAt = updatedAt
  }
  data.processes = normalizeProcessSemantics(data.processes, data.opportunities, data.processEvents, data.actions)
  projectScheduleNodesToLegacyInPlace(data)
}

export const PROCESS_EVENT_HISTORY_DELETION_MESSAGE = '此事件关联已完成或已过期的历史日程；请保留历史并操作具体安排。This event has completed or elapsed historical occurrences; keep its history and update the exact occurrence.'

export function processEventHasHistoricalOccurrences(data: ScheduleContractData, processEventId: string, now: Date) {
  if (data.processEvents.find(event => event.id === processEventId)?.invalidation) return true
  ensureScheduleContractInPlace(data)
  return (data.scheduleNodes ?? []).some((node) => node.processEventId === processEventId
    && ['completed', 'elapsed_unresolved'].includes(effectiveScheduleNodeState(node, now)))
}

export function cancelScheduleNodeForProcessEvent(
  data: ScheduleContractData,
  processEventId: string,
  cancelledAt: string,
) {
  ensureScheduleContractInPlace(data)
  for (const node of data.scheduleNodes ?? []) {
    if (node.processEventId !== processEventId || terminalStates.has(node.state)) continue
    node.state = 'cancelled'
    node.cancelledAt = cancelledAt
    node.updatedAt = cancelledAt
  }
}

function dateInTimezone(now: Date, timezone: string) {
  if (timezone === 'floating-date' || timezone === 'UTC' || timezone === 'source-offset') {
    return now.toISOString().slice(0, 10)
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

export function effectiveScheduleNodeState(node: ScheduleNode, now = new Date(), displayTimezone?: string): ScheduleNodeState {
  if (terminalStates.has(node.state) || node.state === 'in_progress') return node.state
  const temporal = node.temporal
  if (temporal.shape === 'date_only' || temporal.shape === 'estimated_date') {
    if (temporal.date && temporal.date < dateInTimezone(now, temporal.timezone === 'floating-date' && displayTimezone ? displayTimezone : temporal.timezone)) return 'elapsed_unresolved'
    return node.state
  }
  const boundary = temporal.shape === 'deadline'
    ? temporal.deadlineAt
    : temporal.endAt ?? temporal.startAt
  if (boundary && new Date(boundary).getTime() < now.getTime()) return 'elapsed_unresolved'
  return node.state
}

export function validateScheduleNode(node: ScheduleNode): string[] {
  const errors: string[] = []
  if (!node.id?.trim() || !node.occurrenceId?.trim()) errors.push('ScheduleNode identity is required.')
  if (!Number.isInteger(node.version) || node.version < 1) errors.push('ScheduleNode version must be a positive integer.')
  if (!timezoneValid(node.temporal.timezone)) errors.push('ScheduleNode timezone is invalid.')
  if (node.temporal.precision === 'date') {
    if (!node.temporal.date || !validDateOnly(node.temporal.date)) errors.push('Date-only ScheduleNode requires YYYY-MM-DD.')
    if (node.temporal.deadlineAt || node.temporal.startAt || node.temporal.endAt || node.temporal.latestStartAt) errors.push('Date-only ScheduleNode may not fabricate a time.')
  } else {
    if (node.temporal.startAt && !validInstant(node.temporal.startAt)) errors.push('ScheduleNode startAt requires a valid offset-aware instant.')
    if (node.temporal.endAt && !validInstant(node.temporal.endAt)) errors.push('ScheduleNode endAt requires a valid offset-aware instant.')
    if (node.temporal.shape === 'deadline' && (!node.temporal.deadlineAt || !validInstant(node.temporal.deadlineAt))) {
      errors.push('Deadline ScheduleNode requires an offset-aware deadlineAt.')
    }
    if (node.temporal.shape === 'fixed_range' && (!node.temporal.startAt || !validInstant(node.temporal.startAt))) {
      errors.push('Fixed ScheduleNode requires an offset-aware startAt.')
    }
    if (node.temporal.shape === 'availability_window') {
      if (!node.temporal.startAt || !validInstant(node.temporal.startAt) || !node.temporal.endAt || !validInstant(node.temporal.endAt)) {
        errors.push('Availability window requires offset-aware startAt and endAt.')
      }
    }
    if (node.temporal.startAt && node.temporal.endAt && new Date(node.temporal.endAt) < new Date(node.temporal.startAt)) {
      errors.push('ScheduleNode endAt precedes startAt.')
    }
    if (node.temporal.latestStartAt) {
      if (!validInstant(node.temporal.latestStartAt)) {
        errors.push('ScheduleNode latestStartAt must be an offset-aware instant.')
      } else if (node.temporal.startAt && new Date(node.temporal.latestStartAt) < new Date(node.temporal.startAt)) {
        errors.push('ScheduleNode latestStartAt precedes startAt.')
      } else if (node.temporal.endAt && new Date(node.temporal.latestStartAt) > new Date(node.temporal.endAt)) {
        errors.push('ScheduleNode latestStartAt exceeds endAt.')
      }
    }
  }
  if (node.supersedesNodeId === node.id || node.supersededByNodeId === node.id) errors.push('ScheduleNode cannot supersede itself.')
  return errors
}
