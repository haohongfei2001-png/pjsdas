import { sameSemanticFactKey } from './opportunityCanonicalization.js'
import { dismissedSemanticCandidate } from './decisionDismissal.js'
import type { IngestionIssueKind, ScheduleNodeTemporal, SemanticIntakeObservation, SemanticIntakeReceipt, TimelineRecord } from './model.js'
import type { PJSDASSnapshot } from './snapshot.js'
import { applySemanticIntake, semanticCandidateFactKey, type SemanticBatchCompensation } from './semanticIntake.js'
import { alreadyIngested, buildIngestionRunSummary, createIngestionLedgerTimeline, createIngestionRunTimeline, stableIngestionHash } from './ingestion.js'
import { bootstrapPolicyFor } from './sourceRegistry.js'
import { validPlanningTimezone } from './timePlanningPreferences.js'
import { readImportedInterviewReschedule } from './boundInterviewReschedule.js'

export const GMAIL_RESCHEDULE_TIME_GAP = 'Reschedule lacks an unambiguous full date/time; the existing occurrence was preserved.'

export interface GmailSemanticRecord {
  observation: SemanticIntakeObservation
  receivedAt: string
  /** True when the bounded Gmail parser classified the source message as recruiting-related even if it requires no action. */
  recruitingRelevant?: boolean
  gaps: string[]
  capabilityBoundaries?: string[]
  issueKinds?: IngestionIssueKind[]
  /** Bounded current-body evidence only, never persisted. Bind after earlier
   * records in this batch have passed through the shared authoritative core. */
  pendingInterviewReschedule?: { text: string; opportunityId: string }
}

function bindPendingInterview(record: GmailSemanticRecord, snapshot: PJSDASSnapshot, prior: TimelineRecord | undefined, sourceId: string, checkedAt: string) {
  const pending = record.pendingInterviewReschedule, observation = record.observation
  if (!pending || observation.statementMode !== 'assertion' || observation.source.kind !== 'gmail'
    || observation.candidates.length || record.issueKinds?.includes('interpretation_failure')
    || observation.source.sourceId !== sourceId || !Number.isFinite(Date.parse(record.receivedAt))
    || Date.parse(record.receivedAt) !== Date.parse(observation.source.assertedAt ?? '')
    || Date.parse(record.receivedAt) > Date.parse(checkedAt)
    || !record.gaps.includes(GMAIL_RESCHEDULE_TIME_GAP)) return record
  // A consumed exact source does not become ambiguous merely because its own
  // successful reschedule changed the old-time precondition. Never replay it.
  const consumed = prior?.ingestion?.outcome !== 'unresolved' && Boolean(prior?.ingestion)
    && prior!.ingestion!.fingerprint === observation.originalTextFingerprint
  // This grammar contains two complete absolute dates. Current eligibility is
  // checked at processing time; the source's original fact clock stays below.
  const candidate = consumed ? undefined : readImportedInterviewReschedule(pending.text, snapshot,
    new Date(checkedAt), observation.source.timezone)
  if (!consumed && (!candidate || candidate.target?.opportunityId !== pending.opportunityId)) return record
  const gaps = record.gaps.filter(gap => gap !== GMAIL_RESCHEDULE_TIME_GAP)
  return { ...record, gaps, issueKinds: record.issueKinds?.filter(kind => kind !== 'business_ambiguity' || gaps.length > 0),
    observation: { ...observation, candidates: candidate ? [{ ...candidate, id: 'fragment:0',
      objectConfidence: 'high' as const, eventConfidence: 'high' as const, temporalConfidence: 'high' as const,
      evidenceRefs: [`${observation.source.sourceId}:${observation.source.sourceRecordId}:fragment:0`],
      sourceVersionRefs: [`${observation.source.sourceRecordId}:${observation.source.sourceVersion}`] }] : [] } }
}

function receiptBindsTemporal(key: string, temporal: ScheduleNodeTemporal) {
  const marker = key.indexOf('|[')
  if (marker < 0) return false
  const instant = (value: string | undefined) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : value ?? ''
  const suffix = JSON.stringify([temporal.shape, temporal.precision, instant(temporal.startAt),
    instant(temporal.endAt), instant(temporal.deadlineAt), temporal.date ?? ''])
    // A legacy key binds the base time but not latest-start. This proves only
    // its historical timezone; the shared core still validates latest identity.
    + (key.includes('|latestStartAt:') && temporal.latestStartAt ? `|latestStartAt:${instant(temporal.latestStartAt)}` : '')
  return key.slice(marker + 1) === suffix
}

/** Legacy dueAt-only decisions materialized source-offset nodes, not the
 * original IANA zone. Prove that zone from this exact historical resolution;
 * this is provenance only and grants no current answer or recovery authority. */
function legacyDecisionTimezone(record: GmailSemanticRecord, snapshot: PJSDASSnapshot, receipt: SemanticIntakeReceipt, key: string, refs: SemanticIntakeReceipt['affectedObjects']) {
  if (receipt.status !== 'committed' && receipt.status !== 'undone') return undefined
  for (const id of receipt.decisionRequestIds) {
    const request = snapshot.data.decisionRequests?.find(item => item.id === id)
    if (!request) continue
    const binding = request.payloadBinding, source = binding.source, candidate = binding.candidate
    if (candidate.kind !== 'process_event' || candidate.temporal || candidate.duePrecision !== 'datetime'
      || !candidate.dueAt || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(candidate.dueAt) || !Number.isFinite(Date.parse(candidate.dueAt))
      || source.kind !== receipt.sourceKind || source.sourceId !== receipt.sourceId || source.sourceRecordId !== receipt.sourceRecordId
      || source.sourceVersion !== receipt.sourceVersion || !validPlanningTimezone(source.timezone)
      || !binding.originalTextFingerprint || binding.originalTextFingerprint !== record.observation.originalTextFingerprint) continue
    const choice = request.choices.find(item => item.resolution && !item.resolution.dismiss
      && receipt.inputId === `decision-resolution:${request.id}:${item.id}`
      && receipt.commandId === `semantic-decision:${request.id}:${item.id}`)
    if (!choice?.resolution || (receipt.status === 'committed' && (request.state !== 'answered' || request.answerChoiceId !== choice.id))) continue
    const resolved = { ...candidate, target: { ...candidate.target,
      ...(choice.resolution.opportunityId ? { opportunityId: choice.resolution.opportunityId } : {}),
      ...(choice.resolution.occurrenceId ? { occurrenceId: choice.resolution.occurrenceId } : {}) } }
    if (semanticCandidateFactKey(snapshot, resolved) !== key) continue
    const opportunityId = resolved.target.opportunityId
    if (!opportunityId) continue
    const expectedKind = candidate.eventType === 'assessment_invite' ? 'assessment' : candidate.eventType === 'written_test_invite' ? 'written_test' : candidate.eventType === 'interview_invite' ? 'interview' : undefined
    const sameInstant = (value: string | undefined) => Boolean(value && Number.isFinite(Date.parse(value)) && Date.parse(value) === Date.parse(candidate.dueAt!))
    const objectProof = refs.some(ref => {
      if (ref.type === 'process_event') {
        const event = snapshot.data.processEvents.find(item => item.id === ref.id)
        return event?.opportunityId === opportunityId && event.type === candidate.eventType
          && !event.temporal && event.duePrecision === candidate.duePrecision && sameInstant(event.dueAt)
      }
      if (ref.type !== 'schedule_node') return false
      const node = snapshot.data.scheduleNodes?.find(item => item.id === ref.id)
      if (!node || !expectedKind) return false
      const temporal = node.temporal
      return node.kind === expectedKind && node.opportunityId === opportunityId && Boolean(node.processEventId && refs.some(item => item.type === 'process_event' && item.id === node.processEventId))
        && temporal?.shape === 'fixed_range' && temporal.precision === 'datetime' && sameInstant(temporal.startAt)
        && !temporal.endAt && !temporal.deadlineAt && !temporal.latestStartAt && !temporal.date
    })
    if (objectProof) return source.timezone
  }
  return undefined
}

/** A new parser version is not permission to reinterpret an already consumed
 * source under today's account preference. Use exact historical receipt refs
 * and value-bound temporal keys, never follow an old occurrence to its latest
 * node or use a later edited event as proof of the original interpretation. */
function preserveConsumedTimezone(record: GmailSemanticRecord, snapshot: PJSDASSnapshot) {
  if (!record.pendingInterviewReschedule && !record.observation.candidates.some(candidate =>
    candidate.kind === 'occurrence_rescheduled' || candidate.kind === 'process_event' && (candidate.temporal || candidate.dueAt))) return record
  const source = record.observation.source
  const zones = new Set<string>(), provenKeys = new Set<string>()
  let hasTimedFact = false, unknownProof = false
  for (const receipt of snapshot.data.semanticReceipts ?? []) {
    if (receipt.sourceKind !== 'gmail' || receipt.sourceId !== source.sourceId || receipt.sourceRecordId !== source.sourceRecordId) continue
    for (const key of receipt.factKeys ?? []) {
      if (!/^(?:process_event|occurrence_rescheduled)\|/.test(key) || !/\|\[[^\]]*\d{4}-\d{2}-\d{2}/.test(key)) continue
      hasTimedFact = true
      const refs = receipt.factMutationObjects ? receipt.factMutationObjects[key] ?? [] : receipt.affectedObjects
      const exact = refs.flatMap(ref => {
        if (ref.type === 'schedule_node') {
          const node = snapshot.data.scheduleNodes?.find(item => item.id === ref.id)
          return node ? [node.temporal] : []
        }
        if (ref.type === 'process_event') {
          const event = snapshot.data.processEvents.find(item => item.id === ref.id)
          return event?.temporal ? [event.temporal] : []
        }
        return []
      }).filter(temporal => receiptBindsTemporal(key, temporal) && validPlanningTimezone(temporal.timezone))
      const legacyZone = exact.length ? undefined : legacyDecisionTimezone(record, snapshot, receipt, key, refs)
      if (!exact.length && !legacyZone) unknownProof = true
      if (legacyZone) zones.add(legacyZone)
      if (exact.length) provenKeys.add(key)
      for (const temporal of exact) zones.add(temporal.timezone)
    }
  }
  if (!hasTimedFact) {
    // Pre-UU06 consumption has a source-bound ledger/event link, but no
    // semantic source-zone receipt. A projected source-offset is not an IANA
    // proof. Keep that timed history unresolved instead of replaying it in the
    // owner's new zone. No-fact/unresolved legacy mail may still be interpreted.
    const legacyTimed = (snapshot.data.timeline ?? []).some(row => {
      const entry = row.ingestion
      if (entry?.sourceKind !== 'gmail' || entry.sourceId !== source.sourceId
        || entry.sourceRecordId !== source.sourceRecordId || !entry.processEventId) return false
      const event = snapshot.data.processEvents.find(item => item.id === entry.processEventId)
      const timing = (temporal: ScheduleNodeTemporal | undefined) => Boolean(temporal?.startAt || temporal?.endAt || temporal?.deadlineAt || temporal?.date)
      return Boolean(event?.dueAt || timing(event?.temporal))
        || Boolean(snapshot.data.scheduleNodes?.some(node => node.processEventId === entry.processEventId && timing(node.temporal)))
    })
    if (legacyTimed) { hasTimedFact = true; unknownProof = true }
  }
  // Explicit source-zone facts can remain byte-identical even when today's
  // workspace preference differs. Full value-bound keys prove no timing was
  // reinterpreted, including mixed-zone messages. Admission/Undo still run below.
  const timed = record.observation.candidates.filter(candidate => candidate.kind === 'occurrence_rescheduled'
    || candidate.kind === 'process_event' && (candidate.temporal || candidate.dueAt))
  const unchanged = !record.pendingInterviewReschedule && timed.length > 0
    && timed.every(candidate => {
      const key = semanticCandidateFactKey(snapshot, candidate)
      return key !== undefined && provenKeys.has(key)
    })
  if (!hasTimedFact || !unknownProof && (unchanged || zones.size === 1 && zones.has(source.timezone))) return record
  return { ...record,
    gaps: [...record.gaps, 'The consumed message timing cannot be reinterpreted in the current workspace timezone; its existing arrangement was retained and needs a fresh confirmed notice.'],
    issueKinds: [...new Set([...(record.issueKinds ?? []), 'interpretation_failure' as const])],
  }
}

/** Source accounting surrounds the shared policy; this adapter never changes business state itself. */
export function applyGmailSemanticBatch(snapshot: PJSDASSnapshot, input: {
  runId: string
  sourceId: string
  checkedAt: string
  cursor?: string
  records: GmailSemanticRecord[]
  authorized: boolean
  workspaceRevision?: string
  /** Re-run semantic interpretation for an already-accounted Gmail record without replaying unchanged business facts. */
  reconcileExisting?: boolean
}) {
  if (!input.authorized) throw new Error('Gmail source is not authorized for writes.')
  let working = structuredClone(snapshot)
  const records: TimelineRecord[] = []
  let persistedSourceRecords = 0
  const compensation: SemanticBatchCompensation = {
    operation: 'semantic_batch', payload: { domainCompensations: [], decisionRequestIds: [], receiptIds: [] },
  }
  const priorRun = (snapshot.data.timeline ?? []).find((item) => item.ingestionRun?.runId === input.runId
    && item.ingestionRun.sourceKind === 'gmail' && item.ingestionRun.sourceId === input.sourceId)?.ingestionRun
  if (priorRun) return { snapshot, run: priorRun, compensation, alreadyApplied: true }
  for (const sourceRecord of [...input.records].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))) {
    const prior = alreadyIngested(working.data.timeline, { sourceKind: 'gmail', sourceId: input.sourceId,
      sourceRecordId: sourceRecord.observation.source.sourceRecordId })
    const protectedSource = prior && input.reconcileExisting ? preserveConsumedTimezone(sourceRecord, working) : sourceRecord
    const record = bindPendingInterview(protectedSource, working, prior, input.sourceId, input.checkedAt)
    // Accounting a source as unresolved must not still commit its parsed
    // prefix. A later, unparsed fragment may negate or qualify that outcome.
    const independentGap = record.gaps.length > 0 || Boolean(record.issueKinds?.some(kind => kind !== 'business_ambiguity'))
    const incomplete = record.issueKinds?.includes('interpretation_failure')
    const observation = incomplete ? { ...record.observation, candidates: [] } : record.observation
    const sourceRecordId = observation.source.sourceRecordId
    // Preserve pre-UU06 consumption, including unresolved historical evidence. A new
    // interpreter is not permission to replay old consumed mail as a new business fact.
    const result = prior && !input.reconcileExisting ? undefined : applySemanticIntake(working, observation, {
      authorized: true, now: new Date(input.checkedAt), workspaceRevision: input.workspaceRevision,
    })
    if (result) working = result.snapshot
    if (result?.compensation) {
      compensation.payload.domainCompensations.push(...result.compensation.payload.domainCompensations)
      compensation.payload.decisionRequestIds.push(...result.compensation.payload.decisionRequestIds)
      compensation.payload.receiptIds.push(...result.compensation.payload.receiptIds)
      for (const previous of result.compensation.payload.restoreDecisionRequests ?? []) {
        // A request created earlier in this same batch did not exist before
        // the batch, so undo must retire it rather than restore it as open.
        if (compensation.payload.decisionRequestIds.includes(previous.id)) continue
        compensation.payload.restoreDecisionRequests ??= []
        if (!compensation.payload.restoreDecisionRequests.some(item => item.id === previous.id)) {
          compensation.payload.restoreDecisionRequests.push(previous)
        }
      }
      for (const receipt of working.data.semanticReceipts ?? []) {
        if (result.compensation.payload.receiptIds.includes(receipt.id)) receipt.commandId = input.runId
      }
    }
    const activeDecisionRequests = (working.data.decisionRequests ?? []).filter((request) =>
      request.payloadBinding.source.kind === 'gmail'
      && request.payloadBinding.source.sourceId === input.sourceId
      && request.payloadBinding.source.sourceRecordId === sourceRecordId
      && (request.state === 'open' || request.state === 'expired'))
    const priorIssues = prior?.ingestion?.issueKinds ?? []
    const settledCurrentChoices = result?.status === 'ALREADY_APPLIED'
      && priorIssues.length > 0
      && priorIssues.every(kind => kind === 'business_ambiguity')
      && observation.candidates.length > 0
      && observation.candidates.every(candidate => {
        if (dismissedSemanticCandidate(working, observation, candidate)) {
          return Boolean(result.receipt?.decisionRequestIds.length
            && result.receipt.decisionRequestIds.every(id => working.data.decisionRequests?.some(request => request.id === id
              && request.payloadBinding.source.kind === observation.source.kind
              && request.payloadBinding.source.sourceId === observation.source.sourceId
              && request.payloadBinding.source.sourceRecordId === sourceRecordId
              && request.payloadBinding.source.sourceVersion === observation.source.sourceVersion))
            && prior?.ingestion?.reason === result.receipt.summary)
        }
        const answered = (working.data.decisionRequests ?? []).some(request =>
          request.state === 'answered'
          && request.payloadBinding.source.kind === 'gmail'
          && request.payloadBinding.source.sourceId === input.sourceId
          && request.payloadBinding.source.sourceRecordId === sourceRecordId
          && request.payloadBinding.source.sourceVersion === observation.source.sourceVersion
          && request.payloadBinding.inputId === observation.inputId
          && request.payloadBinding.candidateId === candidate.id
          && JSON.stringify({ ...request.payloadBinding.candidate, sourceVersionRefs: undefined })
            === JSON.stringify({ ...candidate, sourceVersionRefs: undefined }))
        if (answered) return true
        const factKey = semanticCandidateFactKey(working, candidate)
        return Boolean(result.receipt?.status === 'committed' && factKey
          && result.receipt.factKeys?.some(key => sameSemanticFactKey(working, key, factKey))
          && !result.receipt.factInvalidations?.some(item => sameSemanticFactKey(working, item.factKey, factKey)))
      })
    // Only this invocation's semantic work can prove that a formerly bounded
    // source was fully re-evaluated. ALREADY_APPLIED can refer to a receipt
    // created by an older, gapful parser version and is therefore not fresh
    // completeness evidence.
    const conclusiveSemanticReplay = (result?.status === 'NO_WRITE' || result?.status === 'APPLIED' || settledCurrentChoices)
      && !result.coverageDebtCount
    const reconciledPriorUnresolved = Boolean(
      input.reconcileExisting
      && prior?.ingestion?.outcome === 'unresolved'
      && !independentGap
      && activeDecisionRequests.length === 0
      && conclusiveSemanticReplay,
    )
    const unresolved = independentGap
      || Boolean(result?.coverageDebtCount)
      || activeDecisionRequests.length > 0
      || (prior?.ingestion?.outcome === 'unresolved' && !reconciledPriorUnresolved)
    const issueKinds = [...new Set([
      ...(record.issueKinds ?? []),
      ...(result?.coverageDebtCount ? ['interpretation_failure' as const] : []),
      ...(activeDecisionRequests.length ? ['business_ambiguity' as const] : []),
      ...(prior?.ingestion?.issueKinds ?? []),
    ])]
    const checkedAtMs = Date.parse(input.checkedAt)
    const priorAccountedMs = Date.parse(prior?.ingestion?.accountedAt ?? '')
    const accountedAt = input.reconcileExisting && prior
      && Number.isFinite(checkedAtMs) && Number.isFinite(priorAccountedMs)
      ? new Date(Math.max(checkedAtMs, priorAccountedMs + 1)).toISOString()
      : input.checkedAt
    const entry = createIngestionLedgerTimeline({
      sourceKind: 'gmail', sourceId: input.sourceId, sourceRecordId,
      runId: input.runId, recordType: 'recruiting_message',
      outcome: unresolved
        ? 'unresolved'
        : input.reconcileExisting && result?.status === 'NO_WRITE'
          ? 'ignored'
          : result?.status === 'APPLIED'
            ? 'updated'
            : prior || result?.status === 'ALREADY_APPLIED'
              ? 'duplicate'
              : 'ignored',
      fingerprint: observation.originalTextFingerprint ?? stableIngestionHash(sourceRecordId),
      receivedAt: record.receivedAt, accountedAt,
      reason: record.gaps.length ? record.gaps.join(' ') : result?.summary ?? prior?.ingestion?.reason ?? 'Previously consumed Gmail source record; no business replay.',
      capabilityBoundaries: record.capabilityBoundaries ?? prior?.ingestion?.capabilityBoundaries,
      issueKinds: unresolved ? issueKinds : undefined,
      sourceRef: `gmail:${sourceRecordId}`,
    })
    records.push(entry)
    const persistReconciliationChange = Boolean(input.reconcileExisting
      && (independentGap
        || Boolean(result?.coverageDebtCount)
        || result?.status === 'APPLIED'
        || result?.status === 'DECISION_REQUIRED'
        || reconciledPriorUnresolved))
    const priorIssueKinds = [...(prior?.ingestion?.issueKinds ?? [])].sort().join('|')
    const nextIssueKinds = [...(entry.ingestion?.issueKinds ?? [])].sort().join('|')
    const sourceStateChanged = !prior
      || prior.ingestion?.outcome !== entry.ingestion?.outcome
      || prior.ingestion?.reason !== entry.ingestion?.reason
      || priorIssueKinds !== nextIssueKinds
    if (!prior || (persistReconciliationChange && (sourceStateChanged || (result?.status === 'APPLIED' && result.changed)))) {
      working.data.timeline = [...(working.data.timeline ?? []), entry]
      persistedSourceRecords += 1
    }
  }
  const run = buildIngestionRunSummary({
    runId: input.runId, sourceKind: 'gmail', sourceId: input.sourceId,
    startedAt: input.checkedAt, completedAt: input.checkedAt, cursor: input.cursor,
    records, sourcePolicy: bootstrapPolicyFor('gmail', input.sourceId),
  })
  if (!input.reconcileExisting && input.records.length > 0 && persistedSourceRecords === 0) {
    return { snapshot, run, compensation, alreadyApplied: true }
  }
  working.data.timeline = [...(working.data.timeline ?? []), createIngestionRunTimeline(run)]
  working.exportedAt = input.checkedAt
  return { snapshot: working, run, compensation, alreadyApplied: false }
}
