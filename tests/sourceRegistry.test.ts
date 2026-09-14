import { describe, expect, it } from 'vitest'
import { applyMonitorIngestionHardened } from '../src/ingestionHardening.js'
import { expectedSourcesFromRegistry, summarizeCoverage } from '../src/ingestion.js'
import { effectiveSourceRegistry, resolveSourcePolicy } from '../src/sourceRegistry.js'
import { createDefaultDecisionRules } from '../src/decisionRules.js'
import { createDefaultDiscoveryProfile } from '../src/discoveryProfile.js'
import { createSnapshot } from '../src/snapshot.js'

function emptySnapshot() {
  return createSnapshot({
    opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [],
    decisionRules: createDefaultDecisionRules('2026-09-13T00:00:00.000Z'),
    discoveryProfile: createDefaultDiscoveryProfile('2026-09-13T00:00:00.000Z'),
    discoveryInbox: [], timeline: [], changeSets: [],
  }, '2026-09-13T00:00:00.000Z')
}

function run(snapshot: ReturnType<typeof emptySnapshot>, sourceId: string, completedAt: string, sourcePolicy?: {
  version: 1
  enabled: boolean
  label: string
  cadenceMinutes: number
  freshnessSlaMinutes: number
}) {
  return applyMonitorIngestionHardened(snapshot, {
    runId: `${sourceId}:${completedAt}`,
    sourceId,
    startedAt: new Date(new Date(completedAt).getTime() - 5 * 60_000).toISOString(),
    completedAt,
    sourcePolicy,
    observations: [],
  }).snapshot
}

function globalCoverage(snapshot: ReturnType<typeof emptySnapshot>, now: string) {
  return summarizeCoverage(snapshot.data.timeline, {
    now: new Date(now),
    expectedSources: expectedSourcesFromRegistry(snapshot.data.timeline),
  })
}

describe('run-backed ingestion Source Registry', () => {
  it('bootstraps legacy production sources before any policy-bearing run exists', () => {
    const registry = effectiveSourceRegistry([])
    expect(registry.filter((item) => item.enabled)).toHaveLength(5)
    expect(registry.find((item) => item.sourceId === 'gmail:primary')?.freshnessSlaMinutes).toBe(120)
  })

  it('persists a changed cadence/SLA in the latest ingestion run and production Coverage uses it', () => {
    const snapshot = run(emptySnapshot(), 'monitor:key-changes', '2026-09-13T10:00:00.000Z', {
      version: 1, enabled: true, label: '关键变化高频检查', cadenceMinutes: 12 * 60, freshnessSlaMinutes: 18 * 60,
    })
    const source = effectiveSourceRegistry(snapshot.data.timeline).find((item) => item.sourceId === 'monitor:key-changes')
    expect(source).toMatchObject({ policySource: 'run', cadenceMinutes: 720, freshnessSlaMinutes: 1080 })
    const coverage = globalCoverage(snapshot, '2026-09-14T05:00:01.000Z')
    expect(coverage.sources.find((item) => item.sourceId === 'monitor:key-changes')?.stale).toBe(true)
  })

  it('allows a source to disable itself through a durable zero-input run instead of editing Coverage code', () => {
    const snapshot = run(emptySnapshot(), 'monitor:key-changes', '2026-09-13T10:00:00.000Z', {
      version: 1, enabled: false, label: '秋招岗位关键变化', cadenceMinutes: 24 * 60, freshnessSlaMinutes: 36 * 60,
    })
    expect(effectiveSourceRegistry(snapshot.data.timeline).find((item) => item.sourceId === 'monitor:key-changes')?.enabled).toBe(false)
    const coverage = globalCoverage(snapshot, '2026-09-13T10:30:00.000Z')
    expect(coverage.expectedSourceCount).toBe(4)
    expect(coverage.missingSources.some((item) => item.sourceId === 'monitor:key-changes')).toBe(false)
  })

  it('treats an explicitly empty enabled registry as no active coverage instead of falling back to historical runs', () => {
    const snapshot = run(emptySnapshot(), 'monitor:key-changes', '2026-09-13T10:00:00.000Z')
    const coverage = summarizeCoverage(snapshot.data.timeline, {
      now: new Date('2026-09-13T10:30:00.000Z'),
      expectedSources: [],
    })
    expect(coverage).toMatchObject({
      allCaughtUp: false,
      sourceCount: 0,
      expectedSourceCount: 0,
      totalReceived: 0,
      totalAccounted: 0,
      unresolvedCount: 0,
    })
  })

  it('requires an explicit policy at the trusted boundary for a brand-new source, then persists it when supplied', () => {
    expect(() => resolveSourcePolicy('gpt_monitor', 'monitor:new-source')).toThrow(/sourcePolicy/)
    const snapshot = run(emptySnapshot(), 'monitor:new-source', '2026-09-13T10:00:00.000Z', {
      version: 1, enabled: true, label: '新增试验监控', cadenceMinutes: 6 * 60, freshnessSlaMinutes: 9 * 60,
    })
    const source = effectiveSourceRegistry(snapshot.data.timeline).find((item) => item.sourceId === 'monitor:new-source')
    expect(source).toMatchObject({ enabled: true, cadenceMinutes: 360, freshnessSlaMinutes: 540, policySource: 'run' })
  })
})
