import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => {
  const remote = {
    fileId: 'synthetic-workspace', version: 'txn:7', schemaVersion: 4,
    fingerprint: 'synthetic-digest', snapshot: { version: 4 },
    updatedByDevice: 'server', updatedAt: '2026-09-23T00:00:00Z',
  }
  return { remote, update: vi.fn(), checkpoint: vi.fn(), decision: vi.fn(), equivalent: vi.fn(), replace: vi.fn() }
})

vi.mock('../src/db.js', () => ({
  exportLocalSnapshot: async () => ({ version: 4 }),
  replaceLocalSnapshotFromCloud: fixture.replace,
}))
vi.mock('../src/snapshot.js', () => ({
  LEGACY_SNAPSHOT_VERSION: 1, SCHEDULE_SNAPSHOT_VERSION: 2,
  PREVIOUS_SNAPSHOT_VERSION: 3, SNAPSHOT_VERSION: 4,
  validateSnapshot: vi.fn(),
}))
vi.mock('../src/cloud/syncState.js', () => ({
  getCloudDeviceState: () => ({ workspaceOwnerUserId: 'qa-account', deviceId: 'qa-device' }),
  getAccountCheckpoint: () => ({ lastSyncedVersion: 'txn:7' }),
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
  fingerprintWorkspace: async () => 'synthetic-digest',
  workspaceIsEffectivelyEmpty: () => false,
  equivalentReadProjection: fixture.equivalent,
}))
vi.mock('../src/cloud/connectedWorkspaceRepository.js', () => ({
  connectedWorkspaceAuthorityEnabled: () => true,
}))

import { runCloudSync } from '../src/cloud/cloudSync.js'

describe('connected passive sync authority', () => {
  beforeEach(() => {
    fixture.update.mockReset().mockResolvedValue(fixture.remote)
    fixture.checkpoint.mockReset()
    fixture.decision.mockReset().mockReturnValue('push_local')
    fixture.equivalent.mockReset().mockReturnValue(false)
    fixture.replace.mockReset().mockResolvedValue(undefined)
    fixture.remote.version = 'txn:7'
  })

  it('pulls a newer audit-only revision when local data is only a read projection', async () => {
    fixture.decision.mockReturnValue('conflict')
    fixture.equivalent.mockReturnValue(true)
    fixture.remote.version = 'txn:442'
    expect(await runCloudSync('qa-account', { passive: true })).toMatchObject({ kind: 'pulled', version: 'txn:442' })
    expect(fixture.replace).toHaveBeenCalledWith(fixture.remote.snapshot)
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
})
