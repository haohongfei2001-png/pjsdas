import type { PJSDASSnapshot } from '../snapshot.js'
import { fingerprintWorkspace, workspaceIsEffectivelyEmpty } from './workspaceFingerprint.js'

export type ConnectedMigrationPlan =
  | {
      status: 'ready'
      source: 'local' | 'drive' | 'reconciled'
      snapshot: PJSDASSnapshot
      fingerprint: string
      reason: string
    }
  | {
      status: 'conflict'
      localFingerprint: string
      driveFingerprint: string
      reason: string
    }

export async function planConnectedMigration(input: {
  local: PJSDASSnapshot
  drive?: PJSDASSnapshot | null
}): Promise<ConnectedMigrationPlan> {
  const localFingerprint = await fingerprintWorkspace(input.local)
  const localEmpty = workspaceIsEffectivelyEmpty(input.local)

  if (!input.drive) {
    return {
      status: 'ready',
      source: 'local',
      snapshot: input.local,
      fingerprint: localFingerprint,
      reason: 'No existing Drive workspace was supplied; the validated local snapshot is the only migration source.',
    }
  }

  const driveFingerprint = await fingerprintWorkspace(input.drive)
  const driveEmpty = workspaceIsEffectivelyEmpty(input.drive)

  if (localFingerprint === driveFingerprint) {
    return {
      status: 'ready',
      source: 'reconciled',
      snapshot: input.local,
      fingerprint: localFingerprint,
      reason: 'Local and Drive snapshots are identical.',
    }
  }

  if (localEmpty && !driveEmpty) {
    return {
      status: 'ready',
      source: 'drive',
      snapshot: input.drive,
      fingerprint: driveFingerprint,
      reason: 'Local workspace is effectively empty and Drive contains the validated durable state.',
    }
  }

  if (!localEmpty && driveEmpty) {
    return {
      status: 'ready',
      source: 'local',
      snapshot: input.local,
      fingerprint: localFingerprint,
      reason: 'Drive workspace is effectively empty and local contains the validated durable state.',
    }
  }

  return {
    status: 'conflict',
    localFingerprint,
    driveFingerprint,
    reason: 'Local and Drive both contain non-empty divergent state. Connected migration must stop for explicit reconciliation.',
  }
}
