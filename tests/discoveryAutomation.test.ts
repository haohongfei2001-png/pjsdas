import { describe, expect, it } from 'vitest'
import type { ContinuousDiscoverySummary } from '../src/continuousDiscovery.js'
import { buildDiscoveryAutomationPlan } from '../src/discoveryAutomation.js'
import { createDefaultDiscoveryProfile } from '../src/discoveryProfile.js'
import type { RegisteredIngestionSource } from '../src/sourceRegistry.js'

function summary(overrides: Partial<ContinuousDiscoverySummary> = {}): ContinuousDiscoverySummary {
  return {
    runCount: 1,
    suggestedMode: 'incremental',
    incrementalSince: '2026-09-14T01:00:00.000Z',
    recentQueries: ['AI 产品经理 北京 2027 校招'],
    sourceCoverage: [],
    refreshQueue: [],
    totals: { received: 4, reviewCandidates: 2, duplicates: 1, filtered: 1, deferred: 0, appliedSelections: 1 },
    ...overrides,
  }
}

function source(sourceId: string, sourceKind: RegisteredIngestionSource['sourceKind'] = 'gpt_monitor', enabled = true): RegisteredIngestionSource {
  return {
    sourceKind,
    sourceId,
    enabled,
    label: sourceId,
    cadenceMinutes: sourceKind === 'gmail' ? 60 : 1440,
    freshnessSlaMinutes: sourceKind === 'gmail' ? 120 : 2160,
    policySource: 'bootstrap',
  }
}

describe('discovery automation plan', () => {
  it('turns only enabled GPT monitor sources into bounded autonomous source runs', () => {
    const profile = createDefaultDiscoveryProfile('2026-09-14T00:00:00.000Z')
    profile.targetRoleQueries = ['AI 产品经理', '商业分析']
    profile.preferredLocations = ['北京', '上海']
    profile.maxReviewCandidates = 5

    const plan = buildDiscoveryAutomationPlan({
      profile,
      continuousDiscovery: summary(),
      sources: [
        source('monitor:urgent-campus'),
        source('monitor:middle-layer'),
        source('monitor:key-changes'),
        source('monitor:disabled', 'gpt_monitor', false),
        source('gmail:primary', 'gmail'),
      ],
    })

    expect(plan.enabled).toBe(true)
    expect(plan.sourceRuns.map((item) => item.sourceId)).toEqual([
      'monitor:key-changes',
      'monitor:middle-layer',
      'monitor:urgent-campus',
    ])
    expect(plan.maxReviewCandidates).toBe(5)
    expect(plan.sourceRuns.every((item) => item.maxObservations === 15)).toBe(true)
    expect(plan.sourceRuns.find((item) => item.sourceId === 'monitor:urgent-campus')?.queryHints).toContain('AI 产品经理 北京 校招 截止 新增')
    expect(plan.executionRules.join(' ')).toContain('2026-09-14T01:00:00.000Z')
    expect(plan.executionRules.join(' ')).toContain('observations is empty')
  })

  it('keeps refresh work on canonical posting identities and does not mix it into new-job query generation', () => {
    const refreshTarget = {
      ownerKind: 'opportunity' as const,
      ownerId: 'op-1',
      postingId: 'posting-1',
      canonicalSourceUrl: 'https://jobs.example.com/roles/123',
      company: 'Example',
      role: 'Product Manager',
      sourceUrl: 'https://jobs.example.com/roles/123?utm_source=old',
      sourceHost: 'jobs.example.com',
      freshness: 'stale' as const,
      postingStatus: 'open' as const,
      lastVerifiedAt: '2026-08-01T00:00:00.000Z',
    }

    const plan = buildDiscoveryAutomationPlan({
      continuousDiscovery: summary({ suggestedMode: 'refresh', refreshQueue: [refreshTarget] }),
      sources: [source('monitor:key-changes'), source('monitor:urgent-campus')],
    })

    expect(plan.suggestedMode).toBe('refresh')
    expect(plan.sourceRuns.find((item) => item.sourceId === 'monitor:key-changes')?.refreshTargets).toEqual([refreshTarget])
    expect(plan.sourceRuns.find((item) => item.sourceId === 'monitor:urgent-campus')?.refreshTargets).toEqual([])
    expect(plan.executionRules.join(' ')).toContain('canonicalSourceUrl')
  })

  it('still emits a bounded baseline plan when the Discovery Profile has no explicit role or location queries', () => {
    const plan = buildDiscoveryAutomationPlan({
      continuousDiscovery: summary({ runCount: 0, suggestedMode: 'full', incrementalSince: undefined, recentQueries: [] }),
      sources: [source('monitor:urgent-campus')],
    })

    expect(plan.enabled).toBe(true)
    expect(plan.sourceRuns[0]?.queryHints).toEqual(['校园招聘 校招 截止 新增'])
    expect(plan.executionRules.join(' ')).toContain('No durable discovery baseline exists yet')
  })
})
