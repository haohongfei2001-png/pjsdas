import {
  applyGmailIngestion,
  applyMonitorIngestion,
  type AutonomousIngestionResult,
  type GmailIngestionRunInput,
  type GmailMessageObservation,
  type MonitorIngestionRunInput,
  type MonitorJobObservation,
} from './autonomousIngestion.js'
import { findSimilarOpportunity } from './discoveryQuality.js'
import {
  alreadyIngested,
  buildIngestionRunSummary,
  createIngestionLedgerTimeline,
  createIngestionRunTimeline,
  stableIngestionHash,
} from './ingestion.js'
import {
  createJobPostingEvidence,
  jobRoleSimilarity,
  logicalJobMatches,
  mergeJobPostingEvidence,
  normalizeJobRole,
} from './jobPosting.js'
import { actionForProcessEvent } from './processEvents.js'
import { sourcePolicyForRun, type IngestionSourcePolicy } from './sourceRegistry.js'
import { validateSnapshot, type PJSDASSnapshot } from './snapshot.js'
import type { Opportunity, TimelineRecord } from './model.js'

export type GmailEventState = 'scheduled' | 'rescheduled' | 'completed' | 'cancelled'

export type HardenedMonitorIngestionRunInput = MonitorIngestionRunInput & {
  sourcePolicy?: IngestionSourcePolicy
}

export type HardenedGmailMessageObservation = GmailMessageObservation & {
  eventKey?: string
  eventState?: GmailEventState
}

export type HardenedGmailIngestionRunInput = Omit<GmailIngestionRunInput, 'messages'> & {
  messages: HardenedGmailMessageObservation[]
  sourcePolicy?: IngestionSourcePolicy
}

type HardenedRunIdentity = Pick<MonitorIngestionRunInput, 'runId' | 'sourceId' | 'startedAt' | 'completedAt'> & {
  sourcePolicy?: IngestionSourcePolicy
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
    observation.sourceVerification ?? 'unverified',
  ]))
}

function validIso(value: string) {
  return !Number.isNaN(new Date(value).getTime())
}

function mergeExistingMonitorObservation(existing: Opportunity, observation: MonitorJobObservation, observedAt: string) {
  const sourceVerifiedAt = observation.sourceVerifiedAt ?? observedAt
  const incoming = createJobPostingEvidence({
    company: observation.company,
    role: observation.role,
    sourceUrl: observation.sourceUrl,
    sourceTitle: observation.sourceTitle,
    location: observation.location,
    deadline: observation.deadline,
    compensationText: observation.compensationText,
    postingStatus: observation.postingStatus ?? 'unknown',
    observedAt: sourceVerifiedAt,
  })
  const discovery = existing.detail?.discovery
  const current = discovery?.posting
  const mergedPosting = current
    ? mergeJobPostingEvidence(current, discovery?.postingHistory, incoming, new Date(observedAt))
    : { current: incoming, history: [] }
  const sameFingerprint = current?.id === incoming.id && current.fingerprint === incoming.fingerprint
  const deadlineChanged = Boolean(observation.deadline && observation.deadline !== existing.deadline)
  const compensationChanged = Boolean(observation.compensationText && observation.compensationText !== existing.salaryReference)
  const next: Opportunity = {
    ...existing,
    deadline: observation.deadline ?? existing.deadline,
    salaryReference: observation.compensationText ?? existing.salaryReference,
    detail: {
      ...existing.detail,
      discovery: {
        sourceUrl: mergedPosting.current.sourceUrl,
        sourceTitle: mergedPosting.current.sourceTitle,
        location: observation.location ?? discovery?.location,
        compensationText: observation.compensationText ?? discovery?.compensationText,
        rationale: discovery?.rationale ?? observation.rationale,
        discoveredAt: discovery?.discoveredAt ?? observedAt,
        sourceVerification: observation.sourceVerification ?? discovery?.sourceVerification,
        sourceVerifiedAt: observation.sourceVerifiedAt ?? discovery?.sourceVerifiedAt,
        fitConfidence: discovery?.fitConfidence ?? observation.fitConfidence,
        opportunityValueConfidence: discovery?.opportunityValueConfidence ?? observation.opportunityValueConfidence,
        profileWarnings: discovery?.profileWarnings,
        posting: mergedPosting.current,
        postingHistory: mergedPosting.history.length ? mergedPosting.history : undefined,
      },
    },
  }
  return { opportunity: next, changed: !sameFingerprint || deadlineChanged || compensationChanged }
}

function replaceRunTimeline(snapshot: PJSDASSnapshot, input: HardenedRunIdentity, sourceKind: 'gpt_monitor' | 'gmail', records: TimelineRecord[], cursor?: string) {
  const timeline = (snapshot.data.timeline ?? []).filter((item) => !(
    item.ingestionRun?.runId === input.runId &&
    item.ingestionRun.sourceKind === sourceKind &&
    item.ingestionRun.sourceId === input.sourceId
  ))
  const sourcePolicy = sourcePolicyForRun(sourceKind, input.sourceId, input.sourcePolicy)
  const run = buildIngestionRunSummary({
    runId: input.runId,
    sourceKind,
    sourceId: input.sourceId,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    records,
    cursor,
    sourcePolicy,
  })
  timeline.push(createIngestionRunTimeline(run))
  snapshot.data.timeline = timeline
  return run
}

function attachRunPolicy(result: AutonomousIngestionResult, input: HardenedRunIdentity, sourceKind: 'gpt_monitor' | 'gmail', cursor?: string): AutonomousIngestionResult {
  if (result.alreadyApplied) return result
  const next = structuredClone(result.snapshot)
  const run = replaceRunTimeline(next, input, sourceKind, result.records, cursor)
  next.exportedAt = input.completedAt
  validateSnapshot(next)
  return { ...result, snapshot: next, run }
}

export function applyMonitorIngestionHardened(snapshot: PJSDASSnapshot, input: HardenedMonitorIngestionRunInput): AutonomousIngestionResult {
  const sourcePolicy = sourcePolicyForRun('gpt_monitor', input.sourceId, input.sourcePolicy)
  const normalizedInput: HardenedMonitorIngestionRunInput = { ...input, sourcePolicy }

  // Preserve run-level idempotency before creating a temporary re-evaluation view.
  const completedRun = (snapshot.data.timeline ?? []).some((item) =>
    item.ingestionRun?.sourceKind === 'gpt_monitor' &&
    item.ingestionRun.sourceId === normalizedInput.sourceId &&
    item.ingestionRun.runId === normalizedInput.runId,
  )
  if (completedRun) return applyMonitorIngestion(snapshot, normalizedInput)

  const unverified = normalizedInput.observations.filter((item) => item.sourceVerification !== 'verified')
  const unverifiedIds = new Set(unverified.map((item) => item.sourceRecordId))
  const ambiguous = normalizedInput.observations.filter((item) =>
    !unverifiedIds.has(item.sourceRecordId) &&
    monitorObservationIsAmbiguous(item, snapshot.data.opportunities),
  )
  const ambiguousIds = new Set(ambiguous.map((item) => item.sourceRecordId))

  // Discovery quality gates decide whether a NEW Opportunity may be created.
  // Once a logical job already exists, public-source facts such as a changed
  // deadline or postingStatus=closed must still refresh its posting evidence.
  // This never changes the user's recruiting process stage.
  const existingRefreshes = normalizedInput.observations.filter((observation) => {
    const receivedAt = observation.discoveredAt ?? normalizedInput.completedAt
    if (unverifiedIds.has(observation.sourceRecordId) || ambiguousIds.has(observation.sourceRecordId)) return false
    if (!observation.sourceRecordId.trim() || !observation.company.trim() || !observation.role.trim() || !validIso(receivedAt)) return false
    return Boolean(findSimilarOpportunity(observation, snapshot.data.opportunities))
  })
  const existingIds = new Set(existingRefreshes.map((item) => item.sourceRecordId))
  const baseObservations = normalizedInput.observations.filter((item) =>
    !unverifiedIds.has(item.sourceRecordId) &&
    !ambiguousIds.has(item.sourceRecordId) &&
    !existingIds.has(item.sourceRecordId),
  )

  // A stable sourceRecordId identifies a posting, not an immutable observation.
  // If its source fingerprint changes in a later run, re-evaluate it instead of
  // permanently treating the posting as duplicate. Historical ledger rows are
  // restored after the current run is evaluated.
  const changedPriorIds = new Set<string>()
  for (const observation of baseObservations) {
    const previous = alreadyIngested(snapshot.data.timeline, {
      sourceKind: 'gpt_monitor', sourceId: normalizedInput.sourceId, sourceRecordId: observation.sourceRecordId,
    })
    if (previous?.ingestion?.outcome && previous.ingestion.outcome !== 'unresolved' && previous.ingestion.fingerprint !== monitorFingerprint(observation)) {
      changedPriorIds.add(observation.sourceRecordId)
    }
  }
  const historicalRecords = (snapshot.data.timeline ?? []).filter((item) =>
    item.ingestion?.sourceKind === 'gpt_monitor' &&
    item.ingestion.sourceId === normalizedInput.sourceId &&
    changedPriorIds.has(item.ingestion.sourceRecordId),
  )
  const workingSnapshot = structuredClone(snapshot)
  if (historicalRecords.length) {
    const removedIds = new Set(historicalRecords.map((item) => item.id))
    workingSnapshot.data.timeline = (workingSnapshot.data.timeline ?? []).filter((item) => !removedIds.has(item.id))
  }

  if (unverified.length === 0 && ambiguous.length === 0 && existingRefreshes.length === 0 && historicalRecords.length === 0) {
    const base = applyMonitorIngestion(snapshot, normalizedInput)
    return attachRunPolicy(base, normalizedInput, 'gpt_monitor')
  }

  const base = applyMonitorIngestion(workingSnapshot, {
    ...normalizedInput,
    observations: baseObservations,
  })
  if (base.alreadyApplied) return base

  const next = structuredClone(base.snapshot)
  const timeline = next.data.timeline ?? []
  for (const historical of historicalRecords) {
    if (!timeline.some((item) => item.id === historical.id)) timeline.push(historical)
  }
  const records = [...base.records]
  const touched = new Set(base.touchedOpportunityIds)

  for (const observation of existingRefreshes) {
    const receivedAt = observation.discoveredAt ?? normalizedInput.completedAt
    const currentFingerprint = monitorFingerprint(observation)
    const previous = alreadyIngested(snapshot.data.timeline, {
      sourceKind: 'gpt_monitor', sourceId: normalizedInput.sourceId, sourceRecordId: observation.sourceRecordId,
    })
    const duplicate = Boolean(
      previous?.ingestion?.outcome &&
      previous.ingestion.outcome !== 'unresolved' &&
      previous.ingestion.fingerprint === currentFingerprint,
    )
    let outcome: 'merged' | 'duplicate' | 'unresolved' = duplicate ? 'duplicate' : 'unresolved'
    let reason = duplicate ? `来源记录 ${observation.sourceRecordId} 的当前事实已在先前 run 对账。` : undefined
    let opportunityId = duplicate ? previous?.ingestion?.opportunityId : undefined

    if (!duplicate) {
      const existing = findSimilarOpportunity(observation, next.data.opportunities)
      if (!existing) {
        reason = '现有逻辑岗位在并发归并期间无法唯一解析；已保留为 unresolved。'
      } else {
        const merged = mergeExistingMonitorObservation(existing, observation, receivedAt)
        const index = next.data.opportunities.findIndex((item) => item.id === existing.id)
        next.data.opportunities[index] = merged.opportunity
        opportunityId = existing.id
        outcome = merged.changed ? 'merged' : 'duplicate'
        if (merged.changed) touched.add(existing.id)
        reason = merged.changed
          ? '已归并到现有逻辑岗位并更新公开来源事实；岗位页面生命周期不改变用户招聘流程。'
          : '现有逻辑岗位已包含相同来源事实。'
      }
    }

    const record = createIngestionLedgerTimeline({
      sourceKind: 'gpt_monitor', sourceId: normalizedInput.sourceId, sourceRecordId: observation.sourceRecordId,
      runId: normalizedInput.runId, recordType: 'job_observation', outcome,
      fingerprint: currentFingerprint, receivedAt, accountedAt: normalizedInput.completedAt,
      reason, opportunityId,
      company: observation.company, role: observation.role, sourceRef: observation.sourceUrl,
    })
    records.push(record)
    timeline.push(record)
  }

  for (const observation of unverified) {
    const currentFingerprint = monitorFingerprint(observation)
    const previous = alreadyIngested(snapshot.data.timeline, {
      sourceKind: 'gpt_monitor',
      sourceId: normalizedInput.sourceId,
      sourceRecordId: observation.sourceRecordId,
    })
    const record = createIngestionLedgerTimeline({
      sourceKind: 'gpt_monitor',
      sourceId: normalizedInput.sourceId,
      sourceRecordId: observation.sourceRecordId,
      runId: normalizedInput.runId,
      recordType: 'job_observation',
      outcome: 'unresolved',
      fingerprint: currentFingerprint,
      receivedAt: observation.discoveredAt ?? normalizedInput.completedAt,
      accountedAt: normalizedInput.completedAt,
      reason: observation.sourceVerificationReason?.trim()
        ? `公开来源尚未通过独立核验：${observation.sourceVerificationReason.trim().slice(0, 500)}`
        : '公开来源尚未通过独立核验；模型输出不会自动升级为 PJSDAS 来源事实。',
      opportunityId: previous?.ingestion?.opportunityId,
      company: observation.company,
      role: observation.role,
      sourceRef: observation.sourceUrl,
    })
    records.push(record)
    timeline.push(record)
  }

  for (const observation of ambiguous) {
    const currentFingerprint = monitorFingerprint(observation)
    const previous = alreadyIngested(snapshot.data.timeline, { sourceKind: 'gpt_monitor', sourceId: normalizedInput.sourceId, sourceRecordId: observation.sourceRecordId })
    const duplicate = Boolean(
      previous?.ingestion?.outcome &&
      previous.ingestion.outcome !== 'unresolved' &&
      previous.ingestion.fingerprint === currentFingerprint,
    )
    const record = createIngestionLedgerTimeline({
      sourceKind: 'gpt_monitor', sourceId: normalizedInput.sourceId, sourceRecordId: observation.sourceRecordId,
      runId: normalizedInput.runId, recordType: 'job_observation', outcome: duplicate ? 'duplicate' : 'unresolved',
      fingerprint: currentFingerprint, receivedAt: observation.discoveredAt ?? normalizedInput.completedAt, accountedAt: normalizedInput.completedAt,
      reason: duplicate ? `来源记录 ${observation.sourceRecordId} 的当前事实已在先前 run 对账。` : '同一公司存在多个高度相似的现有 Opportunity；为避免错误归并，本次自动摄入停止并保留为 unresolved。',
      opportunityId: duplicate ? previous?.ingestion?.opportunityId : undefined,
      company: observation.company, role: observation.role, sourceRef: observation.sourceUrl,
    })
    records.push(record)
    timeline.push(record)
  }
  const run = replaceRunTimeline(next, normalizedInput, 'gpt_monitor', records)
  next.exportedAt = normalizedInput.completedAt
  validateSnapshot(next)
  return { ...base, snapshot: next, run, records, touchedOpportunityIds: [...touched] }
}

function logicalEventId(sourceId: string, eventKey: string) {
  return `gmail-logical-event:${stableIngestionHash(`${sourceId}|${eventKey}`)}`
}
function actionIdForEvent(eventId: string) { return `event-action:${eventId}` }
function updateTimelinePointers(timeline: TimelineRecord[], oldEventId: string, newEventId: string, oldActionId?: string, newActionId?: string) {
  for (const item of timeline) {
    if (item.processEventId === oldEventId) item.processEventId = newEventId
    if (item.ingestion?.processEventId === oldEventId) item.ingestion.processEventId = newEventId
    if (oldActionId && newActionId && item.actionId === oldActionId) item.actionId = newActionId
    if (oldActionId && newActionId && item.ingestion?.actionId === oldActionId) item.ingestion.actionId = newActionId
  }
}

function reconcileLogicalGmailEvents(result: AutonomousIngestionResult, input: HardenedGmailIngestionRunInput) {
  const next = structuredClone(result.snapshot)
  const timeline = next.data.timeline ?? []
  for (const message of [...input.messages].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))) {
    const eventKey = message.eventKey?.trim()
    if (!eventKey || !message.eventType || message.classification !== 'recruiting' || message.confidence !== 'high') continue
    const ledger = timeline.find((item) => item.ingestion?.sourceKind === 'gmail' && item.ingestion.sourceId === input.sourceId && item.ingestion.runId === input.runId && item.ingestion.sourceRecordId === message.sourceRecordId)
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
      } else updateTimelinePointers(timeline, oldEventId, canonicalId)
    } else if (canonical && created && created.id !== canonical.id) {
      const oldEventId = created.id
      const oldAction = next.data.actions.find((item) => item.processEventId === oldEventId)
      next.data.processEvents = next.data.processEvents.filter((item) => item.id !== oldEventId)
      if (oldAction) next.data.actions = next.data.actions.filter((item) => item.id !== oldAction.id)
      next.data.timeline = timeline.filter((item) => !(item.kind === 'process_event_recorded' && item.processEventId === oldEventId))
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
      if (generated) { next.data.actions.push(generated); action = generated }
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
        ledger.ingestion.reason = message.eventState === 'completed' ? '同一 Gmail 逻辑事件已标记完成。' : message.eventState === 'cancelled' ? '同一 Gmail 逻辑事件已标记取消。' : '同一 Gmail 逻辑事件的时间/安排已更新。'
      }
    }
  }

  const records = (next.data.timeline ?? []).filter((item) => item.ingestion?.sourceKind === 'gmail' && item.ingestion.sourceId === input.sourceId && item.ingestion.runId === input.runId)
  const run = replaceRunTimeline(next, input, 'gmail', records, input.cursor)
  next.exportedAt = input.completedAt
  validateSnapshot(next)
  return { ...result, snapshot: next, run, records }
}

export function applyGmailIngestionHardened(snapshot: PJSDASSnapshot, input: HardenedGmailIngestionRunInput): AutonomousIngestionResult {
  const sourcePolicy = sourcePolicyForRun('gmail', input.sourceId, input.sourcePolicy)
  const normalized: HardenedGmailIngestionRunInput = {
    ...input,
    sourcePolicy,
    messages: input.messages.map((message) => {
      if (message.eventState && message.eventState !== 'scheduled' && !message.eventKey?.trim()) {
        return { ...message, confidence: 'medium', notes: [message.notes?.trim(), '事件更新缺少稳定 eventKey；为避免重复/误完成，自动写入已停止。'].filter(Boolean).join('；') }
      }
      return message
    }),
  }
  const base = applyGmailIngestion(snapshot, normalized as GmailIngestionRunInput)
  if (base.alreadyApplied) return base
  return reconcileLogicalGmailEvents(base, normalized)
}
