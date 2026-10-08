import type { DiscoveryAutomationSourcePlan } from '../src/discoveryAutomation.js'
import { discoveryProfileManagementFingerprint } from '../src/discoveryProfileManagement.js'
import { discoveryScopeBatchSchema, type DiscoveryScopeBatch, type DiscoveryScopeLedgerRecord } from '../src/discoveryScopeBatch.js'
import type { DiscoveryWebQuery } from '../src/discoveryQueryPlan.js'
import { hashMutationPayload } from './mutationKernel.js'
import { validateDiscoveryReceipt, verifiedDiscoveryCommandId } from './verifiedDiscoveryCommit.js'
import { requireWritableWorkspaceSource, WorkspaceSourceError, type WorkspaceSource, type DiscoveryCommitAuthorization } from './workspaceSource.js'

export const DISCOVERY_MAX_QUERIES_PER_TICK = 48
export interface ScopeBatchIdentity {
  sourceId: string; scopeFingerprint: string; planFingerprint: string; cycleId: string
  index: number; count: number; queryStart: number; queryCount: number; totalQueryCount: number; queries: DiscoveryWebQuery[]
}
export function batchMetadata(identity: ScopeBatchIdentity, settled?: Omit<DiscoveryScopeBatch, 'version' | 'planFingerprint' | 'cycleId' | 'claimAttemptId' | 'index' | 'count' | 'queryStart' | 'queryCount' | 'totalQueryCount' | 'phase'>, claimAttemptId: string = crypto.randomUUID()): DiscoveryScopeBatch {
  return discoveryScopeBatchSchema.parse({ version: 1, claimAttemptId, planFingerprint: identity.planFingerprint, cycleId: identity.cycleId,
    index: identity.index, count: identity.count, queryStart: identity.queryStart, queryCount: identity.queryCount, totalQueryCount: identity.totalQueryCount,
    phase: settled ? 'settled' : 'claimed', ...settled })
}
export function batchRequest(identity: ScopeBatchIdentity) { return { contractVersion: 2, ...identity } }
export async function batchRunId(identity: ScopeBatchIdentity) { return `server-discovery-batch:${await hashMutationPayload('discovery_scope_batch', batchRequest(identity))}` }
export async function checkpointIdentity(identity: ScopeBatchIdentity, batch: DiscoveryScopeBatch) {
  const request = { request: batchRequest(identity), batch }
  return { commandId: `discovery-search-${batch.phase}:${await hashMutationPayload('discovery_scope_checkpoint', batchRequest(identity))}`,
    kind: 'checkpoint_discovery_search', inputFingerprint: await hashMutationPayload('checkpoint_discovery_search', request), request }
}
export function batchProvenance(identity: ScopeBatchIdentity, runId: string, batch: DiscoveryScopeBatch) {
  return { producer: 'server_scheduler', sourceId: identity.sourceId, scopeFingerprint: identity.scopeFingerprint, runId,
    searchPlanFingerprint: identity.planFingerprint, searchCycleId: identity.cycleId, searchPhase: batch.phase, searchBatchIndex: batch.index, searchBatch: batch }
}

function identityFor(source: DiscoveryAutomationSourcePlan, scopeFingerprint: string, planFingerprint: string, cycleId: string, size: number, index: number): ScopeBatchIdentity {
  const all = source.webQueries ?? [], queries = all.slice(index * size, (index + 1) * size)
  return { sourceId: source.sourceId, scopeFingerprint, planFingerprint, cycleId, index, count: Math.ceil(all.length / size),
    queryStart: index * size, queryCount: queries.length, totalQueryCount: all.length, queries }
}
/** Only immutable original receipts can select a cursor. An uncertain claim
 * stays blocked forever until separately reconciled; elapsed time is not a
 * permit to spend again, including a crash before the outbound request. */
export async function nextDiscoveryScopeBatch(input: {
  source: WorkspaceSource; sourceRun: DiscoveryAutomationSourcePlan; scopeFingerprint: string; planFingerprint: string
  batchSize: number; workspaceVersion: string; now: Date; force: boolean; legacyDue: () => Promise<boolean>
  restartCompletedCycles?: boolean
}) {
  const { source, sourceRun, scopeFingerprint, planFingerprint, batchSize, now } = input
  if (!source.readDiscoveryScopeRecords) throw new WorkspaceSourceError('DISCOVERY_AUTHORITATIVE_COMMAND_REQUIRED', 'Search batches require the authoritative command ledger.', false)
  const total = sourceRun.webQueries?.length ?? 0
  if (!total || total > 3720 || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 48 || Math.ceil(total / batchSize) > 80) throw new WorkspaceSourceError('DISCOVERY_SCOPE_INCOMPLETE', 'The complete scope exceeds the supported bounded batch plan; no query may be silently omitted.', false)
  const latest = await source.readDiscoveryScopeRecords(sourceRun.sourceId, scopeFingerprint, planFingerprint)
  const newCycleId = await hashMutationPayload('discovery_scope_cycle', { planFingerprint, sourceId: sourceRun.sourceId, bucket: Math.floor(now.getTime() / (sourceRun.cadenceMinutes * 60_000)) })
  let cycleId = latest[0]?.batch.cycleId ?? newCycleId, records: DiscoveryScopeLedgerRecord[] = []
  if (latest.length) records = await source.readDiscoveryScopeRecords(sourceRun.sourceId, scopeFingerprint, planFingerprint, cycleId)
  const claimed = new Map<number, DiscoveryScopeLedgerRecord>(), settled = new Map<number, DiscoveryScopeLedgerRecord>()
  for (const record of records) {
    const identity = identityFor(sourceRun, scopeFingerprint, planFingerprint, cycleId, batchSize, record.batch.index)
    const expected = batchMetadata(identity, record.batch.phase === 'settled' ? {
      outcome: record.batch.outcome, successfulQueryCount: record.batch.successfulQueryCount, failedQueryCount: record.batch.failedQueryCount,
      ...(record.batch.omittedHitCount === undefined ? {} : { omittedHitCount: record.batch.omittedHitCount }), ...(record.batch.errorCode ? { errorCode: record.batch.errorCode } : {}),
    } : undefined, record.batch.claimAttemptId)
    const checkpoint = await checkpointIdentity(identity, expected), runId = await batchRunId(identity)
    const command = record.operation === 'ingest_verified_discovery'
      ? { commandId: await verifiedDiscoveryCommandId(sourceRun.sourceId, runId), kind: record.operation, inputFingerprint: await hashMutationPayload('ingest_verified_discovery', batchRequest(identity)) }
      : checkpoint
    if (Date.parse(record.createdAt) > now.getTime()) throw new WorkspaceSourceError('DISCOVERY_COMMIT_UNVERIFIED', 'Future ledger time cannot establish completed search progress.', false)
    if (JSON.stringify(record.batch) !== JSON.stringify(expected) || record.runId !== runId
      || record.operation === 'ingest_verified_discovery' && record.batch.phase !== 'settled') throw new WorkspaceSourceError('DISCOVERY_RECEIPT_MISMATCH', 'Search progress disagrees with the complete immutable plan.', false)
    validateDiscoveryReceipt(record, command, input.workspaceVersion)
    const target = record.batch.phase === 'claimed' ? claimed : settled
    if (target.has(record.batch.index)) throw new WorkspaceSourceError('DISCOVERY_RECEIPT_MISMATCH', 'A search batch has conflicting original receipts.', false)
    target.set(record.batch.index, record)
  }
  const count = Math.ceil(total / batchSize)
  if (latest.length && (!claimed.has(0) || latest[0].commandId !== claimed.get(0)?.commandId)) throw new WorkspaceSourceError('DISCOVERY_RECEIPT_MISMATCH', 'The original cycle claim is absent from authoritative progress.', false)
  let nextIndex = 0, successful = 0, omitted = 0, hadFailure = false
  while (settled.has(nextIndex)) {
    if (!claimed.has(nextIndex) || claimed.get(nextIndex)!.batch.claimAttemptId !== settled.get(nextIndex)!.batch.claimAttemptId) throw new WorkspaceSourceError('DISCOVERY_RECEIPT_MISMATCH', 'Search progress has a settlement without its original claim.', false)
    const batch = settled.get(nextIndex)!.batch
    successful += batch.successfulQueryCount ?? 0; omitted += batch.omittedHitCount ?? 0
    hadFailure ||= batch.outcome !== 'complete'; nextIndex += 1
  }
  if ([...claimed.keys(), ...settled.keys()].some(index => index > nextIndex)) throw new WorkspaceSourceError('DISCOVERY_RECEIPT_MISMATCH', 'Search progress skips an unattempted batch.', false)
  if ([...settled.values()].some(record => record.batch.outcome === 'budget_exhausted')) {
    return { state: 'budget_exhausted' as const, totalQueryCount: total, remainingQueryCount: total - successful, omittedHitCount: omitted, hadFailure: true }
  }
  if (nextIndex === count) {
    const completedAt = Date.parse(settled.get(count - 1)!.createdAt)
    if (input.restartCompletedCycles === false || cycleId === newCycleId || !input.force && now.getTime() - completedAt < sourceRun.cadenceMinutes * 60_000) {
      return { state: 'not_due' as const, totalQueryCount: total, remainingQueryCount: total - successful, omittedHitCount: omitted, hadFailure }
    }
    cycleId = newCycleId; nextIndex = 0; successful = 0; omitted = 0; hadFailure = false
  } else if (claimed.has(nextIndex)) {
    return { state: 'uncertain' as const, totalQueryCount: total, remainingQueryCount: total - successful, omittedHitCount: omitted, hadFailure: true }
  } else if (!latest.length && !await input.legacyDue()) {
    return { state: 'not_due' as const, totalQueryCount: total, remainingQueryCount: total, omittedHitCount: 0, hadFailure: false }
  }
  return { state: 'ready' as const, identity: identityFor(sourceRun, scopeFingerprint, planFingerprint, cycleId, batchSize, nextIndex),
    totalQueryCount: total, successfulQueryCount: successful, remainingQueryCount: total - successful, omittedHitCount: omitted, hadFailure }
}

/** Metadata checkpoints still pass through the existing exact-authority,
 * workspace CAS and immutable receipt transaction. They cannot alter snapshot
 * business data. Only a confirmed first COMMITTED claim admits a paid call. */
export async function commitDiscoveryCheckpoint(input: {
  source: WorkspaceSource; identity: ScopeBatchIdentity; batch: DiscoveryScopeBatch; authorize: () => Promise<void>
  discoveryAuthorization: DiscoveryCommitAuthorization
}) {
  const writable = requireWritableWorkspaceSource(input.source), command = await checkpointIdentity(input.identity, input.batch), runId = await batchRunId(input.identity)
  if (input.discoveryAuthorization.kind !== 'automation' || !input.source.readCommandReceipt || !input.source.readRawForCheckpoint) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Search checkpoints require existing server automation authority and its exact raw preimage.', false)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await input.authorize()
    const workspace = await input.source.readRawForCheckpoint()
    if (await discoveryProfileManagementFingerprint(workspace.snapshot.data.discoveryProfile ?? null) !== input.identity.scopeFingerprint) throw new WorkspaceSourceError('DISCOVERY_SCOPE_CHANGED', 'The confirmed scope changed before the search checkpoint.', false)
    let written
    try {
      written = await writable.write({ snapshot: workspace.snapshot, expectedWorkspaceVersion: workspace.context.workspaceVersion,
        updatedByDevice: 'discovery-search-checkpoint', command: { commandId: command.commandId, operation: command.kind, payload: command.request,
          payloadHash: command.inputFingerprint, discoveryAuthorization: input.discoveryAuthorization,
          provenance: batchProvenance(input.identity, runId, input.batch) } })
    } catch (error) {
      if (error instanceof WorkspaceSourceError && error.code === 'WORKSPACE_CONFLICT' && attempt === 0) continue
      // A lost claim ACK cannot prove this invocation won. It must not send.
      throw error
    }
    const recorded = await input.source.readCommandReceipt(command.commandId)
    if (!recorded) throw new WorkspaceSourceError('DISCOVERY_COMMIT_UNVERIFIED', 'The search checkpoint has no original receipt; do not repeat external work.', false)
    const receipt = validateDiscoveryReceipt(recorded, command, written.context.workspaceVersion)
    if (!['COMMITTED', 'ALREADY_APPLIED'].includes(written.commandOutcome ?? '') || written.commandReceipt?.commandId !== command.commandId
      || written.commandReceipt?.revision !== receipt.revision) throw new WorkspaceSourceError('DISCOVERY_RECEIPT_MISMATCH', 'Search claim response and original receipt disagree.', false)
    if (written.commandOutcome === 'COMMITTED' && (written.context.workspaceVersion !== `txn:${receipt.revision}`
      || Number(receipt.revision) !== Number(workspace.context.workspaceVersion?.slice(4)) + 1)) throw new WorkspaceSourceError('DISCOVERY_RECEIPT_MISMATCH', 'A first claim must carry its own new authoritative revision.', false)
    return { firstCommit: written.commandOutcome === 'COMMITTED', receipt }
  }
  throw new WorkspaceSourceError('WORKSPACE_CONFLICT', 'Search checkpoint could not pass bounded CAS.', true)
}
