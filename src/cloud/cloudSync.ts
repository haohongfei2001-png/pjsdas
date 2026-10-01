import { interactionIsRecent } from './interactionActivity.js'
import { captureAccountCacheLease, AccountCacheChangedError } from './accountCacheLease.js'
import { isRecordedAccountProjection, assertLocalSnapshotCurrent } from '../db.js'
import { exportLocalSnapshot, replaceLocalSnapshotFromCloud } from '../db.js'
import { LEGACY_SNAPSHOT_VERSION, PREVIOUS_SNAPSHOT_VERSION, SCHEDULE_SNAPSHOT_VERSION, SNAPSHOT_VERSION, validateSnapshot } from '../snapshot.js'
import {
  bindLocalWorkspaceToUser,
  getAccountCheckpoint,
  getCloudDeviceState,
  patchAccountCheckpoint,
  type CloudConflictState,
} from './syncState.js'
import { decideSyncAction, localFingerprintHasUnsyncedChanges } from './syncLogic.js'
import {
  createRemoteWorkspace,
  fetchRemoteWorkspace,
  updateRemoteWorkspace,
  type RemoteWorkspaceRow,
} from './cloudRepository.js'
import { classifyReadProjectionDifference, equivalentReadProjection, fingerprintWorkspace, workspaceIsEffectivelyEmpty } from './workspaceFingerprint.js'
import { connectedWorkspaceAuthorityEnabled } from './connectedWorkspaceRepository.js'
import { pendingCommandSummary } from './authoritativeCommandClient.js'

function unresolvedPendingCommandCount(userId: string) {
  const summary = pendingCommandSummary(userId)
  return summary.count - summary.conflict
}

export type CloudSyncOutcomeKind =
  | 'created'
  | 'pushed'
  | 'pulled'
  | 'synced'
  | 'conflict'
  | 'account_mismatch'
  | 'local_pending'

export interface CloudSyncOutcome {
  kind: CloudSyncOutcomeKind
  version?: string
  remoteUpdatedAt?: string
}

export async function inspectConnectedDivergence(userId: string) {
  const local = await exportLocalSnapshot()
  const remoteRaw = await fetchRemoteWorkspace(userId)
  const remote = remoteRaw ? await verifyRemote(remoteRaw) : null
  const checkpoint = getAccountCheckpoint(userId)
  const localFingerprint = await fingerprintWorkspace(local)
  const pendingOperations = pendingCommandSummary(userId)
  const recordedProjection = await isRecordedAccountProjection(userId, local)
  const difference = remote ? classifyReadProjectionDifference(local, remote.snapshot) : 'remote_unavailable' as const
  return {
    localFingerprint,
    authoritativeFingerprint: remote?.fingerprint,
    authoritativeVersion: remote?.version,
    checkpointVersion: checkpoint.lastSyncedVersion,
    checkpointFingerprint: checkpoint.lastSyncedFingerprint,
    localProjectionFingerprint: checkpoint.lastReadProjectionFingerprint,
    localProjectionSourceFingerprint: checkpoint.lastReadProjectionSourceFingerprint,
    localPendingFingerprint: checkpoint.localPendingFingerprint,
    recordedProjection,
    pendingOperations,
    classification: pendingOperations.count > pendingOperations.conflict ? 'pending_operations' as const : difference,
  }
}

async function verifyRemote(row: RemoteWorkspaceRow) {
  if (![LEGACY_SNAPSHOT_VERSION, SCHEDULE_SNAPSHOT_VERSION, PREVIOUS_SNAPSHOT_VERSION, SNAPSHOT_VERSION].includes(row.schemaVersion as 1 | 2 | 3 | 4)) {
    throw new Error(`不支持的工作区 schema v${row.schemaVersion}。`)
  }
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
    clearedCacheFingerprint: undefined,
    lastSyncedVersion: row.version,
    lastSyncedFingerprint: row.fingerprint,
    lastSyncedAt: new Date().toISOString(),
    localPendingFingerprint: undefined,
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

export async function hasUnsyncedLocalWorkspace(userId: string) {
  const checkpoint = getAccountCheckpoint(userId)
  const localFingerprint = await fingerprintWorkspace(await exportLocalSnapshot())
  return localFingerprintHasUnsyncedChanges({ checkpoint, localFingerprint })
}

export async function runCloudSync(userId: string, options: { passive?: boolean; equivalenceOnly?: boolean } = {}): Promise<CloudSyncOutcome> {
  const lease = connectedWorkspaceAuthorityEnabled() ? captureAccountCacheLease(userId) : undefined
  let targetVersion: string | undefined
  let projectingEquivalent = false
  const hotPending = () => connectedWorkspaceAuthorityEnabled() && (unresolvedPendingCommandCount(userId) > 0 || (options.passive && interactionIsRecent(userId))) && !getAccountCheckpoint(userId).conflict
  const assertCurrent = () => {
    lease?.assertCurrent()
    if (hotPending()) throw new AccountCacheChangedError()
    if (projectingEquivalent && unresolvedPendingCommandCount(userId) > 0) throw new AccountCacheChangedError()
    if (lease && targetVersion && Number(getAccountCheckpoint(userId).lastSyncedVersion?.replace('txn:', '')) > Number(targetVersion.replace('txn:', ''))) throw new AccountCacheChangedError()
  }
  const device = getCloudDeviceState()
  if (device.workspaceOwnerUserId && device.workspaceOwnerUserId !== userId) {
    return { kind: 'account_mismatch' }
  }
  if (!device.workspaceOwnerUserId) bindLocalWorkspaceToUser(userId)
  // An ordinary in-flight command already owns local projection. Defer
  // expensive full read/fingerprint work until it settles; persisted conflicts
  // still classify against the latest server revision below.
  if (hotPending()) {
    return { kind: 'local_pending', version: getAccountCheckpoint(userId).lastSyncedVersion }
  }

  try {
    const local = await exportLocalSnapshot(assertCurrent)
    if (hotPending()) return { kind: 'local_pending', version: getAccountCheckpoint(userId).lastSyncedVersion }
    const localFingerprint = await fingerprintWorkspace(local)
    if (hotPending()) return { kind: 'local_pending', version: getAccountCheckpoint(userId).lastSyncedVersion }
    const remoteRaw = await fetchRemoteWorkspace(userId, assertCurrent)
    if (hotPending()) return { kind: 'local_pending', version: getAccountCheckpoint(userId).lastSyncedVersion }
    const remote = remoteRaw ? await verifyRemote(remoteRaw) : null
    targetVersion = remote?.version
    assertCurrent()
    await assertLocalSnapshotCurrent(local, assertCurrent)
    const checkpoint = getAccountCheckpoint(userId)
    const recordedProjection = await isRecordedAccountProjection(userId, local, { compact: unresolvedPendingCommandCount(userId) === 0, assertCurrent })
    assertCurrent()
    // A connected browser keeps unresolved user intent in its account-bound
    // outbox. No workspace refresh may replace that cache before recovery.
    if (connectedWorkspaceAuthorityEnabled() && unresolvedPendingCommandCount(userId) > 0) {
      if (remote && checkpoint.conflict) {
        await assertLocalSnapshotCurrent(local, assertCurrent)
        const current = getAccountCheckpoint(userId)
        if (current.conflict && Number(current.conflict.remoteVersion.replace('txn:', ''))
          <= Number(remote.version.replace('txn:', ''))) markConflict(userId, remote)
      }
      return { kind: 'local_pending', version: remote?.version, remoteUpdatedAt: remote?.updatedAt }
    }
    if (connectedWorkspaceAuthorityEnabled() && checkpoint.localPendingFingerprint === localFingerprint
      && (!remote || (remote.fingerprint !== localFingerprint && !equivalentReadProjection(local, remote.snapshot)))) {
      if (!remote || (remote.version === checkpoint.lastSyncedVersion && remote.fingerprint === checkpoint.lastSyncedFingerprint)) {
        return { kind: 'local_pending', version: remote?.version, remoteUpdatedAt: remote?.updatedAt }
      }
      await assertLocalSnapshotCurrent(local, assertCurrent)
      const latestCheckpoint = getAccountCheckpoint(userId)
      if (latestCheckpoint.localPendingFingerprint !== localFingerprint) {
        return { kind: latestCheckpoint.conflict ? 'conflict' : 'synced',
          version: latestCheckpoint.conflict?.remoteVersion ?? latestCheckpoint.lastSyncedVersion }
      }
      if (latestCheckpoint.conflict
        && Number(latestCheckpoint.conflict.remoteVersion.replace('txn:', '')) > Number(remote.version.replace('txn:', ''))) {
        return { kind: 'conflict', version: latestCheckpoint.conflict.remoteVersion,
          remoteUpdatedAt: latestCheckpoint.conflict.remoteUpdatedAt }
      }
      markConflict(userId, remote)
      return { kind: 'conflict', version: remote.version, remoteUpdatedAt: remote.updatedAt }
    }
    projectingEquivalent = connectedWorkspaceAuthorityEnabled() || Boolean(options.equivalenceOnly)
    assertCurrent()
    const decision = remote && localFingerprint === checkpoint.clearedCacheFingerprint ? 'pull_remote' : decideSyncAction({
      checkpoint,
      localFingerprint,
      localProjectionBaselineFingerprint: recordedProjection ? localFingerprint : checkpoint.lastReadProjectionSourceFingerprint === checkpoint.lastSyncedFingerprint
        ? checkpoint.lastReadProjectionFingerprint : undefined,
      localEmpty: workspaceIsEffectivelyEmpty(local),
      remote: remote ? { version: remote.version, fingerprint: remote.fingerprint } : null,
    })
    // A recovery probe may pull a newer authoritative revision when this
    // browser still matches its verified checkpoint. Current-remote equality
    // also covers order and cache-only differences. Neither permits uploads.
    if (options.equivalenceOnly && (!remote || unresolvedPendingCommandCount(userId) > 0
      || (decision !== 'pull_remote' && !equivalentReadProjection(local, remote.snapshot)))) {
      await assertLocalSnapshotCurrent(local, assertCurrent)
      const latestCheckpoint = getAccountCheckpoint(userId)
      if (checkpoint.conflict && !latestCheckpoint.conflict) {
        return { kind: 'synced', version: latestCheckpoint.lastSyncedVersion }
      }
      if (remote && latestCheckpoint.conflict
        && Number(latestCheckpoint.conflict.remoteVersion.replace('txn:', '')) > Number(remote.version.replace('txn:', ''))) {
        return { kind: 'conflict', version: latestCheckpoint.conflict.remoteVersion,
          remoteUpdatedAt: latestCheckpoint.conflict.remoteUpdatedAt }
      }
      if (remote) markConflict(userId, remote)
      return { kind: 'conflict', version: remote?.version, remoteUpdatedAt: remote?.updatedAt }
    }

    // Connected mode is command-authoritative. A stale raw fingerprint can be
    // caused solely by local hydration plus newer server ingestion audit.
    // Reconcile only when the local data is a verified read projection of the
    // current remote; a real local edit still takes the fail-closed path below.
    if ((connectedWorkspaceAuthorityEnabled() || options.equivalenceOnly) && remote
      && (decision === 'conflict' || decision === 'push_local')
      && unresolvedPendingCommandCount(userId) === 0
      && equivalentReadProjection(local, remote.snapshot)) {
      const remoteChanged = remote.version !== checkpoint.lastSyncedVersion
        || remote.fingerprint !== checkpoint.lastSyncedFingerprint
      projectingEquivalent = true
      assertCurrent()
      if (remoteChanged) {
        const committed = await replaceLocalSnapshotFromCloud(remote.snapshot, { expectedLocal: local, assertCurrent, accountKey: userId, version: remote.version })
        const projectedFingerprint = await fingerprintWorkspace(committed)
        assertCurrent()
        markSynced(userId, remote)
        patchAccountCheckpoint(userId, {
          lastReadProjectionSourceFingerprint: remote.fingerprint,
          lastReadProjectionFingerprint: projectedFingerprint,
        })
        if (typeof window !== 'undefined') window.dispatchEvent(new Event('pjsdas:workspace-replaced'))
        return { kind: 'pulled', version: remote.version, remoteUpdatedAt: remote.updatedAt }
      }
      markSynced(userId, remote)
      patchAccountCheckpoint(userId, {
        lastReadProjectionSourceFingerprint: remote.fingerprint,
        lastReadProjectionFingerprint: localFingerprint,
      })
      return { kind: 'synced', version: remote.version, remoteUpdatedAt: remote.updatedAt }
    }

    if (decision === 'create_remote') {
      if (options.equivalenceOnly) return { kind: 'conflict' }
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
      if (options.equivalenceOnly) return { kind: 'conflict', version: remote.version, remoteUpdatedAt: remote.updatedAt }
      // Connected mode has one authoritative write path: scoped commands.
      // A manual refresh is a read/reconciliation request, not permission to
      // upload unrelated local changes as one workspace snapshot.
      if (connectedWorkspaceAuthorityEnabled()) {
        patchAccountCheckpoint(userId, {
          localPendingFingerprint: localFingerprint,
          lastError: undefined,
        })
        return { kind: 'local_pending', version: remote.version, remoteUpdatedAt: remote.updatedAt }
      }
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
      const committed = await replaceLocalSnapshotFromCloud(remote.snapshot, { expectedLocal: local, assertCurrent, accountKey: userId, version: remote.version })
      const projectedFingerprint = await fingerprintWorkspace(committed)
      assertCurrent()
      markSynced(userId, remote)
      patchAccountCheckpoint(userId, {
        lastReadProjectionSourceFingerprint: remote.fingerprint,
        lastReadProjectionFingerprint: projectedFingerprint,
      })
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
    lease?.assertCurrent()
    if (hotPending()) return { kind: 'local_pending', version: getAccountCheckpoint(userId).lastSyncedVersion }
    assertCurrent()
    patchAccountCheckpoint(userId, {
      lastError: caught instanceof Error ? caught.message : String(caught),
    })
    throw caught
  }
}

export async function resolveConflictKeepLocal(userId: string): Promise<CloudSyncOutcome> {
  const lease = connectedWorkspaceAuthorityEnabled() ? captureAccountCacheLease(userId) : undefined
  const assertCurrent = () => lease?.assertCurrent()
  const device = getCloudDeviceState()
  const local = await exportLocalSnapshot()
  const fingerprint = await fingerprintWorkspace(local)
  const remoteRaw = await fetchRemoteWorkspace(userId)
  if (!remoteRaw) {
    assertCurrent()
    bindLocalWorkspaceToUser(userId, true)
    return runCloudSync(userId)
  }
  const remote = await verifyRemote(remoteRaw)
  await assertLocalSnapshotCurrent(local, assertCurrent)
  assertCurrent()
  const updated = await updateRemoteWorkspace({
    userId,
    fileId: remote.fileId,
    expectedVersion: remote.version,
    fingerprint,
    snapshot: local,
    deviceId: device.deviceId,
    purpose: 'migration_recovery',
  })
  if (!updated) {
    const latest = await fetchRemoteWorkspace(userId)
    if (!latest) throw new Error('Google Drive 工作区在冲突解决过程中消失。')
    const verified = await verifyRemote(latest)
    assertCurrent()
    markConflict(userId, verified)
    return { kind: 'conflict', version: verified.version, remoteUpdatedAt: verified.updatedAt }
  }
  assertCurrent()
  bindLocalWorkspaceToUser(userId)
  markSynced(userId, updated)
  return { kind: 'pushed', version: updated.version, remoteUpdatedAt: updated.updatedAt }
}

export async function resolveConflictUseCloud(userId: string): Promise<CloudSyncOutcome> {
  const lease = connectedWorkspaceAuthorityEnabled() ? captureAccountCacheLease(userId) : undefined
  const assertCurrent = () => lease?.assertCurrent()
  const local = await exportLocalSnapshot()
  const remoteRaw = await fetchRemoteWorkspace(userId)
  if (!remoteRaw) throw new Error('这个 Google 账号还没有 TodayAction Drive 工作区。')
  const remote = await verifyRemote(remoteRaw)
  const committed = await replaceLocalSnapshotFromCloud(remote.snapshot, { expectedLocal: local, assertCurrent, accountKey: userId, version: remote.version })
  const projectedFingerprint = await fingerprintWorkspace(committed)
  assertCurrent()
  bindLocalWorkspaceToUser(userId, true)
  markSynced(userId, remote)
  patchAccountCheckpoint(userId, {
    lastReadProjectionSourceFingerprint: remote.fingerprint,
    lastReadProjectionFingerprint: projectedFingerprint,
  })
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('pjsdas:workspace-replaced'))
  return { kind: 'pulled', version: remote.version, remoteUpdatedAt: remote.updatedAt }
}

export async function rebindCurrentLocalWorkspace(userId: string) {
  if (connectedWorkspaceAuthorityEnabled()) captureAccountCacheLease(userId).assertCurrent()
  bindLocalWorkspaceToUser(userId, true)
  return runCloudSync(userId)
}
