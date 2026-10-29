import { WorkspaceWriteAuthError } from '../src/cloud/workspaceWriteLease.js'
import { beginAccountCacheSessionResolution, setAccountCacheSession } from '../src/cloud/accountCacheLease.js'
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
  undoConnectedBusinessCommand,
  readAccountDraft,
  replayAccountPendingOperations,
  saveAccountDraft,
  rememberCaptureDraftContext,
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

  it.each(['execute', 'queue', 'undo', 'confirm'] as const)('blocks %s before reading, staging, or sending while Auth is unresolved', async mode => {
    beginAccountCacheSessionResolution()
    const command = { type: 'domain' as const, value: { commandId: 'unresolved-command',
      kind: 'set_action_status' as const, actionId: 'action-a', status: 'done' as const } }
    const operation = mode === 'execute' ? executeConnectedBusinessCommand('account-a', command)
      : mode === 'queue' ? queueConnectedBusinessCommand('account-a', command)
        : mode === 'undo' ? undoConnectedBusinessCommand('account-a', 'prior-receipt')
          : confirmConnectedCommand('account-a', 'prior-receipt')
    await expect(operation).rejects.toBeInstanceOf(WorkspaceWriteAuthError)
    expect(listAccountPendingOperations('account-a')).toEqual([])
    expect(exportLocalSnapshot).not.toHaveBeenCalled()
    expect(fetchBackend).not.toHaveBeenCalled()
  })

  it('does not stage a command after its revision read changes the active account', async () => {
    vi.mocked(fetchBackend).mockImplementationOnce(async () => {
      setAccountCacheSession('account-b')
      return response({ revision: 7, workspaceVersion: 'txn:7', schemaVersion: 4, snapshot: snapshot() })
    })
    await expect(executeConnectedBusinessCommand('account-a', { type: 'domain', value: {
      commandId: 'delayed-revision', kind: 'set_action_status', actionId: 'action-a', status: 'done',
    } })).rejects.toBeInstanceOf(AccountCacheChangedError)
    expect(listAccountPendingOperations('account-a')).toEqual([])
    expect(listAccountPendingOperations('account-b')).toEqual([])
    expect(fetchBackend).toHaveBeenCalledTimes(1)
    expect(replaceLocalSnapshotFromCloud).not.toHaveBeenCalled()
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

  it('keeps the outbox untouched when background recovery fires after going offline', async () => {
    const commandId = 'web-action:offline-background'
    const command = { type: 'domain' as const, value: {
      commandId, kind: 'set_action_status' as const, actionId: 'action-a', status: 'done' as const,
    } }
    const fingerprint = await fingerprintWorkspace(snapshot())
    patchAccountCheckpoint('account-a', { lastSyncedVersion: 'txn:7', lastSyncedFingerprint: fingerprint })
    await queueConnectedBusinessCommand('account-a', command, { commandId })
    vi.stubGlobal('navigator', { onLine: false })
    try {
      expect(await replayAccountPendingOperations('account-a')).toEqual([])
      expect(fetchBackend).not.toHaveBeenCalled()
      expect(listAccountPendingOperations('account-a')).toMatchObject([{ commandId, status: 'pending' }])
    } finally {
      vi.unstubAllGlobals()
    }
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
    await expect(queueConnectedBusinessCommand('account-a', command)).rejects.toBeInstanceOf(WorkspaceWriteAuthError)
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

  it('recovers later committed receipts after a queue-head denial without sending later unconfirmed commands', async () => {
    const ids = ['denied-head', 'already-committed', 'still-unconfirmed']
    patchAccountCheckpoint('account-a', { lastSyncedVersion: 'txn:7', lastSyncedFingerprint: await fingerprintWorkspace(snapshot()) })
    saveAccountDraft('account-a', 'tell-pjsdas', 'original draft')
    for (const commandId of ids) await queueConnectedBusinessCommand('account-a', { type: 'domain', value: {
      commandId, kind: 'set_action_status', actionId: commandId, status: 'done',
    } })
    const original = structuredClone(listAccountPendingOperations('account-a'))
    const requests: string[] = []
    vi.mocked(fetchBackend).mockImplementation(async (_path, init) => {
      const body = JSON.parse(String(init?.body)); requests.push(`${body.action}:${body.commandId}`)
      if (body.action === 'receipt') return body.commandId === ids[1]
        ? response({ found: true, revision: 8, workspaceVersion: 'txn:8', schemaVersion: 4,
          snapshot: snapshot(), receipt: { commandId: body.commandId, status: 'COMMITTED' } })
        : response({ found: false })
      expect(body.commandId).toBe(ids[0])
      return response({ code: 'AUTH_FORBIDDEN' }, 403)
    })
    await expect(replayAccountPendingOperations('account-a')).rejects.toBeInstanceOf(PreExecutionCommandError)
    expect(requests).toEqual(['receipt:denied-head', 'command:denied-head', 'receipt:already-committed', 'receipt:still-unconfirmed'])
    const pending = listAccountPendingOperations('account-a')
    expect(pending.map(item => item.commandId)).toEqual([ids[0], ids[2]])
    expect(pending[0]).toMatchObject({ command: original[0].command, baseRevision: 7, status: 'pending' })
    expect(pending[1]).toEqual(original[2])
    expect(readAccountDraft('account-a', 'tell-pjsdas')).toBe('original draft')
  })

  it.each(['transport', 'permission'] as const)('does not let a %s receipt failure hide later receipts or replace the first error', async failure => {
    patchAccountCheckpoint('account-a', { lastSyncedVersion: 'txn:7', lastSyncedFingerprint: await fingerprintWorkspace(snapshot()) })
    for (const commandId of ['read-failed-head', 'read-failed-middle', 'read-committed-tail']) {
      await queueConnectedBusinessCommand('account-a', { type: 'domain', value: {
        commandId, kind: 'set_action_status', actionId: commandId, status: 'done',
      } })
    }
    const requests: string[] = []
    vi.mocked(fetchBackend).mockImplementation(async (_path, init) => {
      const body = JSON.parse(String(init?.body)); requests.push(`${body.action}:${body.commandId}`)
      expect(body.action).toBe('receipt')
      if (body.commandId === 'read-failed-head') {
        if (failure === 'transport') throw new Error('original receipt transport failure')
        return response({ code: 'AUTH_FORBIDDEN', message: 'original receipt permission failure' }, 403)
      }
      if (body.commandId === 'read-failed-middle') throw new Error('secondary receipt failure')
      return response({ found: true, revision: 8, workspaceVersion: 'txn:8', schemaVersion: 4,
        snapshot: snapshot(), receipt: { commandId: body.commandId, status: 'COMMITTED' } })
    })
    await expect(replayAccountPendingOperations('account-a')).rejects.toThrow(`original receipt ${failure} failure`)
    expect(requests).toEqual(['receipt:read-failed-head', 'receipt:read-failed-middle', 'receipt:read-committed-tail'])
    expect(listAccountPendingOperations('account-a').map(item => item.commandId)).toEqual(['read-failed-head', 'read-failed-middle'])
  })

  it.each(['different-account', 'same-account-new-generation', 'unresolved-auth'] as const)('stops recovery immediately on %s, including after a prior item failure', async transition => {
    patchAccountCheckpoint('account-a', { lastSyncedVersion: 'txn:7', lastSyncedFingerprint: await fingerprintWorkspace(snapshot()) })
    for (const commandId of ['failed-head', 'switch-middle', 'untouched-tail']) await queueConnectedBusinessCommand('account-a', { type: 'domain', value: {
      commandId, kind: 'set_action_status', actionId: commandId, status: 'done',
    } })
    const original = structuredClone(listAccountPendingOperations('account-a'))
    const requests: string[] = []
    vi.mocked(fetchBackend).mockImplementation(async (_path, init) => {
      const body = JSON.parse(String(init?.body)); requests.push(body.commandId)
      expect(body.action).toBe('receipt')
      if (body.commandId === 'failed-head') throw new Error('original temporary failure')
      if (transition === 'unresolved-auth') beginAccountCacheSessionResolution()
      else { setAccountCacheSession('account-b'); if (transition === 'same-account-new-generation') setAccountCacheSession('account-a') }
      return response({ found: false })
    })
    await expect(replayAccountPendingOperations('account-a')).rejects.toBeInstanceOf(AccountCacheChangedError)
    expect(requests).toEqual(['failed-head', 'switch-middle'])
    expect(listAccountPendingOperations('account-a')).toEqual(original)
    expect(listAccountPendingOperations('account-b')).toEqual([])
    expect(replaceLocalSnapshotFromCloud).not.toHaveBeenCalled()
  })

  it.each(['pending', 'projection_pending', 'confirmed-fact'] as const)('does not publish a stale recovered event when %s projection detects an account transition', async mode => {
    patchAccountCheckpoint('account-a', { lastSyncedVersion: 'txn:7', lastSyncedFingerprint: await fingerprintWorkspace(snapshot()) })
    for (const commandId of ['projection-switch', 'untouched-after-projection']) await queueConnectedBusinessCommand('account-a', { type: 'domain', value: {
      commandId, kind: 'set_action_status', actionId: commandId, status: 'done',
    } })
    if (mode !== 'pending') {
      const items = listAccountPendingOperations('account-a')
      items[0].status = 'projection_pending'
      if (mode === 'confirmed-fact') items[0].confirmedFact = 'ALREADY_APPLIED'
      window.localStorage.setItem('pjsdas-cgr01-pending:account-a', JSON.stringify(items))
    }
    saveAccountDraft('account-a', 'tell-pjsdas', 'preserved original draft')
    vi.mocked(fetchBackend).mockImplementation(async (_path, init) => {
      const body = JSON.parse(String(init?.body))
      expect(body.action).toBe(mode === 'confirmed-fact' ? 'read' : 'receipt')
      return response({ found: true, revision: 8, workspaceVersion: 'txn:8', schemaVersion: 4,
        snapshot: snapshot(), receipt: { commandId: 'projection-switch', status: 'COMMITTED' } })
    })
    vi.mocked(replaceLocalSnapshotFromCloud).mockImplementation(async () => {
      setAccountCacheSession('account-b')
      throw new AccountCacheChangedError()
    })
    await expect(replayAccountPendingOperations('account-a')).rejects.toBeInstanceOf(AccountCacheChangedError)
    expect(fetchBackend).toHaveBeenCalledTimes(1)
    expect(window.dispatchEvent).not.toHaveBeenCalled()
    expect(listAccountPendingOperations('account-a').map(item => item.commandId)).toEqual(['projection-switch', 'untouched-after-projection'])
    expect(readAccountDraft('account-a', 'tell-pjsdas')).toBe('preserved original draft')
  })

  it('recovers a lost response by receipt identity without sending a duplicate command', async () => {
    let calls = 0
    vi.mocked(fetchBackend).mockImplementation(async (_path, init) => {
      calls += 1
      const body = JSON.parse(String(init?.body))
      if (calls <= 2) throw new Error('simulated transport loss')
      expect(body).toEqual({ action: 'receipt', commandId: 'web-action:lost-0001', projection: 'snapshot' })
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
        expect(body).toEqual({ action: 'receipt', commandId, projection: 'snapshot' })
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

it('receipt-only recovery preserves a queued envelope without resending when its receipt is absent', async () => {
  const commandId = 'web-action:receipt-only'
  const fingerprint = await fingerprintWorkspace(snapshot())
  patchAccountCheckpoint('account-a', { lastSyncedVersion: 'txn:7', lastSyncedFingerprint: fingerprint })
  await queueConnectedBusinessCommand('account-a', { type: 'domain', value: {
    commandId, kind: 'set_action_status', actionId: 'action-a', status: 'done',
  } })
  const before = listAccountPendingOperations('account-a')
  vi.mocked(fetchBackend).mockImplementation(async (_path, init) => {
    expect(JSON.parse(String(init?.body))).toEqual({ action: 'receipt', commandId, projection: 'snapshot' })
    return response({ found: false })
  })
  await expect(confirmConnectedCommand('account-a', commandId, { receiptOnly: true })).rejects.toBeInstanceOf(UnknownCommandOutcomeError)
  expect(fetchBackend).toHaveBeenCalledTimes(1)
  expect(listAccountPendingOperations('account-a')).toEqual(before)
})

it('receipt-only recovery still reconciles an existing committed receipt', async () => {
  const commandId = 'web-action:receipt-only-found'
  vi.mocked(fetchBackend).mockResolvedValue(response({ found: true, revision: 8, workspaceVersion: 'txn:8',
    schemaVersion: 4, snapshot: snapshot(), receipt: { commandId, status: 'COMMITTED', result: { status: 'APPLIED' } } }))
  const result = await confirmConnectedCommand('account-a', commandId, { receiptOnly: true })
  expect(result).toMatchObject({ outcome: 'ALREADY_APPLIED', localProjection: 'applied' })
  expect(fetchBackend).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(vi.mocked(fetchBackend).mock.calls[0]![1]!.body))).toEqual({ action: 'receipt', commandId, projection: 'snapshot' })
})


it('receipt-only recovery does not resend after a failed receipt lookup', async () => {
  const commandId = 'web-action:receipt-only-unavailable'
  const fingerprint = await fingerprintWorkspace(snapshot())
  patchAccountCheckpoint('account-a', { lastSyncedVersion: 'txn:7', lastSyncedFingerprint: fingerprint })
  await queueConnectedBusinessCommand('account-a', { type: 'domain', value: {
    commandId, kind: 'set_action_status', actionId: 'action-a', status: 'done',
  } })
  const before = listAccountPendingOperations('account-a')
  vi.mocked(fetchBackend).mockRejectedValue(new Error('synthetic receipt unavailable'))
  await expect(confirmConnectedCommand('account-a', commandId, { receiptOnly: true })).rejects.toBeInstanceOf(UnknownCommandOutcomeError)
  expect(fetchBackend).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(vi.mocked(fetchBackend).mock.calls[0]![1]!.body)).action).toBe('receipt')
  expect(listAccountPendingOperations('account-a')).toEqual(before)
})


it('receipt-only lookup does not join a concurrently held same-ID resend', async () => {
  const commandId = 'web-action:receipt-only-concurrent'
  const fingerprint = await fingerprintWorkspace(snapshot())
  patchAccountCheckpoint('account-a', { lastSyncedVersion: 'txn:7', lastSyncedFingerprint: fingerprint })
  await queueConnectedBusinessCommand('account-a', { type: 'domain', value: {
    commandId, kind: 'set_action_status', actionId: 'action-a', status: 'done',
  } })
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  const actions: string[] = []
  vi.mocked(fetchBackend).mockImplementation(async (_path, init) => {
    const body = JSON.parse(String(init?.body)); actions.push(body.action)
    if (body.action === 'receipt') return response({ found: false })
    if (body.action === 'read') return response({ revision: 7, workspaceVersion: 'txn:7', schemaVersion: 4, snapshot: snapshot() })
    expect(body.action).toBe('command')
    entered(); await gate
    return response({ outcome: 'COMMITTED', revision: 8, workspaceVersion: 'txn:8', schemaVersion: 4, snapshot: snapshot() })
  })
  const writer = confirmConnectedCommand('account-a', commandId)
  await started
  try {
    await expect(confirmConnectedCommand('account-a', commandId, { receiptOnly: true })).rejects.toBeInstanceOf(UnknownCommandOutcomeError)
    expect(actions.filter(action => action === 'command')).toHaveLength(1)
    expect(actions.filter(action => action === 'receipt')).toHaveLength(2)
  } finally { release(); await writer }
})

  describe('context-bound confirmation of a frozen semantic command', () => {
    async function queueContext(suffix = '') {
      const commandId = 'web-semantic:context-bound' + suffix
      const fingerprint = await fingerprintWorkspace(snapshot())
      patchAccountCheckpoint('account-a', { lastSyncedVersion: 'txn:7', lastSyncedFingerprint: fingerprint })
      await queueConnectedBusinessCommand('account-a', { type: 'semantic_intake', value: {
        contractVersion: 1, inputId: 'context-input-001', statementMode: 'assertion', originalText: '这次面试已经完成了。',
        contextRefs: ['opportunity:a'], candidates: [],
        source: { kind: 'web', sourceId: 'web', sourceRecordId: 'capture-a', observedAt: '2026-10-22T10:00:00.000Z', timezone: 'UTC' },
      } }, { commandId })
      return commandId
    }
    it.each(['absent', 'failed'] as const)('different context only reads an %s receipt and preserves A', async outcome => {
      const commandId = await queueContext(), before = listAccountPendingOperations('account-a')
      vi.mocked(fetchBackend).mockImplementation(async (_path, init) => {
        expect(JSON.parse(String(init?.body)).action).toBe('receipt')
        if (outcome === 'failed') throw new Error('synthetic lookup failure')
        return response({ found: false })
      })
      await expect(confirmConnectedCommand('account-a', commandId, { expectedContextRefs: ['opportunity:b'] })).rejects.toBeInstanceOf(UnknownCommandOutcomeError)
      expect(fetchBackend).toHaveBeenCalledTimes(1); expect(listAccountPendingOperations('account-a')).toEqual(before)
      expect(findAccountPendingSemanticOperation('account-a')).toMatchObject({ commandId, contextRefs: ['opportunity:a'] })
    })
    it('different context may recover an existing A receipt but never dispatch B', async () => {
      const commandId = await queueContext()
      vi.mocked(fetchBackend).mockImplementation(async (_path, init) => {
        expect(JSON.parse(String(init?.body)).action).toBe('receipt')
        return response({ found: true, revision: 8, workspaceVersion: 'txn:8', schemaVersion: 4, snapshot: snapshot(),
          receipt: { commandId, status: 'COMMITTED', result: { status: 'APPLIED' } } })
      })
      expect(await confirmConnectedCommand('account-a', commandId, { expectedContextRefs: ['opportunity:b'] })).toMatchObject({ outcome: 'ALREADY_APPLIED' })
      expect(fetchBackend).toHaveBeenCalledTimes(1); expect(listAccountPendingOperations('account-a')).toEqual([])
    })
    it.each(['a', 'b', 'unknown'] as const)('background replay preserves or clears only its proven %s draft owner', async context => {
      const commandId = await queueContext()
      const originalText = '这次面试已经完成了。'
      saveAccountDraft('account-a', 'tell-pjsdas', originalText)
      if (context !== 'unknown') rememberCaptureDraftContext('account-a', [`opportunity:${context}`])
      vi.mocked(fetchBackend).mockImplementation(async (_path, init) => {
        const body = JSON.parse(String(init?.body))
        if (body.action === 'receipt') return response({ found: false })
        expect(body.command.value.contextRefs).toEqual(['opportunity:a'])
        return response({ outcome: 'COMMITTED', revision: 8, workspaceVersion: 'txn:8', schemaVersion: 4, snapshot: snapshot(), result: { status: 'APPLIED' } })
      })
      await replayAccountPendingOperations('account-a')
      expect(listAccountPendingOperations('account-a')).toEqual([])
      expect(readAccountDraft('account-a', 'tell-pjsdas')).toBe(context === 'a' ? '' : originalText)
    })
    it('a new same-context command renews draft ownership after the previous clear', async () => {
      for (const suffix of ['-first', '-second']) {
        await queueContext(suffix)
        saveAccountDraft('account-a', 'tell-pjsdas', '这次面试已经完成了。')
        // The composer remembers the active owner on every edit/submission;
        // closing preserves this memory until background completion.
        rememberCaptureDraftContext('account-a', ['opportunity:a'])
        vi.mocked(fetchBackend).mockImplementation(async (_path, init) => {
          if (JSON.parse(String(init?.body)).action === 'receipt') return response({ found: false })
          return response({ outcome: 'COMMITTED', revision: 8, workspaceVersion: 'txn:8', schemaVersion: 4, snapshot: snapshot(), result: { status: 'APPLIED' } })
        })
        await replayAccountPendingOperations('account-a')
        expect(readAccountDraft('account-a', 'tell-pjsdas')).toBe('')
      }
    })
    it('unchanged context permits only the frozen original A envelope', async () => {
      const commandId = await queueContext()
      const original = listAccountPendingOperations('account-a')[0]!.command
      vi.mocked(fetchBackend).mockImplementation(async (_path, init) => {
        const body = JSON.parse(String(init?.body))
        if (body.action === 'receipt') return response({ found: false })
        expect(body.command).toEqual(original)
        return response({ outcome: 'COMMITTED', revision: 8, workspaceVersion: 'txn:8', schemaVersion: 4, snapshot: snapshot(), result: { status: 'APPLIED' } })
      })
      expect(await confirmConnectedCommand('account-a', commandId, { expectedContextRefs: ['opportunity:a', 'opportunity:a'] })).toMatchObject({ outcome: 'COMMITTED' })
      expect(fetchBackend).toHaveBeenCalledTimes(2)
    })
  })

  describe('AI receipt recovery retains original selected context', () => {
    async function stageAi(contextRefs?: string[]) {
      const commandId = 'ai-context-command'
      const fingerprint = await fingerprintWorkspace(snapshot())
      patchAccountCheckpoint('account-a', { lastSyncedVersion: 'txn:7', lastSyncedFingerprint: fingerprint })
      vi.mocked(fetchBackend).mockRejectedValue(new Error('synthetic lost response'))
      await expect(executeConnectedBusinessCommand('account-a', { type: 'ai_capture_confirm', value: { requestId: 'ai-review-original' } },
        { commandId, baseRevision: 7, captureOriginalText: 'synthetic draft', ...(contextRefs === undefined ? {} : { captureContextRefs: contextRefs }) })).rejects.toBeInstanceOf(UnknownCommandOutcomeError)
      vi.mocked(fetchBackend).mockReset()
      return commandId
    }
    it.each(['changed', 'legacy-unknown'] as const)('%s context only looks up a receipt and never reissues the effect', async mode => {
      const refs = mode === 'changed' ? ['opportunity:a'] : undefined
      const commandId = await stageAi(refs), before = listAccountPendingOperations('account-a')
      vi.mocked(fetchBackend).mockImplementation(async (_path, init) => {
        expect(JSON.parse(String(init?.body)).action).toBe('receipt')
        return response({ found: false })
      })
      await expect(confirmConnectedCommand('account-a', commandId, { expectedContextRefs: ['opportunity:b'] })).rejects.toBeInstanceOf(UnknownCommandOutcomeError)
      expect(fetchBackend).toHaveBeenCalledOnce(); expect(listAccountPendingOperations('account-a')).toEqual(before)
      expect(findAccountPendingSemanticOperation('account-a')).toMatchObject({ commandId, contextRefs: refs })
    })
    it('same-context recovery sends only the frozen original review identity', async () => {
      const commandId = await stageAi(['opportunity:a'])
      const original = listAccountPendingOperations('account-a')[0]!.command
      vi.mocked(fetchBackend).mockImplementation(async (_path, init) => {
        const body = JSON.parse(String(init?.body))
        if (body.action === 'receipt') return response({ found: false })
        expect(body.command).toEqual(original)
        expect(body.command).toEqual({ type: 'ai_capture_confirm', value: { requestId: 'ai-review-original' } })
        return response({ outcome: 'COMMITTED', revision: 8, workspaceVersion: 'txn:8', schemaVersion: 4, snapshot: snapshot(), result: { status: 'APPLIED' } })
      })
      expect(await confirmConnectedCommand('account-a', commandId, { expectedContextRefs: ['opportunity:a'] })).toMatchObject({ outcome: 'COMMITTED' })
      expect(fetchBackend).toHaveBeenCalledTimes(2)
    })
  })

})
