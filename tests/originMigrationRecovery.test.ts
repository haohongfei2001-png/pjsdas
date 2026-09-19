import { describe, expect, it } from 'vitest'
import { createSnapshot } from '../src/snapshot.js'
import { fingerprintWorkspace } from '../src/cloud/workspaceFingerprint.js'
import {
  createOriginMigrationRecoveryBundle,
  parseOriginMigrationRecoveryText,
} from '../src/cloud/originMigrationRecovery.js'

function snapshot(label: string) {
  return createSnapshot({
    opportunities: [{
      id: `opp-${label}`,
      company: 'Example',
      role: label,
      currentStageLabel: '待投',
      processStage: 'not_applied',
      roleType: 'core',
      early: false,
      opportunityValue: 50,
      fitScore: 50,
      assessmentStatus: 'unassessed',
      importedAt: '2026-09-19T00:00:00.000Z',
    }],
    processes: [],
    processEvents: [],
    actions: [],
    prep: [],
    applicationGroups: [],
  }, '2026-09-19T00:00:00.000Z')
}

describe('origin migration recovery bundle', () => {
  it('round-trips the selected safe migration source into a restorable PJSDAS snapshot', async () => {
    const local = snapshot('local')
    const drive = snapshot('drive')
    const fingerprint = await fingerprintWorkspace(drive)
    const bundle = createOriginMigrationRecoveryBundle({
      origin: 'https://haohongfei2001-png.github.io',
      selectedSource: 'drive',
      selectedFingerprint: fingerprint,
      local,
      drive,
      createdAt: '2026-09-19T00:01:00.000Z',
    })

    const parsed = await parseOriginMigrationRecoveryText(JSON.stringify(bundle))
    expect(parsed.bundle.selectedSource).toBe('drive')
    expect(parsed.recoverySnapshot).toEqual(drive)
  })

  it('rejects a recovery bundle whose selected snapshot no longer matches its recorded fingerprint', async () => {
    const local = snapshot('local')
    const fingerprint = await fingerprintWorkspace(local)
    const bundle = createOriginMigrationRecoveryBundle({
      origin: 'https://haohongfei2001-png.github.io',
      selectedSource: 'local',
      selectedFingerprint: fingerprint,
      local,
    })
    bundle.local.data.opportunities[0]!.role = 'tampered'

    await expect(parseOriginMigrationRecoveryText(JSON.stringify(bundle)))
      .rejects.toThrow(/fingerprint/)
  })

  it('requires a Drive snapshot when Drive was the selected migration source', () => {
    const local = snapshot('local')
    expect(() => createOriginMigrationRecoveryBundle({
      origin: 'https://haohongfei2001-png.github.io',
      selectedSource: 'drive',
      selectedFingerprint: 'sha256:not-used',
      local,
    })).toThrow(/Drive snapshot/)
  })
})
