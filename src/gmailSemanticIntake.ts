import type { SemanticIntakeObservation, TimelineRecord } from './model.js'
import type { PJSDASSnapshot } from './snapshot.js'
import { applySemanticIntake, type SemanticBatchCompensation } from './semanticIntake.js'
import { alreadyIngested, buildIngestionRunSummary, createIngestionLedgerTimeline, createIngestionRunTimeline, stableIngestionHash } from './ingestion.js'
import { bootstrapPolicyFor } from './sourceRegistry.js'

export interface GmailSemanticRecord {
  observation: SemanticIntakeObservation
  receivedAt: string
  gaps: string[]
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
}) {
  if (!input.authorized) throw new Error('Gmail source is not authorized for writes.')
  let working = structuredClone(snapshot)
  const records: TimelineRecord[] = []
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
    const result = prior ? undefined : applySemanticIntake(working, observation, {
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
    const entry = createIngestionLedgerTimeline({
      sourceKind: 'gmail', sourceId: input.sourceId, sourceRecordId,
      runId: input.runId, recordType: 'recruiting_message',
      outcome: unresolved ? 'unresolved' : prior || result?.status === 'ALREADY_APPLIED' ? 'duplicate' : result?.status === 'APPLIED' ? 'updated' : 'ignored',
      fingerprint: observation.originalTextFingerprint ?? stableIngestionHash(sourceRecordId),
      receivedAt: record.receivedAt, accountedAt: input.checkedAt,
      reason: record.gaps.length ? record.gaps.join(' ') : result?.summary ?? prior?.ingestion?.reason ?? 'Previously consumed Gmail source record; no business replay.',
      sourceRef: `gmail:${sourceRecordId}`,
    })
    records.push(entry)
    working.data.timeline = [...(working.data.timeline ?? []), entry]
  }
  const run = buildIngestionRunSummary({
    runId: input.runId, sourceKind: 'gmail', sourceId: input.sourceId,
    startedAt: input.checkedAt, completedAt: input.checkedAt, cursor: input.cursor,
    records, sourcePolicy: bootstrapPolicyFor('gmail', input.sourceId),
  })
  working.data.timeline = [...(working.data.timeline ?? []), createIngestionRunTimeline(run)]
  working.exportedAt = input.checkedAt
  return { snapshot: working, run, compensation, alreadyApplied: false }
}
