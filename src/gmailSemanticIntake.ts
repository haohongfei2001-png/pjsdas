import { sameSemanticFactKey } from './opportunityCanonicalization.js'
import { dismissedSemanticCandidate } from './decisionDismissal.js'
import type { IngestionIssueKind, SemanticIntakeObservation, TimelineRecord } from './model.js'
import type { PJSDASSnapshot } from './snapshot.js'
import { applySemanticIntake, semanticCandidateFactKey, type SemanticBatchCompensation } from './semanticIntake.js'
import { alreadyIngested, buildIngestionRunSummary, createIngestionLedgerTimeline, createIngestionRunTimeline, stableIngestionHash } from './ingestion.js'
import { bootstrapPolicyFor } from './sourceRegistry.js'
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
    const record = bindPendingInterview(sourceRecord, working, prior, input.sourceId, input.checkedAt)
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
