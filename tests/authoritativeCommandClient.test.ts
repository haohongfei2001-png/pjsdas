import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/cloud/cloudClient.js', () => ({
  getAccountAccessToken: vi.fn(async () => 'access-token'),
}))

vi.mock('../src/db.js', () => ({
  replaceLocalSnapshotFromCloud: vi.fn(async () => undefined),
}))

vi.mock('../src/backendEndpoints.js', () => ({
  fetchBackend: vi.fn(),
}))

import { fetchBackend } from '../src/backendEndpoints.js'
import { replaceLocalSnapshotFromCloud } from '../src/db.js'
import {
  clearAccountDraft,
  discardAccountPendingOperation,
  executeConnectedBusinessCommand,
  findAccountPendingSemanticOperation,
  listAccountPendingOperations,
  readAccountDraft,
  replayAccountPendingOperations,
  saveAccountDraft,
} from '../src/cloud/authoritativeCommandClient.js'
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
    const localStorage = new MemoryStorage()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { localStorage, dispatchEvent: vi.fn() },
    })
    vi.mocked(fetchBackend).mockReset()
    vi.mocked(replaceLocalSnapshotFromCloud).mockClear()
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

    await expect(executeConnectedBusinessCommand('account-a', command, { commandId }))
      .rejects.toThrow(/UNKNOWN_COMMAND_OUTCOME/)

    expect(findAccountPendingSemanticOperation('account-a', '事项：整理面试材料')).toMatchObject({
      commandId,
      status: 'unknown',
      originalText: '事项：整理面试材料',
    })
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
    })).rejects.toThrow(/UNKNOWN_COMMAND_OUTCOME/)

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
    })).rejects.toThrow(/SESSION_EXPIRED_BEFORE_COMMAND/)

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
})
