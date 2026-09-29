import { setAccountCacheSession } from '../src/cloud/accountCacheLease.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => {
  const remote = {
    fileId: 'synthetic-workspace', version: 'txn:7', schemaVersion: 4,
    fingerprint: 'synthetic-digest', snapshot: { version: 4, marker: 'remote' },
    updatedByDevice: 'server', updatedAt: '2026-09-23T00:00:00Z',
  }
  return { remote, localFingerprint: 'synthetic-digest', update: vi.fn(), checkpoint: vi.fn(), checkpointRead: vi.fn(), decision: vi.fn(), equivalent: vi.fn(), replace: vi.fn(), pending: vi.fn() }
})

vi.mock('../src/db.js', () => ({
  isRecordedAccountProjection: vi.fn(async () => false),
  assertLocalSnapshotCurrent: vi.fn(async () => undefined),
  exportLocalSnapshot: async () => ({ version: 4, marker: 'local' }),
  replaceLocalSnapshotFromCloud: fixture.replace,
}))
vi.mock('../src/snapshot.js', () => ({
  LEGACY_SNAPSHOT_VERSION: 1, SCHEDULE_SNAPSHOT_VERSION: 2,
  PREVIOUS_SNAPSHOT_VERSION: 3, SNAPSHOT_VERSION: 4,
  validateSnapshot: vi.fn(),
}))
vi.mock('../src/cloud/syncState.js', () => ({
  getCloudDeviceState: () => ({ workspaceOwnerUserId: 'qa-account', deviceId: 'qa-device' }),
  getAccountCheckpoint: fixture.checkpointRead,
  bindLocalWorkspaceToUser: vi.fn(),
  patchAccountCheckpoint: fixture.checkpoint,
}))
vi.mock('../src/cloud/syncLogic.js', () => ({ decideSyncAction: fixture.decision }))
vi.mock('../src/cloud/cloudRepository.js', () => ({
  fetchRemoteWorkspace: async () => fixture.remote,
  createRemoteWorkspace: vi.fn(),
  updateRemoteWorkspace: fixture.update,
}))
vi.mock('../src/cloud/workspaceFingerprint.js', () => ({
  fingerprintWorkspace: async (value: unknown) => value === fixture.remote.snapshot ? fixture.remote.fingerprint : fixture.localFingerprint,
  workspaceIsEffectivelyEmpty: () => false,
  equivalentReadProjection: fixture.equivalent,
}))
vi.mock('../src/cloud/connectedWorkspaceRepository.js', () => ({
  connectedWorkspaceAuthorityEnabled: () => true,
}))
vi.mock('../src/cloud/authoritativeCommandClient.js', () => ({
  pendingCommandSummary: fixture.pending,
}))

import { runCloudSync } from '../src/cloud/cloudSync.js'

describe('connected passive sync authority', () => {
  beforeEach(() => {
    setAccountCacheSession(undefined)
    setAccountCacheSession('qa-account')
    fixture.update.mockReset().mockResolvedValue(fixture.remote)
    fixture.checkpoint.mockReset()
    fixture.checkpointRead.mockReset().mockReturnValue({ lastSyncedVersion: 'txn:7' })
    fixture.decision.mockReset().mockReturnValue('push_local')
    fixture.equivalent.mockReset().mockReturnValue(false)
    fixture.replace.mockReset().mockResolvedValue(undefined)
    fixture.pending.mockReset().mockReturnValue({ count: 0, pending: 0, unknown: 0, conflict: 0 })
    fixture.remote.version = 'txn:7'
    fixture.remote.fingerprint = 'synthetic-digest'
  })

  it('pulls a newer audit-only revision when local data is only a read projection', async () => {
    fixture.decision.mockReturnValue('conflict')
    fixture.equivalent.mockReturnValue(true)
    fixture.remote.version = 'txn:442'
    expect(await runCloudSync('qa-account', { passive: true })).toMatchObject({ kind: 'pulled', version: 'txn:442' })
    expect(fixture.replace).toHaveBeenCalledWith(fixture.remote.snapshot, expect.objectContaining({ assertCurrent: expect.any(Function) }))
    expect(fixture.update).not.toHaveBeenCalled()
    expect(fixture.checkpoint).toHaveBeenCalledWith('qa-account', expect.objectContaining({ lastSyncedVersion: 'txn:442' }))
  })

  it('preserves the conflict when the local snapshot contains a real edit', async () => {
    fixture.decision.mockReturnValue('conflict')
    fixture.equivalent.mockReturnValue(false)
    fixture.remote.version = 'txn:442'
    expect(await runCloudSync('qa-account', { passive: true })).toMatchObject({ kind: 'conflict', version: 'txn:442' })
    expect(fixture.replace).not.toHaveBeenCalled()
    expect(fixture.update).not.toHaveBeenCalled()
  })

  it.each([true, false])('keeps a local change pending without whole-snapshot upload (passive=%s)', async (passive) => {
    expect(await runCloudSync('qa-account', { passive })).toMatchObject({ kind: 'local_pending', version: 'txn:7' })
    expect(fixture.update).not.toHaveBeenCalled()
    expect(fixture.checkpoint).toHaveBeenCalledWith('qa-account', expect.objectContaining({
      localPendingFingerprint: 'synthetic-digest',
    }))
    expect(fixture.checkpoint).not.toHaveBeenCalledWith('qa-account', expect.objectContaining({ lastSyncedAt: expect.any(String) }))
  })

  it('converges an equivalent persisted conflict through a read-only recovery probe', async () => {
    fixture.decision.mockReturnValue('conflict')
    fixture.equivalent.mockReturnValue(true)
    fixture.remote.version = 'txn:442'
    expect(await runCloudSync('qa-account', { equivalenceOnly: true })).toMatchObject({ kind: 'pulled' })
    expect(fixture.update).not.toHaveBeenCalled()
  })

  it('pulls a newer independent remote change when the local cache still matches its verified checkpoint', async () => {
    fixture.checkpointRead.mockReturnValue({ lastSyncedVersion: 'txn:843', lastSyncedFingerprint: 'synthetic-digest',
      conflict: { remoteVersion: 'txn:843', remoteFingerprint: 'old-digest', remoteUpdatedAt: '2026-09-20T00:00:00Z' } })
    fixture.remote.version = 'txn:1004'
    fixture.decision.mockReturnValue('pull_remote')
    fixture.equivalent.mockReturnValue(false)
    expect(await runCloudSync('qa-account', { equivalenceOnly: true })).toMatchObject({ kind: 'pulled', version: 'txn:1004' })
    expect(fixture.replace).toHaveBeenCalledTimes(1)
    expect(fixture.update).not.toHaveBeenCalled()
    expect(fixture.checkpoint).toHaveBeenCalledWith('qa-account', expect.objectContaining({ conflict: undefined, lastSyncedVersion: 'txn:1004' }))
  })

  it('does not mutate either side when equivalence is unproven or a command is pending', async () => {
    fixture.decision.mockReturnValue('conflict')
    fixture.equivalent.mockReturnValue(false)
    expect(await runCloudSync('qa-account', { equivalenceOnly: true })).toMatchObject({ kind: 'conflict' })
    fixture.equivalent.mockReturnValue(true)
    fixture.pending.mockReturnValue({ count: 1, pending: 1, unknown: 0, conflict: 0 })
    expect(await runCloudSync('qa-account', { equivalenceOnly: true })).toMatchObject({ kind: 'local_pending' })
    expect(fixture.replace).not.toHaveBeenCalled()
    expect(fixture.update).not.toHaveBeenCalled()
  })

  it('never projects a newer remote snapshot over an unresolved command during passive sync', async () => {
    fixture.decision.mockReturnValue('pull_remote')
    fixture.remote.version = 'txn:1004'
    fixture.remote.fingerprint = 'new-digest'
    fixture.pending.mockReturnValue({ count: 1, pending: 1, unknown: 0, conflict: 0 })
    expect(await runCloudSync('qa-account', { passive: true })).toMatchObject({ kind: 'local_pending', version: 'txn:1004' })
    expect(fixture.replace).not.toHaveBeenCalled()
    expect(fixture.update).not.toHaveBeenCalled()
  })

  it('tracks a newer remote conflict revision while an unresolved command blocks projection', async () => {
    fixture.checkpointRead.mockReturnValue({ lastSyncedVersion: 'txn:843', lastSyncedFingerprint: 'old-digest',
      conflict: { remoteVersion: 'txn:843', remoteFingerprint: 'old-digest', remoteUpdatedAt: '2026-09-20T00:00:00Z' } })
    fixture.remote.version = 'txn:1004'
    fixture.pending.mockReturnValue({ count: 1, pending: 1, unknown: 0, conflict: 0 })
    expect(await runCloudSync('qa-account', { equivalenceOnly: true })).toMatchObject({ kind: 'local_pending', version: 'txn:1004' })
    expect(fixture.checkpoint).toHaveBeenCalledWith('qa-account', expect.objectContaining({
      conflict: expect.objectContaining({ remoteVersion: 'txn:1004' }),
    }))
    expect(fixture.replace).not.toHaveBeenCalled()
  })

  it('aborts a read projection if a command enters the outbox during the replacement', async () => {
    fixture.decision.mockReturnValue('pull_remote')
    fixture.remote.version = 'txn:1004'
    fixture.replace.mockImplementation(async (_snapshot, options) => {
      fixture.pending.mockReturnValue({ count: 1, pending: 1, unknown: 0, conflict: 0 })
      options.assertCurrent()
    })
    await expect(runCloudSync('qa-account', { passive: true })).rejects.toThrow()
    expect(fixture.checkpoint).not.toHaveBeenCalledWith('qa-account', expect.objectContaining({ lastSyncedVersion: 'txn:1004' }))
    expect(fixture.update).not.toHaveBeenCalled()
  })

  it('preserves an explicitly recorded local-only edit when the remote revision advances', async () => {
    fixture.checkpointRead.mockReturnValue({ lastSyncedVersion: 'txn:843', lastSyncedFingerprint: 'old-digest',
      localPendingFingerprint: 'synthetic-digest' })
    fixture.decision.mockReturnValue('pull_remote')
    fixture.remote.version = 'txn:1004'
    fixture.remote.fingerprint = 'new-digest'
    expect(await runCloudSync('qa-account', { equivalenceOnly: true })).toMatchObject({ kind: 'conflict', version: 'txn:1004' })
    expect(fixture.replace).not.toHaveBeenCalled()
    expect(fixture.update).not.toHaveBeenCalled()
    expect(fixture.checkpoint).toHaveBeenCalledWith('qa-account', expect.objectContaining({
      conflict: expect.objectContaining({ remoteVersion: 'txn:1004' }),
    }))
  })

  it('clears a stale local-only marker after business projection equivalence is proved', async () => {
    fixture.checkpointRead.mockReturnValue({ lastSyncedVersion: 'txn:843', lastSyncedFingerprint: 'old-digest',
      localPendingFingerprint: 'synthetic-digest' })
    fixture.decision.mockReturnValue('conflict')
    fixture.remote.version = 'txn:1004'
    fixture.remote.fingerprint = 'new-digest'
    fixture.equivalent.mockReturnValue(true)
    expect(await runCloudSync('qa-account', { equivalenceOnly: true })).toMatchObject({ kind: 'pulled', version: 'txn:1004' })
    expect(fixture.checkpoint).toHaveBeenCalledWith('qa-account', expect.objectContaining({ localPendingFingerprint: undefined }))
  })

  it('does not restore an old conflict after a concurrent user resolution clears it', async () => {
    const old = { lastSyncedVersion: 'txn:7', conflict: { remoteVersion: 'txn:7', remoteFingerprint: 'old', remoteUpdatedAt: '2026-09-23T00:00:00Z' } }
    fixture.checkpointRead.mockReturnValueOnce(old).mockReturnValueOnce(old)
    fixture.decision.mockReturnValue('conflict')
    fixture.equivalent.mockReturnValue(false)
    expect(await runCloudSync('qa-account', { equivalenceOnly: true })).toMatchObject({ kind: 'synced' })
    expect(fixture.checkpoint).not.toHaveBeenCalled()
    expect(fixture.replace).not.toHaveBeenCalled()
  })

  it('lets equivalent cache converge after a terminal rejected command', async () => {
    fixture.pending.mockReturnValue({ count: 1, pending: 0, unknown: 0, conflict: 1 })
    fixture.decision.mockReturnValue('conflict')
    fixture.equivalent.mockReturnValue(true)
    fixture.remote.version = 'txn:442'
    expect(await runCloudSync('qa-account', { equivalenceOnly: true })).toMatchObject({ kind: 'pulled' })
    expect(fixture.replace).toHaveBeenCalledTimes(1)
  })
})
