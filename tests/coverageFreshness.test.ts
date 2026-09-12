import { describe, expect, it } from 'vitest'
import { applyGmailIngestionHardened, applyMonitorIngestionHardened } from '../src/ingestionHardening.js'
import { createDefaultDecisionRules } from '../src/decisionRules.js'
import { createDefaultDiscoveryProfile } from '../src/discoveryProfile.js'
import {
  PJSDAS_EXPECTED_INGESTION_SOURCES,
  summarizeCoverage,
} from '../src/ingestion.js'
import { createSnapshot } from '../src/snapshot.js'

function emptySnapshot() {
  return createSnapshot({
    opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [],
    decisionRules: createDefaultDecisionRules('2026-09-13T00:00:00.000Z'),
    discoveryProfile: createDefaultDiscoveryProfile('2026-09-13T00:00:00.000Z'),
    discoveryInbox: [], timeline: [], changeSets: [],
  }, '2026-09-13T00:00:00.000Z')
}

function addZeroResultMonitor(snapshot: ReturnType<typeof emptySnapshot>, sourceId: string, completedAt: string) {
  return applyMonitorIngestionHardened(snapshot, {
    runId: `${sourceId}:${completedAt}`,
    sourceId,
    startedAt: new Date(new Date(completedAt).getTime() - 5 * 60_000).toISOString(),
    completedAt,
    observations: [],
  }).snapshot
}

function addZeroResultGmail(snapshot: ReturnType<typeof emptySnapshot>, completedAt: string) {
  return applyGmailIngestionHardened(snapshot, {
    runId: `gmail:primary:${completedAt}`,
    sourceId: 'gmail:primary',
    startedAt: new Date(new Date(completedAt).getTime() - 5 * 60_000).toISOString(),
    completedAt,
    messages: [],
  }).snapshot
}

function addAllSources(completedAt = '2026-09-13T10:00:00.000Z') {
  let snapshot = emptySnapshot()
  for (const source of PJSDAS_EXPECTED_INGESTION_SOURCES.filter((item) => item.sourceKind === 'gpt_monitor')) {
    snapshot = addZeroResultMonitor(snapshot, source.sourceId, completedAt)
  }
  snapshot = addZeroResultGmail(snapshot, completedAt)
  return snapshot
}

describe('Coverage freshness and configured-source completeness', () => {
  it('does not show green when configured sources have never completed a run', () => {
    const coverage = summarizeCoverage(emptySnapshot().data.timeline, {
      now: new Date('2026-09-13T10:30:00.000Z'),
      expectedSources: PJSDAS_EXPECTED_INGESTION_SOURCES,
    })
    expect(coverage.allCaughtUp).toBe(false)
    expect(coverage.missingSourceCount).toBe(PJSDAS_EXPECTED_INGESTION_SOURCES.length)
  })

  it('shows green when every configured source has a balanced fresh run and no unresolved records', () => {
    const snapshot = addAllSources()
    const coverage = summarizeCoverage(snapshot.data.timeline, {
      now: new Date('2026-09-13T10:30:00.000Z'),
      expectedSources: PJSDAS_EXPECTED_INGESTION_SOURCES,
    })
    expect(coverage.allCaughtUp).toBe(true)
    expect(coverage.missingSourceCount).toBe(0)
    expect(coverage.staleSourceCount).toBe(0)
    expect(coverage.sourceCount).toBe(PJSDAS_EXPECTED_INGESTION_SOURCES.length)
  })

  it('turns Coverage non-green when Gmail misses its two-hour freshness SLA even though the last run was balanced', () => {
    const snapshot = addAllSources('2026-09-13T10:00:00.000Z')
    const coverage = summarizeCoverage(snapshot.data.timeline, {
      now: new Date('2026-09-13T12:01:00.000Z'),
      expectedSources: PJSDAS_EXPECTED_INGESTION_SOURCES,
    })
    expect(coverage.allCaughtUp).toBe(false)
    expect(coverage.staleSourceCount).toBe(1)
    expect(coverage.sources.find((item) => item.sourceId === 'gmail:primary')?.stale).toBe(true)
  })

  it('turns Coverage non-green when one daily monitor stops running beyond 36 hours', () => {
    let snapshot = addAllSources('2026-09-13T10:00:00.000Z')
    for (const source of PJSDAS_EXPECTED_INGESTION_SOURCES.filter((item) => item.sourceKind === 'gpt_monitor' && item.sourceId !== 'monitor:key-changes')) {
      snapshot = addZeroResultMonitor(snapshot, source.sourceId, '2026-09-14T22:30:00.000Z')
    }
    snapshot = addZeroResultGmail(snapshot, '2026-09-14T22:30:00.000Z')

    const coverage = summarizeCoverage(snapshot.data.timeline, {
      now: new Date('2026-09-14T22:30:01.000Z'),
      expectedSources: PJSDAS_EXPECTED_INGESTION_SOURCES,
    })
    expect(coverage.allCaughtUp).toBe(false)
    expect(coverage.sources.find((item) => item.sourceId === 'monitor:key-changes')?.stale).toBe(true)
  })
})
