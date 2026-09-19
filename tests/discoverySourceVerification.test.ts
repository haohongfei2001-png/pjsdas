import { describe, expect, it } from 'vitest'
import { applyMonitorIngestionHardened } from '../src/ingestionHardening.js'
import { createSnapshot } from '../src/snapshot.js'

describe('discovery source verification ingestion boundary', () => {
  it('accounts an unverified model observation as unresolved without creating or refreshing an Opportunity', () => {
    const snapshot = createSnapshot({
      opportunities: [],
      processes: [],
      processEvents: [],
      actions: [],
      prep: [],
      applicationGroups: [],
      timeline: [],
    }, '2026-09-19T00:00:00.000Z')

    const result = applyMonitorIngestionHardened(snapshot, {
      runId: 'run-unverified-1',
      sourceId: 'monitor:urgent-campus',
      startedAt: '2026-09-19T00:00:00.000Z',
      completedAt: '2026-09-19T00:01:00.000Z',
      observations: [{
        sourceRecordId: 'job-1',
        company: 'Example AI',
        role: 'AI Product Manager',
        sourceUrl: 'https://careers.example.com/jobs/1',
        sourceTitle: 'Model-provided title',
        rationale: 'Model assessment',
        roleType: 'core',
        opportunityValue: 90,
        fitScore: 90,
        fitConfidence: 'high',
        opportunityValueConfidence: 'high',
        sourceVerification: 'unverified',
        sourceVerificationReason: 'page did not corroborate identity',
      }],
    })

    expect(result.createdOpportunityIds).toEqual([])
    expect(result.touchedOpportunityIds).toEqual([])
    expect(result.snapshot.data.opportunities).toEqual([])
    expect(result.run).toMatchObject({
      receivedCount: 1,
      accountedCount: 1,
      outcomes: { unresolved: 1 },
    })
    const ledger = result.records.find((item) => item.ingestion?.sourceRecordId === 'job-1')
    expect(ledger?.ingestion).toMatchObject({ outcome: 'unresolved' })
    expect(ledger?.ingestion?.reason).toContain('尚未通过独立核验')
  })
})
