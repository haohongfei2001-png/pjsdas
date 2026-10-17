import { applyVerifiedPostingRefreshCommand, type VerifiedPostingRefreshCommand } from './verifiedPostingRefreshCommand.js'
import { applyVerifiedDiscoveryCommand, type VerifiedDiscoveryCommand } from './verifiedDiscoveryCommand.js'
import { actionArrangementDate, isExplicitActionArrangement, scheduleNodeEligible } from './scheduleEligibility.js'
import { resolveApplicationDeadline } from './applicationDeadline.js'
import { appendOpportunityOnly, createUserOpportunity, findUserJobDuplicate, normalizedUserJobFacts, userJobIdentity, type UserJobFacts } from './opportunityCreation.js'
import {applyVerifiedOpportunityCommand,type VerifiedOpportunityCommand} from './verifiedOpportunityCommand.js'
import { canonicalOpportunityId } from './opportunityCanonicalization.js'
import { applicationDeadlineFingerprint, applicationDeadlineNodes } from './applicationDeadline.js'
import { correctApplicationDeadline, type CorrectApplicationDeadlineCommand } from './deadlineCorrection.js'
import { captureProcessProjectionUndo, restoreProcessProjection, invalidateProcessFact, type InvalidateProcessEventCommand } from './processFactCorrection.js'
import { captureActionStatusUndo, restoreActionStatusUndo, restoreScheduleNodeChanges } from './actionStatusUndo.js'
import {
  actionForProcessEvent,
  defaultMinutesForProcessEvent,
  defaultTimingModeForProcessEvent,
  processEventStageLabel,
  stageForProcessEvent,
} from './processEvents.js'
import { timelineFromActionStatus, timelineFromProcessEvent } from './timeline.js'
import { indexScheduleOccurrenceEvidence, recruitingOccurrenceNeedsConfirmation } from './scheduleOccurrenceEvidence.js'
import type {
  Action,
  ActionStatus,
  ActionTimingMode,
  DatePrecision,
  Opportunity,
  OpportunityRole,
  ProcessEvent,
  ProcessEventType,
  ProcessRecord,
  ScheduleNode,
  ScheduleNodeTemporal,
  TimelineRecord,
  ReminderChannel,
  ReminderDeliveryOwner,
  ReminderPurpose,
  ExternalCapabilityState,
} from './model.js'
import type { PJSDASSnapshot } from './snapshot.js'
import { upgradeSnapshotToLatest, validateSnapshot } from './snapshot.js'
import { validPlanningDate, validateTimePlanningPreferences, type WorkWindow } from './timePlanningPreferences.js'
import { cancelReminderIntentInPlace, buildReminderIntent, reminderCapabilityForOwner, reminderDedupeKey, resolveReminderTrigger } from './reminders.js'
import {
  validateScheduleNode,
  ensureScheduleContractInPlace,
  latestScheduleOccurrence,
  migrateLegacyScheduleNodes,
  scheduleNodeForAction,
  projectScheduleNodesToLegacyInPlace,
  setApplicationDeadlineScheduleNode,
  supersedeScheduleOccurrence,
  syncScheduleNodeForActionStatus,
} from './scheduleNodes.js'

export type UserFactField = 'location' | 'compensationText' | 'applicationUrl'

export type UserDomainCommand =
  | ({ commandId: string; kind: 'add_user_opportunity' } & UserJobFacts)
  | { commandId: string; kind: 'plan_application_action'; opportunityId: string; plannedDate?: string; scheduledTemporal?: ScheduleNodeTemporal }
  | InvalidateProcessEventCommand
  | CorrectApplicationDeadlineCommand
  | { commandId: string; kind: 'record_application_submission'; opportunityId: string; occurredAt?: string; reactivateConfirmed?: boolean }
  | {
      commandId: string
      kind: 'record_process_event'
      sourceOccurrenceId?: string
      temporal?: ScheduleNodeTemporal
      opportunityId: string
      eventType: ProcessEventType
      occurredAt?: string
      dueAt?: string
      duePrecision?: DatePrecision
      timingMode?: ActionTimingMode
      estimatedMinutes?: number
      notes?: string
      location?: string
      joinUrl?: string
      source?: ProcessEvent['source']
    }
  | { commandId: string; kind: 'set_deadline'; opportunityId: string; deadline: string; precision: DatePrecision }
  | { commandId: string; kind: 'complete_occurrence'; occurrenceId: string; occurredAt?: string }
  | { commandId: string; kind: 'cancel_occurrence'; occurrenceId: string; occurredAt?: string }
  | {
      commandId: string
      kind: 'reschedule_occurrence'
      occurrenceId: string
      temporal: ScheduleNodeTemporal
      evidenceRefs?: string[]
      sourceVersionRefs?: string[]
    }
  | { commandId: string; kind: 'set_action_status'; actionId: string; status: ActionStatus }
  | { commandId: string; kind: 'abandon_opportunity'; opportunityId: string; occurredAt?: string }
  | { commandId: string; kind: 'correct_opportunity_fact'; opportunityId: string; field: UserFactField; value: string }
  | { commandId: string; kind: 'set_opportunity_preference'; opportunityId: string; roleType: OpportunityRole }
  | { commandId: string; kind: 'set_daily_capacity'; minutes: number }
  | { commandId: string; kind: 'set_date_capacity'; date: string; minutes: number }
  | { commandId: string; kind: 'set_work_windows'; windows: WorkWindow[] }
  | {
      commandId: string
      kind: 'upsert_reminder_intent'
      scheduleNodeId: string
      purpose: ReminderPurpose
      triggerAt?: string
      offsetMinutesBefore?: number
      deliveryOwner?: ReminderDeliveryOwner
      channel?: ReminderChannel
      capabilityStates?: Partial<Record<'chatgpt_tasks' | 'google_calendar', ExternalCapabilityState>>
    }
  | { commandId: string; kind: 'cancel_reminder_intent'; reminderIntentId: string }
  | {
      commandId: string
      kind: 'add_manual_action'
      title: string
      dueAt?: string
      duePrecision?: DatePrecision
      plannedDate?: string
      scheduledTemporal?: ScheduleNodeTemporal
      estimatedMinutes?: number
    }

export type UserDomainCommandResult =
  | {
      status: 'APPLIED'
      snapshot: PJSDASSnapshot
      summary: string
      compensation?: { operation: string; payload: unknown }
    }
  | {
      status: 'ALREADY_APPLIED'
      snapshot: PJSDASSnapshot
      summary: string
    }
  | {
      status: 'NEEDS_CONFIRMATION'
      snapshot: PJSDASSnapshot
      reason: string
      summary: string
    }

function validateActionPlan(command: { plannedDate?: string; scheduledTemporal?: ScheduleNodeTemporal }) {
  if (command.plannedDate && !validPlanningDate(command.plannedDate)) throw new Error('Plan day must be a valid local calendar date.')
  if (!command.scheduledTemporal) return
  if (!isExplicitActionArrangement(command.scheduledTemporal)) throw new Error('An Action arrangement requires an explicit user-chosen start time and timezone.')
  const errors = validateScheduleNode({ id: 'validation', occurrenceId: 'validation', version: 1, kind: 'follow_up',
    state: 'scheduled', temporal: command.scheduledTemporal, constraintKind: 'user_plan', evidenceRefs: [],
    sourceVersionRefs: [], relatedActionIds: [], relatedPrepIds: [], createdAt: '', updatedAt: '' })
  if (errors.length) throw new Error(errors[0])
  if (command.scheduledTemporal.timezone === 'floating-date' || command.plannedDate && command.plannedDate !== (command.scheduledTemporal ? actionArrangementDate(command.scheduledTemporal) : undefined)) throw new Error('The plan day must match the explicit arrangement timezone and date.')
}

function actionPlanFacts(command: Extract<UserDomainCommand, { kind: 'plan_application_action' | 'add_manual_action' }>) {
  return command.kind === 'plan_application_action'
    ? { kind: command.kind, opportunityId: command.opportunityId, plannedDate: command.plannedDate, scheduledTemporal: command.scheduledTemporal }
    : { kind: command.kind, title: command.title.trim(), dueAt: command.dueAt, duePrecision: command.duePrecision,
      plannedDate: command.plannedDate, scheduledTemporal: command.scheduledTemporal, estimatedMinutes: command.estimatedMinutes }
}

function stableHash(value: string) {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return (result >>> 0).toString(36)
}

function nowIso(now: Date) {
  if (Number.isNaN(now.getTime())) throw new Error('Invalid command clock.')
  return now.toISOString()
}

function assertIso(value: string, label: string) {
  if (Number.isNaN(new Date(value).getTime())) throw new Error(`${label} must be a valid date/time string.`)
}

function opportunity(next: PJSDASSnapshot, id: string) {
  return next.data.opportunities.find((item) => item.id === canonicalOpportunityId(next, id))
}

function action(next: PJSDASSnapshot, id: string) {
  return next.data.actions.find((item) => item.id === id)
}

function commandAlreadyApplied(snapshot: PJSDASSnapshot, commandId: string) {
  return (snapshot.data.timeline ?? []).some((item) => item.commandId === commandId)
}

function appendTimeline(next: PJSDASSnapshot, record: TimelineRecord, command: UserDomainCommand) {
  next.data.timeline = [...(next.data.timeline ?? []), {
    ...record,
    commandId: command.commandId,
    commandOperation: command.kind,
  }]
}

function commandTimeline(command: UserDomainCommand, now: string, input: {
  kind?: TimelineRecord['kind']
  category?: TimelineRecord['category']
  title: string
  detail?: string
  opportunity?: Opportunity
  action?: Action
  changes?: TimelineRecord['changes']
}): TimelineRecord {
  return {
    id: `timeline:command:${stableHash(command.commandId)}`,
    kind: input.kind ?? 'opportunity_updated',
    category: input.category ?? 'opportunity',
    source: 'user_action',
    occurredAt: now,
    recordedAt: now,
    title: input.title,
    detail: input.detail,
    opportunityId: input.opportunity?.id ?? input.action?.opportunityId,
    actionId: input.action?.id,
    company: input.opportunity?.company,
    role: input.opportunity?.role,
    changes: input.changes,
  }
}

function upsertProcess(next: PJSDASSnapshot, target: Opportunity, occurredAt: string) {
  const matches = next.data.processes.filter((item) => item.opportunityId === target.id)
  if (matches.length) {
    next.data.processes = next.data.processes.map((item) => item.opportunityId === target.id ? {
      ...item,
      company: target.company,
      role: target.role,
      stage: 'screening',
      stageLabel: '筛选中',
      progress: 'waiting_result',
      result: 'pending',
      participationState: 'active',
      lastProgressAt: occurredAt,
      effectiveProcessEventId: undefined,
      effectiveProcessEventAt: undefined,
      nextCheckAt: undefined,
      silenceRisk: undefined,
      currentAction: undefined,
      locallyManaged: true,
    } : item)
    return
  }
  const process: ProcessRecord = {
    id: `local-process:${target.id}`,
    opportunityId: target.id,
    company: target.company,
    role: target.role,
    stage: 'screening',
    stageLabel: '筛选中',
    progress: 'waiting_result',
    result: 'pending',
    participationState: 'active',
    lastProgressAt: occurredAt,
    locallyManaged: true,
  }
  next.data.processes.push(process)
}

function finalizeSnapshot(next: PJSDASSnapshot, timestamp: string) {
  ensureScheduleContractInPlace(next.data)
  next.exportedAt = timestamp
  validateSnapshot(next)
}

function upsertProcessAtEventStage(next: PJSDASSnapshot, target: Opportunity, event: ProcessEvent) {
  const stage = stageForProcessEvent(event.type)
  if (!stage) return
  const stageLabel = processEventStageLabel(event)
  target.processStage = stage
  target.currentStageLabel = stageLabel
  target.effectiveProcessEventId = event.id
  target.effectiveProcessEventAt = event.occurredAt
  target.locallyManaged = true
  const existing = next.data.processes.find((item) => item.opportunityId === target.id)
  if (existing) {
    existing.company = target.company
    existing.role = target.role
    existing.stage = stage
    existing.stageLabel = stageLabel
    existing.lastProgressAt = event.occurredAt
    existing.effectiveProcessEventId = event.id
    existing.effectiveProcessEventAt = event.occurredAt
    existing.locallyManaged = true
    return
  }
  next.data.processes.push({
    id: `local-process:${target.id}`,
    opportunityId: target.id,
    company: target.company,
    role: target.role,
    stage,
    stageLabel,
    lastProgressAt: event.occurredAt,
    effectiveProcessEventId: event.id,
    effectiveProcessEventAt: event.occurredAt,
    locallyManaged: true,
  })
}

function stageLabelFor(stage: ProcessRecord['stage']) {
  const labels: Record<ProcessRecord['stage'], string> = {
    unknown: '阶段待核实',
    not_applied: '待投',
    screening: '筛选中',
    assessment: '测评',
    written_test: '笔试',
    interview: '面试',
    offer: 'Offer',
    waiting_release: '待开放',
    closed: '流程结束',
  }
  return labels[stage]
}

function activeScheduleNode(next: PJSDASSnapshot, occurrenceId: string) {
  return latestScheduleOccurrence(next.data.scheduleNodes ?? [], occurrenceId)
}

// Only an explicit occurrence command may replace an ambiguous task-derived
// terminal state. Keep its original version and give the new fact its own ID.
function confirmationVersionId(node: ScheduleNode, previous: ScheduleNode, commandId: string) {
  node.id = `${node.id}:confirmation:${encodeURIComponent(commandId)}`
  previous.supersededByNodeId = node.id
}

function occurrenceOwnerStates(snapshot: PJSDASSnapshot, node: ScheduleNode) {
  return structuredClone({
    actions: snapshot.data.actions.filter(item => node.relatedActionIds.includes(item.id)),
    processEvents: snapshot.data.processEvents.filter(item => item.id === node.processEventId),
    opportunities: snapshot.data.opportunities.filter(item => node.kind === 'application_deadline' && item.id === node.opportunityId),
    processes: snapshot.data.processes.filter(item => item.id === node.processId || Boolean(node.opportunityId && item.opportunityId === node.opportunityId)),
  })
}

function occurrenceValueEqual(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

function occurrenceMatchesWithDerivedSources(snapshot: PJSDASSnapshot, current: ScheduleNode, expected: ScheduleNode,
  owners: ReturnType<typeof occurrenceOwnerStates>) {
  if (occurrenceValueEqual(current, expected)) return true
  if (!expected || !occurrenceValueEqual({ ...current, sourceVersionRefs: [] }, { ...expected, sourceVersionRefs: [] })) return false
  const retained = new Set(current.sourceVersionRefs)
  if (expected.sourceVersionRefs.some(ref => !retained.has(ref))) return false
  const added = current.sourceVersionRefs.filter(ref => !expected.sourceVersionRefs.includes(ref))
  if (!added.length) return false
  // A normal workspace read may already have added source-version provenance
  // for a descriptive edit. Do not admit structural owner changes or arbitrary
  // references under that exception.
  const structural = (value: object) => Object.fromEntries(Object.entries(value)
    .filter(([field]) => !['notes', 'updatedAt', 'title', 'sourceLabel'].includes(field)))
  for (const collection of ['actions', 'processEvents', 'opportunities', 'processes'] as const) {
    for (const owner of owners[collection]) {
      const actual = snapshot.data[collection].find(item => item.id === owner.id)
      if (!actual || !occurrenceValueEqual(structural(actual), structural(owner))) return false
    }
  }
  const derived = migrateLegacyScheduleNodes(snapshot.data).find(candidate => candidate.occurrenceId === current.occurrenceId
    && candidate.kind === current.kind && candidate.opportunityId === current.opportunityId
    && candidate.processEventId === current.processEventId && candidate.processId === current.processId)
  return Boolean(derived && added.every(ref => derived.sourceVersionRefs.includes(ref)))
}

function restoreOccurrenceOwnerStates(snapshot: PJSDASSnapshot, states: {
  before: ReturnType<typeof occurrenceOwnerStates>; after: ReturnType<typeof occurrenceOwnerStates>
}, apply = true) {
  const changes: Array<{ target: Record<string, unknown>; field: string; present: boolean; value: unknown }> = []
  for (const collection of ['actions', 'processEvents', 'opportunities', 'processes'] as const) {
    for (const before of states.before[collection]) {
      const after = states.after[collection].find(item => item.id === before.id)
      const current = snapshot.data[collection].find(item => item.id === before.id)
      if (!after || !current) throw new Error('Occurrence owner changed; Undo cannot restore safely.')
      const previous = before as unknown as Record<string, unknown>
      const expected = after as unknown as Record<string, unknown>
      const target = current as unknown as Record<string, unknown>
      for (const field of new Set([...Object.keys(previous), ...Object.keys(expected)])) {
        if (occurrenceValueEqual(previous[field], expected[field])) continue
        if (!occurrenceValueEqual(target[field], expected[field])) throw new Error('Occurrence-owned field changed; Undo cannot restore safely.')
        changes.push({ target, field, present: Object.hasOwn(previous, field), value: previous[field] })
      }
    }
  }
  // Validate every owned field first. Unrelated later fields remain untouched.
  for (const change of apply ? changes : []) {
    if (change.present) change.target[change.field] = structuredClone(change.value)
    else delete change.target[change.field]
  }
}

function restoreProcessSnapshots(next: PJSDASSnapshot, states: Array<{
  id: string
  stage: ProcessRecord['stage']
  stageLabel: string
  progress?: ProcessRecord['progress']
  result?: ProcessRecord['result']
  participationState?: ProcessRecord['participationState']
}>) {
  for (const state of states) {
    const process = next.data.processes.find((item) => item.id === state.id)
    if (!process) continue
    process.stage = state.stage
    process.stageLabel = state.stageLabel
    process.progress = state.progress
    process.result = state.result
    process.participationState = state.participationState
  }
}

function ensureUserFacts(target: Opportunity, timestamp: string) {
  const existing = target.detail?.userFacts
  target.detail = {
    ...target.detail,
    userFacts: {
      provenance: 'user_asserted',
      updatedAt: timestamp,
      ...existing,
    },
  }
  target.detail.userFacts!.updatedAt = timestamp
  return target.detail.userFacts!
}

export function applyUserDomainCommand(snapshot: PJSDASSnapshot, command: VerifiedDiscoveryCommand, now?: Date): ReturnType<typeof applyVerifiedDiscoveryCommand>
export function applyUserDomainCommand(snapshot: PJSDASSnapshot, command: VerifiedPostingRefreshCommand, now?: Date): ReturnType<typeof applyVerifiedPostingRefreshCommand>
export function applyUserDomainCommand(snapshot: PJSDASSnapshot, command: VerifiedOpportunityCommand, now?: Date): ReturnType<typeof applyVerifiedOpportunityCommand>
export function applyUserDomainCommand(snapshot: PJSDASSnapshot, command: UserDomainCommand, now?: Date): UserDomainCommandResult
export function applyUserDomainCommand(
  snapshot: PJSDASSnapshot,
  command: UserDomainCommand | VerifiedDiscoveryCommand | VerifiedOpportunityCommand | VerifiedPostingRefreshCommand,
  now = new Date(),
): UserDomainCommandResult {
  if (command.kind === 'ingest_verified_discovery') return applyVerifiedDiscoveryCommand(snapshot, command, now)
  if (command.kind === 'refresh_verified_discovery_posting') return applyVerifiedPostingRefreshCommand(snapshot, command, now)
  if (command.kind === 'save_verified_discovery_opportunity') return applyVerifiedOpportunityCommand(snapshot, command, now)
  if (!command.commandId.trim()) throw new Error('commandId is required.')
  if (commandAlreadyApplied(snapshot, command.commandId)) {
    if (command.kind === 'plan_application_action' || command.kind === 'add_manual_action') {
      const recorded = snapshot.data.timeline?.find(item => item.commandId === command.commandId)?.changes?.planFacts?.after
      if (typeof recorded !== 'string' || !occurrenceValueEqual(JSON.parse(recorded), actionPlanFacts(command))) throw new Error('Task plan command ID was reused with different facts or an unsupported legacy receipt.')
    }
    if (command.kind === 'add_user_opportunity') {
      const record = snapshot.data.timeline?.find(item => item.commandId === command.commandId)
      if (record?.changes?.jobFacts?.after !== JSON.stringify(normalizedUserJobFacts(command))) throw new Error('Job creation command ID was reused with different facts.')
    }
    if (command.kind === 'invalidate_process_event') {
      const event = snapshot.data.processEvents.find(item => item.id === command.eventId && item.opportunityId === canonicalOpportunityId(snapshot, command.opportunityId))
      const correction = event?.invalidation
      if (!correction || correction.commandId !== command.commandId || correction.sourceReceiptId !== command.receiptId || event?.updatedAt !== command.expectedEventUpdatedAt || correction.reason !== command.reason || JSON.stringify(correction.evidenceRefs) !== JSON.stringify(command.evidenceRefs)) throw new Error('Correction command ID was reused with a different payload.')
    }
    if (command.kind === 'correct_application_deadline') {
      const correction = snapshot.data.opportunities.find(item => item.id === canonicalOpportunityId(snapshot, command.opportunityId))?.detail?.deadlineCorrections?.find(item => item.commandId === command.commandId)
      if (!correction || Object.entries(command.correction).some(([key, value]) => correction[key as keyof typeof correction] !== value)) throw new Error('Correction command ID was reused with a different payload.')
    }
    return { status: 'ALREADY_APPLIED', snapshot, summary: `Command ${command.commandId} is already recorded.` }
  }

  const next = upgradeSnapshotToLatest(snapshot)
  const timestamp = nowIso(now)

  if (command.kind === 'add_user_opportunity') {
    const facts = normalizedUserJobFacts(command)
    const duplicate = findUserJobDuplicate(facts, next.data.opportunities)
    if (duplicate) return { status: 'ALREADY_APPLIED', snapshot,
      summary: `Job already saved: ${duplicate.company}｜${duplicate.role}.` }
    const target = appendOpportunityOnly(next.data, createUserOpportunity(facts, command.commandId, timestamp))
    appendTimeline(next, commandTimeline(command, timestamp, { kind: 'opportunity_added',
      title: `添加岗位｜${target.company}｜${target.role}`, opportunity: target,
      changes: { jobFacts: { before: null, after: JSON.stringify(facts) } } }), command)
    finalizeSnapshot(next, timestamp)
    return { status: 'APPLIED', snapshot: next, summary: `Saved job ${target.company}｜${target.role}.`,
      compensation: { operation: 'remove_created_opportunity', payload: { opportunityId: target.id,
        expected: structuredClone(target) } } }
  }

  if (command.kind === 'plan_application_action') {
    validateActionPlan(command)
    const plannedDate = command.plannedDate ?? (command.scheduledTemporal ? actionArrangementDate(command.scheduledTemporal) : undefined)
    const target = opportunity(next, command.opportunityId)
    if (!target || !['not_applied', 'waiting_release'].includes(target.processStage) || target.participationStatus === 'abandoned') {
      throw new Error('Choose an active unsubmitted job before planning an application.')
    }
    const previous = next.data.actions.find(item => item.kind === 'apply' && item.opportunityId === target.id)
    if (previous && ['todo', 'doing'].includes(previous.status) && previous.plannedDate === plannedDate
      && occurrenceValueEqual(previous.scheduledTemporal, command.scheduledTemporal)) return { status: 'ALREADY_APPLIED', snapshot, summary: 'Application task is already planned.' }
    const existingArrangement = previous ? latestScheduleOccurrence(next.data.scheduleNodes ?? [], `action:${previous.id}`) : undefined
    if (existingArrangement && !['cancelled', 'superseded'].includes(existingArrangement.state)
      && (!command.scheduledTemporal || existingArrangement.state === 'completed')) return {
      status: 'NEEDS_CONFIRMATION', snapshot, reason: 'EXISTING_ARRANGEMENT',
      summary: 'This task already has a precise or completed arrangement; update that occurrence explicitly before replacing its time.' }
    const before = previous ? structuredClone(previous) : undefined
    const beforeNodes = structuredClone(next.data.scheduleNodes?.filter(node => previous && node.relatedActionIds.includes(previous.id)) ?? [])
    const deadline = resolveApplicationDeadline(target, next.data)
    const planned: Action = { ...(previous ?? {}), timingContractVersion: 2, id: previous?.id ?? `apply:${target.id}`, kind: 'apply',
      title: previous?.title ?? `投递 ${target.company}｜${target.role}`, opportunityId: target.id, processStage: 'not_applied',
      plannedDate, scheduledTemporal: command.scheduledTemporal ? structuredClone(command.scheduledTemporal) : undefined,
      dueAt: deadline.deadline, duePrecision: deadline.precision, timingMode: deadline.deadline ? 'deadline' : undefined,
      estimatedMinutes: previous?.estimatedMinutes ?? 45, leverage: previous?.leverage ?? 0, delayCost: previous?.delayCost ?? 0,
      status: previous?.status === 'doing' ? 'doing' : 'todo', sourceLabel: '用户明确计划',
      createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp }
    if (previous) next.data.actions[next.data.actions.indexOf(previous)] = planned
    else next.data.actions.push(planned)
    if (existingArrangement && command.scheduledTemporal) {
      const candidate = scheduleNodeForAction(planned)!
      const { id: _id, version: _version, ...replacement } = candidate
      const updated = supersedeScheduleOccurrence(next.data.scheduleNodes!, replacement)
      confirmationVersionId(updated, existingArrangement, command.commandId)
    }
    appendTimeline(next, commandTimeline(command, timestamp, { kind: previous ? 'action_status_changed' : 'action_added', category: 'action',
      title: command.plannedDate ? '安排投递任务' : '创建投递任务', opportunity: target, action: planned,
      changes: { planFacts: { before: null, after: JSON.stringify(actionPlanFacts(command)) } } }), command)
    finalizeSnapshot(next, timestamp)
    return { status: 'APPLIED', snapshot: next, summary: 'Application task planned.',
      compensation: { operation: 'restore_action_plan', payload: { actionId: planned.id, previous: before,
        expected: structuredClone(planned), previousNodes: beforeNodes,
        expectedNodes: structuredClone(next.data.scheduleNodes?.filter(node => node.relatedActionIds.includes(planned.id)) ?? []) } } }
  }

  if (command.kind === 'set_daily_capacity' || command.kind === 'set_date_capacity' || command.kind === 'set_work_windows') {
    const before = next.data.timePlanning
    const current = before ?? { version: 1 as const, updatedAt: timestamp }
    const preferences = structuredClone(current)
    let compensation: { operation: string; payload: unknown }
    if (command.kind === 'set_daily_capacity') {
      if (!Number.isInteger(command.minutes) || command.minutes < 0 || command.minutes > 1440) throw new Error('Daily capacity must be 0–1440 minutes.')
      if (preferences.defaultDailyMinutes === command.minutes) return { status: 'ALREADY_APPLIED', snapshot, summary: 'Daily available time is already set.' }
      compensation = { operation: 'restore_daily_capacity', payload: { minutes: preferences.defaultDailyMinutes } }
      preferences.defaultDailyMinutes = command.minutes
    } else if (command.kind === 'set_date_capacity') {
      if (!validPlanningDate(command.date) || !Number.isInteger(command.minutes) || command.minutes < 0 || command.minutes > 1440) throw new Error('Invalid date capacity.')
      const prior = preferences.dateOverrides?.[command.date]
      if (prior === command.minutes) return { status: 'ALREADY_APPLIED', snapshot, summary: 'Available time for this day is already set.' }
      compensation = { operation: 'restore_date_capacity', payload: { date: command.date, minutes: prior } }
      preferences.dateOverrides = { ...preferences.dateOverrides, [command.date]: command.minutes }
    } else {
      const prior = preferences.weeklyWindows
      if (JSON.stringify(prior ?? []) === JSON.stringify(command.windows)) return { status: 'ALREADY_APPLIED', snapshot, summary: 'Work windows are already set.' }
      compensation = { operation: 'restore_work_windows', payload: { windows: prior } }
      preferences.weeklyWindows = structuredClone(command.windows)
    }
    preferences.updatedAt = timestamp
    const errors = validateTimePlanningPreferences(preferences)
    if (errors.length) throw new Error(errors[0])
    next.data.timePlanning = preferences
    appendTimeline(next, commandTimeline(command, timestamp, { kind: 'time_preferences_changed', category: 'rules',
      title: '更新可用时间', detail: command.kind }), command)
    finalizeSnapshot(next, timestamp)
    return { status: 'APPLIED', snapshot: next, summary: 'Available time updated.', compensation }
  }

  if (command.kind === 'record_application_submission') {
    const beforeData = structuredClone(next.data)
    const target = opportunity(next, command.opportunityId)
    if (!target) throw new Error(`Opportunity ${command.opportunityId} was not found.`)
    if (target.participationStatus === 'abandoned' && !command.reactivateConfirmed) {
      return {
        status: 'NEEDS_CONFIRMATION',
        snapshot,
        reason: 'TARGET_ABANDONED',
        summary: 'This opportunity is marked abandoned; confirm whether it should be reactivated before recording an application.',
      }
    }
    const occurredAt = command.occurredAt ?? timestamp
    assertIso(occurredAt, 'occurredAt')
    const beforeStage = target.processStage
    const priorSubmissionCommandIds = Object.entries(target.applicationSubmissionProofs ?? {}).filter(([, state]) => state === 'active').map(([id]) => id)
    target.applicationSubmissionProofs = { ...target.applicationSubmissionProofs, [command.commandId]: 'active' }
    target.participationStatus = 'active'
    target.abandonedAt = undefined
    target.processStage = 'screening'
    target.currentStageLabel = '筛选中'
    target.effectiveProcessEventId = undefined
    target.effectiveProcessEventAt = undefined
    target.locallyManaged = true
    const apply = next.data.actions.find((item) => item.id === `apply:${target.id}`)
    const beforeApplyStatus = apply?.status
    if (apply && (apply.status === 'todo' || apply.status === 'doing')) {
      apply.status = 'done'
      apply.updatedAt = occurredAt
      syncScheduleNodeForActionStatus(next.data, apply.id, 'done', occurredAt)
    }
    upsertProcess(next, target, occurredAt)
    appendTimeline(next, { ...commandTimeline(command, occurredAt, {
      kind: 'application_submitted',
      title: '完成投递',
      opportunity: target,
      changes: { stage: { before: beforeStage, after: 'screening' } },
    }), recordedAt: timestamp }, command)
    finalizeSnapshot(next, timestamp)
    return {
      status: 'APPLIED',
      snapshot: next,
      summary: `Recorded application submission for ${target.company}｜${target.role}.`,
      compensation: {
        operation: 'restore_application_submission',
        payload: {
          opportunityId: target.id,
          submissionCommandId: command.commandId,
          priorSubmissionCommandIds,
          priorProcessEventIds: beforeData.processEvents.filter(event => event.opportunityId === target.id && !event.invalidation).map(event => event.id),
          processStage: beforeStage,
          actionId: apply?.id,
          actionStatus: beforeApplyStatus,
          undo: apply ? captureActionStatusUndo(beforeData, next.data, [apply.id]) : undefined,
        },
      },
    }
  }

  if (command.kind === 'invalidate_process_event') {
    invalidateProcessFact(next, command, timestamp)
    const target = opportunity(next, command.opportunityId)!
    appendTimeline(next, commandTimeline(command, timestamp, { kind: 'opportunity_updated', category: 'process',
      title: '更正流程事实', detail: command.reason, opportunity: target,
      changes: { invalidatedProcessEvent: { before: command.eventId, after: 'invalidated' } } }), command)
    finalizeSnapshot(next, timestamp)
    return { status: 'APPLIED', snapshot: next, summary: 'Invalidated the exact source fact; original evidence and later independent progress were retained.' }
  }

  if (command.kind === 'record_process_event') {
    const beforeProjection = structuredClone(next)
    const target = opportunity(next, command.opportunityId)
    if (!target) throw new Error(`Opportunity ${command.opportunityId} was not found.`)
    const occurredAt = command.occurredAt ?? timestamp
    assertIso(occurredAt, 'occurredAt')
    const effectiveDueAt = command.temporal?.shape === 'availability_window' ? command.temporal.endAt : command.temporal?.startAt ?? command.temporal?.deadlineAt ?? command.temporal?.date ?? command.dueAt
    if (command.temporal && !['assessment_invite', 'written_test_invite', 'interview_invite'].includes(command.eventType)) throw new Error('Explicit process temporal requires a schedule-bearing event.')
    if (effectiveDueAt) assertIso(effectiveDueAt, 'dueAt')
    if (command.temporal) {
      const errors = validateScheduleNode({ id: 'validation', occurrenceId: 'validation', version: 1, kind: 'interview', state: 'scheduled', temporal: command.temporal, constraintKind: 'employer_hard', evidenceRefs: [], sourceVersionRefs: [], relatedActionIds: [], relatedPrepIds: [], createdAt: timestamp, updatedAt: timestamp })
      if (errors.length) throw new Error(errors[0])
    }
    if (command.location && command.location.length > 200) throw new Error('Location exceeds the bounded field length.')
    if (command.joinUrl) {
      const url = new URL(command.joinUrl)
      if (url.protocol !== 'https:' || url.username || url.password || command.joinUrl.length > 500) throw new Error('Join URL must be a bounded HTTPS reference.')
    }
    const eventId = `user-event:${stableHash(command.commandId)}`
    const event: ProcessEvent = {
      id: eventId,
      opportunityId: target.id,
      company: target.company,
      role: target.role,
      type: command.eventType,
      sourceOccurrenceId: command.sourceOccurrenceId,
      temporal: command.temporal ? structuredClone(command.temporal) : undefined,
      occurredAt,
      dueAt: effectiveDueAt,
      duePrecision: command.temporal?.precision ?? command.duePrecision,
      timingMode: command.temporal?.shape === 'deadline' || command.temporal?.shape === 'availability_window' ? 'deadline' : command.timingMode ?? defaultTimingModeForProcessEvent(command.eventType),
      estimatedMinutes: command.estimatedMinutes ?? defaultMinutesForProcessEvent(command.eventType),
      location: command.location?.trim() || undefined,
      joinUrl: command.joinUrl?.trim() || undefined,
      notes: [command.notes?.trim(), command.location ? `地点：${command.location}` : undefined,
        command.joinUrl ? `邮件链接（未验证）：${command.joinUrl}` : undefined].filter(Boolean).join('；') || undefined,
      source: command.source ?? 'manual',
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    next.data.processEvents.push(event)
    const generated = actionForProcessEvent(event)
    if (generated) next.data.actions.push(generated)
    upsertProcessAtEventStage(next, target, event)
    appendTimeline(next, {
      ...timelineFromProcessEvent(event, 'user_action', timestamp),
      id: `timeline:command:${stableHash(command.commandId)}`,
    }, command)
    finalizeSnapshot(next, timestamp)
    return {
      status: 'APPLIED',
      snapshot: next,
      summary: `Recorded ${command.eventType} for ${target.company}｜${target.role}.`,
      compensation: { operation: 'delete_process_event', payload: { eventId, projectionUndo: captureProcessProjectionUndo(beforeProjection, next, target.id) } },
    }
  }

  if (command.kind === 'complete_occurrence' || command.kind === 'cancel_occurrence') {
    const cancelled = command.kind === 'cancel_occurrence'
    let node = activeScheduleNode(next, command.occurrenceId)
    if (!node) throw new Error(`Schedule occurrence ${command.occurrenceId} was not found.`)
    if (node.kind === 'application_deadline') throw new Error('A job deadline is not a calendar occurrence; use the job fact or explicit submission command.')
    const confirmsTaskObservation = recruitingOccurrenceNeedsConfirmation(node, indexScheduleOccurrenceEvidence(next.data.timeline ?? []), now)
    if (!confirmsTaskObservation && node.state === (cancelled ? 'cancelled' : 'completed')) {
      return { status: 'ALREADY_APPLIED', snapshot, summary: `Schedule occurrence ${command.occurrenceId} is already ${cancelled ? 'cancelled' : 'completed'}.` }
    }
    if (!confirmsTaskObservation && (node.state === 'cancelled' || node.state === 'completed' || node.state === 'superseded')) {
      return {
        status: 'NEEDS_CONFIRMATION',
        snapshot,
        reason: 'OCCURRENCE_NOT_ACTIVE',
        summary: 'This schedule occurrence is no longer active; confirm the intended occurrence before completing it.',
      }
    }
    const occurredAt = command.occurredAt ?? timestamp
    assertIso(occurredAt, 'occurredAt')
    const beforeNode = structuredClone(node)
    const ownerStates = confirmsTaskObservation ? occurrenceOwnerStates(next, node) : undefined
    const actionStates = node.relatedActionIds.flatMap((id) => {
      const item = next.data.actions.find((action) => action.id === id)
      return item ? [{ id: item.id, status: item.status, updatedAt: item.updatedAt }] : []
    })
    const affectedProcesses = next.data.processes.filter((process) =>
      (node.processId && process.id === node.processId)
      || (node.opportunityId && process.opportunityId === node.opportunityId),
    )
    const processStates = affectedProcesses.map((process) => ({
      id: process.id,
      stage: process.stage,
      stageLabel: process.stageLabel,
      progress: process.progress,
      result: process.result,
      participationState: process.participationState,
    }))

    if (confirmsTaskObservation) {
      const previous = node
      const { id: _id, version: _version, supersedesNodeId: _supersedes, supersededByNodeId: _supersededBy, ...replacement } = structuredClone(node)
      node = supersedeScheduleOccurrence(next.data.scheduleNodes ?? [], { ...replacement, updatedAt: timestamp })
      confirmationVersionId(node, previous, command.commandId)
    }
    node.state = cancelled ? 'cancelled' : 'completed'
    node.completedAt = cancelled ? undefined : occurredAt
    if (confirmsTaskObservation) node.cancelledAt = cancelled ? occurredAt : undefined
    node.updatedAt = occurredAt
    for (const actionId of node.relatedActionIds) {
      const item = next.data.actions.find((action) => action.id === actionId)
      if (!item || item.status === 'done') continue
      item.status = cancelled ? 'skipped' : 'done'
      item.updatedAt = occurredAt
    }
    for (const process of affectedProcesses) {
      if (!cancelled && (node.kind === 'assessment' || node.kind === 'written_test' || node.kind === 'interview')) {
        process.progress = 'waiting_result'
        process.result ??= 'pending'
        process.currentAction = undefined
        process.lastProgressAt = occurredAt
      }
    }
    projectScheduleNodesToLegacyInPlace(next.data)
    appendTimeline(next, {
      id: `timeline:command:${stableHash(command.commandId)}`,
      kind: 'semantic_intake_applied',
      category: 'process',
      source: 'user_action',
      occurredAt,
      recordedAt: timestamp,
      title: cancelled ? '取消招聘节点' : '完成招聘节点',
      detail: `${node.kind} · ${node.occurrenceId}`,
      opportunityId: node.opportunityId,
      scheduleNodeId: node.id,
    }, command)
    finalizeSnapshot(next, timestamp)
    return {
      status: 'APPLIED',
      snapshot: next,
      summary: `${cancelled ? 'Cancelled' : 'Completed'} schedule occurrence ${node.occurrenceId}.`,
      compensation: confirmsTaskObservation ? {
        operation: 'restore_occurrence_supersession',
        payload: { previousNode: beforeNode, newNodeId: node.id, expectedNode: structuredClone(node),
          ownerStates: { before: ownerStates!, after: occurrenceOwnerStates(next, node) } },
      } : {
        operation: 'restore_occurrence_completion',
        payload: {
          occurrenceId: node.occurrenceId,
          node: beforeNode,
          actionStates,
          processStates,
        },
      },
    }
  }

  if (command.kind === 'reschedule_occurrence') {
    const current = activeScheduleNode(next, command.occurrenceId)
    if (!current) throw new Error(`Schedule occurrence ${command.occurrenceId} was not found.`)
    if (current.kind === 'application_deadline') throw new Error('A job deadline is not a calendar occurrence; update its deadline fact instead.')
    if (current.constraintKind === 'user_plan' && !['interview', 'written_test', 'assessment'].includes(current.kind) && !isExplicitActionArrangement(command.temporal)) throw new Error('A timed Action reschedule requires an explicit start; a day-only plan cannot replace its arrangement.')
    const confirmsTaskObservation = recruitingOccurrenceNeedsConfirmation(current, indexScheduleOccurrenceEvidence(next.data.timeline ?? []), now)
    if (!confirmsTaskObservation && (current.state === 'completed' || current.state === 'cancelled' || current.state === 'superseded')) {
      return {
        status: 'NEEDS_CONFIRMATION',
        snapshot,
        reason: 'OCCURRENCE_NOT_ACTIVE',
        summary: 'This occurrence is already completed or cancelled; confirm before creating another occurrence.',
      }
    }
    const previousNode = structuredClone(current)
    const ownerStates = occurrenceOwnerStates(next, current)
    const affectedProcesses = next.data.processes.filter((process) =>
      (current.processId && process.id === current.processId)
      || (current.opportunityId && process.opportunityId === current.opportunityId),
    )
    const processStates = affectedProcesses.map((process) => ({
      id: process.id,
      stage: process.stage,
      stageLabel: process.stageLabel,
      progress: process.progress,
      result: process.result,
      participationState: process.participationState,
    }))
    const replacement = supersedeScheduleOccurrence(next.data.scheduleNodes ?? [], {
      occurrenceId: current.occurrenceId,
      opportunityId: current.opportunityId,
      processId: current.processId,
      processEventId: current.processEventId,
      kind: current.kind,
      state: 'scheduled',
      temporal: structuredClone(command.temporal),
      constraintKind: current.constraintKind,
      estimatedMinutes: current.estimatedMinutes,
      estimateProvenance: current.estimateProvenance,
      evidenceRefs: [...new Set([...current.evidenceRefs, ...(command.evidenceRefs ?? [])])],
      sourceVersionRefs: [...new Set([...current.sourceVersionRefs, ...(command.sourceVersionRefs ?? [])])],
      relatedActionIds: [...current.relatedActionIds],
      relatedPrepIds: [...current.relatedPrepIds],
      completedAt: undefined,
      cancelledAt: undefined,
      createdAt: current.createdAt,
      updatedAt: timestamp,
    })
    if (confirmsTaskObservation) confirmationVersionId(replacement, current, command.commandId)
    for (const process of affectedProcesses) {
      process.progress = 'scheduled'
      process.currentAction = process.currentAction
      process.lastProgressAt = timestamp
    }
    projectScheduleNodesToLegacyInPlace(next.data)
    appendTimeline(next, {
      id: `timeline:command:${stableHash(command.commandId)}`,
      kind: 'semantic_intake_applied',
      category: 'process',
      source: 'user_action',
      occurredAt: timestamp,
      recordedAt: timestamp,
      title: '更新招聘节点时间',
      detail: `${replacement.kind} · ${replacement.occurrenceId}`,
      opportunityId: replacement.opportunityId,
      scheduleNodeId: replacement.id,
    }, command)
    finalizeSnapshot(next, timestamp)
    return {
      status: 'APPLIED',
      snapshot: next,
      summary: `Rescheduled occurrence ${replacement.occurrenceId}.`,
      compensation: {
        operation: 'restore_occurrence_supersession',
        payload: {
          previousNode,
          newNodeId: replacement.id,
          processStates,
          ...(ownerStates ? { expectedNode: structuredClone(replacement), ownerStates: { before: ownerStates, after: occurrenceOwnerStates(next, replacement) } } : {}),
        },
      },
    }
  }

  if (command.kind === 'correct_application_deadline') {
    const correction = correctApplicationDeadline(next, command, timestamp, snapshot)
    const target = opportunity(next, command.opportunityId)!
    appendTimeline(next, commandTimeline(command, timestamp, { title: '核实投递截止时间', detail: correction.evidence, opportunity: target,
      changes: { deadline: { before: correction.previousDeadline ?? null, after: target.deadline ?? null }, sourceUrl: { before: null, after: correction.sourceUrl ?? null } } }), command)
    finalizeSnapshot(next, timestamp)
    return { status: 'APPLIED', snapshot: next, summary: correction.state === 'confirmed' ? 'Confirmed the application deadline fact.' : 'Cleared the unverified deadline; retained source history without creating a reminder date.' }
  }

  if (command.kind === 'set_deadline') {
    const target = opportunity(next, command.opportunityId)
    if (!target) throw new Error(`Opportunity ${command.opportunityId} was not found.`)
    assertIso(command.deadline, 'deadline')
    const previousDeadlineNodes = structuredClone(applicationDeadlineNodes(next.data, target.id))
    const before = { deadlineCorrections: structuredClone(target.detail?.deadlineCorrections), deadline: target.deadline, deadlinePrecision: target.deadlinePrecision, userFactsDeadline: target.detail?.userFacts?.deadline, userFactsDeadlinePrecision: target.detail?.userFacts?.deadlinePrecision }
    target.deadline = command.deadline
    target.deadlinePrecision = command.precision
    const userFacts = ensureUserFacts(target, timestamp)
    userFacts.deadline = command.deadline
    userFacts.deadlinePrecision = command.precision
    const apply = next.data.actions.find((item) => item.id === `apply:${target.id}`)
    if (apply && (apply.status === 'todo' || apply.status === 'doing')) {
      apply.dueAt = command.deadline
      apply.duePrecision = command.precision
      apply.timingMode = 'deadline'
      apply.updatedAt = timestamp
    }
    setApplicationDeadlineScheduleNode(next.data, target.id, command.deadline, command.precision, timestamp, command.commandId)
    appendTimeline(next, commandTimeline(command, timestamp, {
      title: '更新投递截止时间',
      opportunity: target,
      changes: { deadline: { before: before.deadline ?? null, after: command.deadline } },
    }), command)
    finalizeSnapshot(next, timestamp)
    return {
      status: 'APPLIED',
      snapshot: next,
      summary: `Updated deadline for ${target.company}｜${target.role}.`,
      compensation: { operation: 'restore_deadline', payload: { opportunityId: target.id, ...before, previousDeadlineNodes, factOnly: true, expectedDeadlineFingerprint: applicationDeadlineFingerprint(target, next.data), expectedDeadlineState: { deadline: command.deadline, correctionId: target.detail?.deadlineCorrections?.at(-1)?.commandId ?? null } } },
    }
  }

  if (command.kind === 'set_action_status') {
    const target = action(next, command.actionId)
    if (!target) throw new Error(`Action ${command.actionId} was not found.`)
    const before = target.status
    const beforeData = structuredClone(next.data)
    if (before === command.status) {
      return { status: 'ALREADY_APPLIED', snapshot, summary: `Action ${target.title} is already ${command.status}.` }
    }
    target.status = command.status
    target.updatedAt = timestamp
    syncScheduleNodeForActionStatus(next.data, target.id, command.status, timestamp)
    appendTimeline(next, {
      ...timelineFromActionStatus(target, before, command.status, timestamp),
      id: `timeline:command:${stableHash(command.commandId)}`,
    }, command)
    finalizeSnapshot(next, timestamp)
    return {
      status: 'APPLIED',
      snapshot: next,
      summary: `Updated action ${target.title} to ${command.status}.`,
      compensation: { operation: 'set_action_status', payload: { actionId: target.id, status: before,
        undo: captureActionStatusUndo(beforeData, next.data, [target.id]) } },
    }
  }

  if (command.kind === 'upsert_reminder_intent') {
    const node = (next.data.scheduleNodes ?? []).find((item) => item.id === command.scheduleNodeId)
    if (!node) throw new Error(`ScheduleNode ${command.scheduleNodeId} was not found.`)
    if (['completed', 'cancelled', 'superseded'].includes(node.state)) {
      return {
        status: 'NEEDS_CONFIRMATION',
        snapshot,
        reason: 'REMINDER_TARGET_INACTIVE',
        summary: 'The reminder target is no longer an active schedule node.',
      }
    }
    const triggerAt = resolveReminderTrigger(node, {
      triggerAt: command.triggerAt,
      offsetMinutesBefore: command.offsetMinutesBefore,
      purpose: command.purpose,
    })
    const dedupeKey = reminderDedupeKey(node, command.purpose)
    const previous = next.data.reminderIntents?.find((item) => item.dedupeKey === dedupeKey)
    const previousReminder = previous ? structuredClone(previous) : undefined
    const previousOutbox = (next.data.reminderOutbox ?? [])
      .filter((item) => item.reminderIntentId === previous?.id)
      .map((item) => structuredClone(item))
    const built = buildReminderIntent({
      node,
      purpose: command.purpose,
      triggerAt,
      deliveryOwner: command.deliveryOwner,
      channel: command.channel,
      capabilityStates: command.capabilityStates,
      existing: previous,
      now: timestamp,
    })
    if (previous
      && previous.triggerAt === built.reminder.triggerAt
      && previous.deliveryOwner === built.reminder.deliveryOwner
      && previous.channel === built.reminder.channel
      && previous.state === built.reminder.state
      && previous.capability === built.reminder.capability) {
      return { status: 'ALREADY_APPLIED', snapshot, summary: 'The same reminder intent is already recorded.' }
    }
    next.data.reminderIntents = [
      ...(next.data.reminderIntents ?? []).filter((item) => item.id !== built.reminder.id),
      built.reminder,
    ]
    next.data.reminderOutbox = (next.data.reminderOutbox ?? []).filter((item) => item.reminderIntentId !== built.reminder.id)
    if (built.outbox) next.data.reminderOutbox.push(built.outbox)
    appendTimeline(next, {
      id: `timeline:command:${stableHash(command.commandId)}`,
      kind: 'semantic_intake_applied',
      category: 'action',
      source: 'user_action',
      occurredAt: timestamp,
      recordedAt: timestamp,
      title: built.reminder.state === 'unsupported' ? '提醒已记录，但外部渠道不可用' : '提醒已记录',
      detail: `${built.reminder.purpose} · ${built.reminder.triggerAt} · owner=${built.reminder.deliveryOwner}`,
      opportunityId: node.opportunityId,
      scheduleNodeId: node.id,
      reminderIntentId: built.reminder.id,
    }, command)
    finalizeSnapshot(next, timestamp)
    return {
      status: 'APPLIED',
      snapshot: next,
      summary: built.reminder.state === 'unsupported'
        ? `Reminder intent recorded, but ${built.reminder.capability} is not currently available to TodayAction.`
        : 'Reminder intent recorded with one delivery owner.',
      compensation: {
        operation: 'restore_reminder_intent',
        payload: { reminderIntentId: built.reminder.id, previousReminder, previousOutbox },
      },
    }
  }

  if (command.kind === 'cancel_reminder_intent') {
    const target = next.data.reminderIntents?.find((item) => item.id === command.reminderIntentId)
    if (!target) throw new Error(`ReminderIntent ${command.reminderIntentId} was not found.`)
    if (target.state === 'cancelled') {
      return { status: 'ALREADY_APPLIED', snapshot, summary: 'The reminder intent is already cancelled.' }
    }
    const previousReminder = structuredClone(target)
    const previousOutbox = (next.data.reminderOutbox ?? [])
      .filter((item) => item.reminderIntentId === target.id)
      .map((item) => structuredClone(item))
    cancelReminderIntentInPlace(next.data, target, timestamp)
    appendTimeline(next, {
      id: `timeline:command:${stableHash(command.commandId)}`,
      kind: 'semantic_intake_applied',
      category: 'action',
      source: 'user_action',
      occurredAt: timestamp,
      recordedAt: timestamp,
      title: '提醒已取消',
      detail: target.purpose,
      scheduleNodeId: target.scheduleNodeId,
      reminderIntentId: target.id,
    }, command)
    finalizeSnapshot(next, timestamp)
    return {
      status: 'APPLIED',
      snapshot: next,
      summary: 'Reminder intent cancelled; this does not complete or cancel the recruiting schedule node.',
      compensation: {
        operation: 'restore_reminder_intent',
        payload: { reminderIntentId: target.id, previousReminder, previousOutbox },
      },
    }
  }

  if (command.kind === 'abandon_opportunity') {
    const target = opportunity(next, command.opportunityId)
    if (!target) throw new Error(`Opportunity ${command.opportunityId} was not found.`)
    if (target.participationStatus === 'abandoned') {
      return { status: 'ALREADY_APPLIED', snapshot, summary: `${target.company}｜${target.role} is already marked abandoned.` }
    }
    const occurredAt = command.occurredAt ?? timestamp
    assertIso(occurredAt, 'occurredAt')
    const before = target.participationStatus ?? 'active'
    target.participationStatus = 'abandoned'
    target.abandonedAt = occurredAt
    const actionStates = next.data.actions
      .filter((item) => item.opportunityId === target.id && (item.status === 'todo' || item.status === 'doing'))
      .map((item) => ({ actionId: item.id, status: item.status }))
    for (const item of next.data.actions) {
      if (item.opportunityId === target.id && (item.status === 'todo' || item.status === 'doing')) {
        item.status = 'skipped'
        item.updatedAt = occurredAt
      }
    }
    appendTimeline(next, { ...commandTimeline(command, occurredAt, {
      title: '放弃岗位',
      opportunity: target,
      detail: '这是用户参与决定，不改变招聘方流程事实，也不删除历史。',
      changes: { participationStatus: { before, after: 'abandoned' } },
    }), recordedAt: timestamp }, command)
    finalizeSnapshot(next, timestamp)
    return {
      status: 'APPLIED',
      snapshot: next,
      summary: `Marked ${target.company}｜${target.role} as abandoned without closing the recruiting process.`,
      compensation: {
        operation: 'restore_participation',
        payload: { opportunityId: target.id, participationStatus: before, actionStates },
      },
    }
  }

  if (command.kind === 'correct_opportunity_fact') {
    const target = opportunity(next, command.opportunityId)
    if (!target) throw new Error(`Opportunity ${command.opportunityId} was not found.`)
    const value = command.value.trim()
    if (!value) throw new Error('Corrected fact value must not be empty.')
    const userFacts = ensureUserFacts(target, timestamp)
    const before = userFacts[command.field]
    userFacts[command.field] = value
    appendTimeline(next, commandTimeline(command, timestamp, {
      title: '修正用户确认事实',
      opportunity: target,
      detail: `${command.field}: ${value}`,
      changes: { [`userFacts.${command.field}`]: { before: before ?? null, after: value } },
    }), command)
    finalizeSnapshot(next, timestamp)
    return {
      status: 'APPLIED',
      snapshot: next,
      summary: `Updated user-asserted ${command.field} for ${target.company}｜${target.role}.`,
      compensation: { operation: 'restore_user_fact', payload: { opportunityId: target.id, field: command.field, value: before ?? null } },
    }
  }

  if (command.kind === 'set_opportunity_preference') {
    const target = opportunity(next, command.opportunityId)
    if (!target) throw new Error(`Opportunity ${command.opportunityId} was not found.`)
    const before = target.roleType
    if (before === command.roleType) {
      return { status: 'ALREADY_APPLIED', snapshot, summary: `${target.company}｜${target.role} is already classified as ${command.roleType}.` }
    }
    target.roleType = command.roleType
    appendTimeline(next, commandTimeline(command, timestamp, {
      title: '修改岗位级偏好',
      opportunity: target,
      changes: { roleType: { before, after: command.roleType } },
    }), command)
    finalizeSnapshot(next, timestamp)
    return {
      status: 'APPLIED',
      snapshot: next,
      summary: `Classified ${target.company}｜${target.role} as ${command.roleType}.`,
      compensation: { operation: 'set_opportunity_preference', payload: { opportunityId: target.id, roleType: before } },
    }
  }

  validateActionPlan(command)
  const title = command.title.trim()
  if (!title) throw new Error('Action title must not be empty.')
  if (command.dueAt) assertIso(command.dueAt, 'dueAt')
  const actionId = `user-action:${stableHash(command.commandId)}`
  const created: Action = {
    timingContractVersion: 2,
    id: actionId,
    kind: 'manual',
    title,
    plannedDate: command.plannedDate ?? (command.scheduledTemporal ? actionArrangementDate(command.scheduledTemporal) : undefined),
    scheduledTemporal: command.scheduledTemporal ? structuredClone(command.scheduledTemporal) : undefined,
    dueAt: command.dueAt,
    duePrecision: command.duePrecision,
    timingMode: command.dueAt ? 'deadline' : undefined,
    estimatedMinutes: Math.max(5, Math.min(720, Math.round(command.estimatedMinutes ?? 30))),
    leverage: 0,
    delayCost: 0,
    status: 'todo',
    sourceLabel: '用户明确命令',
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  next.data.actions.push(created)
  appendTimeline(next, commandTimeline(command, timestamp, {
    kind: 'action_added',
    category: 'action',
    title: `新增行动｜${title}`,
    action: created,
    changes: { planFacts: { before: null, after: JSON.stringify(actionPlanFacts(command)) } },
  }), command)
  finalizeSnapshot(next, timestamp)
  return {
    status: 'APPLIED',
    snapshot: next,
    summary: `Added action ${title}.`,
    compensation: { operation: 'restore_action_plan', payload: { actionId, previous: undefined, expected: structuredClone(created), previousNodes: [], expectedNodes: structuredClone(next.data.scheduleNodes?.filter(node => node.relatedActionIds.includes(actionId)) ?? []) } },
  }
}

export interface DomainCompensation {
  operation: string
  payload: any
}

/** Bind old receipts only when the original trusted command owns an exact fact. */
export function bindLegacyApplicationSubmissionUndo(compensation: DomainCompensation, commandId: string, timeline: readonly TimelineRecord[]): DomainCompensation {
  if (compensation.operation !== 'restore_application_submission' || compensation.payload.submissionCommandId) return compensation
  const proof = timeline.find(record => record.kind === 'application_submitted' && record.commandOperation === 'record_application_submission'
    && record.commandId === commandId && record.opportunityId === compensation.payload.opportunityId)
  if (!proof) throw new Error('Legacy submission Undo lacks exact fact ownership; no history was changed.')
  return { ...compensation, payload: { ...compensation.payload, submissionCommandId: commandId, legacySubmissionTimelineId: proof.id } }
}

function assertCreatedOpportunityUndoSafe(snapshot: PJSDASSnapshot, opportunityId: string, expected: unknown, allowedInboxId?: string) {
  const target = snapshot.data.opportunities.find(item => item.id === opportunityId)
  if (!target || !expected || !occurrenceValueEqual(target, expected)
    || snapshot.data.actions.some(item => item.opportunityId === target.id)
    || snapshot.data.processes.some(item => item.opportunityId === target.id)
    || snapshot.data.processEvents.some(item => item.opportunityId === target.id)
    || snapshot.data.scheduleNodes?.some(item => item.opportunityId === target.id)
    || snapshot.data.opportunityAliases?.some(item => item.id === target.id || item.canonicalOpportunityId === target.id)
    || snapshot.data.discoveryInbox?.some(item => item.id !== allowedInboxId && item.promotedOpportunityId === target.id)) {
    throw new Error('The saved job has later changes or related facts; Undo cannot remove it safely.')
  }
  return target
}

export function applyDomainCompensation(
  snapshot: PJSDASSnapshot,
  compensation: DomainCompensation,
  now = new Date(),
): PJSDASSnapshot {
  if (compensation.operation === 'restore_application_submission') {
    const target = snapshot.data.opportunities.find(item => item.id === compensation.payload.opportunityId)
    const commandId = compensation.payload.submissionCommandId
    if (!target || typeof commandId !== 'string' || !commandId.trim()) throw new Error('Legacy submission Undo lacks exact fact ownership; no history was changed.')
    const state = target.applicationSubmissionProofs?.[commandId]
    if (state === 'withdrawn') return snapshot
    if (state !== 'active' && !compensation.payload.legacySubmissionTimelineId) throw new Error('Submission proof changed; Undo cannot replace another fact.')
  }
  if (compensation.operation === 'restore_action_plan') {
    const payload = compensation.payload
    const current = snapshot.data.actions.find(item => item.id === payload.actionId)
    const nodes = snapshot.data.scheduleNodes?.filter(node => node.relatedActionIds.includes(payload.actionId)) ?? []
    if (!current || !occurrenceValueEqual(current, payload.expected) || !occurrenceValueEqual(nodes, payload.expectedNodes)) throw new Error('The task plan changed; Undo cannot overwrite it.')
  }
  if (compensation.operation === 'restore_occurrence_supersession' && compensation.payload?.ownerStates) {
    // Inspect the supplied rows before legacy projection could normalize a
    // conflicting date or add provenance from an unrelated source-note edit.
    const payload = compensation.payload
    const current = latestScheduleOccurrence(snapshot.data.scheduleNodes ?? [], payload.previousNode?.occurrenceId)
    if (!current || current.id !== payload.newNodeId
      || !occurrenceMatchesWithDerivedSources(snapshot, current, payload.expectedNode, payload.ownerStates.after)) {
      throw new Error('Confirmed occurrence changed; Undo cannot restore safely.')
    }
    restoreOccurrenceOwnerStates(snapshot, compensation.payload.ownerStates, false)
  }
  const next = upgradeSnapshotToLatest(snapshot)
  const timestamp = nowIso(now)
  const payload = compensation.payload ?? {}

  if (compensation.operation === 'restore_action_plan') {
    const current = next.data.actions.find(item => item.id === payload.actionId)
    const currentNodes = next.data.scheduleNodes?.filter(node => node.relatedActionIds.includes(payload.actionId)) ?? []
    if (!current || !occurrenceValueEqual(current, payload.expected) || !occurrenceValueEqual(currentNodes, payload.expectedNodes)) throw new Error('The task plan changed; Undo cannot overwrite it.')
    next.data.actions = next.data.actions.filter(item => item.id !== payload.actionId)
    if (payload.previous) next.data.actions.push(payload.previous)
    next.data.scheduleNodes = (next.data.scheduleNodes ?? []).filter(node => !node.relatedActionIds.includes(payload.actionId)).concat(payload.previousNodes)
    finalizeSnapshot(next, timestamp)
    return next
  }

  if (compensation.operation === 'remove_created_opportunity') {
    const target = assertCreatedOpportunityUndoSafe(next, payload.opportunityId, payload.expected)
    next.data.opportunities = next.data.opportunities.filter(item => item.id !== target.id)
    next.exportedAt = timestamp
    validateSnapshot(next)
    return next
  }

  if (compensation.operation === 'restore_daily_capacity' || compensation.operation === 'restore_date_capacity' || compensation.operation === 'restore_work_windows') {
    const preferences = structuredClone(next.data.timePlanning ?? { version: 1 as const, updatedAt: timestamp })
    if (compensation.operation === 'restore_daily_capacity') preferences.defaultDailyMinutes = payload.minutes
    if (compensation.operation === 'restore_date_capacity') {
      const overrides = { ...preferences.dateOverrides }
      if (payload.minutes === undefined) delete overrides[payload.date]
      else overrides[payload.date] = payload.minutes
      preferences.dateOverrides = overrides
    }
    if (compensation.operation === 'restore_work_windows') preferences.weeklyWindows = payload.windows
    preferences.updatedAt = timestamp
    next.data.timePlanning = preferences
  } else if (compensation.operation === 'set_action_status') {
    if (payload.undo) {
      restoreActionStatusUndo(next.data, payload.undo)
    } else {
      // Older receipts lack occurrence ownership evidence. Never guess which
      // historical completion to reopen from an action id or a matching time.
      if (next.data.scheduleNodes?.some((node) => node.relatedActionIds.includes(payload.actionId))) {
        throw new Error('Legacy Undo lacks historical occurrence evidence; cannot restore safely.')
      }
      const target = next.data.actions.find((item) => item.id === payload.actionId)
      if (!target) throw new Error('Action no longer exists; Undo cannot restore safely.')
      target.status = payload.status
      target.updatedAt = timestamp
    }
  } else if (compensation.operation === 'restore_discovery_promotion') {
    const target = (next.data.discoveryInbox ?? []).find(item => item.id === payload.inboxItemId)
    if (!target || payload.expectedPromotedItem && !occurrenceValueEqual(target, payload.expectedPromotedItem)
      || !payload.expectedPromotedItem && target.status !== 'promoted') throw new Error('The promoted candidate changed; Undo cannot overwrite it safely.')
    if (payload.createdOpportunityId) {
      const savedChangeSet = next.data.changeSets?.find(item => item.id === payload.createdChangeSetId)
      const originalCreation = savedChangeSet?.operations.find(item => item.kind === 'add_discovered_opportunity' && item.opportunity.id === payload.createdOpportunityId)
      const expected = payload.createdOpportunityUndo?.operation === 'remove_created_opportunity'
        && payload.createdOpportunityUndo.payload.opportunityId === payload.createdOpportunityId
        ? payload.createdOpportunityUndo.payload.expected
        : originalCreation?.kind === 'add_discovered_opportunity' ? originalCreation.opportunity : undefined
      assertCreatedOpportunityUndoSafe(next, payload.createdOpportunityId, expected, target.id)
    }
    if (payload.createdActionId && next.data.actions.some(item => item.id === payload.createdActionId)) {
      throw new Error('Legacy promotion Undo lacks the created task ownership needed for safe removal.')
    }
    target.status = payload.status
    target.rejectionReason = payload.rejectionReason
    target.promotedOpportunityId = payload.promotedOpportunityId
    target.updatedAt = timestamp
    next.data.timeline = (next.data.timeline ?? []).filter(item => !(payload.timelineIds ?? []).includes(item.id))
    if (payload.createdOpportunityId) next.data.opportunities = next.data.opportunities.filter(item => item.id !== payload.createdOpportunityId)
    if (payload.createdChangeSetId) next.data.changeSets = (next.data.changeSets ?? []).filter(item => item.id !== payload.createdChangeSetId)
  } else if (compensation.operation === 'restore_discovery_profile') {
    next.data.discoveryProfile = payload.profile
  } else if (compensation.operation === 'restore_discovery_status') {
    const target = (next.data.discoveryInbox ?? []).find((item) => item.id === payload.inboxItemId)
    if (target) {
      target.status = payload.status
      target.rejectionReason = payload.rejectionReason
      target.seenAt = payload.seenAt
      target.updatedAt = timestamp
    }
    if (payload.timelineId) next.data.timeline = (next.data.timeline ?? []).filter((item) => item.id !== payload.timelineId)
  } else if (compensation.operation === 'delete_process_event') {
    if (next.data.processEvents.find(item => item.id === payload.eventId)?.invalidation) throw new Error('Corrected original evidence is retained; its source command cannot delete the audit record.')
    restoreProcessProjection(next, payload.projectionUndo, payload.eventId)
    next.data.processEvents = next.data.processEvents.filter((item) => item.id !== payload.eventId)
    next.data.actions = next.data.actions.filter((item) => item.processEventId !== payload.eventId)
    for (const node of next.data.scheduleNodes ?? []) {
      if (node.processEventId === payload.eventId && node.state !== 'superseded') {
        node.state = 'cancelled'
        node.cancelledAt = timestamp
        node.updatedAt = timestamp
      }
    }
  } else if (compensation.operation === 'restore_deleted_process_event') {
    const event = payload.event as ProcessEvent | undefined
    if (!event?.id || next.data.processEvents.some((item) => item.id === event.id)) {
      throw new Error('Deleted process event cannot be restored safely.')
    }
    next.data.processEvents.push(structuredClone(event))
    const actions = (payload.actions ?? (payload.action ? [payload.action] : [])) as Action[]
    for (const action of actions) {
      if (next.data.actions.some((item) => item.id === action.id)) throw new Error('Generated Action already exists.')
      next.data.actions.push(structuredClone(action))
    }
    if (payload.scheduleNodeChanges) {
      restoreScheduleNodeChanges(next.data, payload.scheduleNodeChanges)
    } else {
      // A legacy receipt can retain unchanged history but cannot prove ownership
      // of a later cancellation/replacement without its exact post-delete state.
      restoreScheduleNodeChanges(next.data, ((payload.scheduleNodes ?? []) as ScheduleNode[])
        .map((previous) => ({ before: previous, after: previous })))
    }
  } else if (compensation.operation === 'restore_deadline') {
    const target = next.data.opportunities.find((item) => item.id === payload.opportunityId)
    if (target) {
      if (payload.expectedDeadlineFingerprint && payload.expectedDeadlineFingerprint !== applicationDeadlineFingerprint(target, next.data)) throw new Error('Deadline evidence changed after this command; undo cannot overwrite newer correction or ownership.')
      const correctionId = target.detail?.deadlineCorrections?.at(-1)?.commandId ?? null
      if (payload.expectedDeadlineState ? payload.expectedDeadlineState.deadline !== target.deadline || payload.expectedDeadlineState.correctionId !== correctionId : Boolean(correctionId)) throw new Error('Deadline evidence changed after this command; undo cannot overwrite the newer correction.')
      if (target.detail?.userFacts) {
        target.detail.userFacts.deadline = payload.userFactsDeadline
        target.detail.userFacts.deadlinePrecision = payload.userFactsDeadlinePrecision
      }
      if (payload.factOnly) {
        target.detail = { ...target.detail, deadlineCorrections: payload.deadlineCorrections }
        target.deadline = payload.deadline
        target.deadlinePrecision = payload.deadlinePrecision
        for (const apply of next.data.actions.filter(item => item.opportunityId === target.id && item.kind === 'apply' && ['todo', 'doing'].includes(item.status))) {
          apply.dueAt = payload.deadline
          apply.duePrecision = payload.deadlinePrecision
          apply.timingMode = payload.deadline ? 'deadline' : undefined
        }
      } else if (payload.previousDeadlineNodes) {
        for (const previous of payload.previousDeadlineNodes as ScheduleNode[]) {
          const restored = { ...previous, updatedAt: timestamp }
          delete restored.supersededByNodeId
          supersedeScheduleOccurrence(next.data.scheduleNodes!, restored)
        }
        if (!payload.previousDeadlineNodes.length) {
          const current = latestScheduleOccurrence(next.data.scheduleNodes ?? [], `application-deadline:${target.id}`)
          if (current) supersedeScheduleOccurrence(next.data.scheduleNodes!, { ...current, state: 'cancelled', cancelledAt: timestamp, updatedAt: timestamp })
        }
        target.deadline = payload.deadline
        target.deadlinePrecision = payload.deadlinePrecision
        if (!payload.deadline) for (const action of next.data.actions.filter(item => item.opportunityId === target.id && item.kind === 'apply' && ['todo', 'doing'].includes(item.status))) { action.dueAt = undefined; action.duePrecision = undefined; action.timingMode = undefined }
      } else if (payload.deadline) {
        setApplicationDeadlineScheduleNode(next.data, target.id, payload.deadline, payload.deadlinePrecision ?? 'datetime', timestamp)
      } else {
        const current = latestScheduleOccurrence(next.data.scheduleNodes ?? [], `application-deadline:${target.id}`)
        if (current && current.state !== 'superseded') {
          current.state = 'cancelled'
          current.cancelledAt = timestamp
          current.updatedAt = timestamp
        }
        target.deadline = undefined
        target.deadlinePrecision = undefined
        const apply = next.data.actions.find((item) => item.id === `apply:${target.id}`)
        if (apply) {
          apply.dueAt = undefined
          apply.duePrecision = undefined
          apply.timingMode = undefined
        }
      }
    }
  } else if (compensation.operation === 'restore_participation') {
    const target = next.data.opportunities.find((item) => item.id === payload.opportunityId)
    if (target) {
      target.participationStatus = payload.participationStatus
      target.abandonedAt = payload.participationStatus === 'abandoned' ? target.abandonedAt ?? timestamp : undefined
    }
    for (const state of payload.actionStates ?? []) {
      const action = next.data.actions.find((item) => item.id === state.actionId)
      if (action) {
        action.status = state.status
        action.updatedAt = timestamp
        syncScheduleNodeForActionStatus(next.data, action.id, action.status, timestamp)
      }
    }
  } else if (compensation.operation === 'restore_application_submission') {
    const target = next.data.opportunities.find((item) => item.id === payload.opportunityId)
    if (!target) throw new Error('Submitted job no longer exists; Undo cannot restore safely.')
    target.applicationSubmissionProofs = { ...target.applicationSubmissionProofs, [payload.submissionCommandId]: 'withdrawn' }
    const priorProofs = new Set<string>(payload.priorSubmissionCommandIds ?? [])
    const otherProofs = Object.entries(target.applicationSubmissionProofs).filter(([, state]) => state === 'active').map(([id]) => id)
    if (otherProofs.some(id => !priorProofs.has(id))
      || next.data.processEvents.some(event => event.opportunityId === target.id && !event.invalidation && !(payload.priorProcessEventIds ?? []).includes(event.id))) {
      throw new Error('A later independent submission or recruiting fact owns this job; Undo cannot overwrite it.')
    }
    // Legacy audit remains unchanged and continues to classify historical facts.
    // Its position is not reliable causal ownership and the instant kernel does
    // not scan it. Both kernels decide Undo from the same command-owned proofs.
    const independentSubmission = otherProofs.length > 0
    if (independentSubmission) {
      // The withdrawn command no longer proves submission; a different actual
      // submission/recruiting fact still owns the current business state.
      ensureScheduleContractInPlace(next.data)
      next.exportedAt = timestamp
      validateSnapshot(next)
      return next
    }
    if (target) {
      target.processStage = payload.processStage
      target.currentStageLabel = stageLabelFor(payload.processStage)
      const process = next.data.processes.find((item) => item.opportunityId === target.id)
      if (process) {
        process.stage = payload.processStage
        process.stageLabel = stageLabelFor(payload.processStage)
        process.progress = payload.processStage === 'not_applied' ? 'not_started' : process.progress
      }
    }
    if (payload.undo) {
      restoreActionStatusUndo(next.data, payload.undo)
    } else if (payload.actionId && payload.actionStatus) {
      if (next.data.scheduleNodes?.some(node => node.relatedActionIds.includes(payload.actionId))) {
        throw new Error('Legacy application Undo lacks occurrence ownership evidence; cannot restore safely.')
      }
      const action = next.data.actions.find((item) => item.id === payload.actionId)
      if (!action) throw new Error('Action no longer exists; Undo cannot restore safely.')
      action.status = payload.actionStatus
      action.updatedAt = timestamp
    }
  } else if (compensation.operation === 'remove_manual_action') {
    next.data.actions = next.data.actions.filter((item) => item.id !== payload.actionId)
    for (const node of next.data.scheduleNodes ?? []) {
      if (node.relatedActionIds.includes(payload.actionId) && node.state !== 'superseded') {
        node.state = 'cancelled'
        node.cancelledAt = timestamp
        node.updatedAt = timestamp
      }
    }
  } else if (compensation.operation === 'restore_reminder_intent') {
    next.data.reminderIntents = (next.data.reminderIntents ?? []).filter((item) => item.id !== payload.reminderIntentId)
    if (payload.previousReminder) next.data.reminderIntents.push(structuredClone(payload.previousReminder))
    next.data.reminderOutbox = (next.data.reminderOutbox ?? []).filter((item) => item.reminderIntentId !== payload.reminderIntentId)
    for (const record of payload.previousOutbox ?? []) next.data.reminderOutbox!.push(structuredClone(record))
  } else if (compensation.operation === 'restore_occurrence_completion') {
    const current = latestScheduleOccurrence(next.data.scheduleNodes ?? [], payload.occurrenceId)
    if (current && payload.node) Object.assign(current, structuredClone(payload.node))
    for (const state of payload.actionStates ?? []) {
      const action = next.data.actions.find((item) => item.id === state.id)
      if (action) {
        action.status = state.status
        action.updatedAt = state.updatedAt ?? timestamp
      }
    }
    restoreProcessSnapshots(next, payload.processStates ?? [])
  } else if (compensation.operation === 'restore_occurrence_supersession') {
    if (payload.ownerStates) {
      // The raw occurrence was checked before normalization. Rebuilding legacy
      // source refs must not turn a preserved independent edit into a conflict.
      restoreOccurrenceOwnerStates(next, payload.ownerStates)
    }
    next.data.scheduleNodes = (next.data.scheduleNodes ?? []).filter((item) => item.id !== payload.newNodeId)
    if (payload.previousNode) {
      const index = (next.data.scheduleNodes ?? []).findIndex((item) => item.id === payload.previousNode.id)
      if (index >= 0) next.data.scheduleNodes![index] = structuredClone(payload.previousNode)
      else next.data.scheduleNodes!.push(structuredClone(payload.previousNode))
    }
    if (!payload.ownerStates) restoreProcessSnapshots(next, payload.processStates ?? [])
  } else {
    throw new Error(`Unsupported domain compensation operation: ${compensation.operation}`)
  }

  ensureScheduleContractInPlace(next.data)
  projectScheduleNodesToLegacyInPlace(next.data)
  next.exportedAt = timestamp
  validateSnapshot(next)
  return next
}
