import { exportLocalSnapshot, replaceLocalSnapshotFromCloud } from '../db.js'
import { validateSnapshot } from '../snapshot.js'
import {
  bindLocalWorkspaceToUser,
  getAccountCheckpoint,
  getCloudDeviceState,
  patchAccountCheckpoint,
  type CloudConflictState,
} from './syncState.js'
import { decideSyncAction } from './syncLogic.js'
import {
  createRemoteWorkspace,
  fetchRemoteWorkspace,
  updateRemoteWorkspace,
  type RemoteWorkspaceRow,
} from './cloudRepository.js'
import { fingerprintWorkspace, workspaceIsEffectivelyEmpty } from './workspaceFingerprint.js'

export type CloudSyncOutcomeKind =
  | 'created'
  | 'pushed'
  | 'pulled'
  | 'synced'
  | 'conflict'
  | 'account_mismatch'

export interface CloudSyncOutcome {
  kind: CloudSyncOutcomeKind
  version?: string
  remoteUpdatedAt?: string
}

async function verifyRemote(row: RemoteWorkspaceRow) {
  if (row.schemaVersion !== 1) throw new Error(`不支持 Google Drive 工作区 schema v${row.schemaVersion}。`)
  validateSnapshot(row.snapshot)
  const fingerprint = await fingerprintWorkspace(row.snapshot)
  if (fingerprint !== row.fingerprint) throw new Error('Google Drive 工作区指纹校验失败，已停止同步。')
  return row
}

function conflictFromRemote(row: RemoteWorkspaceRow): CloudConflictState {
  return {
    remoteVersion: row.version,
    remoteFingerprint: row.fingerprint,
    remoteUpdatedAt: row.updatedAt,
    remoteDeviceId: row.updatedByDevice,
    remoteFileId: row.fileId,
  }
}

function markSynced(userId: string, row: RemoteWorkspaceRow) {
  patchAccountCheckpoint(userId, {
    lastSyncedVersion: row.version,
    lastSyncedFingerprint: row.fingerprint,
    lastSyncedAt: new Date().toISOString(),
    conflict: undefined,
    lastError: undefined,
  })
}

function markConflict(userId: string, row: RemoteWorkspaceRow) {
  patchAccountCheckpoint(userId, {
    conflict: conflictFromRemote(row),
    lastError: undefined,
  })
}

export async function runCloudSync(userId: string): Promise<CloudSyncOutcome> {
  const device = getCloudDeviceState()
  if (device.workspaceOwnerUserId && device.workspaceOwnerUserId !== userId) {
    return { kind: 'account_mismatch' }
  }
  if (!device.workspaceOwnerUserId) bindLocalWorkspaceToUser(userId)

  try {
    const local = await exportLocalSnapshot()
    const localFingerprint = await fingerprintWorkspace(local)
    const remoteRaw = await fetchRemoteWorkspace(userId)
    const remote = remoteRaw ? await verifyRemote(remoteRaw) : null
    const checkpoint = getAccountCheckpoint(userId)
    const decision = decideSyncAction({
      checkpoint,
      localFingerprint,
      localEmpty: workspaceIsEffectivelyEmpty(local),
      remote: remote ? { version: remote.version, fingerprint: remote.fingerprint } : null,
    })

    if (decision === 'create_remote') {
      const created = await createRemoteWorkspace({
        userId,
        fingerprint: localFingerprint,
        snapshot: local,
        deviceId: device.deviceId,
      })
      if (!created) {
        const raced = await fetchRemoteWorkspace(userId)
        if (!raced) throw new Error('Google Drive 工作区创建冲突，但无法读取最新版本。')
        const verified = await verifyRemote(raced)
        markConflict(userId, verified)
        return { kind: 'conflict', version: verified.version, remoteUpdatedAt: verified.updatedAt }
      }
      markSynced(userId, created)
      return { kind: 'created', version: created.version, remoteUpdatedAt: created.updatedAt }
    }

    if (!remote) throw new Error('同步状态异常：预期存在 Google Drive 工作区。')

    if (decision === 'push_local') {
      const updated = await updateRemoteWorkspace({
        userId,
        fileId: remote.fileId,
        expectedVersion: remote.version,
        fingerprint: localFingerprint,
        snapshot: local,
        deviceId: device.deviceId,
      })
      if (!updated) {
        const latest = await fetchRemoteWorkspace(userId)
        if (!latest) throw new Error('Google Drive 工作区在同步过程中消失。')
        const verified = await verifyRemote(latest)
        markConflict(userId, verified)
        return { kind: 'conflict', version: verified.version, remoteUpdatedAt: verified.updatedAt }
      }
      markSynced(userId, updated)
      return { kind: 'pushed', version: updated.version, remoteUpdatedAt: updated.updatedAt }
    }

    if (decision === 'pull_remote') {
      await replaceLocalSnapshotFromCloud(remote.snapshot)
      markSynced(userId, remote)
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('pjsdas:workspace-replaced'))
      return { kind: 'pulled', version: remote.version, remoteUpdatedAt: remote.updatedAt }
    }

    if (decision === 'conflict') {
      markConflict(userId, remote)
      return { kind: 'conflict', version: remote.version, remoteUpdatedAt: remote.updatedAt }
    }

    markSynced(userId, remote)
    return { kind: 'synced', version: remote.version, remoteUpdatedAt: remote.updatedAt }
  } catch (caught) {
    patchAccountCheckpoint(userId, {
      lastError: caught instanceof Error ? caught.message : String(caught),
    })
    throw caught
  }
}

export async function resolveConflictKeepLocal(userId: string): Promise<CloudSyncOutcome> {
  const device = getCloudDeviceState()
  const local = await exportLocalSnapshot()
  const fingerprint = await fingerprintWorkspace(local)
  const remoteRaw = await fetchRemoteWorkspace(userId)
  if (!remoteRaw) {
    bindLocalWorkspaceToUser(userId, true)
    return runCloudSync(userId)
  }
  const remote = await verifyRemote(remoteRaw)
  const updated = await updateRemoteWorkspace({
    userId,
    fileId: remote.fileId,
    expectedVersion: remote.version,
    fingerprint,
    snapshot: local,
    deviceId: device.deviceId,
  })
  if (!updated) {
    const latest = await fetchRemoteWorkspace(userId)
    if (!latest) throw new Error('Google Drive 工作区在冲突解决过程中消失。')
    const verified = await verifyRemote(latest)
    markConflict(userId, verified)
    return { kind: 'conflict', version: verified.version, remoteUpdatedAt: verified.updatedAt }
  }
  bindLocalWorkspaceToUser(userId)
  markSynced(userId, updated)
  return { kind: 'pushed', version: updated.version, remoteUpdatedAt: updated.updatedAt }
}

export async function resolveConflictUseCloud(userId: string): Promise<CloudSyncOutcome> {
  const remoteRaw = await fetchRemoteWorkspace(userId)
  if (!remoteRaw) throw new Error('这个 Google 账号还没有 PJSDAS Drive 工作区。')
  const remote = await verifyRemote(remoteRaw)
  await replaceLocalSnapshotFromCloud(remote.snapshot)
  bindLocalWorkspaceToUser(userId, true)
  markSynced(userId, remote)
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('pjsdas:workspace-replaced'))
  return { kind: 'pulled', version: remote.version, remoteUpdatedAt: remote.updatedAt }
}

export async function rebindCurrentLocalWorkspace(userId: string) {
  bindLocalWorkspaceToUser(userId, true)
  return runCloudSync(userId)
}
