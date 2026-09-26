import type { IngestionIssueKind, SemanticIntakeObservation, TimelineRecord } from './model.js'
import type { PJSDASSnapshot } from './snapshot.js'
import { applySemanticIntake, type SemanticBatchCompensation } from './semanticIntake.js'
import { alreadyIngested, buildIngestionRunSummary, createIngestionLedgerTimeline, createIngestionRunTimeline, stableIngestionHash } from './ingestion.js'
import { bootstrapPolicyFor } from './sourceRegistry.js'

export interface GmailSemanticRecord {
  observation: SemanticIntakeObservation
  receivedAt: string
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
    const observation = record.observation
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
      for (const receipt of working.data.semanticReceipts ?? []) {
        if (result.compensation.payload.receiptIds.includes(receipt.id)) receipt.commandId = input.runId
      }
    }
    const unresolved = record.gaps.length > 0 || Boolean(result?.decisionRequests.length) || prior?.ingestion?.outcome === 'unresolved'
    const issueKinds = [...new Set([
      ...(record.issueKinds ?? []),
      ...(result?.decisionRequests.length ? ['business_ambiguity' as const] : []),
      ...(prior?.ingestion?.issueKinds ?? []),
    ])]
    const entry = createIngestionLedgerTimeline({
      sourceKind: 'gmail', sourceId: input.sourceId, sourceRecordId,
      runId: input.runId, recordType: 'recruiting_message',
      outcome: unresolved ? 'unresolved' : prior || result?.status === 'ALREADY_APPLIED' ? 'duplicate' : result?.status === 'APPLIED' ? 'updated' : 'ignored',
      fingerprint: observation.originalTextFingerprint ?? stableIngestionHash(sourceRecordId),
      receivedAt: record.receivedAt, accountedAt: input.checkedAt,
      reason: record.gaps.length ? record.gaps.join(' ') : result?.summary ?? prior?.ingestion?.reason ?? 'Previously consumed Gmail source record; no business replay.',
      capabilityBoundaries: record.capabilityBoundaries ?? prior?.ingestion?.capabilityBoundaries,
      issueKinds: unresolved ? issueKinds : undefined,
      sourceRef: `gmail:${sourceRecordId}`,
    })
    records.push(entry)
    const persistReconciliationChange = Boolean(input.reconcileExisting
      && (record.gaps.length > 0 || result?.status === 'APPLIED' || result?.decisionRequests.length))
    if (!prior || persistReconciliationChange) {
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
