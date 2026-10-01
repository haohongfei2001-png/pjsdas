import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PJSDASSnapshot } from '../src/snapshot.js'
import type { CommandInteractionRecord } from '../src/db.js'

const state = vi.hoisted(() => ({ snapshot: undefined as unknown as PJSDASSnapshot, records: new Map<string, CommandInteractionRecord>() }))
vi.mock('../src/db.js', async () => {
  const { applyWorkspaceDelta } = await import('../src/workspaceDelta.js')
  return {
    exportLocalSnapshot: async () => structuredClone(state.snapshot),
    isRecordedAccountProjection: async () => true,
    replaceLocalSnapshotFromCloud: async (snapshot: PJSDASSnapshot, guard: { assertCurrent: () => void; interactionSteps: Array<{ record: CommandInteractionRecord }> }) => {
      guard.assertCurrent(); state.snapshot = structuredClone(snapshot)
      for (const { record } of guard.interactionSteps) state.records.set(record.commandId, record)
      return structuredClone(state.snapshot)
    },
    readCommandInteraction: async (_account: string, id: string) => state.records.get(id),
    readPendingCommandInteractions: async () => [...state.records.values()].filter(row => ['active', 'projection_pending', 'rollback_pending'].includes(row.state)),
    saveCommandInteraction: async (record: CommandInteractionRecord) => { state.records.set(record.commandId, record) },
    persistInteractionProjection: async (record: CommandInteractionRecord, assertCurrent: () => void, delta = record.delta) => {
      assertCurrent(); state.snapshot = applyWorkspaceDelta(state.snapshot, delta); state.records.set(record.commandId, record)
    },
    persistInteractionProjections: vi.fn(),
  }
})
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
    state.snapshot = instantDenseWorkspace(0); state.records.clear()
    setAccountCacheSession(undefined); setAccountCacheSession('metadata-owner')
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: new MemoryStorage(), dispatchEvent: vi.fn() } })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } })
    bindLocalWorkspaceToUser('metadata-owner')
    patchAccountCheckpoint('metadata-owner', { lastSyncedVersion: 'txn:1204', lastSyncedFingerprint: 'synthetic-baseline' })
    vi.mocked(fetchBackend).mockReset()
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
})
