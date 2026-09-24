import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => {
  const remote = {
    fileId: 'synthetic-workspace', version: 'txn:7', schemaVersion: 4,
    fingerprint: 'synthetic-digest', snapshot: { version: 4 },
    updatedByDevice: 'server', updatedAt: '2026-09-23T00:00:00Z',
  }
  return { remote, update: vi.fn(), checkpoint: vi.fn() }
})

vi.mock('../src/db.js', () => ({
  exportLocalSnapshot: async () => ({ version: 4 }),
  replaceLocalSnapshotFromCloud: vi.fn(),
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
vi.mock('../src/cloud/syncLogic.js', () => ({ decideSyncAction: () => 'push_local' }))
vi.mock('../src/cloud/cloudRepository.js', () => ({
  fetchRemoteWorkspace: async () => fixture.remote,
  createRemoteWorkspace: vi.fn(),
  updateRemoteWorkspace: fixture.update,
}))
vi.mock('../src/cloud/workspaceFingerprint.js', () => ({
  fingerprintWorkspace: async () => 'synthetic-digest',
  workspaceIsEffectivelyEmpty: () => false,
}))
vi.mock('../src/cloud/connectedWorkspaceRepository.js', () => ({
  connectedWorkspaceAuthorityEnabled: () => true,
}))

import { runCloudSync } from '../src/cloud/cloudSync.js'

describe('connected passive sync authority', () => {
  beforeEach(() => {
    fixture.update.mockReset().mockResolvedValue(fixture.remote)
    fixture.checkpoint.mockReset()
  })

  it.each([true, false])('keeps a local change pending without whole-snapshot upload (passive=%s)', async (passive) => {
    expect(await runCloudSync('qa-account', { passive })).toMatchObject({ kind: 'local_pending', version: 'txn:7' })
    expect(fixture.update).not.toHaveBeenCalled()
    expect(fixture.checkpoint).not.toHaveBeenCalledWith('qa-account', expect.objectContaining({ lastSyncedAt: expect.any(String) }))
  })
})
