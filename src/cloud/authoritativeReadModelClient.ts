import { mockCloudMode } from './runtimeCloudMode.js'
import { hasInitialMockBinding, markVerifiedMockCache } from './mockCacheBoundary.js'
import { interactionIsRecent } from './interactionActivity.js'
import { captureAccountCacheLease, AccountCacheChangedError } from './accountCacheLease.js'
import { isRecordedAccountProjection, assertLocalSnapshotCurrent, exportLocalSnapshot, replaceLocalSnapshotFromCloud } from '../db.js'
import { fetchConnectedRemoteWorkspace } from './connectedWorkspaceRepository.js'
import {
  bindLocalWorkspaceToUser,
  getAccountCheckpoint,
  getCloudDeviceState,
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

async function markFresh(accountKey: string, version: string, fingerprint: string, projectionFingerprint: string, observedAt: string, assertCurrent: () => void) {
  assertCurrent()
  // Only this verified first binding may establish a new development proof.
  // An existing unknown binding must never be silently relabelled as mock.
  const firstMockBinding = mockCloudMode() && typeof window !== 'undefined'
    && (!getCloudDeviceState().workspaceOwnerUserId || hasInitialMockBinding(window.localStorage, getCloudDeviceState(), accountKey))
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
  if (firstMockBinding) await markVerifiedMockCache(window.localStorage, getCloudDeviceState, accountKey, assertCurrent)
}

export async function refreshConnectedAuthoritativeCache(
  accountKey: string,
  options: { passive?: boolean } = {},
): Promise<AuthoritativeReadFreshness> {
  const lease = captureAccountCacheLease(accountKey)
  const startedAt = Date.now()
  const hotPending = () => (unresolvedPendingCommandCount(accountKey) > 0 || (options.passive && interactionIsRecent(accountKey))) && !getAccountCheckpoint(accountKey).conflict
  const pendingResult = (): AuthoritativeReadFreshness => ({ state: 'pending_operations', workspaceVersion: getAccountCheckpoint(accountKey).lastSyncedVersion ?? 'pending',
    observedAt: new Date().toISOString(), latencyMs: Date.now() - startedAt, changed: false })
  const assertReadCurrent = () => { lease.assertCurrent(); if (hotPending()) throw new AccountCacheChangedError() }
  if (unresolvedPendingCommandCount(accountKey) > 0 || (options.passive && interactionIsRecent(accountKey))) {
    const initialCheckpoint = getAccountCheckpoint(accountKey)
    if (!initialCheckpoint.conflict) return { state: 'pending_operations', workspaceVersion: initialCheckpoint.lastSyncedVersion ?? 'pending',
      observedAt: new Date().toISOString(), latencyMs: 0, changed: false }
  }
  let sampledCheckpoint = JSON.stringify(getAccountCheckpoint(accountKey))
  const reading = Promise.all([
    exportLocalSnapshot(assertReadCurrent),
    options.passive ? fetchConnectedRemoteWorkspace(accountKey, assertReadCurrent, { passive: true }) : fetchConnectedRemoteWorkspace(accountKey, assertReadCurrent),
  ])
  const pair = await reading.catch(error => { lease.assertCurrent(); if (hotPending()) return undefined; throw error })
  if (!pair || hotPending()) return pendingResult()
  let [local] = pair
  const remote = pair[1]
  let localFingerprint = await fingerprintWorkspace(local)
  assertReadCurrent()
  let checkpoint = getAccountCheckpoint(accountKey)
  if (JSON.stringify(checkpoint) !== sampledCheckpoint) {
    // Login sync can install the account projection while this remote read is
    // in flight. Never compare its new checkpoint with our earlier local copy.
    // Resample only the local side once; continuous changes remain fail-closed.
    sampledCheckpoint = JSON.stringify(checkpoint)
    local = await exportLocalSnapshot(assertReadCurrent)
    localFingerprint = await fingerprintWorkspace(local)
    assertReadCurrent()
    checkpoint = getAccountCheckpoint(accountKey)
    if (JSON.stringify(checkpoint) !== sampledCheckpoint) throw new AccountCacheChangedError()
  }
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
    await markFresh(accountKey, remote.version, remote.fingerprint, localFingerprint, observedAt, assertCurrent)
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
  await markFresh(accountKey, remote.version, remote.fingerprint, projectedFingerprint, observedAt, assertCurrent)
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
