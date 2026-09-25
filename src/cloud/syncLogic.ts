export interface SyncCheckpointInput {
  lastSyncedVersion?: string
  lastSyncedFingerprint?: string
}

export interface RemoteWorkspaceVersion {
  version: string
  fingerprint: string
}

export interface LocalProjectionCheckpoint extends SyncCheckpointInput {
  lastReadProjectionFingerprint?: string
  lastReadProjectionSourceFingerprint?: string
  localPendingFingerprint?: string
}

export function localFingerprintHasUnsyncedChanges(input: {
  checkpoint: LocalProjectionCheckpoint
  localFingerprint: string
}) {
  if (input.checkpoint.localPendingFingerprint
    && input.localFingerprint === input.checkpoint.localPendingFingerprint) return true
  const baseline = input.checkpoint.lastReadProjectionSourceFingerprint === input.checkpoint.lastSyncedFingerprint
    ? input.checkpoint.lastReadProjectionFingerprint ?? input.checkpoint.lastSyncedFingerprint
    : input.checkpoint.lastSyncedFingerprint
  if (input.checkpoint.localPendingFingerprint && !baseline) return true
  return Boolean(baseline && input.localFingerprint !== baseline)
}

export type SyncDecision =
  | 'create_remote'
  | 'push_local'
  | 'pull_remote'
  | 'adopt_equal'
  | 'noop'
  | 'conflict'

export function decideSyncAction(input: {
  checkpoint: SyncCheckpointInput
  localFingerprint: string
  localProjectionBaselineFingerprint?: string
  localEmpty: boolean
  remote: RemoteWorkspaceVersion | null
}): SyncDecision {
  const { checkpoint, localFingerprint, localEmpty, remote } = input
  if (!remote) return 'create_remote'
  if (remote.fingerprint === localFingerprint) return 'adopt_equal'

  if (!checkpoint.lastSyncedVersion || !checkpoint.lastSyncedFingerprint) {
    return localEmpty ? 'pull_remote' : 'conflict'
  }

  const localChanged = localFingerprint !== (input.localProjectionBaselineFingerprint ?? checkpoint.lastSyncedFingerprint)
  const remoteChanged = remote.version !== checkpoint.lastSyncedVersion ||
    remote.fingerprint !== checkpoint.lastSyncedFingerprint

  if (!localChanged && !remoteChanged) return 'noop'
  if (localChanged && !remoteChanged) return 'push_local'
  if (!localChanged && remoteChanged) return 'pull_remote'
  return 'conflict'
}
