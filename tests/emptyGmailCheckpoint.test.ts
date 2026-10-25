import { afterEach, expect, it, vi } from 'vitest'
import { EMPTY_GMAIL_OBSERVATION, emptyGmailRun, isStrictEmptyGmailPoll, overlayEmptyGmailRuns } from '../gateway/emptyGmailCheckpoint.js'
import { createTransactionalWorkspaceStore } from '../gateway/transactionalWorkspaceStore.js'
import { createSnapshot } from '../src/snapshot.js'
import { applyGmailSemanticBatch } from '../src/gmailSemanticIntake.js'
import { summarizeSourceHealth } from '../src/sourceHealth.js'
const checkedAt = '2026-10-25T00:00:00.000Z', commandId = `gmail:auto:${checkedAt}`
const state = () => createSnapshot({ opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [] })
const input = { userId: 'owner', executionToken: 'synthetic-token', commandId, checkedAt, historyId: '1234', payloadHash: 'a'.repeat(64), expectedRevision: 0, observation: EMPTY_GMAIL_OBSERVATION }
const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const row = { user_id: 'owner', workspace_id: 'workspace', command_id: commandId, operation: 'gmail_semantic_intake', principal_kind: 'automation', status: 'COMMITTED', resulting_revision: 1, gmail_empty_poll_run: wire(emptyGmailRun(commandId, checkedAt, '1234')) }
const identity = { userId: 'owner', workspaceId: 'workspace', materializedRevision: 0, revision: 1 }
afterEach(() => vi.unstubAllEnvs())
it('projects exactly the original semantic empty run and complete source-health history', () => {
  let full = state(); const base = structuredClone(full), rows = []
  for (let i = 0; i < 20; i++) {
    const at = new Date(Date.parse(checkedAt) + i * 600000).toISOString(), id = `gmail:auto:${at}`
    full = applyGmailSemanticBatch(full, { runId: id, checkedAt: at, sourceId: 'gmail:primary', cursor: '1234', records: [], authorized: true }).snapshot
    rows.push({ ...row, command_id: id, resulting_revision: i + 1, gmail_empty_poll_run: wire(emptyGmailRun(id, at, '1234')) })
  }
  const overlay = overlayEmptyGmailRuns(base, rows, { ...identity, revision: rows.length })
  expect(wire(overlay)).toEqual(wire(full))
  expect(summarizeSourceHealth(overlay.data.timeline, new Date('2026-10-25T04:00:00Z'))).toEqual(summarizeSourceHealth(full.data.timeline, new Date('2026-10-25T04:00:00Z')))
  expect(base.data.timeline).toEqual([])
})
it.each(['gap', 'owner', 'workspace', 'operation', 'principal', 'status', 'run', 'duplicate', 'marker'])('fails closed on invalid %s overlay evidence', kind => {
  const rows = [structuredClone(row)], id = { ...identity }
  if (kind === 'gap') rows[0].resulting_revision = 2
  if (kind === 'owner') rows[0].user_id = 'other'
  if (kind === 'workspace') rows[0].workspace_id = 'other'
  if (kind === 'operation') rows[0].operation = 'generic'
  if (kind === 'principal') rows[0].principal_kind = 'first_party_web'
  if (kind === 'status') rows[0].status = 'FAILED'
  if (kind === 'run') rows[0].gmail_empty_poll_run.title = 'tampered'
  if (kind === 'duplicate') { rows.push({ ...row, resulting_revision: 2 }); id.revision = 2 }
  if (kind === 'marker') id.materializedRevision = 2
  expect(() => overlayEmptyGmailRuns(state(), rows, id)).toThrow()
})
it('default OFF uses old schema only and makes no checkpoint call', async () => {
  vi.stubEnv('PJSDAS_GMAIL_EMPTY_CHECKPOINTS', ''); vi.stubEnv('PJSDAS_GMAIL_EMPTY_CHECKPOINT_READS', '')
  const snapshot = state(), fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
    expect(String(url)).not.toContain('materialized_revision')
    return Response.json([{ id: 'workspace', user_id: 'owner', revision: 0, schema_version: 4, snapshot }])
  })
  const store = createTransactionalWorkspaceStore({ supabaseUrl: 'https://synthetic.invalid', serviceRoleKey: 'synthetic', fetchImpl })
  await store.readForUser('owner'); expect(await store.checkpointEmptyGmailPollForUser(input)).toEqual({ outcome: 'NOT_ELIGIBLE' }); expect(fetchImpl).toHaveBeenCalledTimes(1)
})
it('reader remains active while checkpoint writers are disabled for rollback', async () => {
  const snapshot = state(), fetchImpl = vi.fn(async (url: RequestInfo | URL) => String(url).includes('pjsdas_command_ledger')
    ? Response.json([row]) : Response.json([{ id: 'workspace', user_id: 'owner', revision: 1, materialized_revision: 0, schema_version: 4, snapshot }]))
  const store = createTransactionalWorkspaceStore({ supabaseUrl: 'https://synthetic.invalid', serviceRoleKey: 'synthetic', fetchImpl, emptyGmailCheckpointReads: true, emptyGmailCheckpoints: false })
  expect((await store.readForUser('owner'))!.snapshot.data.timeline).toHaveLength(1)
  expect(await store.checkpointEmptyGmailPollForUser(input)).toEqual({ outcome: 'NOT_ELIGIBLE' }); expect(fetchImpl).toHaveBeenCalledTimes(2)
  const query = new URL(String(fetchImpl.mock.calls[1][0])); expect(query.searchParams.get('and')).toBe('(resulting_revision.gt.0,resulting_revision.lte.1)'); expect(query.searchParams.get('limit')).toBe('257')
})
it('writer configuration cannot precede overlay readers', () => {
  expect(() => createTransactionalWorkspaceStore({ supabaseUrl: 'https://synthetic.invalid', serviceRoleKey: 'synthetic', emptyGmailCheckpoints: true, emptyGmailCheckpointReads: false })).toThrow()
})
it.each([403, 404, 409, 500, 503, 'network', 'malformed'])('never retries uncertain checkpoint failure %s', async failure => {
  const fetchImpl = vi.fn(async () => { if (failure === 'network') throw new Error('lost response'); return failure === 'malformed' ? Response.json([]) : Response.json({ code: 'synthetic' }, { status: Number(failure) }) })
  const store = createTransactionalWorkspaceStore({ supabaseUrl: 'https://synthetic.invalid', serviceRoleKey: 'synthetic', fetchImpl, emptyGmailCheckpoints: true, emptyGmailCheckpointReads: true })
  await expect(store.checkpointEmptyGmailPollForUser(input)).rejects.toThrow(); expect(fetchImpl).toHaveBeenCalledTimes(1)
})
it.each(['cursor', 'fetched', 'unavailable', 'records', 'continuation', 'recovery', 'backfill', 'fallback', 'incomplete', 'drive', 'bindingContinuation'])('only exact strict subset qualifies: reject %s', kind => {
  const value = { transactional: true, backfillComplete: true, sourceRecordCount: 0, binding: { gmailHistoryId: '1234' } as any, batch: { messages: [] as unknown[], unavailableMessageIds: [] as string[], nextHistoryId: '1234', coverageComplete: true, usedFallbackScan: false } as any }
  expect(isStrictEmptyGmailPoll(value)).toBe(true)
  if (kind === 'cursor') value.batch.nextHistoryId = '1235'
  if (kind === 'fetched') value.batch.messages = [{}]
  if (kind === 'unavailable') value.batch.unavailableMessageIds = ['missing']
  if (kind === 'records') value.sourceRecordCount = 1
  if (kind === 'continuation') value.batch.continuation = {}
  if (kind === 'recovery') value.batch.recoveryGapReason = 'gap'
  if (kind === 'backfill') value.backfillComplete = false
  if (kind === 'fallback') value.batch.usedFallbackScan = true
  if (kind === 'incomplete') value.batch.coverageComplete = false
  if (kind === 'drive') value.transactional = false
  if (kind === 'bindingContinuation') value.binding.gmailPendingHistoryId = '1234'
  expect(isStrictEmptyGmailPoll(value)).toBe(false)
})

it.each([2, 4, 5, 6, 7, undefined])('uses actual merged snapshot, not submitted input, for guarded consent %s', async consentVersion => {
  const snapshot = state(), merged = overlayEmptyGmailRuns(snapshot, [row], identity)
  const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
    expect(new URL(String(url)).searchParams.get('select')).toContain('snapshot')
    return Response.json([{ outcome: 'COMMITTED', workspace_id: 'workspace', revision: 2, snapshot: merged, receipt: {} }])
  })
  const store = createTransactionalWorkspaceStore({ supabaseUrl: 'https://synthetic.invalid', serviceRoleKey: 'synthetic', fetchImpl, emptyGmailCheckpointReads: true, emptyGmailCheckpoints: false, metadataOnlyCommits: false, rawJsonCommits: false })
  const operations: Record<number, string> = { 2: 'business_management', 4: 'planning_management', 5: 'discovery_profile_management', 6: 'private_reminder_management', 7: 'business_management' }
  const result = await store.commitAuthoritativeForUser({ userId: 'owner', commandId: 'full', operation: consentVersion ? operations[consentVersion] : 'synthetic', payloadHash: 'synthetic', expectedRevision: 1, snapshot, schemaVersion: 4,
    principalKind: consentVersion ? 'delegated_mcp' : 'first_party_web', receiptContext: {},
    ...(consentVersion ? { clientId: 'synthetic', managementAuthorization: { grantId: 'synthetic', grantRevision: 1, consentVersion: consentVersion as 2|4|5|6|7 } } : {}),
  })
  expect(result.snapshot).toEqual(merged); expect(result.snapshot.data.timeline).toHaveLength(1); expect(fetchImpl).toHaveBeenCalledTimes(1)
})

it.each(['same-revision', 'receipt-revision', 'receipt-id', 'storage-contract', 'wrong-run'])('rejects malformed successful receipt: %s without retry', async kind => {
  const receipt = { commandId, receiptId: `command-receipt:${commandId}`, status: 'COMMITTED', operation: 'gmail_semantic_intake', revision: 1, contractVersion: 2, storageContract: 'gmail-empty-poll-v1', affectedObjects: [{ type: 'timeline', id: row.gmail_empty_poll_run.id }], undoDependencyObjects: [{ type: 'timeline', id: row.gmail_empty_poll_run.id }] }
  if (kind === 'receipt-revision') receipt.revision = 99
  if (kind === 'receipt-id') receipt.receiptId = 'wrong'
  if (kind === 'storage-contract') receipt.storageContract = 'wrong'
  if (kind === 'wrong-run') receipt.affectedObjects[0].id = 'wrong'
  const fetchImpl = vi.fn(async () => Response.json([{ outcome: 'COMMITTED', workspace_id: 'workspace', revision: kind === 'same-revision' ? 0 : 1, receipt }]))
  const store = createTransactionalWorkspaceStore({ supabaseUrl: 'https://synthetic.invalid', serviceRoleKey: 'synthetic', fetchImpl, emptyGmailCheckpointReads: true, emptyGmailCheckpoints: true })
  await expect(store.checkpointEmptyGmailPollForUser(input)).rejects.toMatchObject({ code: 'WORKSPACE_INVALID' }); expect(fetchImpl).toHaveBeenCalledTimes(1)
})
