import {
  actionForProcessEvent,
  defaultMinutesForProcessEvent,
  defaultTimingModeForProcessEvent,
  processEventStageLabel,
  stageForProcessEvent,
} from './processEvents.js'
import { timelineFromActionStatus, timelineFromProcessEvent } from './timeline.js'
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
  TimelineRecord,
} from './model.js'
import type { PJSDASSnapshot } from './snapshot.js'
import { upgradeSnapshotToLatest, validateSnapshot } from './snapshot.js'
import {
  ensureScheduleContractInPlace,
  setApplicationDeadlineScheduleNode,
  syncScheduleNodeForActionStatus,
} from './scheduleNodes.js'

export type UserFactField = 'location' | 'compensationText' | 'applicationUrl'

export type UserDomainCommand =
  | { commandId: string; kind: 'record_application_submission'; opportunityId: string; occurredAt?: string }
  | {
      commandId: string
      kind: 'record_process_event'
      opportunityId: string
      eventType: ProcessEventType
      occurredAt?: string
      dueAt?: string
      duePrecision?: DatePrecision
      timingMode?: ActionTimingMode
      estimatedMinutes?: number
      notes?: string
    }
  | { commandId: string; kind: 'set_deadline'; opportunityId: string; deadline: string; precision: DatePrecision }
  | { commandId: string; kind: 'set_action_status'; actionId: string; status: ActionStatus }
  | { commandId: string; kind: 'abandon_opportunity'; opportunityId: string; occurredAt?: string }
  | { commandId: string; kind: 'correct_opportunity_fact'; opportunityId: string; field: UserFactField; value: string }
  | { commandId: string; kind: 'set_opportunity_preference'; opportunityId: string; roleType: OpportunityRole }
  | {
      commandId: string
      kind: 'add_manual_action'
      title: string
      dueAt?: string
      duePrecision?: DatePrecision
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
  return next.data.opportunities.find((item) => item.id === id)
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

export function applyUserDomainCommand(
  snapshot: PJSDASSnapshot,
  command: UserDomainCommand,
  now = new Date(),
): UserDomainCommandResult {
  if (!command.commandId.trim()) throw new Error('commandId is required.')
  if (commandAlreadyApplied(snapshot, command.commandId)) {
    return { status: 'ALREADY_APPLIED', snapshot, summary: `Command ${command.commandId} is already recorded.` }
  }

  const next = upgradeSnapshotToLatest(snapshot)
  const timestamp = nowIso(now)

  if (command.kind === 'record_application_submission') {
    const target = opportunity(next, command.opportunityId)
    if (!target) throw new Error(`Opportunity ${command.opportunityId} was not found.`)
    if (target.participationStatus === 'abandoned') {
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
    target.participationStatus = 'active'
    target.abandonedAt = undefined
    target.processStage = 'screening'
    target.currentStageLabel = '筛选中'
    target.locallyManaged = true
    const apply = next.data.actions.find((item) => item.id === `apply:${target.id}`)
    const beforeApplyStatus = apply?.status
    if (apply && (apply.status === 'todo' || apply.status === 'doing')) {
      apply.status = 'done'
      apply.updatedAt = occurredAt
      syncScheduleNodeForActionStatus(next.data, apply.id, 'done', occurredAt)
    }
    upsertProcess(next, target, occurredAt)
    appendTimeline(next, commandTimeline(command, occurredAt, {
      kind: 'application_submitted',
      title: '完成投递',
      opportunity: target,
      changes: { stage: { before: beforeStage, after: 'screening' } },
    }), command)
    finalizeSnapshot(next, timestamp)
    return {
      status: 'APPLIED',
      snapshot: next,
      summary: `Recorded application submission for ${target.company}｜${target.role}.`,
      compensation: {
        operation: 'restore_application_submission',
        payload: {
          opportunityId: target.id,
          processStage: beforeStage,
          actionId: apply?.id,
          actionStatus: beforeApplyStatus,
        },
      },
    }
  }

  if (command.kind === 'record_process_event') {
    const target = opportunity(next, command.opportunityId)
    if (!target) throw new Error(`Opportunity ${command.opportunityId} was not found.`)
    const occurredAt = command.occurredAt ?? timestamp
    assertIso(occurredAt, 'occurredAt')
    if (command.dueAt) assertIso(command.dueAt, 'dueAt')
    const eventId = `user-event:${stableHash(command.commandId)}`
    const event: ProcessEvent = {
      id: eventId,
      opportunityId: target.id,
      company: target.company,
      role: target.role,
      type: command.eventType,
      occurredAt,
      dueAt: command.dueAt,
      duePrecision: command.duePrecision,
      timingMode: command.timingMode ?? defaultTimingModeForProcessEvent(command.eventType),
      estimatedMinutes: command.estimatedMinutes ?? defaultMinutesForProcessEvent(command.eventType),
      notes: command.notes?.trim() || undefined,
      source: 'manual',
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    next.data.processEvents.push(event)
    const generated = actionForProcessEvent(event)
    if (generated) next.data.actions.push({ ...generated, duePrecision: command.duePrecision })
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
      compensation: { operation: 'delete_process_event', payload: { eventId } },
    }
  }

  if (command.kind === 'set_deadline') {
    const target = opportunity(next, command.opportunityId)
    if (!target) throw new Error(`Opportunity ${command.opportunityId} was not found.`)
    assertIso(command.deadline, 'deadline')
    const before = { deadline: target.deadline, deadlinePrecision: target.deadlinePrecision }
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
    setApplicationDeadlineScheduleNode(next.data, target.id, command.deadline, command.precision, timestamp)
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
      compensation: { operation: 'restore_deadline', payload: { opportunityId: target.id, ...before } },
    }
  }

  if (command.kind === 'set_action_status') {
    const target = action(next, command.actionId)
    if (!target) throw new Error(`Action ${command.actionId} was not found.`)
    const before = target.status
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
      compensation: { operation: 'set_action_status', payload: { actionId: target.id, status: before } },
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
    appendTimeline(next, commandTimeline(command, occurredAt, {
      title: '放弃岗位',
      opportunity: target,
      detail: '这是用户参与决定，不改变招聘方流程事实，也不删除历史。',
      changes: { participationStatus: { before, after: 'abandoned' } },
    }), command)
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

  const title = command.title.trim()
  if (!title) throw new Error('Action title must not be empty.')
  if (command.dueAt) assertIso(command.dueAt, 'dueAt')
  const actionId = `user-action:${stableHash(command.commandId)}`
  const created: Action = {
    id: actionId,
    kind: 'manual',
    title,
    dueAt: command.dueAt,
    duePrecision: command.duePrecision,
    timingMode: command.dueAt ? 'deadline' : undefined,
    estimatedMinutes: Math.max(5, Math.min(720, Math.round(command.estimatedMinutes ?? 30))),
    leverage: 70,
    delayCost: command.dueAt ? 65 : 40,
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
  }), command)
  next.exportedAt = timestamp
  validateSnapshot(next)
  return {
    status: 'APPLIED',
    snapshot: next,
    summary: `Added action ${title}.`,
    compensation: { operation: 'remove_manual_action', payload: { actionId } },
  }
}
