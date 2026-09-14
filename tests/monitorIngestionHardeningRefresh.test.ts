import { describe, expect, it } from 'vitest'
import type { MonitorJobObservation } from '../src/autonomousIngestion.js'
import { createDefaultDecisionRules } from '../src/decisionRules.js'
import { createDefaultDiscoveryProfile } from '../src/discoveryProfile.js'
import { applyMonitorIngestionHardened } from '../src/ingestionHardening.js'
import { createSnapshot } from '../src/snapshot.js'

function snapshot() {
  return createSnapshot({
    opportunities: [],
    processes: [],
    processEvents: [],
    actions: [],
    prep: [],
    applicationGroups: [],
    decisionRules: createDefaultDecisionRules('2026-09-15T00:00:00.000Z'),
    discoveryProfile: createDefaultDiscoveryProfile('2026-09-15T00:00:00.000Z'),
    discoveryInbox: [],
    timeline: [],
    changeSets: [],
  }, '2026-09-15T00:00:00.000Z')
}

function observation(overrides: Partial<MonitorJobObservation> = {}): MonitorJobObservation {
  return {
    sourceRecordId: 'official-job-123',
    company: 'Example Tech',
    role: 'AI Product Manager',
    sourceUrl: 'https://careers.example.com/jobs/123',
    sourceTitle: 'AI Product Manager - 2027 Campus',
    location: 'Beijing',
    rationale: 'Official campus recruiting source.',
    roleType: 'core',
    opportunityValue: 80,
    fitScore: 80,
    fitConfidence: 'high',
    opportunityValueConfidence: 'high',
    postingStatus: 'open',
    discoveredAt: '2026-09-15T00:05:00.000Z',
    ...overrides,
  }
}

function run(runId: string, completedAt: string, observations: MonitorJobObservation[]) {
  return {
    runId,
    sourceId: 'monitor:key-changes',
    startedAt: completedAt,
    completedAt,
    observations,
  }
}

describe('hardened monitor posting refresh semantics', () => {
  it('merges a changed closed-status fact for the same stable sourceRecordId without closing the user recruiting process', () => {
    const first = applyMonitorIngestionHardened(snapshot(), run(
      'refresh-run-1',
      '2026-09-15T00:10:00.000Z',
      [observation()],
    ))
    expect(first.run.outcomes.created).toBe(1)

    const second = applyMonitorIngestionHardened(first.snapshot, run(
      'refresh-run-2',
      '2026-09-16T00:10:00.000Z',
      [observation({
        postingStatus: 'closed',
        deadline: '2026-09-15T23:59:00.000Z',
        discoveredAt: '2026-09-16T00:05:00.000Z',
      })],
    ))

    expect(second.snapshot.data.opportunities).toHaveLength(1)
    expect(second.run).toMatchObject({ receivedCount: 1, accountedCount: 1, outcomes: { merged: 1 } })
    expect(second.snapshot.data.opportunities[0].detail?.discovery?.posting?.postingStatus).toBe('closed')
    expect(second.snapshot.data.opportunities[0].deadline).toBe('2026-09-15T23:59:00.000Z')
    expect(second.snapshot.data.opportunities[0].processStage).toBe('not_applied')
    expect(second.snapshot.data.opportunities[0].currentStageLabel).toBe('待投')
  })

  it('still treats the same stable source record and unchanged fingerprint as duplicate', () => {
    const first = applyMonitorIngestionHardened(snapshot(), run(
      'refresh-run-1',
      '2026-09-15T00:10:00.000Z',
      [observation()],
    ))
    const second = applyMonitorIngestionHardened(first.snapshot, run(
      'refresh-run-2',
      '2026-09-16T00:10:00.000Z',
      [observation({ discoveredAt: '2026-09-16T00:05:00.000Z' })],
    ))

    expect(second.run).toMatchObject({ receivedCount: 1, accountedCount: 1, outcomes: { duplicate: 1 } })
    expect(second.snapshot.data.opportunities).toHaveLength(1)
  })

  it('re-evaluates a changed fingerprint after an earlier filtered observation instead of permanently suppressing the posting id', () => {
    const firstSnapshot = snapshot()
    firstSnapshot.data.discoveryProfile = {
      ...createDefaultDiscoveryProfile('2026-09-15T00:00:00.000Z'),
      mustNotHave: ['销售'],
    }
    const first = applyMonitorIngestionHardened(firstSnapshot, run(
      'refresh-run-filtered',
      '2026-09-15T00:10:00.000Z',
      [observation({ role: '销售经理', sourceTitle: '销售经理' })],
    ))
    expect(first.run.outcomes.filtered).toBe(1)
    expect(first.snapshot.data.opportunities).toHaveLength(0)

    first.snapshot.data.discoveryProfile = createDefaultDiscoveryProfile('2026-09-16T00:00:00.000Z')
    const second = applyMonitorIngestionHardened(first.snapshot, run(
      'refresh-run-reconsidered',
      '2026-09-16T00:10:00.000Z',
      [observation({
        role: 'AI Product Manager',
        sourceTitle: 'AI Product Manager - 2027 Campus',
        discoveredAt: '2026-09-16T00:05:00.000Z',
      })],
    ))

    expect(second.run.outcomes.created).toBe(1)
    expect(second.snapshot.data.opportunities).toHaveLength(1)
    expect(second.snapshot.data.timeline.filter((item) => item.ingestion?.sourceRecordId === 'official-job-123')).toHaveLength(2)
  })
})
