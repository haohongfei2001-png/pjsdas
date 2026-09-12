import {
  applyGmailIngestion,
  applyMonitorIngestion,
  type AutonomousIngestionResult,
  type GmailIngestionRunInput,
  type GmailMessageObservation,
  type MonitorIngestionRunInput,
  type MonitorJobObservation,
} from './autonomousIngestion.js'
import {
  alreadyIngested,
  buildIngestionRunSummary,
  createIngestionLedgerTimeline,
  createIngestionRunTimeline,
  stableIngestionHash,
} from './ingestion.js'
import {
  jobRoleSimilarity,
  logicalJobMatches,
  normalizeJobRole,
} from './jobPosting.js'
import { actionForProcessEvent } from './processEvents.js'
import { validateSnapshot, type PJSDASSnapshot } from './snapshot.js'
import type { Opportunity, TimelineRecord } from './model.js'

export type GmailEventState = 'scheduled' | 'rescheduled' | 'completed' | 'cancelled'

export type HardenedGmailMessageObservation = GmailMessageObservation & {
  /**
   * Explicit logical-event identity supplied by the trusted upstream classifier.
   * Different Gmail messages may share this only when they refer to the same
   * recruiting event (for example invitation -> reschedule -> completion).
   */
  eventKey?: string
  eventState?: GmailEventState
}

export type HardenedGmailIngestionRunInput = Omit<GmailIngestionRunInput, 'messages'> & {
  messages: HardenedGmailMessageObservation[]
}

function monitorMatches(observation: MonitorJobObservation, opportunities: Opportunity[]) {
  return opportunities.filter((item) => logicalJobMatches(
    { company: observation.company, role: observation.role, location: observation.location },
    { company: item.company, role: item.role, location: item.detail?.discovery?.location },
  ))
}

export function monitorObservationIsAmbiguous(observation: MonitorJobObservation, opportunities: Opportunity[]) {
  const matches = monitorMatches(observation, opportunities)
  if (matches.length <= 1) return false

  const normalizedRole = normalizeJobRole(observation.role)
  const exact = matches.filter((item) => normalizeJobRole(item.role) === normalizedRole)
  if (exact.length === 1) return false
  if (exact.length > 1) return true

  const scored = matches
    .map((opportunity) => ({ opportunity, score: jobRoleSimilarity(observation.role, opportunity.role) }))
    .sort((a, b) => b.score - a.score || a.opportunity.id.localeCompare(b.opportunity.id))
  const best = scored[0]
  const second = scored[1]
  if (!best || !second) return false
  return !(best.score >= 0.94 && best.score - second.score >= 0.12)
}

function monitorFingerprint(observation: MonitorJobObservation) {
  return stableIngestionHash(JSON.stringify([
    observation.company,
    observation.role,
    observation.sourceUrl,
    observation.location ?? '',
    observation.deadline ?? '',
    observation.compensationText ?? '',
    observation.postingStatus ?? 'unknown',
  ]))
}

function replaceRunTimeline(
  snapshot: PJSDASSnapshot,
  input: Pick<MonitorIngestionRunInput, 'runId' | 'sourceId' | 'startedAt' | 'completedAt'>,
  sourceKind: 'gpt_monitor' | 'gmail',
  records: TimelineRecord[],
  cursor?: string,
) {
  const timeline = (snapshot.data.timeline ?? []).filter((item) => !(
    item.ingestionRun?.runId === input.runId &&
    item.ingestionRun.sourceKind === sourceKind &&
    item.ingestionRun.sourceId === input.sourceId
  ))
  const run = buildIngestionRunSummary({
    runId: input.runId,
    sourceKind,
    sourceId: input.sourceId,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    records,
    cursor,
  })
  timeline.push(createIngestionRunTimeline(run))
  snapshot.data.timeline = timeline
  return run
}

export function applyMonitorIngestionHardened(
  snapshot: PJSDASSnapshot,
  input: MonitorIngestionRunInput,
): AutonomousIngestionResult {
  const ambiguous = input.observations.filter((item) => monitorObservationIsAmbiguous(item, snapshot.data.opportunities))
  if (ambiguous.length === 0) return applyMonitorIngestion(snapshot, input)

  const ambiguousIds = new Set(ambiguous.map((item) => item.sourceRecordId))
  const base = applyMonitorIngestion(snapshot, {
    ...input,
    observations: input.observations.filter((item) => !ambiguousIds.has(item.sourceRecordId)),
  })
  if (base.alreadyApplied) return base

  const next = structuredClone(base.snapshot)
  const timeline = next.data.timeline ?? []
  const records = [...base.records]

  for (const observation of ambiguous) {
    const previous = alreadyIngested(snapshot.data.timeline, {
      sourceKind: 'gpt_monitor',
      sourceId: input.sourceId,
      sourceRecordId: observation.sourceRecordId,
    })
    const duplicate = previous?.ingestion?.outcome && previous.ingestion.outcome !== 'unresolved'
    const record = createIngestionLedgerTimeline({
      sourceKind: 'gpt_monitor',
      sourceId: input.sourceId,
      sourceRecordId: observation.sourceRecordId,
      runId: input.runId,
      recordType: 'job_observation',
      outcome: duplicate ? 'duplicate' : 'unresolved',
      fingerprint: monitorFingerprint(observation),
      receivedAt: observation.discoveredAt ?? input.completedAt,
      accountedAt: input.completedAt,
      reason: duplicate
        ? `来源记录 ${observation.sourceRecordId} 已在先前 run 对账。`
        : '同一公司存在多个高度相似的现有 Opportunity；为避免错误归并，本次自动摄入停止并保留为 unresolved。',
      opportunityId: duplicate ? previous?.ingestion?.opportunityId : undefined,
      company: observation.company,
      role: observation.role,
      sourceRef: observation.sourceUrl,
    })
    records.push(record)
    timeline.push(record)
  }

  const run = replaceRunTimeline(next, input, 'gpt_monitor', records)
  next.exportedAt = input.completedAt
  validateSnapshot(next)
  return { ...base, snapshot: next, run, records }
}

function logicalEventId(sourceId: string, eventKey: string) {
  return `gmail-logical-event:${stableIngestionHash(`${sourceId}|${eventKey}`)}`
}

function actionIdForEvent(eventId: string) {
  return `event-action:${eventId}`
}

function updateTimelinePointers(timeline: TimelineRecord[], oldEventId: string, newEventId: string, oldActionId?: string, newActionId?: string) {
  for (const item of timeline) {
    if (item.processEventId === oldEventId) item.processEventId = newEventId
    if (item.ingestion?.processEventId === oldEventId) item.ingestion.processEventId = newEventId
    if (oldActionId && newActionId && item.actionId === oldActionId) item.actionId = newActionId
    if (oldActionId && newActionId && item.ingestion?.actionId === oldActionId) item.ingestion.actionId = newActionId
  }
}

function reconcileLogicalGmailEvents(
  result: AutonomousIngestionResult,
  input: HardenedGmailIngestionRunInput,
) {
  const next = structuredClone(result.snapshot)
  const timeline = next.data.timeline ?? []

  for (const message of [...input.messages].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))) {
    const eventKey = message.eventKey?.trim()
    if (!eventKey || !message.eventType || message.classification !== 'recruiting' || message.confidence !== 'high') continue

    const ledger = timeline.find((item) =>
      item.ingestion?.sourceKind === 'gmail' &&
      item.ingestion.sourceId === input.sourceId &&
      item.ingestion.runId === input.runId &&
      item.ingestion.sourceRecordId === message.sourceRecordId,
    )
    const createdEventId = ledger?.ingestion?.processEventId
    if (!createdEventId) continue

    const canonicalId = logicalEventId(input.sourceId, eventKey)
    let canonical = next.data.processEvents.find((item) => item.id === canonicalId)
    const created = next.data.processEvents.find((item) => item.id === createdEventId)
    if (!created && !canonical) continue

    if (!canonical && created) {
      const oldEventId = created.id
      const oldAction = next.data.actions.find((item) => item.processEventId === oldEventId)
      const newActionId = actionIdForEvent(canonicalId)
      created.id = canonicalId
      canonical = created
      if (oldAction) {
        const oldActionId = oldAction.id
        oldAction.id = newActionId
        oldAction.processEventId = canonicalId
        updateTimelinePointers(timeline, oldEventId, canonicalId, oldActionId, newActionId)
      } else {
        updateTimelinePointers(timeline, oldEventId, canonicalId)
      }
    } else if (canonical && created && created.id !== canonical.id) {
      const oldEventId = created.id
      const oldAction = next.data.actions.find((item) => item.processEventId === oldEventId)
      next.data.processEvents = next.data.processEvents.filter((item) => item.id !== oldEventId)
      if (oldAction) next.data.actions = next.data.actions.filter((item) => item.id !== oldAction.id)
      next.data.timeline = timeline.filter((item) => !(
        item.kind === 'process_event_recorded' && item.processEventId === oldEventId
      ))
      updateTimelinePointers(next.data.timeline, oldEventId, canonical.id, oldAction?.id, actionIdForEvent(canonical.id))
      if (ledger?.ingestion) {
        ledger.ingestion.outcome = 'updated'
        ledger.ingestion.reason = '同一 Gmail 逻辑事件的新消息已归并到既有 Process Event。'
      }
    }

    canonical = next.data.processEvents.find((item) => item.id === canonicalId)
    if (!canonical) continue
    if (message.dueAt) canonical.dueAt = message.dueAt
    if (message.timingMode) canonical.timingMode = message.timingMode
    if (message.estimatedMinutes) canonical.estimatedMinutes = message.estimatedMinutes
    if (message.notes?.trim()) canonical.notes = message.notes.trim()
    canonical.updatedAt = message.receivedAt

    let action = next.data.actions.find((item) => item.processEventId === canonicalId)
    if (!action) {
      const generated = actionForProcessEvent(canonical)
      if (generated) {
        next.data.actions.push(generated)
        action = generated
      }
    }
    if (action) {
      action.dueAt = canonical.dueAt
      action.timingMode = canonical.timingMode
      action.estimatedMinutes = canonical.estimatedMinutes ?? action.estimatedMinutes
      action.updatedAt = message.receivedAt
      if (message.eventState === 'completed') action.status = 'done'
      else if (message.eventState === 'cancelled') action.status = 'skipped'
    }
    if (ledger?.ingestion) {
      ledger.ingestion.processEventId = canonicalId
      ledger.ingestion.actionId = action?.id
      if (message.eventState && message.eventState !== 'scheduled') {
        ledger.ingestion.outcome = 'updated'
        ledger.ingestion.reason = message.eventState === 'completed'
          ? '同一 Gmail 逻辑事件已标记完成。'
          : message.eventState === 'cancelled'
            ? '同一 Gmail 逻辑事件已标记取消。'
            : '同一 Gmail 逻辑事件的时间/安排已更新。'
      }
    }
  }

  const records = (next.data.timeline ?? []).filter((item) =>
    item.ingestion?.sourceKind === 'gmail' &&
    item.ingestion.sourceId === input.sourceId &&
    item.ingestion.runId === input.runId,
  )
  const run = replaceRunTimeline(next, input, 'gmail', records, input.cursor)
  next.exportedAt = input.completedAt
  validateSnapshot(next)
  return { ...result, snapshot: next, run, records }
}

export function applyGmailIngestionHardened(
  snapshot: PJSDASSnapshot,
  input: HardenedGmailIngestionRunInput,
): AutonomousIngestionResult {
  const normalized: HardenedGmailIngestionRunInput = {
    ...input,
    messages: input.messages.map((message) => {
      if (message.eventState && message.eventState !== 'scheduled' && !message.eventKey?.trim()) {
        return {
          ...message,
          confidence: 'medium',
          notes: [message.notes?.trim(), '事件更新缺少稳定 eventKey；为避免重复/误完成，自动写入已停止。'].filter(Boolean).join('；'),
        }
      }
      return message
    }),
  }
  const base = applyGmailIngestion(snapshot, normalized as GmailIngestionRunInput)
  if (base.alreadyApplied) return base
  return reconcileLogicalGmailEvents(base, normalized)
}
