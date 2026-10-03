import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PJSDASSnapshot } from '../src/snapshot.js'
import type { CommandInteractionRecord } from '../src/db.js'

const state = vi.hoisted(() => ({ snapshot: undefined as unknown as PJSDASSnapshot, records: new Map<string, CommandInteractionRecord>(), failAfterNoopWrite: false, holdPending: undefined as undefined | Promise<void>, holdRead: undefined as undefined | { id: string; wait: Promise<void> } }))
vi.mock('../src/db.js', async () => {
  const { applyWorkspaceDelta } = await import('../src/workspaceDelta.js')
  return {
    exportLocalSnapshot: async () => structuredClone(state.snapshot),
    isRecordedAccountProjection: async () => true,
    replaceLocalSnapshotFromCloud: async (snapshot: PJSDASSnapshot, guard: { assertCurrent: () => void; interactionSteps: Array<{ record: CommandInteractionRecord; delta: import('../src/workspaceDelta.js').WorkspaceDelta }> }) => {
      guard.assertCurrent(); let next = structuredClone(snapshot)
      for (const { delta } of guard.interactionSteps) next = applyWorkspaceDelta(next, delta)
      guard.assertCurrent(); state.snapshot = next
      for (const { record } of guard.interactionSteps) state.records.set(record.commandId, record)
      return structuredClone(state.snapshot)
    },
    readCommandInteraction: async (_account: string, id: string) => { if (state.holdRead?.id === id) await state.holdRead.wait; return state.records.get(id) },
    readPendingCommandInteractions: async () => { if(state.holdPending) await state.holdPending; return [...state.records.values()].filter(row => ['active', 'projection_pending', 'rollback_pending'].includes(row.state)) },
    saveCommandInteraction: async (record: CommandInteractionRecord) => {
      state.records.set(record.commandId, record)
      if (state.failAfterNoopWrite && record.noOpRevision !== undefined) {
        state.failAfterNoopWrite = false; throw new Error('Synthetic crash after durable no-write acknowledgement')
      }
    },
    persistInteractionProjection: async (record: CommandInteractionRecord, assertCurrent: () => void, delta = record.delta) => {
      assertCurrent(); state.snapshot = applyWorkspaceDelta(state.snapshot, delta); state.records.set(record.commandId, record)
    },
    persistInteractionProjections: async (steps: Array<{ record: CommandInteractionRecord; delta: import('../src/workspaceDelta.js').WorkspaceDelta }>, assertCurrent: () => void) => {
      assertCurrent(); let next = state.snapshot
      for (const { delta } of steps) next = applyWorkspaceDelta(next, delta)
      assertCurrent(); state.snapshot = next
      for (const { record } of steps) state.records.set(record.commandId, record)
    },
  }
})
vi.mock('../src/cloud/authoritativeReadModelClient.js', () => ({ refreshConnectedAuthoritativeCache: vi.fn(async () => undefined) }))
vi.mock('../src/cloud/cloudClient.js', () => ({ getAccountAccessToken: async () => 'synthetic-token' }))
vi.mock('../src/backendEndpoints.js', () => ({ fetchBackend: vi.fn() }))
import { fetchBackend } from '../src/backendEndpoints.js'
import { beginInstantCommand, beginInstantUndo, recoverInstantInteraction } from '../src/cloud/instantCommandClient.js'
import { setAccountCacheSession } from '../src/cloud/accountCacheLease.js'
import { bindLocalWorkspaceToUser, getAccountCheckpoint, patchAccountCheckpoint } from '../src/cloud/syncState.js'
import { listAccountPendingOperations } from '../src/cloud/authoritativeCommandClient.js'
import { applyUserDomainCommand } from '../src/domainCommands.js'
import { diffWorkspaceDelta } from '../src/workspaceDelta.js'
import { instantDenseWorkspace, INSTANT_NOW } from './fixtures/instantDenseWorkspace.js'

class MemoryStorage {
  values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
}
function response(payload: unknown) { return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } }) }

describe('confirmed interaction metadata recovery', () => {
  beforeEach(() => {
    state.snapshot = instantDenseWorkspace(0); state.records.clear(); state.failAfterNoopWrite = false; state.holdRead = undefined; state.holdPending = undefined
    setAccountCacheSession(undefined); setAccountCacheSession('metadata-owner')
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: new MemoryStorage(), dispatchEvent: vi.fn() } })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } })
    bindLocalWorkspaceToUser('metadata-owner')
    patchAccountCheckpoint('metadata-owner', { lastSyncedVersion: 'txn:1204', lastSyncedFingerprint: 'synthetic-baseline' })
    vi.mocked(fetchBackend).mockReset()
  })
  it('does not recover a live action preparation and releases the guard after local settlement', async () => {
    let release!: () => void
    state.holdPending = new Promise<void>(resolve => { release = resolve })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } })
    vi.mocked(fetchBackend).mockResolvedValue(response({ found: false }))
    const command = { commandId: 'live-action-preparation', kind: 'set_action_status' as const, actionId: 'dense-action-0', status: 'done' as const }
    const preparing = beginInstantCommand('metadata-owner', state.snapshot, command)
    expect(listAccountPendingOperations('metadata-owner')).toHaveLength(1)
    expect(state.records.has(command.commandId)).toBe(false)
    await recoverInstantInteraction('metadata-owner', command.commandId)
    expect(fetchBackend).not.toHaveBeenCalled()
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } })
    release();state.holdPending=undefined;await preparing
    await new Promise(resolve=>setTimeout(resolve,0))
    expect(state.records.get(command.commandId)?.state).toBe('active')
    // A later reconnect is real recovery, so the temporary marker must be gone.
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } })
    await recoverInstantInteraction('metadata-owner', command.commandId)
    expect(JSON.parse(String(vi.mocked(fetchBackend).mock.calls[0][1]!.body)).action).toBe('receipt')
  })
  it('does not mistake a live Undo preparation for a crash before its journal transaction', async () => {
    const command = { commandId: 'live-preparation-parent', kind: 'set_action_status' as const, actionId: 'dense-action-0', status: 'done' as const }
    await beginInstantCommand('metadata-owner', state.snapshot, command)
    await new Promise(resolve => setTimeout(resolve, 0))
    const parent = state.records.get(command.commandId)!
    state.records.set(command.commandId, { ...parent, state: 'confirmed', serverRevision: 1205 })
    // Terminal parent no longer belongs in the pending mirror.
    const { settleConnectedInteraction } = await import('../src/cloud/authoritativeCommandClient.js')
    settleConnectedInteraction('metadata-owner', command.commandId)
    let release!: () => void
    state.holdRead = { id: command.commandId, wait: new Promise<void>(resolve => { release = resolve }) }
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } })
    vi.mocked(fetchBackend).mockResolvedValue(response({ found: false }))
    const preparing = beginInstantUndo('metadata-owner', command.commandId, state.snapshot)
    const pending = listAccountPendingOperations('metadata-owner').find(row => row.targetCommandId === command.commandId)!
    expect(pending).toBeDefined(); expect(state.records.has(pending.commandId)).toBe(false)
    // The recovery timer can see the synchronous localStorage reservation while
    // the original caller is still awaiting IDB. It must not query or project it.
    const recovery = recoverInstantInteraction('metadata-owner', pending.commandId)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fetchBackend).not.toHaveBeenCalled()
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } })
    release(); state.holdRead = undefined; state.holdPending = undefined
    await preparing; await recovery
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(state.records.get(pending.commandId)?.state).toBe('active')
    expect(state.snapshot.data.actions.find(row => row.id === 'dense-action-0')?.status).toBe('todo')
  })
  describe.each(['delta', 'snapshot'] as const)('%s response', format => {
  it.each(['checkpoint', 'mirror'] as const)('keeps a committed journal undoable after a failed %s write', async failure => {
    const before = structuredClone(state.snapshot)
    const command = { commandId: `confirmed-${failure}`, kind: 'set_action_status' as const, actionId: 'dense-action-0', status: 'done' as const }
    await beginInstantCommand('metadata-owner', state.snapshot, command)
    await new Promise(resolve => setTimeout(resolve, 0))
    const evaluated = applyUserDomainCommand(before, command, new Date(INSTANT_NOW.getTime() + 1000))
    expect(evaluated.status).toBe('APPLIED')
    if (evaluated.status !== 'APPLIED') return
    const payload = { outcome: 'COMMITTED', revision: 1205, delta: diffWorkspaceDelta(before, evaluated.snapshot, 1204),
      receipt: { commandId: command.commandId, revision: 1205, undoCompensation: evaluated.compensation } }
    vi.mocked(fetchBackend).mockImplementation(async (_url, options) => {
      const body = JSON.parse(options!.body as string)
      if (body.action === 'receipt') return response({ found: false })
      const { delta: _delta, ...legacy } = payload
      return response(format === 'delta' ? payload : { ...legacy, snapshot: evaluated.snapshot, workspaceVersion: 'txn:1205' })
    })
    const storage = window.localStorage as unknown as MemoryStorage
    const setItem = storage.setItem.bind(storage), removeItem = storage.removeItem.bind(storage)
    let armed = true
    storage.setItem = (key, value) => {
      if (armed && failure === 'checkpoint' && key === 'pjsdas-google-drive-sync-state-v2'
        && JSON.parse(value).accounts?.['metadata-owner']?.lastSyncedVersion === 'txn:1205') {
        armed = false; throw new Error('Synthetic post-commit checkpoint failure')
      }
      setItem(key, value)
    }
    storage.removeItem = key => {
      if (armed && failure === 'mirror' && key === 'pjsdas-cgr01-pending:metadata-owner') {
        armed = false; throw new Error('Synthetic post-commit mirror failure')
      }
      removeItem(key)
    }
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
    await recoverInstantInteraction('metadata-owner', command.commandId)
    expect(armed).toBe(false)
    expect(state.records.get(command.commandId)!.state).toBe('confirmed')
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    await expect(beginInstantUndo('metadata-owner', command.commandId, state.snapshot)).resolves.toBeTypeOf('string')
    await new Promise(resolve => setTimeout(resolve, 0))
    await recoverInstantInteraction('metadata-owner', command.commandId)
    expect(getAccountCheckpoint('metadata-owner').lastSyncedVersion).toBe('txn:1205')
    expect(listAccountPendingOperations('metadata-owner').some(item => item.commandId === command.commandId)).toBe(false)
    expect(vi.mocked(fetchBackend).mock.calls.filter(([, options]) => JSON.parse(options!.body as string).action === 'command')).toHaveLength(1)
  })
  })
  it.each([false, true].flatMap(crash => [false, true].flatMap(changed => [false, true].map(undo => ({ crash, changed, undo })))))
  ('recovers receiptless facts without adopting newer writes or Undo ownership (crash=$crash, changed=$changed, undo=$undo)', async ({ crash, changed, undo }) => {
    const initial = structuredClone(state.snapshot)
    const parent = { commandId: 'noop-parent', kind: 'set_date_capacity' as const, date: '2026-10-01', minutes: 300 }
    const child = { ...parent, commandId: 'noop-child', minutes: 240 }
    let remote = applyUserDomainCommand(initial, { ...parent, commandId: 'other-device' }, new Date('2026-10-01T02:00:00Z')).snapshot
    let revision = 1205
    const sent: string[] = [], ledger = new Map<string, unknown>()
    await beginInstantCommand('metadata-owner', state.snapshot, parent)
    await new Promise(resolve => setTimeout(resolve, 0))
    const childId = undo ? await beginInstantUndo('metadata-owner', parent.commandId, state.snapshot)
      : await beginInstantCommand('metadata-owner', state.snapshot, child)
    await new Promise(resolve => setTimeout(resolve, 0))
    await beginInstantCommand('metadata-owner', state.snapshot, { commandId: 'noop-independent', kind: 'set_action_status', actionId: 'dense-action-0', status: 'done' })
    await new Promise(resolve => setTimeout(resolve, 0))
    vi.mocked(fetchBackend).mockImplementation(async (_url, options) => {
      const body = JSON.parse(options!.body as string)
      if (body.action === 'receipt') return response({ found: ledger.has(body.commandId), ...ledger.get(body.commandId) as object })
      if (body.action === 'read') return response({ revision, workspaceVersion: `txn:${revision}`, snapshot: remote })
      sent.push(body.commandId)
      const before = remote, evaluated = applyUserDomainCommand(remote, body.command.value, new Date('2026-10-01T03:00:00Z'))
      if (evaluated.status === 'ALREADY_APPLIED') return response({ outcome: 'ALREADY_APPLIED', revision, workspaceVersion: `txn:${revision}`, recoveryRequired: true })
      if (evaluated.status !== 'APPLIED') throw new Error('Unexpected synthetic command result')
      remote = evaluated.snapshot
      const payload = { outcome: 'COMMITTED', revision: ++revision, delta: diffWorkspaceDelta(before, remote, revision - 1),
        receipt: { commandId: body.commandId, revision, undoCompensation: evaluated.compensation } }
      ledger.set(body.commandId, payload); return response(payload)
    })
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
    state.failAfterNoopWrite = crash
    await recoverInstantInteraction('metadata-owner', parent.commandId)
    expect(state.records.get(parent.commandId)!.noOpRevision).toBe(1205)
    expect(state.records.get(parent.commandId)!.compensation).toBeUndefined()
    if (changed) {
      remote = applyUserDomainCommand(remote, { ...parent, commandId: 'newer-other-device', minutes: 400 }, new Date('2026-10-01T04:00:00Z')).snapshot
      revision++
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      await recoverInstantInteraction('metadata-owner', parent.commandId)
      await recoverInstantInteraction('metadata-owner', childId)
    }
    if (changed) {
      expect(sent).toEqual([parent.commandId])
      expect(remote.data.timePlanning!.dateOverrides!['2026-10-01']).toBe(400)
      expect(state.snapshot.data.timePlanning).toEqual(remote.data.timePlanning)
      expect(state.records.get(parent.commandId)!.state).toBe('conflict')
      expect(state.records.get(childId)!.state).toBe('rejected')
    } else if (undo) {
      expect(sent).toEqual([parent.commandId])
      expect(state.records.get(childId)!.state).toBe('rejected')
      expect(state.snapshot.data.timePlanning).toEqual(remote.data.timePlanning)
      expect(listAccountPendingOperations('metadata-owner').map(item => item.commandId)).toEqual(['noop-independent'])
    } else {
      expect(sent).toEqual([parent.commandId, child.commandId])
      expect(listAccountPendingOperations('metadata-owner').map(item => item.commandId)).toEqual(['noop-independent'])
      expect(state.snapshot.data.timePlanning).toEqual(remote.data.timePlanning)
      expect(state.records.get(parent.commandId)!.serverRevision).toBe(1205)
    }
    await recoverInstantInteraction('metadata-owner', 'noop-independent')
    expect(sent.at(-1)).toBe('noop-independent')
    expect(state.snapshot.data.actions.find(item => item.id === 'dense-action-0')!.status).toBe('done')
    expect(state.snapshot.data.actions).toEqual(remote.data.actions)
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    await expect(beginInstantUndo('metadata-owner', parent.commandId, state.snapshot)).rejects.toThrow()
    await new Promise(resolve => setTimeout(resolve, 0))
  })

  it.each([false, true])('never certifies unseen no-op revisions from an empty delta (terminal=%s)', async terminal => {
    state.snapshot.data.timePlanning!.dateOverrides = { '2026-10-01': 300 }
    const command = { commandId: 'empty-noop', kind: 'set_date_capacity' as const, date: '2026-10-01', minutes: 300 }
    await beginInstantCommand('metadata-owner', state.snapshot, command)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(state.records.get(command.commandId)!.delta.changes).toHaveLength(0)
    const remote = applyUserDomainCommand(state.snapshot, { ...command, commandId: 'other-date-change', date: '2026-10-02', minutes: 80 }, INSTANT_NOW).snapshot
    let reads = 0
    vi.mocked(fetchBackend).mockImplementation(async (_url, options) => {
      const body = JSON.parse(options!.body as string)
      if (body.action === 'receipt') return response({ found: false })
      if (body.action === 'read') { reads++; return response({ revision: 1205, workspaceVersion: 'txn:1205', snapshot: remote }) }
      return response({ outcome: 'ALREADY_APPLIED', revision: 1205, recoveryRequired: true })
    })
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
    if (terminal) state.records.set(command.commandId, { ...state.records.get(command.commandId)!, state: 'confirmed', noOpRevision: 1205, serverRevision: 1205, compensation: undefined })
    await recoverInstantInteraction('metadata-owner', command.commandId)
    expect(reads).toBe(0)
    expect(getAccountCheckpoint('metadata-owner').lastSyncedVersion).toBe('txn:1204')
    expect(state.snapshot.data.timePlanning!.dateOverrides?.['2026-10-02']).toBeUndefined()
    if (!terminal) {
      expect(state.records.get(command.commandId)!.state).toBe('projection_pending')
      await recoverInstantInteraction('metadata-owner', command.commandId)
      // Recovery obtains a readback, then rechecks the authoritative snapshot
      // after receipt reconciliation before its guarded replacement.
      expect(reads).toBe(2)
      expect(state.snapshot.data.timePlanning).toEqual(remote.data.timePlanning)
      expect(getAccountCheckpoint('metadata-owner').lastSyncedVersion).toBe('txn:1205')
    }
  })

})
