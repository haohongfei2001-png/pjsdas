import type { IngestionIssueKind, SemanticIntakeObservation, TimelineRecord } from './model.js'
import type { PJSDASSnapshot } from './snapshot.js'
import { applySemanticIntake, semanticCandidateFactKey, type SemanticBatchCompensation } from './semanticIntake.js'
import { alreadyIngested, buildIngestionRunSummary, createIngestionLedgerTimeline, createIngestionRunTimeline, stableIngestionHash } from './ingestion.js'
import { bootstrapPolicyFor } from './sourceRegistry.js'

export interface GmailSemanticRecord {
  observation: SemanticIntakeObservation
  receivedAt: string
  /** True when the bounded Gmail parser classified the source message as recruiting-related even if it requires no action. */
  recruitingRelevant?: boolean
  gaps: string[]
  capabilityBoundaries?: string[]
  issueKinds?: IngestionIssueKind[]
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
  for (const record of [...input.records].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))) {
    // Accounting a source as unresolved must not still commit its parsed
    // prefix. A later, unparsed fragment may negate or qualify that outcome.
    const incomplete = record.issueKinds?.includes('interpretation_failure')
    const observation = incomplete ? { ...record.observation, candidates: [] } : record.observation
    const sourceRecordId = observation.source.sourceRecordId
    // Preserve pre-UU06 consumption, including unresolved historical evidence. A new
    // interpreter is not permission to replay old consumed mail as a new business fact.
    const prior = alreadyIngested(working.data.timeline, { sourceKind: 'gmail', sourceId: input.sourceId, sourceRecordId })
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
    const answeredCurrentChoices = result?.status === 'ALREADY_APPLIED'
      && priorIssues.length > 0
      && priorIssues.every(kind => kind === 'business_ambiguity')
      && observation.candidates.length > 0
      && observation.candidates.every(candidate => {
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
          && result.receipt.factKeys?.includes(factKey)
          && !result.receipt.factInvalidations?.some(item => item.factKey === factKey))
      })
    // Only this invocation's semantic work can prove that a formerly bounded
    // source was fully re-evaluated. ALREADY_APPLIED can refer to a receipt
    // created by an older, gapful parser version and is therefore not fresh
    // completeness evidence.
    const conclusiveSemanticReplay = (result?.status === 'NO_WRITE' || result?.status === 'APPLIED' || answeredCurrentChoices)
      && !result.coverageDebtCount
    const reconciledPriorUnresolved = Boolean(
      input.reconcileExisting
      && prior?.ingestion?.outcome === 'unresolved'
      && record.gaps.length === 0
      && activeDecisionRequests.length === 0
      && conclusiveSemanticReplay,
    )
    const unresolved = record.gaps.length > 0
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
      && (record.gaps.length > 0
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
