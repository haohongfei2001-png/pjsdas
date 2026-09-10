export interface SyncCheckpointInput {
  lastSyncedRevision?: number
  lastSyncedFingerprint?: string
}

export interface RemoteWorkspaceVersion {
  revision: number
  fingerprint: string
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
  localEmpty: boolean
  remote: RemoteWorkspaceVersion | null
}): SyncDecision {
  const { checkpoint, localFingerprint, localEmpty, remote } = input
  if (!remote) return 'create_remote'
  if (remote.fingerprint === localFingerprint) return 'adopt_equal'

  if (checkpoint.lastSyncedRevision === undefined || !checkpoint.lastSyncedFingerprint) {
    return localEmpty ? 'pull_remote' : 'conflict'
  }

  const localChanged = localFingerprint !== checkpoint.lastSyncedFingerprint
  const remoteChanged = remote.revision !== checkpoint.lastSyncedRevision ||
    remote.fingerprint !== checkpoint.lastSyncedFingerprint

  if (!localChanged && !remoteChanged) return 'noop'
  if (localChanged && !remoteChanged) return 'push_local'
  if (!localChanged && remoteChanged) return 'pull_remote'
  return 'conflict'
}
