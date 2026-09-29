import { setAccountCacheSession } from '../src/cloud/accountCacheLease.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/db.js', () => ({
  isRecordedAccountProjection: vi.fn(async () => false),
  assertLocalSnapshotCurrent: vi.fn(async () => undefined),
  exportLocalSnapshot: vi.fn(),
  replaceLocalSnapshotFromCloud: vi.fn(async (value) => value),
}))

vi.mock('../src/cloud/connectedWorkspaceRepository.js', () => ({
  fetchConnectedRemoteWorkspace: vi.fn(),
}))

vi.mock('../src/cloud/syncState.js', () => ({
  bindLocalWorkspaceToUser: vi.fn(),
  getAccountCheckpoint: vi.fn(),
  patchAccountCheckpoint: vi.fn(),
}))

vi.mock('../src/cloud/workspaceFingerprint.js', () => ({
  equivalentReadProjection: vi.fn(),
  fingerprintWorkspace: vi.fn(),
  workspaceIsEffectivelyEmpty: vi.fn(),
}))
vi.mock('../src/cloud/authoritativeCommandClient.js', () => ({
  pendingCommandSummary: vi.fn(() => ({ count: 0 })),
}))

import { assertLocalSnapshotCurrent, exportLocalSnapshot, replaceLocalSnapshotFromCloud } from '../src/db.js'
import { fetchConnectedRemoteWorkspace } from '../src/cloud/connectedWorkspaceRepository.js'
import {
  bindLocalWorkspaceToUser,
  getAccountCheckpoint,
  patchAccountCheckpoint,
} from '../src/cloud/syncState.js'
import { equivalentReadProjection, fingerprintWorkspace, workspaceIsEffectivelyEmpty } from '../src/cloud/workspaceFingerprint.js'
import { pendingCommandSummary } from '../src/cloud/authoritativeCommandClient.js'
import {
  refreshConnectedAuthoritativeCache,
  TODAY_AUTHORITATIVE_REFRESH_INTERVAL_MS,
} from '../src/cloud/authoritativeReadModelClient.js'

const local = { schema: 'local', marker: 'local' } as any
const remoteSnapshot = { schema: 'remote', marker: 'remote' } as any

function remote(version = 'txn:8', fingerprint = 'remote-fp') {
  return {
    fileId: 'workspace-a',
    version,
    schemaVersion: 4,
    fingerprint,
    snapshot: remoteSnapshot,
    updatedByDevice: 'transactional-server',
    updatedAt: '2026-09-23T04:00:00.000Z',
  }
}

describe('CGR-02 authoritative Today read freshness', () => {
  beforeEach(() => {
    setAccountCacheSession(undefined)
    setAccountCacheSession('account-a')
    vi.clearAllMocks()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { dispatchEvent: vi.fn() },
    })
    Object.defineProperty(globalThis, 'CustomEvent', {
      configurable: true,
      value: class CustomEvent {
        type: string
        detail: unknown
        constructor(type: string, init?: { detail?: unknown }) {
          this.type = type
          this.detail = init?.detail
        }
      },
    })
    vi.mocked(exportLocalSnapshot).mockResolvedValue(local)
    vi.mocked(replaceLocalSnapshotFromCloud).mockResolvedValue(local)
    vi.mocked(fetchConnectedRemoteWorkspace).mockResolvedValue(remote())
    vi.mocked(getAccountCheckpoint).mockReturnValue({
      lastSyncedVersion: 'txn:7',
      lastSyncedFingerprint: 'local-fp',
    })
    vi.mocked(workspaceIsEffectivelyEmpty).mockReturnValue(false)
    vi.mocked(equivalentReadProjection).mockReturnValue(false)
    vi.mocked(pendingCommandSummary).mockReturnValue({ count: 0, pending: 0, unknown: 0, conflict: 0 })
    vi.mocked(fingerprintWorkspace).mockImplementation(async (value: any) =>
      value?.marker === 'remote' ? 'remote-fp' : 'local-fp')
  })

  it('uses a bounded 15-second freshness target', () => {
    expect(TODAY_AUTHORITATIVE_REFRESH_INTERVAL_MS).toBe(15_000)
  })

  it('projects a newer authoritative revision when local cache has not diverged', async () => {
    const result = await refreshConnectedAuthoritativeCache('account-a')
    expect(result).toMatchObject({ state: 'updated', workspaceVersion: 'txn:8', changed: true })
    expect(replaceLocalSnapshotFromCloud).toHaveBeenCalledWith(remoteSnapshot, expect.objectContaining({ expectedLocal: local, assertCurrent: expect.any(Function) }))
    expect(bindLocalWorkspaceToUser).toHaveBeenCalledWith('account-a')
    expect(patchAccountCheckpoint).toHaveBeenCalledWith('account-a', expect.objectContaining({
      lastSyncedVersion: 'txn:8',
      lastSyncedFingerprint: 'remote-fp',
      lastReadProjectionFingerprint: 'local-fp',
      lastReadProjectionSourceFingerprint: 'remote-fp',
    }))
    expect(window.dispatchEvent).toHaveBeenCalledTimes(1)
  })

  it('does not rewrite cache when it already matches authoritative state', async () => {
    vi.mocked(fingerprintWorkspace).mockResolvedValue('remote-fp')
    const result = await refreshConnectedAuthoritativeCache('account-a')
    expect(result).toMatchObject({ state: 'current', changed: false })
    expect(replaceLocalSnapshotFromCloud).not.toHaveBeenCalled()
  })

  it('never overwrites a client that has both local and remote changes', async () => {
    vi.mocked(fingerprintWorkspace).mockImplementation(async (value: any) =>
      value?.marker === 'remote' ? 'remote-fp' : 'local-new-fp')
    const result = await refreshConnectedAuthoritativeCache('account-a')
    expect(result).toMatchObject({ state: 'diverged', changed: false })
    expect(replaceLocalSnapshotFromCloud).not.toHaveBeenCalled()
    expect(patchAccountCheckpoint).not.toHaveBeenCalled()
  })

  it('refreshes txn:442 after audit-only remote revision despite raw local cache dirtiness', async () => {
    vi.mocked(getAccountCheckpoint).mockReturnValue({
      lastSyncedVersion: 'txn:441',
      lastSyncedFingerprint: 'remote-441-fp',
      lastReadProjectionSourceFingerprint: 'remote-441-fp',
      lastReadProjectionFingerprint: 'projected-441-fp',
    })
    vi.mocked(fetchConnectedRemoteWorkspace).mockResolvedValue(remote('txn:442', 'remote-442-fp'))
    vi.mocked(fingerprintWorkspace).mockImplementation(async (value: any) =>
      value?.marker === 'remote' ? 'remote-442-fp' : 'hydrated-441-fp')
    vi.mocked(equivalentReadProjection).mockReturnValue(true)
    const result = await refreshConnectedAuthoritativeCache('account-a')
    expect(result).toMatchObject({ state: 'updated', workspaceVersion: 'txn:442', changed: true })
    expect(replaceLocalSnapshotFromCloud).toHaveBeenCalledWith(remoteSnapshot, expect.objectContaining({ expectedLocal: local, assertCurrent: expect.any(Function) }))
    expect(patchAccountCheckpoint).toHaveBeenCalledWith('account-a', expect.objectContaining({
      lastSyncedVersion: 'txn:442', lastReadProjectionSourceFingerprint: 'remote-442-fp',
    }))
  })

  it('keeps a genuine local edit fail-closed when server revision also advances', async () => {
    vi.mocked(fetchConnectedRemoteWorkspace).mockResolvedValue(remote('txn:442', 'remote-442-fp'))
    vi.mocked(fingerprintWorkspace).mockImplementation(async (value: any) =>
      value?.marker === 'remote' ? 'remote-442-fp' : 'local-business-edit-fp')
    vi.mocked(equivalentReadProjection).mockReturnValue(false)
    const result = await refreshConnectedAuthoritativeCache('account-a')
    expect(result.state).toBe('diverged')
    expect(replaceLocalSnapshotFromCloud).not.toHaveBeenCalled()
  })

  it('refreshes a projected cache when only the remote revision changes', async () => {
    vi.mocked(getAccountCheckpoint).mockReturnValue({
      lastSyncedVersion: 'txn:7',
      lastSyncedFingerprint: 'remote-old-fp',
      lastReadProjectionFingerprint: 'local-fp',
      lastReadProjectionSourceFingerprint: 'remote-old-fp',
    })
    const result = await refreshConnectedAuthoritativeCache('account-a')
    expect(result.state).toBe('updated')
    expect(replaceLocalSnapshotFromCloud).toHaveBeenCalledWith(remoteSnapshot, expect.objectContaining({ expectedLocal: local, assertCurrent: expect.any(Function) }))
  })

  it('keeps a verified projected cache current without repeatedly replacing it', async () => {
    vi.mocked(getAccountCheckpoint).mockReturnValue({
      lastSyncedVersion: 'txn:8',
      lastSyncedFingerprint: 'remote-fp',
      lastReadProjectionFingerprint: 'local-fp',
      lastReadProjectionSourceFingerprint: 'remote-fp',
    })
    const result = await refreshConnectedAuthoritativeCache('account-a')
    expect(result).toMatchObject({ state: 'current', changed: false, workspaceVersion: 'txn:8' })
    expect(replaceLocalSnapshotFromCloud).not.toHaveBeenCalled()
    expect(window.dispatchEvent).not.toHaveBeenCalled()
  })

  it('adopts a legacy checkpoint only when local projection is equivalent', async () => {
    vi.mocked(getAccountCheckpoint).mockReturnValue({
      lastSyncedVersion: 'txn:8',
      lastSyncedFingerprint: 'remote-fp',
    })
    vi.mocked(equivalentReadProjection).mockReturnValue(true)
    const result = await refreshConnectedAuthoritativeCache('account-a')
    expect(result.state).toBe('current')
    expect(replaceLocalSnapshotFromCloud).not.toHaveBeenCalled()
    expect(patchAccountCheckpoint).toHaveBeenCalledWith('account-a', expect.objectContaining({
      lastReadProjectionFingerprint: 'local-fp',
    }))
  })

  it('does not adopt remote state over an unbound non-empty local workspace', async () => {
    vi.mocked(getAccountCheckpoint).mockReturnValue({})
    const result = await refreshConnectedAuthoritativeCache('account-a')
    expect(result).toMatchObject({ state: 'unbound_local', changed: false })
    expect(replaceLocalSnapshotFromCloud).not.toHaveBeenCalled()
  })

  it('may safely hydrate an unbound empty cache from the authoritative server', async () => {
    vi.mocked(getAccountCheckpoint).mockReturnValue({})
    vi.mocked(workspaceIsEffectivelyEmpty).mockReturnValue(true)
    const result = await refreshConnectedAuthoritativeCache('account-a')
    expect(result.state).toBe('updated')
    expect(replaceLocalSnapshotFromCloud).toHaveBeenCalledWith(remoteSnapshot, expect.objectContaining({ expectedLocal: local, assertCurrent: expect.any(Function) }))
  })

  it('does not converge even an equal projection while a command awaits recovery', async () => {
    vi.mocked(pendingCommandSummary).mockReturnValue({ count: 1, pending: 0, unknown: 0, conflict: 0 })
    vi.mocked(fingerprintWorkspace).mockResolvedValue('remote-fp')
    expect(await refreshConnectedAuthoritativeCache('account-a')).toMatchObject({ state: 'pending_operations' })
    expect(replaceLocalSnapshotFromCloud).not.toHaveBeenCalled()
    expect(patchAccountCheckpoint).not.toHaveBeenCalled()
  })

  it('updates a stale conflict to each current remote revision without overwriting a real local edit', async () => {
    vi.mocked(getAccountCheckpoint).mockReturnValue({
      lastSyncedVersion: 'txn:843', lastSyncedFingerprint: 'old-fp',
      conflict: { remoteVersion: 'txn:843', remoteFingerprint: 'old-fp', remoteUpdatedAt: '2026-09-20T00:00:00Z' },
    })
    vi.mocked(fingerprintWorkspace).mockImplementation(async (value: any) => value?.marker === 'remote' ? 'remote-fp' : 'local-edit-fp')
    for (const version of ['txn:1000', 'txn:1004']) {
      vi.mocked(fetchConnectedRemoteWorkspace).mockResolvedValue(remote(version))
      expect(await refreshConnectedAuthoritativeCache('account-a')).toMatchObject({ state: 'diverged', workspaceVersion: version })
      expect(patchAccountCheckpoint).toHaveBeenLastCalledWith('account-a', expect.objectContaining({
        conflict: expect.objectContaining({ remoteVersion: version }),
      }))
    }
    expect(replaceLocalSnapshotFromCloud).not.toHaveBeenCalled()
  })

  it('does not restore a conflict resolved while the local-state check was in flight', async () => {
    const stale = {
      lastSyncedVersion: 'txn:843', lastSyncedFingerprint: 'old-fp',
      conflict: { remoteVersion: 'txn:843', remoteFingerprint: 'old-fp', remoteUpdatedAt: '2026-09-20T00:00:00Z' },
    }
    vi.mocked(getAccountCheckpoint).mockReturnValueOnce(stale).mockReturnValue({
      lastSyncedVersion: 'txn:1004', lastSyncedFingerprint: 'remote-fp',
    })
    vi.mocked(fetchConnectedRemoteWorkspace).mockResolvedValue(remote('txn:1004'))
    vi.mocked(fingerprintWorkspace).mockResolvedValue('local-edit-fp')
    vi.mocked(assertLocalSnapshotCurrent).mockResolvedValueOnce(undefined)
    expect(await refreshConnectedAuthoritativeCache('account-a')).toMatchObject({ state: 'diverged' })
    expect(patchAccountCheckpoint).not.toHaveBeenCalled()
    expect(replaceLocalSnapshotFromCloud).not.toHaveBeenCalled()
  })
})
