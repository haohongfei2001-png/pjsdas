import { exportLocalSnapshot } from '../db.js'
import type { PJSDASSnapshot } from '../snapshot.js'
import { bootstrapConnectedWorkspace, fetchConnectedRemoteWorkspace } from './connectedWorkspaceRepository.js'
import { planConnectedMigration, type ConnectedMigrationPlan } from './connectedMigration.js'
import { fetchLegacyDriveWorkspaceForMigration } from './cloudRepository.js'
import { fingerprintWorkspace } from './workspaceFingerprint.js'
import { createOriginMigrationRecoveryBundle } from './originMigrationRecovery.js'

export type ConnectedMigrationInspection =
  | {
      status: 'ready'
      plan: Extract<ConnectedMigrationPlan, { status: 'ready' }>
      local: PJSDASSnapshot
      drive?: PJSDASSnapshot
    }
  | {
      status: 'already_migrated'
      plan: Extract<ConnectedMigrationPlan, { status: 'ready' }>
      connectedFingerprint: string
      local: PJSDASSnapshot
      drive?: PJSDASSnapshot
    }
  | {
      status: 'conflict'
      reason: string
      local: PJSDASSnapshot
      drive?: PJSDASSnapshot
      localFingerprint: string
      driveFingerprint?: string
      connectedFingerprint?: string
    }

function migrationRequired(caught: unknown) {
  return caught instanceof Error && caught.message.includes('WORKSPACE_MIGRATION_REQUIRED')
}

export async function inspectConnectedMigration(userId: string): Promise<ConnectedMigrationInspection> {
  const [local, driveRow] = await Promise.all([
    exportLocalSnapshot(),
    fetchLegacyDriveWorkspaceForMigration(userId),
  ])
  const drive = driveRow?.snapshot
  const plan = await planConnectedMigration({ local, drive })

  if (plan.status === 'conflict') {
    return {
      status: 'conflict',
      reason: plan.reason,
      local,
      drive,
      localFingerprint: plan.localFingerprint,
      driveFingerprint: plan.driveFingerprint,
    }
  }

  let connected
  try {
    connected = await fetchConnectedRemoteWorkspace()
  } catch (caught) {
    if (!migrationRequired(caught)) throw caught
  }

  if (connected) {
    if (connected.fingerprint === plan.fingerprint) {
      return {
        status: 'already_migrated',
        plan,
        connectedFingerprint: connected.fingerprint,
        local,
        drive,
      }
    }
    return {
      status: 'conflict',
      reason: 'A connected transactional workspace already exists but does not match the safe Local/Drive migration candidate. TodayAction will not overwrite it.',
      local,
      drive,
      localFingerprint: await fingerprintWorkspace(local),
      driveFingerprint: drive ? await fingerprintWorkspace(drive) : undefined,
      connectedFingerprint: connected.fingerprint,
    }
  }

  return { status: 'ready', plan, local, drive }
}

function downloadRecoveryBundle(input: ConnectedMigrationInspection & { status: 'ready' | 'already_migrated' }) {
  if (typeof window === 'undefined' || input.status === 'already_migrated') return
  const createdAt = new Date().toISOString()
  const body = createOriginMigrationRecoveryBundle({
    createdAt,
    origin: window.location.origin,
    selectedSource: input.plan.source,
    selectedFingerprint: input.plan.fingerprint,
    local: input.local,
    drive: input.drive,
  })
  const blob = new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `pjsdas-origin-migration-recovery-${createdAt.slice(0, 10)}.json`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

export async function executeConnectedMigration(userId: string) {
  const inspection = await inspectConnectedMigration(userId)
  if (inspection.status === 'conflict') {
    throw new Error(`CONNECTED_MIGRATION_CONFLICT: ${inspection.reason}`)
  }
  if (inspection.status === 'already_migrated') return inspection

  downloadRecoveryBundle(inspection)
  const created = await bootstrapConnectedWorkspace({
    snapshot: inspection.plan.snapshot,
    sourceFingerprint: inspection.plan.fingerprint,
    migratedFrom: inspection.plan.source,
  })
  const verified = await fetchConnectedRemoteWorkspace()
  if (created.fingerprint !== inspection.plan.fingerprint || verified.fingerprint !== inspection.plan.fingerprint) {
    throw new Error('CONNECTED_MIGRATION_VERIFY_FAILED: transactional workspace fingerprint does not match the selected migration source.')
  }
  return {
    status: 'migrated' as const,
    source: inspection.plan.source,
    fingerprint: inspection.plan.fingerprint,
    revision: Number(verified.version.replace(/^txn:/, '')),
  }
}
