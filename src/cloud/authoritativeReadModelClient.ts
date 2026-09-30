import { captureAccountCacheLease, AccountCacheChangedError } from './accountCacheLease.js'
import { isRecordedAccountProjection, assertLocalSnapshotCurrent, exportLocalSnapshot, replaceLocalSnapshotFromCloud } from '../db.js'
import { fetchConnectedRemoteWorkspace } from './connectedWorkspaceRepository.js'
import {
  bindLocalWorkspaceToUser,
  getAccountCheckpoint,
  patchAccountCheckpoint,
} from './syncState.js'
import { equivalentReadProjection, fingerprintWorkspace, workspaceIsEffectivelyEmpty } from './workspaceFingerprint.js'
import { pendingCommandSummary } from './authoritativeCommandClient.js'

function unresolvedPendingCommandCount(accountKey: string) {
  const summary = pendingCommandSummary(accountKey)
  return summary.count - summary.conflict
}

export const TODAY_AUTHORITATIVE_REFRESH_INTERVAL_MS = 15_000

export type AuthoritativeReadFreshnessState =
  | 'current'
  | 'updated'
  | 'local_changes_pending'
  | 'diverged'
  | 'unbound_local'
  | 'pending_operations'

export interface AuthoritativeReadFreshness {
  state: AuthoritativeReadFreshnessState
  workspaceVersion: string
  observedAt: string
  latencyMs: number
  changed: boolean
}

function markFresh(accountKey: string, version: string, fingerprint: string, projectionFingerprint: string, observedAt: string) {
  bindLocalWorkspaceToUser(accountKey)
  patchAccountCheckpoint(accountKey, {
    clearedCacheFingerprint: undefined,
    lastSyncedVersion: version,
    lastSyncedFingerprint: fingerprint,
    lastReadProjectionFingerprint: projectionFingerprint,
    lastReadProjectionSourceFingerprint: fingerprint,
    lastSyncedAt: observedAt,
    localPendingFingerprint: undefined,
    conflict: undefined,
    lastError: undefined,
  })
}

export async function refreshConnectedAuthoritativeCache(
  accountKey: string,
): Promise<AuthoritativeReadFreshness> {
  const lease = captureAccountCacheLease(accountKey)
  const startedAt = Date.now()
  if (unresolvedPendingCommandCount(accountKey) > 0) {
    const initialCheckpoint = getAccountCheckpoint(accountKey)
    if (!initialCheckpoint.conflict) return { state: 'pending_operations', workspaceVersion: initialCheckpoint.lastSyncedVersion ?? 'pending',
      observedAt: new Date().toISOString(), latencyMs: 0, changed: false }
  }
  const [local, remote] = await Promise.all([
    exportLocalSnapshot(),
    fetchConnectedRemoteWorkspace(accountKey),
  ])
  const localFingerprint = await fingerprintWorkspace(local)
  lease.assertCurrent()
  const checkpoint = getAccountCheckpoint(accountKey)
  const observedAt = new Date().toISOString()
  const assertMetadataCurrent = () => {
    lease.assertCurrent()
    const current = getAccountCheckpoint(accountKey).lastSyncedVersion
    if (Number(current?.replace('txn:', '')) > Number(remote.version.replace('txn:', ''))) throw new AccountCacheChangedError()
  }
  const assertCurrent = () => {
    assertMetadataCurrent()
    if (unresolvedPendingCommandCount(accountKey) > 0) throw new AccountCacheChangedError()
  }
  const markCurrent = async () => {
    await assertLocalSnapshotCurrent(local, assertCurrent)
    assertCurrent()
    await isRecordedAccountProjection(accountKey, local, { compact: true, assertCurrent })
    markFresh(accountKey, remote.version, remote.fingerprint, localFingerprint, observedAt)
  }

  const preserveLatestConflict = async () => {
    if (!checkpoint.conflict) return
    await assertLocalSnapshotCurrent(local, assertMetadataCurrent)
    const current = getAccountCheckpoint(accountKey)
    if (!current.conflict) return
    if ((Number(current.conflict.remoteVersion.replace('txn:', '')) || 0)
      > (Number(remote.version.replace('txn:', '')) || 0)) return
    assertMetadataCurrent()
    patchAccountCheckpoint(accountKey, { conflict: {
      remoteVersion: remote.version,
      remoteFingerprint: remote.fingerprint,
      remoteUpdatedAt: remote.updatedAt,
      remoteDeviceId: remote.updatedByDevice,
      remoteFileId: remote.fileId,
    } })
  }

  // A pending command keeps the cache in place. The conflict's observed
  // server revision may still advance without changing any business data.
  if (unresolvedPendingCommandCount(accountKey) > 0) {
    await preserveLatestConflict()
    return { state: 'pending_operations', workspaceVersion: remote.version, observedAt,
      latencyMs: Date.now() - startedAt, changed: false }
  }

  if (checkpoint.localPendingFingerprint === localFingerprint && remote.fingerprint !== localFingerprint
    && !equivalentReadProjection(local, remote.snapshot)) {
    await preserveLatestConflict()
    const remoteChanged = remote.version !== checkpoint.lastSyncedVersion
      || remote.fingerprint !== checkpoint.lastSyncedFingerprint
    return { state: remoteChanged ? 'diverged' : 'local_changes_pending', workspaceVersion: remote.version,
      observedAt, latencyMs: Date.now() - startedAt, changed: false }
  }

  if (remote.fingerprint === localFingerprint) {
    await markCurrent()
    return {
      state: 'current',
      workspaceVersion: remote.version,
      observedAt,
      latencyMs: Date.now() - startedAt,
      changed: false,
    }
  }

  if (!checkpoint.lastSyncedFingerprint || !checkpoint.lastSyncedVersion) {
    if (!workspaceIsEffectivelyEmpty(local)) {
      await preserveLatestConflict()
      return {
        state: 'unbound_local',
        workspaceVersion: remote.version,
        observedAt,
        latencyMs: Date.now() - startedAt,
        changed: false,
      }
    }
  } else if (localFingerprint !== checkpoint.clearedCacheFingerprint) {
    const projectedBaseline = checkpoint.lastReadProjectionSourceFingerprint === checkpoint.lastSyncedFingerprint
      ? checkpoint.lastReadProjectionFingerprint
      : undefined
    const localChanged = localFingerprint !== (projectedBaseline ?? checkpoint.lastSyncedFingerprint)
      && !await isRecordedAccountProjection(accountKey, local, { compact: true, assertCurrent })
    const remoteChanged = remote.version !== checkpoint.lastSyncedVersion
      || remote.fingerprint !== checkpoint.lastSyncedFingerprint
    if (!localChanged && !remoteChanged) {
      await markCurrent()
      return {
        state: 'current',
        workspaceVersion: remote.version,
        observedAt,
        latencyMs: Date.now() - startedAt,
        changed: false,
      }
    }
    if (localChanged) {
      // A full snapshot fingerprint also sees cache hydration and server-only
      // ingestion audit. Compare the actual local data before declaring a
      // conflict, including when a newer authoritative revision exists.
      if (equivalentReadProjection(local, remote.snapshot)) {
        if (!remoteChanged) {
          await markCurrent()
          return { state: 'current', workspaceVersion: remote.version, observedAt, latencyMs: Date.now() - startedAt, changed: false }
        }
      } else {
        await preserveLatestConflict()
        return {
          state: remoteChanged ? 'diverged' : 'local_changes_pending',
          workspaceVersion: remote.version,
          observedAt,
          latencyMs: Date.now() - startedAt,
          changed: false,
        }
      }
    }
  }

  const committed = await replaceLocalSnapshotFromCloud(remote.snapshot, { expectedLocal: local, assertCurrent, accountKey, version: remote.version })
  const projectedFingerprint = await fingerprintWorkspace(committed)
  assertCurrent()
  markFresh(accountKey, remote.version, remote.fingerprint, projectedFingerprint, observedAt)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('pjsdas:workspace-replaced', {
      detail: { source: 'authoritative-read-refresh', workspaceVersion: remote.version },
    }))
  }
  return {
    state: 'updated',
    workspaceVersion: remote.version,
    observedAt,
    latencyMs: Date.now() - startedAt,
    changed: true,
  }
}
