import { exportLocalSnapshot, replaceLocalSnapshotFromCloud } from '../db.js'
import { fetchConnectedRemoteWorkspace } from './connectedWorkspaceRepository.js'
import {
  bindLocalWorkspaceToUser,
  getAccountCheckpoint,
  patchAccountCheckpoint,
} from './syncState.js'
import { equivalentReadProjection, fingerprintWorkspace, workspaceIsEffectivelyEmpty } from './workspaceFingerprint.js'

export const TODAY_AUTHORITATIVE_REFRESH_INTERVAL_MS = 15_000

export type AuthoritativeReadFreshnessState =
  | 'current'
  | 'updated'
  | 'local_changes_pending'
  | 'diverged'
  | 'unbound_local'

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
  const startedAt = Date.now()
  const [local, remote] = await Promise.all([
    exportLocalSnapshot(),
    fetchConnectedRemoteWorkspace(),
  ])
  const localFingerprint = await fingerprintWorkspace(local)
  const checkpoint = getAccountCheckpoint(accountKey)
  const observedAt = new Date().toISOString()

  if (remote.fingerprint === localFingerprint) {
    markFresh(accountKey, remote.version, remote.fingerprint, localFingerprint, observedAt)
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
      return {
        state: 'unbound_local',
        workspaceVersion: remote.version,
        observedAt,
        latencyMs: Date.now() - startedAt,
        changed: false,
      }
    }
  } else {
    const projectedBaseline = checkpoint.lastReadProjectionSourceFingerprint === checkpoint.lastSyncedFingerprint
      ? checkpoint.lastReadProjectionFingerprint
      : undefined
    const localChanged = localFingerprint !== (projectedBaseline ?? checkpoint.lastSyncedFingerprint)
    const remoteChanged = remote.version !== checkpoint.lastSyncedVersion
      || remote.fingerprint !== checkpoint.lastSyncedFingerprint
    if (!localChanged && !remoteChanged) {
      markFresh(accountKey, remote.version, remote.fingerprint, localFingerprint, observedAt)
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
          markFresh(accountKey, remote.version, remote.fingerprint, localFingerprint, observedAt)
          return { state: 'current', workspaceVersion: remote.version, observedAt, latencyMs: Date.now() - startedAt, changed: false }
        }
      } else {
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

  await replaceLocalSnapshotFromCloud(remote.snapshot)
  const projectedFingerprint = await fingerprintWorkspace(await exportLocalSnapshot())
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
