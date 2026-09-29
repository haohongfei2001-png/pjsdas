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
    conflict: undefined,
    lastError: undefined,
  })
}

export async function refreshConnectedAuthoritativeCache(
  accountKey: string,
): Promise<AuthoritativeReadFreshness> {
  const lease = captureAccountCacheLease(accountKey)
  const startedAt = Date.now()
  const [local, remote] = await Promise.all([
    exportLocalSnapshot(),
    fetchConnectedRemoteWorkspace(accountKey),
  ])
  const localFingerprint = await fingerprintWorkspace(local)
  lease.assertCurrent()
  const checkpoint = getAccountCheckpoint(accountKey)
  const observedAt = new Date().toISOString()
  const assertCurrent = () => {
    lease.assertCurrent()
    if (pendingCommandSummary(accountKey).count > 0) throw new AccountCacheChangedError()
    const current = getAccountCheckpoint(accountKey).lastSyncedVersion
    if (Number(current?.replace('txn:', '')) > Number(remote.version.replace('txn:', ''))) throw new AccountCacheChangedError()
  }
  const markCurrent = async () => {
    await assertLocalSnapshotCurrent(local, assertCurrent)
    assertCurrent()
    markFresh(accountKey, remote.version, remote.fingerprint, localFingerprint, observedAt)
  }

  // A successful read must not erase a command that is still awaiting a
  // receipt or safe local projection. Keep the local cache and conflict state.
  if (pendingCommandSummary(accountKey).count > 0) {
    return { state: 'pending_operations', workspaceVersion: remote.version, observedAt,
      latencyMs: Date.now() - startedAt, changed: false }
  }
  const preserveLatestConflict = async () => {
    if (!checkpoint.conflict) return
    await assertLocalSnapshotCurrent(local, assertCurrent)
    const current = getAccountCheckpoint(accountKey)
    if (!current.conflict) return
    if ((Number(current.conflict.remoteVersion.replace('txn:', '')) || 0)
      > (Number(remote.version.replace('txn:', '')) || 0)) return
    assertCurrent()
    patchAccountCheckpoint(accountKey, { conflict: {
      remoteVersion: remote.version,
      remoteFingerprint: remote.fingerprint,
      remoteUpdatedAt: remote.updatedAt,
      remoteDeviceId: remote.updatedByDevice,
      remoteFileId: remote.fileId,
    } })
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
      && !await isRecordedAccountProjection(accountKey, local)
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
