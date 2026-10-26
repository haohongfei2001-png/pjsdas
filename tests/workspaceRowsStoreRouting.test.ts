import { createAiCaptureLedger } from '../gateway/aiCaptureLedger'
import { describe, expect, it, vi } from 'vitest'
import { createTransactionalWorkspaceStore } from '../gateway/transactionalWorkspaceStore'
import { createSnapshot } from '../src/snapshot'

const userId = '11111111-1111-4111-8111-111111111111'
const workspaceId = '22222222-2222-4222-8222-222222222222'
const epoch = '33333333-3333-4333-8333-333333333333'
const snapshot = createSnapshot({ opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], scheduleNodes: [], decisionRequests: [], semanticReceipts: [], reminderIntents: [], reminderOutbox: [], discoveryInbox: [], changeSets: [], timeline: [] }, '2030-01-01T00:00:00Z')
const marker = (value: string | null = epoch) => [{ id: workspaceId, user_id: userId, row_candidate_epoch: value }]
const record = { workspaceId, userId, epoch, revision: 7, snapshot }
const reader = () => ({ read: vi.fn(async () => record), readIdentity: vi.fn(async () => ({ workspaceId, userId, epoch, revision: 7, schemaVersion: snapshot.version })) })
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })

describe('stage-A actual transactional store layout routing', () => {
  it('uses a bounded readiness projection with the same deadline across all fences', async () => {
    const signal = new AbortController().signal
    const rows = { ...reader(), readDiscoveryProfile: vi.fn(async (_id: string, _signal?: AbortSignal) => ({ ...record, profile: null })) }
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => { expect(init?.signal).toBe(signal); return response(marker()) })
    const store = createTransactionalWorkspaceStore({ supabaseUrl: 'https://synthetic.invalid', serviceRoleKey: 'synthetic', fetchImpl, rowLayoutReader: rows })
    expect(await store.readDiscoveryProfileForUser(userId, signal)).toEqual({ profile: null })
    expect(rows.readDiscoveryProfile).toHaveBeenCalledWith(userId, signal)
    expect(rows.read).not.toHaveBeenCalled()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
  it('missing readiness capability fails closed without raw snapshot fallback', async () => {
    const fetchImpl = vi.fn(async () => response(marker()))
    const store = createTransactionalWorkspaceStore({ supabaseUrl: 'https://synthetic.invalid', serviceRoleKey: 'synthetic', fetchImpl, rowLayoutReader: reader() })
    await expect(store.readDiscoveryProfileForUser(userId)).rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it.each(['missing_writer', 'stale', 'metadata_failure'])('capture admission never dispatches through old RPC when row state is %s', async kind => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL) => response(kind === 'metadata_failure' ? {} : marker(), kind === 'metadata_failure' ? 503 : 200))
    const ledger = createAiCaptureLedger({ supabaseUrl: 'https://synthetic.invalid', serviceRoleKey: 'synthetic', fetchImpl, rowLayoutReader: reader() })
    await expect(ledger.admit({ userId, requestId: 'synthetic', payloadHash: 'a'.repeat(64), text: 'Synthetic', timezone: 'UTC', referenceTime: '2030-01-01T00:00:00Z', reservationUnits: 1, expectedRevision: kind === 'stale' ? 0 : 7, contextRefs: [] })).rejects.toMatchObject({ code: 'AI_CAPTURE_ADMISSION_REJECTED', retryable: false })
    expect(fetchImpl.mock.calls.every(call => !String(call[0]).includes('rpc/'))).toBe(true)
  })
  it('returns logical current rows, never the retained snapshot; preserves internal epoch/schema', async () => {
    const rows = reader(), fetchImpl = vi.fn(async (_url: RequestInfo | URL) => response(marker()))
    const store = createTransactionalWorkspaceStore({ supabaseUrl: 'https://synthetic.invalid', serviceRoleKey: 'synthetic', fetchImpl, rowLayoutReader: rows })
    expect(await store.readForUser(userId, { preserveRawData: true, includeStoredSchema: true })).toEqual({ workspaceId, userId, revision: 7, snapshot, schemaVersion: snapshot.version, storedSchemaVersion: snapshot.version, rowEpoch: epoch })
    expect(await store.readIdentityForUser(userId)).toEqual({ workspaceId, userId, revision: 7, schemaVersion: snapshot.version, rowEpoch: epoch })
    expect(fetchImpl.mock.calls.every(([url]) => !String(url).includes('snapshot'))).toBe(true)
    expect(rows.read).toHaveBeenCalledTimes(1)
  })
  it.each(['missing', 'failed', 'malformed'])('does not fall back when layout metadata is %s', async kind => {
    const rows = reader(), fetchImpl = vi.fn(async () => kind === 'failed' ? response({}, 500) : response(kind === 'missing' ? [{ id: workspaceId, user_id: userId }] : marker('not-an-epoch')))
    const store = createTransactionalWorkspaceStore({ supabaseUrl: 'https://synthetic.invalid', serviceRoleKey: 'synthetic', fetchImpl, rowLayoutReader: rows })
    await expect(store.readForUser(userId)).rejects.toMatchObject({ code: kind === 'failed' ? 'WORKSPACE_UNAVAILABLE' : 'WORKSPACE_INVALID' })
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(rows.read).not.toHaveBeenCalled()
  })
  it.each(['owner', 'workspace', 'epoch', 'absent', 'cutover'])('rejects mixed row identity: %s', async kind => {
    const rows = reader()
    rows.read.mockImplementation(async () => kind === 'absent' ? null as never : { ...record, ...(kind === 'owner' ? { userId: workspaceId } : kind === 'workspace' ? { workspaceId: userId } : kind === 'epoch' ? { epoch: workspaceId } : {}) })
    let n = 0
    const store = createTransactionalWorkspaceStore({ supabaseUrl: 'https://synthetic.invalid', serviceRoleKey: 'synthetic', rowLayoutReader: rows, fetchImpl: async () => response(marker(kind === 'cutover' && n++ > 0 ? workspaceId : epoch)) })
    await expect(store.readForUser(userId)).rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' })
  })
  it('rejects old ledger/commit fallback for an active layout before making those requests', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL) => response(marker()))
    const store = createTransactionalWorkspaceStore({ supabaseUrl: 'https://synthetic.invalid', serviceRoleKey: 'synthetic', fetchImpl, rowLayoutReader: reader() })
    await expect(store.readCommandForUser(userId, 'synthetic')).rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' })
    await expect(store.commitForUser({ userId, commandId: 'synthetic', operation: 'semantic_intake', payloadHash: 'a'.repeat(64), expectedRevision: 7, snapshot, schemaVersion: snapshot.version, principalKind: 'first_party_web' })).rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' })
    expect(fetchImpl.mock.calls.every(([url]) => !String(url).includes('rpc/') && !String(url).includes('ledger'))).toBe(true)
  })
  it('rejects a legacy raw read that overlaps activation instead of returning stale data', async () => {
    let n = 0
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => String(url).includes('row_candidate_epoch') ? response(marker(++n < 3 ? null : epoch)) : response([{ id: workspaceId, user_id: userId, revision: 0, schema_version: snapshot.version, snapshot }]))
    const store = createTransactionalWorkspaceStore({ supabaseUrl: 'https://synthetic.invalid', serviceRoleKey: 'synthetic', fetchImpl, rowLayoutReader: reader(), emptyGmailCheckpointReads: false })
    await expect(store.readForUser(userId)).rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' })
  })
  it('does not query candidate metadata without the explicit injection', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL) => response([{ id: workspaceId, user_id: userId, revision: 0, schema_version: snapshot.version, snapshot }]))
    const store = createTransactionalWorkspaceStore({ supabaseUrl: 'https://synthetic.invalid', serviceRoleKey: 'synthetic', fetchImpl, emptyGmailCheckpointReads: false })
    expect((await store.readForUser(userId))?.snapshot).toEqual(snapshot)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String(fetchImpl.mock.calls[0][0])).not.toContain('row_candidate_epoch')
  })
})
