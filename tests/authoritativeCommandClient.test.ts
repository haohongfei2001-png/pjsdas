import { setAccountCacheSession } from '../src/cloud/accountCacheLease.js'
import { AccountCacheChangedError } from '../src/cloud/accountCacheLease.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/cloud/cloudClient.js', () => ({
  getAccountAccessToken: vi.fn(async () => 'access-token'),
}))

vi.mock('../src/db.js', () => ({
  isRecordedAccountProjection: vi.fn(async () => false),
  assertLocalSnapshotCurrent: vi.fn(async () => undefined),
  exportLocalSnapshot: vi.fn(async () => snapshot()),
  replaceLocalSnapshotFromCloud: vi.fn(async (value) => value),
}))

vi.mock('../src/backendEndpoints.js', () => ({
  fetchBackend: vi.fn(),
}))

import { fetchBackend } from '../src/backendEndpoints.js'
import { exportLocalSnapshot, replaceLocalSnapshotFromCloud } from '../src/db.js'
import {
  clearAccountDraft,
  confirmConnectedCommand,
  discardAccountPendingOperation,
  executeConnectedBusinessCommand,
  findAccountPendingSemanticOperation,
  listAccountPendingOperations,
  lookupConnectedCommandReceipt,
  queueConnectedBusinessCommand,
  readAccountDraft,
  replayAccountPendingOperations,
  saveAccountDraft,
  UnknownCommandOutcomeError,
  ConnectedProjectionPendingError,
  PreExecutionCommandError,
} from '../src/cloud/authoritativeCommandClient.js'
import { bindLocalWorkspaceToUser, patchAccountCheckpoint } from '../src/cloud/syncState.js'
import { fingerprintWorkspace } from '../src/cloud/workspaceFingerprint.js'
import { upgradeSnapshotToLatest, type PJSDASSnapshot } from '../src/snapshot.js'

class MemoryStorage {
  private values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, String(value)) }
  removeItem(key: string) { this.values.delete(key) }
  clear() { this.values.clear() }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  get length() { return this.values.size }
}

function snapshot(): PJSDASSnapshot {
  return upgradeSnapshotToLatest({
    schema: 'pjsdas-local-snapshot',
    version: 1,
    exportedAt: '2026-09-23T00:00:00.000Z',
    data: {
      opportunities: [],
      processes: [],
      processEvents: [],
      actions: [],
      prep: [],
      applicationGroups: [],
    },
  })
}

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

describe('CGR-01 account-scoped connected command client', () => {
  beforeEach(() => {
    setAccountCacheSession(undefined)
    setAccountCacheSession('account-a')
    const localStorage = new MemoryStorage()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { localStorage, dispatchEvent: vi.fn() },
    })
    bindLocalWorkspaceToUser('account-a')
    vi.mocked(fetchBackend).mockReset()
    vi.mocked(exportLocalSnapshot).mockReset().mockImplementation(async () => snapshot())
    vi.mocked(replaceLocalSnapshotFromCloud).mockReset().mockImplementation(async value => value)
  })

  it('keeps drafts and pending operations isolated by account', async () => {
    saveAccountDraft('account-a', 'tell-pjsdas', 'A draft')
    saveAccountDraft('account-b', 'tell-pjsdas', 'B draft')
    expect(readAccountDraft('account-a', 'tell-pjsdas')).toBe('A draft')
    expect(readAccountDraft('account-b', 'tell-pjsdas')).toBe('B draft')

    vi.mocked(fetchBackend).mockResolvedValue(response({
      outcome: 'CONFLICT',
      revision: 4,
      workspaceVersion: 'txn:4',
      schemaVersion: 4,
      snapshot: snapshot(),
      conflict: {
        kind: 'OBJECT_CONFLICT',
        message: 'same action changed',
        objects: [{ type: 'action', id: 'action-a' }],
      },
    }, 409))

    const commandId = 'web-action:account-a-0001'
    await executeConnectedBusinessCommand('account-a', {
      type: 'domain',
      value: { commandId, kind: 'set_action_status', actionId: 'action-a', status: 'done' },
    }, { commandId, baseRevision: 3 })

    expect(listAccountPendingOperations('account-a')).toMatchObject([
      { commandId, status: 'conflict' },
    ])
    expect(listAccountPendingOperations('account-b')).toEqual([])
    clearAccountDraft('account-a', 'tell-pjsdas')
    expect(readAccountDraft('account-a', 'tell-pjsdas')).toBe('')
    expect(readAccountDraft('account-b', 'tell-pjsdas')).toBe('B draft')
  })

  it('retires a known conflicted pending operation only when the user intentionally edits into a new intent', async () => {
    vi.mocked(fetchBackend).mockResolvedValue(response({
      outcome: 'CONFLICT',
      revision: 4,
      workspaceVersion: 'txn:4',
      schemaVersion: 4,
      snapshot: snapshot(),
      conflict: {
        kind: 'OBJECT_CONFLICT',
        message: 'same object changed',
        objects: [{ type: 'action', id: 'action-a' }],
      },
    }, 409))

    const commandId = 'web-action:conflict-retire'
    await executeConnectedBusinessCommand('account-a', {
      type: 'domain',
      value: { commandId, kind: 'set_action_status', actionId: 'action-a', status: 'done' },
    }, { commandId, baseRevision: 3 })

    expect(listAccountPendingOperations('account-a')).toMatchObject([{ commandId, status: 'conflict' }])
    discardAccountPendingOperation('account-a', commandId)
    expect(listAccountPendingOperations('account-a')).toEqual([])
  })

  it('restores the same semantic command identity for an unknown capture after close or reload', async () => {
    const commandId = 'web-semantic:unknown-reopen'
    const command = {
      type: 'semantic_intake' as const,
      value: {
        contractVersion: 1 as const,
        inputId: 'web:capture-1',
        source: {
          kind: 'web' as const,
          sourceId: 'todayaction-web',
          sourceRecordId: 'capture-1',
          observedAt: '2026-09-23T00:00:00.000Z',
          timezone: 'Asia/Shanghai',
        },
        statementMode: 'assertion' as const,
        originalText: '事项：整理面试材料',
        contextRefs: [],
        candidates: [],
      },
    }
    vi.mocked(fetchBackend)
      .mockRejectedValueOnce(new Error('transport lost'))
      .mockRejectedValueOnce(new Error('receipt lookup lost'))

    await expect(executeConnectedBusinessCommand('account-a', command, { commandId, baseRevision: 7 }))
      .rejects.toBeInstanceOf(UnknownCommandOutcomeError)

    expect(findAccountPendingSemanticOperation('account-a', '事项：整理面试材料')).toMatchObject({
      commandId,
      status: 'unknown',
      originalText: '事项：整理面试材料',
    })
  })

  it('queues a verified account command offline and replays the same identity after remote advances', async () => {
    const commandId = 'web-semantic:offline-restart'
    const command = { type: 'domain' as const, value: {
      commandId, kind: 'set_action_status' as const, actionId: 'action-a', status: 'done' as const,
    } }
    const fingerprint = await fingerprintWorkspace(snapshot())
    patchAccountCheckpoint('account-a', { lastSyncedVersion: 'txn:7', lastSyncedFingerprint: fingerprint })
    await queueConnectedBusinessCommand('account-a', command, { commandId })
    await queueConnectedBusinessCommand('account-a', command, { commandId })
    expect(fetchBackend).not.toHaveBeenCalled()
    expect(listAccountPendingOperations('account-a')).toMatchObject([{ commandId, baseRevision: 7, status: 'pending' }])
    vi.mocked(fetchBackend).mockImplementation(async (_path, init) => {
      const body = JSON.parse(String(init?.body))
      if (body.action === 'receipt') return response({ found: false })
      expect(body).toMatchObject({ action: 'command', commandId, baseRevision: 7, command })
      return response({ outcome: 'COMMITTED', revision: 10, workspaceVersion: 'txn:10',
        schemaVersion: 4, snapshot: snapshot(), receipt: { commandId, status: 'COMMITTED' } })
    })
    expect(await replayAccountPendingOperations('account-a')).toMatchObject([{ outcome: 'COMMITTED' }])
    expect(listAccountPendingOperations('account-a')).toEqual([])
    expect(vi.mocked(fetchBackend).mock.calls.filter(([, init]) => JSON.parse(String(init?.body)).action === 'command')).toHaveLength(1)
  })

  it('does not queue against an unverified account cache or reuse an id for a changed payload', async () => {
    const commandId = 'web-action:offline-protected'
    const command = { type: 'domain' as const, value: {
      commandId, kind: 'set_action_status' as const, actionId: 'action-a', status: 'done' as const,
    } }
    await expect(queueConnectedBusinessCommand('account-a', command)).rejects.toThrow('尚无已核实')
    const fingerprint = await fingerprintWorkspace(snapshot())
    patchAccountCheckpoint('account-a', { lastSyncedVersion: 'txn:7', lastSyncedFingerprint: fingerprint })
    bindLocalWorkspaceToUser('account-b')
    await expect(queueConnectedBusinessCommand('account-a', command)).rejects.toThrow('尚无已核实')
    bindLocalWorkspaceToUser('account-a')
    await queueConnectedBusinessCommand('account-a', command)
    await expect(queueConnectedBusinessCommand('account-a', { type: 'domain', value: {
      ...command.value, status: 'doing',
    } })).rejects.toThrow('原操作内容已变化')
    expect(listAccountPendingOperations('account-a')).toHaveLength(1)
  })

  it('keeps an unsynced local edit intact instead of queuing against its old checkpoint', async () => {
    const fingerprint = await fingerprintWorkspace(snapshot())
    patchAccountCheckpoint('account-a', { lastSyncedVersion: 'txn:7', lastSyncedFingerprint: fingerprint })
    const changed = snapshot()
    changed.data.actions.push({ id: 'local-only', kind: 'manual', title: 'Local edit',
      estimatedMinutes: 20, leverage: 50, delayCost: 50, status: 'todo',
      createdAt: '2026-09-23T00:00:00.000Z', updatedAt: '2026-09-23T00:00:00.000Z' })
    vi.mocked(exportLocalSnapshot).mockResolvedValue(changed)
    await expect(queueConnectedBusinessCommand('account-a', { type: 'domain', value: {
      commandId: 'web-action:dirty', kind: 'set_action_status', actionId: 'local-only', status: 'done',
    } })).rejects.toBeInstanceOf(AccountCacheChangedError)
    expect(listAccountPendingOperations('account-a')).toEqual([])
    expect(fetchBackend).not.toHaveBeenCalled()
  })

  it('shares one in-flight recovery when reconnect and foreground refresh race', async () => {
    const commandId = 'web-action:one-flight'
    const fingerprint = await fingerprintWorkspace(snapshot())
    patchAccountCheckpoint('account-a', { lastSyncedVersion: 'txn:7', lastSyncedFingerprint: fingerprint })
    await queueConnectedBusinessCommand('account-a', { type: 'domain', value: {
      commandId, kind: 'set_action_status', actionId: 'action-a', status: 'done',
    } })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let commandCalls = 0
    vi.mocked(fetchBackend).mockImplementation(async (_path, init) => {
      const body = JSON.parse(String(init?.body))
      if (body.action === 'receipt') return response({ found: false })
      commandCalls += 1
      await gate
      return response({ outcome: 'COMMITTED', revision: 8, workspaceVersion: 'txn:8',
        schemaVersion: 4, snapshot: snapshot(), receipt: { commandId, status: 'COMMITTED' } })
    })
    const first = replayAccountPendingOperations('account-a')
    const second = replayAccountPendingOperations('account-a')
    release()
    await Promise.all([first, second])
    expect(commandCalls).toBe(1)
    expect(listAccountPendingOperations('account-a')).toEqual([])
  })

  it('recovers a lost response by receipt identity without sending a duplicate command', async () => {
    let calls = 0
    vi.mocked(fetchBackend).mockImplementation(async (_path, init) => {
      calls += 1
      const body = JSON.parse(String(init?.body))
      if (calls <= 2) throw new Error('simulated transport loss')
      expect(body).toEqual({ action: 'receipt', commandId: 'web-action:lost-0001' })
      return response({
        found: true,
        revision: 8,
        workspaceVersion: 'txn:8',
        schemaVersion: 4,
        snapshot: snapshot(),
        receipt: {
          commandId: 'web-action:lost-0001',
          receiptId: 'command-receipt:web-action:lost-0001',
          status: 'COMMITTED',
          revision: 8,
          result: { status: 'APPLIED', summary: 'done' },
        },
      })
    })

    const commandId = 'web-action:lost-0001'
    const command = {
      type: 'domain' as const,
      value: { commandId, kind: 'set_action_status' as const, actionId: 'action-a', status: 'done' as const },
    }

    await expect(executeConnectedBusinessCommand('account-a', command, {
      commandId,
      baseRevision: 7,
    })).rejects.toBeInstanceOf(UnknownCommandOutcomeError)

    expect(listAccountPendingOperations('account-a')).toMatchObject([
      { commandId, status: 'unknown' },
    ])

    const replayed = await replayAccountPendingOperations('account-a')
    expect(replayed).toHaveLength(1)
    expect(replayed[0]).toMatchObject({
      outcome: 'ALREADY_APPLIED',
      revision: 8,
      receipt: { receiptId: 'command-receipt:web-action:lost-0001' },
    })
    expect(calls).toBe(3)
    expect(listAccountPendingOperations('account-a')).toEqual([])
    expect(replaceLocalSnapshotFromCloud).toHaveBeenCalledTimes(1)
  })

  it('keeps an auth-rejected command pending and safely resumes it after reauthentication', async () => {
    const commandId = 'web-action:reauth-0001'
    const command = {
      type: 'domain' as const,
      value: { commandId, kind: 'set_action_status' as const, actionId: 'action-a', status: 'done' as const },
    }

    vi.mocked(fetchBackend).mockResolvedValueOnce(response({
      code: 'AUTH_REQUIRED',
      message: 'session expired',
      retryable: false,
    }, 401))

    await expect(executeConnectedBusinessCommand('account-a', command, {
      commandId,
      baseRevision: 7,
    })).rejects.toMatchObject({ code: 'SESSION_EXPIRED_BEFORE_COMMAND' } satisfies Partial<PreExecutionCommandError>)

    expect(listAccountPendingOperations('account-a')).toMatchObject([
      { commandId, status: 'pending' },
    ])

    vi.mocked(fetchBackend)
      .mockResolvedValueOnce(response({
        found: false,
        revision: 7,
        workspaceVersion: 'txn:7',
        schemaVersion: 4,
        snapshot: snapshot(),
      }))
      .mockResolvedValueOnce(response({
        outcome: 'COMMITTED',
        revision: 8,
        workspaceVersion: 'txn:8',
        schemaVersion: 4,
        snapshot: snapshot(),
        receipt: {
          commandId,
          receiptId: `command-receipt:${commandId}`,
          status: 'COMMITTED',
          revision: 8,
          result: { status: 'APPLIED', summary: 'done after reauthentication' },
        },
        result: { status: 'APPLIED', summary: 'done after reauthentication' },
      }))

    const replayed = await replayAccountPendingOperations('account-a')
    expect(replayed).toMatchObject([{ outcome: 'COMMITTED', revision: 8 }])
    expect(listAccountPendingOperations('account-a')).toEqual([])
  })

  it.each(['complete_occurrence', 'cancel_occurrence', 'reschedule_occurrence'] as const)(
    'keeps a committed %s receipt distinct from a blocked local projection', async (kind) => {
      const commandId = `web-occurrence:${kind}`
      const command = { type: 'domain' as const, value: {
        commandId, kind, occurrenceId: 'occurrence-a',
        ...(kind === 'reschedule_occurrence' ? { temporal: {
          shape: 'date_only' as const, precision: 'date' as const,
          timezone: 'floating-date', date: '2026-10-01', resolutionBasis: 'user_explicit' as const,
        } } : {}),
      } }
      vi.mocked(replaceLocalSnapshotFromCloud).mockRejectedValue(new Error('local projection blocked'))
      let commandCalls = 0
      vi.mocked(fetchBackend).mockImplementation(async (_path, init) => {
        const body = JSON.parse(String(init?.body))
        if (body.action === 'command') {
          commandCalls += 1
          return response({ outcome: 'COMMITTED', revision: 8, workspaceVersion: 'txn:8',
            schemaVersion: 4, snapshot: snapshot() })
        }
        expect(body).toEqual({ action: 'receipt', commandId })
        return response({ found: true, revision: 8, workspaceVersion: 'txn:8',
          schemaVersion: 4, snapshot: snapshot(), receipt: { commandId, status: 'COMMITTED' } })
      })
      const submitted = await executeConnectedBusinessCommand('account-a', command as any, { commandId, baseRevision: 7, allowProjectionPending: true })
      expect(submitted).toMatchObject({ outcome: 'COMMITTED', localProjection: 'pending' })
      expect(listAccountPendingOperations('account-a')).toMatchObject([{ commandId, status: 'projection_pending' }])
      const confirmed = await confirmConnectedCommand('account-a', commandId, { allowProjectionPending: true })
      expect(confirmed).toMatchObject({ outcome: 'ALREADY_APPLIED', localProjection: 'pending' })
      await replayAccountPendingOperations('account-a')
      expect(commandCalls).toBe(1)
      expect(listAccountPendingOperations('account-a')).toMatchObject([{ commandId, status: 'projection_pending' }])
    },
  )

  it('does not resubmit a confirmed command when a later receipt lookup is absent', async () => {
    const commandId = 'web-occurrence:confirmed-absent'
    vi.mocked(replaceLocalSnapshotFromCloud).mockRejectedValue(new Error('local projection blocked'))
    let commandCalls = 0
    vi.mocked(fetchBackend).mockImplementation(async (_path, init) => {
      const body = JSON.parse(String(init?.body))
      if (body.action === 'command') {
        commandCalls += 1
        return response({ outcome: 'COMMITTED', revision: 8, workspaceVersion: 'txn:8', schemaVersion: 4, snapshot: snapshot() })
      }
      return response({ found: false })
    })
    await executeConnectedBusinessCommand('account-a', { type: 'domain', value: {
      commandId, kind: 'cancel_occurrence', occurrenceId: 'occurrence-a',
    } }, { commandId, baseRevision: 7, allowProjectionPending: true })
    await replayAccountPendingOperations('account-a')
    await expect(confirmConnectedCommand('account-a', commandId)).rejects.toBeInstanceOf(ConnectedProjectionPendingError)
    expect(commandCalls).toBe(1)
  })

  it('reads an existing server receipt even when the local database cannot be opened', async () => {
    const commandId = 'web-occurrence:receipt-before-db'
    vi.mocked(exportLocalSnapshot).mockRejectedValueOnce(new Error('IndexedDB temporarily unavailable'))
    vi.mocked(fetchBackend).mockResolvedValue(response({ found: true, revision: 9, workspaceVersion: 'txn:9',
      schemaVersion: 4, snapshot: snapshot(), receipt: { commandId, status: 'COMMITTED' } }))
    expect(await lookupConnectedCommandReceipt('account-a', commandId)).toMatchObject({
      outcome: 'ALREADY_APPLIED', localProjection: 'pending',
    })
    expect(fetchBackend).toHaveBeenCalledTimes(1)
  })

  it('applies a later safe receipt projection and retires the stable pending identity', async () => {
    const commandId = 'web-occurrence:projection-retry'
    vi.mocked(replaceLocalSnapshotFromCloud).mockRejectedValueOnce(new Error('local projection blocked'))
    let commandCalls = 0
    vi.mocked(fetchBackend).mockImplementation(async (_path, init) => {
      const body = JSON.parse(String(init?.body))
      if (body.action === 'command') commandCalls += 1
      return response(body.action === 'command'
        ? { outcome: 'COMMITTED', revision: 8, workspaceVersion: 'txn:8', schemaVersion: 4, snapshot: snapshot() }
        : { found: true, revision: 8, workspaceVersion: 'txn:8', schemaVersion: 4, snapshot: snapshot(), receipt: { commandId, status: 'COMMITTED' } })
    })
    expect(await executeConnectedBusinessCommand('account-a', { type: 'domain', value: {
      commandId, kind: 'complete_occurrence', occurrenceId: 'occurrence-a',
    } }, { commandId, baseRevision: 7, allowProjectionPending: true })).toMatchObject({ localProjection: 'pending' })
    expect(await replayAccountPendingOperations('account-a')).toMatchObject([{ localProjection: 'applied' }])
    expect(listAccountPendingOperations('account-a')).toEqual([])
    expect(commandCalls).toBe(1)
  })

  it('does not report a committed command as locally saved to ordinary callers', async () => {
    const commandId = 'web-semantic:blocked-projection'
    vi.mocked(replaceLocalSnapshotFromCloud).mockRejectedValue(new Error('local projection blocked'))
    vi.mocked(fetchBackend).mockImplementation(async () => response({ outcome: 'COMMITTED', revision: 8,
      workspaceVersion: 'txn:8', schemaVersion: 4, snapshot: snapshot() }))
    await expect(executeConnectedBusinessCommand('account-a', { type: 'domain', value: {
      commandId, kind: 'complete_occurrence', occurrenceId: 'occurrence-a',
    } }, { commandId, baseRevision: 7 })).rejects.toBeInstanceOf(ConnectedProjectionPendingError)
    expect(listAccountPendingOperations('account-a')).toMatchObject([{ commandId, status: 'projection_pending' }])
  })

  it('allows an independent command after an earlier commit awaits projection', async () => {
    const firstId = 'web-occurrence:first-committed'
    const secondId = 'web-occurrence:blocked-before-send'
    vi.mocked(replaceLocalSnapshotFromCloud).mockRejectedValue(new Error('local projection blocked'))
    vi.mocked(fetchBackend).mockImplementation(async () => response({ outcome: 'COMMITTED', revision: 8,
      workspaceVersion: 'txn:8', schemaVersion: 4, snapshot: snapshot() }))
    expect(await executeConnectedBusinessCommand('account-a', { type: 'domain', value: {
      commandId: firstId, kind: 'cancel_occurrence', occurrenceId: 'occurrence-a',
    } }, { commandId: firstId, baseRevision: 7, allowProjectionPending: true })).toMatchObject({ localProjection: 'pending' })
    await expect(executeConnectedBusinessCommand('account-a', { type: 'domain', value: {
      commandId: secondId, kind: 'complete_occurrence', occurrenceId: 'occurrence-b',
    } }, { commandId: secondId, baseRevision: 7, allowProjectionPending: true })).resolves.toMatchObject({ outcome: 'COMMITTED', localProjection: 'pending' })
    expect(listAccountPendingOperations('account-a').map(item => item.commandId)).toEqual([firstId, secondId])
    expect(fetchBackend).toHaveBeenCalledTimes(2)
  })

  it('preserves a known same-object server conflict even if its snapshot cannot project locally', async () => {
    const commandId = 'web-occurrence:same-object-conflict'
    vi.mocked(replaceLocalSnapshotFromCloud).mockRejectedValue(new Error('local projection blocked'))
    vi.mocked(fetchBackend).mockResolvedValue(response({ outcome: 'CONFLICT', revision: 9,
      workspaceVersion: 'txn:9', schemaVersion: 4, snapshot: snapshot(),
      conflict: { kind: 'OBJECT_CONFLICT', message: 'Same occurrence changed',
        objects: [{ type: 'occurrence', id: 'occurrence-a' }] },
    }, 409))
    expect(await executeConnectedBusinessCommand('account-a', { type: 'domain', value: {
      commandId, kind: 'cancel_occurrence', occurrenceId: 'occurrence-a',
    } }, { commandId, baseRevision: 7 })).toMatchObject({ outcome: 'CONFLICT' })
    expect(listAccountPendingOperations('account-a')).toMatchObject([{ commandId, status: 'conflict' }])
    expect(fetchBackend).toHaveBeenCalledTimes(1)
  })

  it('retires a no-write command without waiting for a receipt the server never created', async () => {
    const commandId = 'web-occurrence:no-write'
    vi.mocked(replaceLocalSnapshotFromCloud).mockRejectedValue(new Error('local projection blocked'))
    vi.mocked(fetchBackend).mockResolvedValue(response({ outcome: 'NO_WRITE', revision: 8,
      workspaceVersion: 'txn:8', schemaVersion: 4, snapshot: snapshot() }))
    expect(await executeConnectedBusinessCommand('account-a', { type: 'domain', value: {
      commandId, kind: 'cancel_occurrence', occurrenceId: 'occurrence-a',
    } }, { commandId, baseRevision: 7 })).toMatchObject({ outcome: 'NO_WRITE', localProjection: 'pending' })
    expect(listAccountPendingOperations('account-a')).toEqual([])
    expect(await replayAccountPendingOperations('account-a')).toEqual([])
  })
})
