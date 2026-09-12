import { describe, expect, it } from 'vitest'
import { buildContinuousDiscoverySummary } from '../src/continuousDiscovery.js'
import { createDiscoveryRunRecord } from '../src/discoveryRun.js'
import { createJobPostingEvidence } from '../src/jobPosting.js'
import type { ChangeSetRecord } from '../src/changeSet.js'
import type { Opportunity } from '../src/model.js'

const now = new Date('2026-09-12T08:00:00+08:00')

function runChangeSet(id: string, completedAt: string, host: string): ChangeSetRecord {
  return {
    id,
    version: 1,
    source: 'mcp',
    status: 'applied',
    title: '岗位发现',
    createdAt: completedAt,
    updatedAt: completedAt,
    discoveryRun: createDiscoveryRunRecord({
      screening: { received: 4, accepted: 2, duplicateCount: 1, rejectedCount: 1, deferredCount: 0 },
      candidateSourceUrls: [`https://${host}/role-a`, `https://${host}/role-b`],
      workspaceVersion: 'drive:9',
      completedAt,
    }),
    operations: [],
  }
}

function opportunity(id: string, verifiedAt: string): Opportunity {
  const posting = createJobPostingEvidence({
    company: '示例科技',
    role: id,
    sourceUrl: `https://jobs.example.com/${id}`,
    sourceTitle: id,
    postingStatus: 'open',
    observedAt: verifiedAt,
  })
  return {
    id,
    company: '示例科技',
    role: id,
    currentStageLabel: '待投',
    processStage: 'not_applied',
    roleType: 'core',
    early: false,
    opportunityValue: 88,
    fitScore: 80,
    importedAt: verifiedAt,
    detail: {
      discovery: {
        sourceUrl: posting.sourceUrl,
        sourceTitle: posting.sourceTitle,
        rationale: '测试',
        discoveredAt: verifiedAt,
        fitConfidence: 'high',
        opportunityValueConfidence: 'high',
        posting,
      },
    },
  }
}

describe('v1.7 continuous discovery summary', () => {
  it('creates an incremental baseline and aggregates productive source coverage', () => {
    const older = runChangeSet('run-old', '2026-09-01T00:00:00.000Z', 'jobs.example.com')
    const newer = runChangeSet('run-new', '2026-09-10T00:00:00.000Z', 'jobs.example.com')
    const summary = buildContinuousDiscoverySummary({ changeSets: [older, newer], opportunities: [], inbox: [], now })
    expect(summary.runCount).toBe(2)
    expect(summary.incrementalSince).toBe('2026-09-10T00:00:00.000Z')
    expect(summary.sourceCoverage[0]).toMatchObject({ host: 'jobs.example.com', runCount: 2, candidateRunCount: 2 })
    expect(summary.totals).toMatchObject({ received: 8, reviewCandidates: 4, duplicates: 2, filtered: 2 })
    expect(summary.suggestedMode).toBe('incremental')
  })

  it('prioritizes stale source verification ahead of another new-job pass', () => {
    const run = runChangeSet('run-one', '2026-09-10T00:00:00.000Z', 'jobs.example.com')
    const stale = opportunity('AI 产品经理', '2026-08-01T00:00:00.000Z')
    const fresh = opportunity('商业分析', '2026-09-10T00:00:00.000Z')
    const summary = buildContinuousDiscoverySummary({ changeSets: [run], opportunities: [fresh, stale], inbox: [], now })
    expect(summary.suggestedMode).toBe('refresh')
    expect(summary.refreshQueue).toHaveLength(1)
    expect(summary.refreshQueue[0]).toMatchObject({ role: 'AI 产品经理', freshness: 'stale', sourceHost: 'jobs.example.com' })
  })
})
