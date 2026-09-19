import { describe, expect, it } from 'vitest'
import { planConnectedMigration } from '../src/cloud/connectedMigration.js'
import type { Opportunity } from '../src/model.js'
import type { PJSDASSnapshot } from '../src/snapshot.js'

function opportunity(id: string): Opportunity {
  return {
    id,
    company: 'Example',
    role: id,
    currentStageLabel: '待投',
    processStage: 'not_applied',
    roleType: 'core',
    early: false,
    opportunityValue: 80,
    fitScore: 70,
    importedAt: '2026-09-19T00:00:00.000Z',
  }
}

function snapshot(ids: string[] = []): PJSDASSnapshot {
  return {
    schema: 'pjsdas-local-snapshot',
    version: 1,
    exportedAt: '2026-09-19T00:00:00.000Z',
    data: {
      opportunities: ids.map(opportunity),
      processes: [],
      processEvents: [],
      actions: [],
      prep: [],
      applicationGroups: [],
    },
  }
}

describe('connected migration planning', () => {
  it('accepts identical local and Drive state as reconciled', async () => {
    await expect(planConnectedMigration({ local: snapshot(['a']), drive: snapshot(['a']) }))
      .resolves.toMatchObject({ status: 'ready', source: 'reconciled' })
  })

  it('uses Drive only when local state is effectively empty', async () => {
    await expect(planConnectedMigration({ local: snapshot(), drive: snapshot(['a']) }))
      .resolves.toMatchObject({ status: 'ready', source: 'drive' })
  })

  it('uses local only when Drive is effectively empty', async () => {
    await expect(planConnectedMigration({ local: snapshot(['a']), drive: snapshot() }))
      .resolves.toMatchObject({ status: 'ready', source: 'local' })
  })

  it('fails closed when both sides contain divergent non-empty state', async () => {
    const result = await planConnectedMigration({ local: snapshot(['a']), drive: snapshot(['b']) })
    expect(result).toMatchObject({ status: 'conflict' })
    if (result.status === 'conflict') expect(result.localFingerprint).not.toBe(result.driveFingerprint)
  })
})
