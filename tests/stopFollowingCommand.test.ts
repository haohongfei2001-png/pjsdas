import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/cloud/cloudClient.js', () => ({ getAccountAccessToken: vi.fn(async () => 'synthetic-token') }))
vi.mock('../src/db.js', () => ({ isRecordedAccountProjection: vi.fn(async () => false), assertLocalSnapshotCurrent: vi.fn(async () => undefined),
  exportLocalSnapshot: vi.fn(), replaceLocalSnapshotFromCloud: vi.fn(async value => value), readCommandInteraction: vi.fn(async () => undefined), persistInteractionProjection: vi.fn() }))
vi.mock('../src/backendEndpoints.js', () => ({ fetchBackend: vi.fn() }))
import { fetchBackend } from '../src/backendEndpoints.js'
import { exportLocalSnapshot, replaceLocalSnapshotFromCloud, readCommandInteraction, persistInteractionProjection } from '../src/db.js'
import { setAccountCacheSession } from '../src/cloud/accountCacheLease.js'
import { bindLocalWorkspaceToUser, patchAccountCheckpoint } from '../src/cloud/syncState.js'
import { fingerprintWorkspace } from '../src/cloud/workspaceFingerprint.js'
import { createSnapshot } from '../src/snapshot.js'
import { largeAbandonFixture } from './fixtures/workspaceRowsLargeCommand.js'
import { listAccountPendingOperations, readAccountDraft, replayAccountPendingOperations, saveAccountDraft } from '../src/cloud/authoritativeCommandClient.js'
import { inspectStopFollowing, retainedStopFollowing, stopFollowing, undoStopFollowing } from '../src/jobs/stopFollowingCommand.js'

class MemoryStorage {
  values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, String(value)) }
  removeItem(key: string) { this.values.delete(key) }
  clear() { this.values.clear() }
}
const account = 'synthetic-owner', job = 'synthetic-job', key = `stop-following:${job}`
const snapshot = createSnapshot({ opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [] }, '2030-01-01T00:00:00Z')
let writes: any[], receipts: Map<string, any>, store: MemoryStorage, dispatch: (body: any) => any
const success = (id: string, target?: string) => ({ outcome: 'COMMITTED', revision: 1, workspaceVersion: 'txn:1', schemaVersion: 4, snapshot,
  receipt: { commandId: id, status: 'COMMITTED', operation: target ? 'undo_command' : 'domain:abandon_opportunity',
    affectedObjects: [{ type: 'opportunity', id: job }], undoAvailable: !target, ...(target ? { undoOf: target } : {}) } })
function reference() { return JSON.parse(readAccountDraft(account, key)) }
beforeEach(async () => {
  setAccountCacheSession(undefined); setAccountCacheSession(account)
  store = new MemoryStorage()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: store, dispatchEvent: vi.fn() } })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true, locks: { request: vi.fn(async (_name, run) => run()) } } })
  bindLocalWorkspaceToUser(account)
  patchAccountCheckpoint(account, { lastSyncedVersion: 'txn:0', lastSyncedFingerprint: await fingerprintWorkspace(snapshot) })
  vi.mocked(exportLocalSnapshot).mockResolvedValue(snapshot)
  vi.mocked(replaceLocalSnapshotFromCloud).mockReset().mockImplementation(async value => value)
  vi.mocked(readCommandInteraction).mockReset().mockResolvedValue(undefined)
  vi.mocked(persistInteractionProjection).mockReset().mockResolvedValue(undefined)
  writes = []; receipts = new Map()
  dispatch = body => {
    if (body.action === 'receipt') {
      const value = receipts.get(body.commandId)
      return Response.json(value ? { ...value, found: true } : { found: false })
    }
    if (body.action === 'read') return Response.json({ revision: 0, workspaceVersion: 'txn:0', snapshot })
    writes.push(body)
    const value = success(body.commandId, body.targetCommandId)
    receipts.set(body.commandId, value)
    return Response.json(value)
  }
  vi.mocked(fetchBackend).mockReset().mockImplementation(async (_url, init) => dispatch(JSON.parse(String(init?.body))))
})

describe('stop-following locator and real connected outbox client (mock HTTP, not browser)', () => {
  it('persists only the versioned identity before HTTP, merges double activation and recovers original Undo after pending clears', async () => {
    const normal = dispatch
    dispatch = body => { if (body.action === 'command') expect(reference()).toEqual({ version: 1, opportunityId: job, commandId: body.commandId }); return normal(body) }
    const [a, b] = await Promise.all([stopFollowing(account, job), stopFollowing(account, job)])
    expect(a).toEqual(b); expect(a.status).toBe('confirmed'); expect(writes).toHaveLength(1)
    expect(navigator.locks.request).toHaveBeenCalledTimes(1)
    expect(listAccountPendingOperations(account)).toHaveLength(0)
    expect((await inspectStopFollowing(account, job)).undoAvailable).toBe(true)
    const before = writes.length
    expect((await inspectStopFollowing(account, job)).commandId).toBe(a.commandId)
    expect(writes).toHaveLength(before)
    const undo = await undoStopFollowing(account, job)
    expect(undo.status).toBe('undone'); expect(writes.at(-1).targetCommandId).toBe(a.commandId)
    const undoId = reference().undoCommandId
    expect((await undoStopFollowing(account, job)).status).toBe('undone')
    expect(writes).toHaveLength(2); expect(reference().undoCommandId).toBe(undoId)
  })
  it('retains unknown identity, allows the existing automatic scheduler to settle, then locates the original receipt', async () => {
    const normal = dispatch; let fail = true
    dispatch = body => { if (body.action === 'command' && fail) { writes.push(body); throw new Error('synthetic-disconnect') } return normal(body) }
    await expect(stopFollowing(account, job)).rejects.toMatchObject({ code: 'UNKNOWN_COMMAND_OUTCOME' })
    const id = reference().commandId
    expect(listAccountPendingOperations(account)[0]?.commandId).toBe(id)
    expect((await inspectStopFollowing(account, job)).status).toBe('pending')
    expect(writes).toHaveLength(1)
    fail = false
    await replayAccountPendingOperations(account)
    expect(listAccountPendingOperations(account)).toHaveLength(0)
    expect(writes).toHaveLength(2); expect(writes.every(body => body.commandId === id)).toBe(true)
    expect(await inspectStopFollowing(account, job)).toMatchObject({ status: 'confirmed', commandId: id, undoAvailable: true })
  })
  it('preserves an offline original command and uses only a receipt read on remount', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    expect((await stopFollowing(account, job)).status).toBe('pending')
    const pending = listAccountPendingOperations(account)[0]!
    expect(pending.command).toEqual({ type: 'domain', value: { commandId: reference().commandId, kind: 'abandon_opportunity', opportunityId: job } })
    expect(fetchBackend).not.toHaveBeenCalled()
    expect((await inspectStopFollowing(account, job)).status).toBe('pending')
    expect(writes).toHaveLength(0)
  })
  it('retains a locator without pending/receipt and never sends on inspection', async () => {
    saveAccountDraft(account, key, JSON.stringify({ version: 1, opportunityId: job, commandId: 'prepared-but-not-journaled' }))
    expect((await inspectStopFollowing(account, job)).status).toBe('pending')
    expect(writes).toHaveLength(0)
  })
  it('clears only an exact known pre-execution rejection; permission uncertainty retains original identity', async () => {
    dispatch = () => Response.json({ code: 'SHARED_GOVERNANCE_REQUIRED', message: 'Use Tell to confirm. No write.', retryable: false }, { status: 400 })
    await expect(stopFollowing(account, job)).rejects.toMatchObject({ code: 'COMMAND_REJECTED' })
    expect(listAccountPendingOperations(account)).toHaveLength(0); expect(readAccountDraft(account, key)).toBe('')
    dispatch = body => body.action === 'receipt' ? Response.json({ found: false }) : Response.json({ code: 'AUTH_FORBIDDEN' }, { status: 403 })
    await expect(stopFollowing(account, job)).rejects.toMatchObject({ code: 'AUTH_REJECTED_BEFORE_COMMAND' })
    expect(retainedStopFollowing(account, job).status).toBe('pending')
    expect(listAccountPendingOperations(account)).toHaveLength(1)
  })
  it.each(['corrupt', 'version', 'target'])('fails closed and preserves %s locator bytes', async mode => {
    const raw = mode === 'corrupt' ? '{' : JSON.stringify({ version: mode === 'version' ? 2 : 1, opportunityId: mode === 'target' ? 'other' : job, commandId: 'id' })
    saveAccountDraft(account, key, raw)
    await expect(stopFollowing(account, job)).rejects.toThrow('STOP_REFERENCE_INVALID')
    expect(readAccountDraft(account, key)).toBe(raw); expect(fetchBackend).not.toHaveBeenCalled()
  })
  it('does not submit when reference persistence fails or Web Locks is unavailable', async () => {
    const original = store.setItem.bind(store)
    store.setItem = (key, value) => { if (key.includes('stop-following')) throw new Error('quota'); original(key, value) }
    await expect(stopFollowing(account, job)).rejects.toThrow('quota'); expect(fetchBackend).not.toHaveBeenCalled()
    store.setItem = original
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })
    await expect(stopFollowing(account, job)).rejects.toThrow('STOP_LOCK_UNAVAILABLE')
    expect(readAccountDraft(account, key)).toBe(''); expect(fetchBackend).not.toHaveBeenCalled()
  })
  it.each(['commandId', 'operation', 'target'])('does not grant Undo from a mismatching %s receipt', async field => {
    const normal = dispatch
    dispatch = body => {
      if (body.action === 'command') {
        const result = success(body.commandId)
        if (field === 'commandId') result.receipt.commandId = 'foreign'
        if (field === 'operation') result.receipt.operation = 'semantic_intake'
        if (field === 'target') result.receipt.affectedObjects[0]!.id = 'foreign'
        return Response.json(result)
      }
      return normal(body)
    }
    await expect(stopFollowing(account, job)).rejects.toThrow('STOP_RECEIPT_MISMATCH')
    expect(retainedStopFollowing(account, job).undoAvailable).toBeUndefined()
  })
  it('never invents an owned receipt/Undo for a no-receipt ALREADY_APPLIED', async () => {
    dispatch = () => Response.json({ ...success('other'), outcome: 'ALREADY_APPLIED', receipt: undefined })
    expect(await stopFollowing(account, job)).toMatchObject({ status: 'no_write' })
    expect((await stopFollowing(account, job)).undoAvailable).toBeUndefined()
  })
  it('reuses the original unknown Undo ID instead of generating another command', async () => {
    await stopFollowing(account, job)
    const normal = dispatch; let fail = true
    dispatch = body => { if (body.action === 'undo' && fail) { writes.push(body); throw new Error('lost-undo') } return normal(body) }
    await expect(undoStopFollowing(account, job)).rejects.toMatchObject({ code: 'UNKNOWN_COMMAND_OUTCOME' })
    const undoId = reference().undoCommandId
    expect(retainedStopFollowing(account, job).undoPending).toBe(true)
    fail = false
    expect((await undoStopFollowing(account, job)).status).toBe('undone')
    expect(writes.filter(body => body.action === 'undo').map(body => body.commandId)).toEqual([undoId, undoId])
    expect(writes.filter(body => body.action === 'undo').every(body => body.targetCommandId === reference().commandId)).toBe(true)
  })
  it('permits a new explicit decision only after a current authorized read shows the old committed decision is no longer current', async () => {
    const current = largeAbandonFixture().before
    current.data.actions = []; current.data.opportunities[0]!.id = job
    vi.mocked(replaceLocalSnapshotFromCloud).mockImplementation(async value => { vi.mocked(exportLocalSnapshot).mockResolvedValue(value); return value })
    const normal = dispatch
    dispatch = body => {
      if (body.action === 'receipt') {
        const found = receipts.get(body.commandId)
        return Response.json(found ? { ...found, found: true, snapshot: current } : { found: false })
      }
      return normal(body)
    }
    const original = await stopFollowing(account, job)
    // Original receipt remains authoritative history; latest state was changed elsewhere.
    const again = await stopFollowing(account, job, { newDecision: true })
    expect(again.commandId).not.toBe(original.commandId); expect(writes).toHaveLength(2)
    current.data.opportunities[0]!.participationStatus = 'abandoned'
    const duplicate = await stopFollowing(account, job, { newDecision: true })
    expect(duplicate.commandId).toBe(again.commandId); expect(writes).toHaveLength(2)
  })
  it('rejects stale completion when another context replaces the locator', async () => {
    await stopFollowing(account, job)
    const normal = dispatch
    dispatch = body => { const value = normal(body); saveAccountDraft(account, key, JSON.stringify({ version: 1, opportunityId: job, commandId: 'new-context' })); return value }
    await expect(inspectStopFollowing(account, job)).rejects.toThrow('STOP_REFERENCE_CHANGED')
    expect(reference().commandId).toBe('new-context')
  })
  it.each([false, true])('distinguishes confirmed server receipt from pending local projection, outbox=%s', async existingPending => {
    if (!existingPending) await stopFollowing(account, job)
    vi.mocked(replaceLocalSnapshotFromCloud).mockRejectedValue(new Error('synthetic-local-projection-conflict'))
    if (existingPending) await expect(stopFollowing(account, job)).rejects.toMatchObject({ code: 'CONNECTED_PROJECTION_PENDING' })
    if (existingPending) expect(retainedStopFollowing(account, job)).toMatchObject({ status: 'projection_pending', automaticRecovery: true })
    const before = writes.length
    expect(await inspectStopFollowing(account, job)).toMatchObject({ status: 'projection_pending', automaticRecovery: existingPending })
    expect((await stopFollowing(account, job)).status).toBe('projection_pending')
    expect(writes).toHaveLength(before)
    expect(listAccountPendingOperations(account).length).toBe(existingPending ? 1 : 0)
  })
  it('retains a confirmed-but-unprojected original Undo without describing it as an unknown write', async () => {
    await stopFollowing(account, job)
    const normal = dispatch
    dispatch = body => {
      if (body.action === 'undo') vi.mocked(replaceLocalSnapshotFromCloud).mockRejectedValue(new Error('local-projection-conflict'))
      return normal(body)
    }
    await expect(undoStopFollowing(account, job)).rejects.toMatchObject({ code: 'CONNECTED_PROJECTION_PENDING' })
    expect(retainedStopFollowing(account, job)).toMatchObject({ status: 'projection_pending', undoPending: true, automaticRecovery: true })
  })
  it('records the generic domain delta interaction and selects delta-v1 for original Undo (mock IDB, not browser)', async () => {
    const records = new Map<string, any>()
    vi.mocked(persistInteractionProjection).mockImplementation(async (record, assertCurrent) => { assertCurrent(); records.set(record.commandId, record) })
    vi.mocked(readCommandInteraction).mockImplementation(async (_account, id) => records.get(id))
    const normal = dispatch
    dispatch = body => {
      if (!['command', 'undo'].includes(body.action)) return normal(body)
      writes.push(body)
      const value = success(body.commandId, body.targetCommandId)
      receipts.set(body.commandId, value)
      const baseRevision = body.action === 'undo' ? 1 : 0
      return Response.json({ ...value, snapshot: undefined, revision: baseRevision + 1, workspaceVersion: `txn:${baseRevision + 1}`,
        delta: { contract: 'delta-v1', baseRevision, changes: [] } })
    }
    const original = await stopFollowing(account, job)
    expect(records.get(original.commandId).command).toEqual({ commandId: original.commandId, kind: 'abandon_opportunity', opportunityId: job })
    expect((await undoStopFollowing(account, job)).status).toBe('undone')
    expect(writes.map(body => body.projection)).toEqual(['delta-v1', 'delta-v1'])
    expect(writes[1].targetCommandId).toBe(original.commandId)
    expect(records.get(writes[1].commandId).targetCommandId).toBe(original.commandId)
  })
  it.each(['command', 'undo'])('rejects an old %s completion after locator replacement without overwriting the new locator', async action => {
    if (action === 'undo') await stopFollowing(account, job)
    const normal = dispatch
    dispatch = body => {
      const result = normal(body)
      if (body.action === action) saveAccountDraft(account, key, JSON.stringify({ version: 1, opportunityId: job, commandId: 'replacement' }))
      return result
    }
    await expect(action === 'undo' ? undoStopFollowing(account, job) : stopFollowing(account, job)).rejects.toThrow('STOP_REFERENCE_CHANGED')
    expect(reference().commandId).toBe('replacement')
  })
  it('revalidates account generation after waiting for the cross-tab lock (A → B → A)', async () => {
    let release!: () => Promise<unknown>
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: vi.fn((_key, run) => new Promise((resolve, reject) => { release = async () => { try { resolve(await run()) } catch (error) { reject(error) } } })) } })
    const pending = stopFollowing(account, job)
    setAccountCacheSession('other'); setAccountCacheSession(account)
    await release()
    await expect(pending).rejects.toThrow('账号或本地数据已变化')
    expect(fetchBackend).not.toHaveBeenCalled(); expect(readAccountDraft(account, key)).toBe('')
  })
})
