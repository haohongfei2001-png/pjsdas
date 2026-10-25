import { isDeepStrictEqual } from 'node:util'
import { buildIngestionRunSummary, createIngestionRunTimeline } from '../src/ingestion.js'
import { bootstrapPolicyFor } from '../src/sourceRegistry.js'
import type { PJSDASSnapshot } from '../src/snapshot.js'
import type { TimelineRecord } from '../src/model.js'
import { WorkspaceSourceError } from './workspaceSource.js'

/** Deliberately narrower than all batches which happen to parse to zero records. */
export const EMPTY_GMAIL_OBSERVATION = Object.freeze({
  version: 1, mode: 'history', coverageComplete: true, fetchedCount: 0,
  unavailableCount: 0, sourceRecordCount: 0, hasContinuation: false,
  hasRecoveryGap: false, backfillComplete: true,
})
export const MAX_PENDING_EMPTY_GMAIL_RUNS = 256
// Immutable v1 storage protocol, not a lookup of today's mutable defaults.
export const EMPTY_GMAIL_POLICY_V1 = Object.freeze({ version: 1 as const, enabled: true,
  label: '招聘邮件自动摄入', cadenceMinutes: 10, freshnessSlaMinutes: 20 })

export interface EmptyGmailCheckpointInput {
  userId: string
  executionToken: string
  commandId: string
  payloadHash: string
  expectedRevision: number
  checkedAt: string
  historyId: string
  observation: unknown
}

export function eligibleEmptyGmailObservation(value: unknown): boolean {
  return isDeepStrictEqual(value, EMPTY_GMAIL_OBSERVATION)
}

export function emptyGmailRun(commandId: string, checkedAt: string, historyId: string): TimelineRecord {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(checkedAt)
    || !Number.isFinite(Date.parse(checkedAt)) || new Date(checkedAt).toISOString() !== checkedAt
    || commandId !== `gmail:auto:${checkedAt}` || !/^\d{1,40}$/.test(historyId)) {
    throw new WorkspaceSourceError('WORKSPACE_INVALID', 'Invalid bounded empty-poll identity.', false)
  }
  return createIngestionRunTimeline(buildIngestionRunSummary({ runId: commandId, sourceKind: 'gmail',
    sourceId: 'gmail:primary', startedAt: checkedAt, completedAt: checkedAt,
    records: [], cursor: historyId,
    sourcePolicy: EMPTY_GMAIL_POLICY_V1,
  }))
}

function invalid(): never {
  throw new WorkspaceSourceError('WORKSPACE_INVALID', 'Empty-poll audit evidence does not match the observed workspace revision.', false)
}

/** Overlay an immutable bounded revision window, never the newest unbounded ledger.
 * The raw base and marker must be from the same database row response. Entries
 * survive later absorption, so a concurrent full write cannot invalidate this read.
 */
export function overlayEmptyGmailRuns(snapshot: PJSDASSnapshot, rows: unknown,
  identity: { userId: string; workspaceId: string; materializedRevision: number; revision: number }): PJSDASSnapshot {
  const { materializedRevision, revision } = identity
  if (!Number.isSafeInteger(materializedRevision) || !Number.isSafeInteger(revision)
    || materializedRevision < 0 || materializedRevision > revision || !Array.isArray(rows)
    || rows.length > MAX_PENDING_EMPTY_GMAIL_RUNS || rows.length !== revision - materializedRevision) invalid()
  if (!rows.length) return snapshot
  if (!snapshot?.data || snapshot.data.timeline !== undefined && !Array.isArray(snapshot.data.timeline)) invalid()
  const history = snapshot.data.timeline ?? [], seen = new Map(history.map(row => [row.id, row]))
  if (seen.size !== history.length) invalid()
  const additions: TimelineRecord[] = []
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== 'object' || row.user_id !== identity.userId || row.workspace_id !== identity.workspaceId
      || row.operation !== 'gmail_semantic_intake' || row.principal_kind !== 'automation' || row.status !== 'COMMITTED'
      || row.resulting_revision !== materializedRevision + index + 1
      || !row.gmail_empty_poll_run || typeof row.gmail_empty_poll_run !== 'object') invalid()
    const run = row.gmail_empty_poll_run as TimelineRecord
    const at = run.ingestionRun?.completedAt, cursor = run.ingestionRun?.cursor
    if (typeof at !== 'string' || typeof cursor !== 'string' || typeof row.command_id !== 'string'
      || !isDeepStrictEqual(run, JSON.parse(JSON.stringify(emptyGmailRun(row.command_id, at, cursor))))) invalid()
    // A pending record is never already in the raw base. Absorption advances
    // the marker atomically; silently deduping here would hide a broken marker.
    if (seen.has(run.id)) invalid()
    seen.set(run.id, run)
    additions.push(structuredClone(run))
  }
  return { ...snapshot, exportedAt: additions.at(-1)!.occurredAt,
    data: { ...snapshot.data, timeline: [...history, ...additions] } }
}

/** Installed only by the controlled worker with its original lease token. Never
 * accepted from a client, tool/model payload or the legacy worker. */
export type TrustedEmptyGmailCheckpoint = (input: {
  commandId: string; expectedRevision: number; checkedAt: string; historyId: string
}) => Promise<{ outcome: 'NOT_ELIGIBLE' | 'COMMITTED' | 'ALREADY_APPLIED' | 'CONFLICT'; revision?: number }>

export function isStrictEmptyGmailPoll(input: {
  transactional: boolean; backfillComplete: boolean; sourceRecordCount: number
  binding: { gmailHistoryId?: string; gmailSyncMode?: string | null; gmailPageToken?: string | null;
    gmailPendingHistoryId?: string | null; gmailPendingMessageIds?: string[] | null }
  batch: { messages: unknown[]; unavailableMessageIds: string[]; nextHistoryId?: string;
    continuation?: unknown; coverageComplete: boolean; usedFallbackScan: boolean; recoveryGapReason?: string }
}): boolean {
  const { binding, batch } = input
  return isDeepStrictEqual(bootstrapPolicyFor('gmail', 'gmail:primary'), EMPTY_GMAIL_POLICY_V1)
    && input.transactional && input.backfillComplete && input.sourceRecordCount === 0
    && !!binding.gmailHistoryId && /^\d{1,40}$/.test(binding.gmailHistoryId)
    && batch.nextHistoryId === binding.gmailHistoryId && batch.coverageComplete
    && !batch.usedFallbackScan && !batch.recoveryGapReason && !batch.continuation
    && batch.messages.length === 0 && batch.unavailableMessageIds.length === 0
    && !binding.gmailSyncMode && !binding.gmailPageToken && !binding.gmailPendingHistoryId
    && !(binding.gmailPendingMessageIds?.length)
}
