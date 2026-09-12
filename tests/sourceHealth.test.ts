import { describe, expect, it } from 'vitest'
import { createIngestionRunTimeline, buildIngestionRunSummary } from '../src/ingestion.js'
import { summarizeSourceHealth } from '../src/sourceHealth.js'
import type { TimelineRecord } from '../src/model.js'

function run(sourceId: string, completedAt: string, options: { unresolved?: number; enabled?: boolean } = {}): TimelineRecord {
  const unresolved = options.unresolved ?? 0
  return createIngestionRunTimeline(buildIngestionRunSummary({
    runId: `${sourceId}:${completedAt}`,
    sourceKind: sourceId === 'gmail:primary' ? 'gmail' : 'gpt_monitor',
    sourceId,
    startedAt: new Date(new Date(completedAt).getTime() - 5 * 60_000).toISOString(),
    completedAt,
    records: Array.from({ length: unresolved }, (_, index) => ({
      id: `ledger:${index}`,
      kind: 'ingestion_recorded', category: 'data', source: 'automation', occurredAt: completedAt, recordedAt: completedAt,
      title: 'unresolved',
      ingestion: {
        version: 1, sourceKind: sourceId === 'gmail:primary' ? 'gmail' : 'gpt_monitor', sourceId,
        sourceRecordId: `r-${index}`, runId: `${sourceId}:${completedAt}`, recordType: sourceId === 'gmail:primary' ? 'recruiting_message' : 'job_observation',
        outcome: 'unresolved', fingerprint: `f-${index}`, receivedAt: completedAt, accountedAt: completedAt,
      },
    } as TimelineRecord)),
    sourcePolicy: {
      version: 1,
      enabled: options.enabled ?? true,
      label: sourceId,
      cadenceMinutes: sourceId === 'gmail:primary' ? 60 : 1440,
      freshnessSlaMinutes: sourceId === 'gmail:primary' ? 120 : 2160,
    },
  }))
}

describe('source health / run history', () => {
  it('reports missing bootstrap sources before their first run', () => {
    const health = summarizeSourceHealth([], new Date('2026-09-13T10:00:00Z'))
    expect(health.filter((item) => item.enabled && item.state === 'missing')).toHaveLength(5)
  })

  it('computes healthy history, next expected time and consecutive runs', () => {
    const timeline = [
      run('gmail:primary', '2026-09-13T08:00:00Z'),
      run('gmail:primary', '2026-09-13T09:00:00Z'),
      run('gmail:primary', '2026-09-13T10:00:00Z'),
    ]
    const gmail = summarizeSourceHealth(timeline, new Date('2026-09-13T10:30:00Z')).find((item) => item.sourceId === 'gmail:primary')!
    expect(gmail).toMatchObject({ state: 'healthy', runCount24h: 3, runCount7d: 3, healthyRunCount7d: 3, consecutiveHealthyRuns: 3 })
    expect(gmail.nextExpectedBy).toBe('2026-09-13T11:00:00.000Z')
    expect(gmail.freshnessDeadline).toBe('2026-09-13T12:00:00.000Z')
  })

  it('marks a source stale after its registry SLA', () => {
    const gmail = summarizeSourceHealth([run('gmail:primary', '2026-09-13T08:00:00Z')], new Date('2026-09-13T10:00:01Z')).find((item) => item.sourceId === 'gmail:primary')!
    expect(gmail.state).toBe('stale')
  })

  it('marks unresolved latest runs unhealthy and keeps the prior healthy streak from crossing them', () => {
    const timeline = [run('gmail:primary', '2026-09-13T09:00:00Z'), run('gmail:primary', '2026-09-13T10:00:00Z', { unresolved: 1 })]
    const gmail = summarizeSourceHealth(timeline, new Date('2026-09-13T10:30:00Z')).find((item) => item.sourceId === 'gmail:primary')!
    expect(gmail.state).toBe('unresolved')
    expect(gmail.consecutiveHealthyRuns).toBe(0)
    expect(gmail.healthyRunCount7d).toBe(1)
  })

  it('keeps disabled registry sources visible without making them missing/stale', () => {
    const keyChanges = summarizeSourceHealth([run('monitor:key-changes', '2026-09-13T08:00:00Z', { enabled: false })], new Date('2026-09-20T10:00:00Z')).find((item) => item.sourceId === 'monitor:key-changes')!
    expect(keyChanges.state).toBe('disabled')
    expect(keyChanges.enabled).toBe(false)
  })
})
