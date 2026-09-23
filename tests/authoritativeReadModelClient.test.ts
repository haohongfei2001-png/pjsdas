import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/db.js', () => ({
  exportLocalSnapshot: vi.fn(),
  replaceLocalSnapshotFromCloud: vi.fn(async () => undefined),
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

import { exportLocalSnapshot, replaceLocalSnapshotFromCloud } from '../src/db.js'
import { fetchConnectedRemoteWorkspace } from '../src/cloud/connectedWorkspaceRepository.js'
import {
  bindLocalWorkspaceToUser,
  getAccountCheckpoint,
  patchAccountCheckpoint,
} from '../src/cloud/syncState.js'
import { equivalentReadProjection, fingerprintWorkspace, workspaceIsEffectivelyEmpty } from '../src/cloud/workspaceFingerprint.js'
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
    vi.mocked(fetchConnectedRemoteWorkspace).mockResolvedValue(remote())
    vi.mocked(getAccountCheckpoint).mockReturnValue({
      lastSyncedVersion: 'txn:7',
      lastSyncedFingerprint: 'local-fp',
    })
    vi.mocked(workspaceIsEffectivelyEmpty).mockReturnValue(false)
    vi.mocked(equivalentReadProjection).mockReturnValue(false)
    vi.mocked(fingerprintWorkspace).mockImplementation(async (value: any) =>
      value?.marker === 'remote' ? 'remote-fp' : 'local-fp')
  })

  it('uses a bounded 15-second freshness target', () => {
    expect(TODAY_AUTHORITATIVE_REFRESH_INTERVAL_MS).toBe(15_000)
  })

  it('projects a newer authoritative revision when local cache has not diverged', async () => {
    const result = await refreshConnectedAuthoritativeCache('account-a')
    expect(result).toMatchObject({ state: 'updated', workspaceVersion: 'txn:8', changed: true })
    expect(replaceLocalSnapshotFromCloud).toHaveBeenCalledWith(remoteSnapshot)
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

  it('refreshes a projected cache when only the remote revision changes', async () => {
    vi.mocked(getAccountCheckpoint).mockReturnValue({
      lastSyncedVersion: 'txn:7',
      lastSyncedFingerprint: 'remote-old-fp',
      lastReadProjectionFingerprint: 'local-fp',
      lastReadProjectionSourceFingerprint: 'remote-old-fp',
    })
    const result = await refreshConnectedAuthoritativeCache('account-a')
    expect(result.state).toBe('updated')
    expect(replaceLocalSnapshotFromCloud).toHaveBeenCalledWith(remoteSnapshot)
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
    expect(replaceLocalSnapshotFromCloud).toHaveBeenCalledWith(remoteSnapshot)
  })
})
