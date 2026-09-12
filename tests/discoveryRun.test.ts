import { describe, expect, it } from 'vitest'
import { createDiscoveryRunRecord, discoveryRunsFromChangeSets, validateDiscoveryRunRecord } from '../src/discoveryRun.js'
import type { ChangeSetRecord } from '../src/changeSet.js'

const completedAt = '2026-09-12T00:30:00.000Z'

function changeSet(status: ChangeSetRecord['status'], id: string, selected = 2): ChangeSetRecord {
  const run = createDiscoveryRunRecord({
    screening: { received: 6, accepted: 3, duplicateCount: 1, rejectedCount: 1, deferredCount: 1 },
    candidateSourceUrls: ['https://jobs.example.com/a', 'https://careers.example.org/b'],
    workspaceVersion: 'drive:20',
    completedAt,
  })
  return {
    id,
    version: 1,
    source: 'mcp',
    status,
    title: '岗位发现',
    createdAt: completedAt,
    updatedAt: completedAt,
    discoveryRun: run,
    operations: Array.from({ length: selected }, (_, index) => ({
      id: `discovery:${index}`,
      kind: 'add_discovered_opportunity' as const,
      summary: `岗位 ${index}`,
      opportunity: {} as never,
    })),
  }
}

describe('v1.7 Discovery Run ledger', () => {
  it('normalizes source hosts and validates bounded screening counts', () => {
    const run = createDiscoveryRunRecord({
      context: { searchedSourceHosts: ['WWW.Example.com', 'https://jobs.example.com/path'] },
      screening: { received: 4, accepted: 2, duplicateCount: 1, rejectedCount: 1, deferredCount: 0 },
      candidateSourceUrls: ['https://jobs.example.com/role?utm_source=x'],
      workspaceVersion: 'drive:20',
      completedAt,
    })
    expect(run.mode).toBe('ad_hoc')
    expect(run.searchedSourceHosts).toEqual(['example.com', 'jobs.example.com'])
    expect(run.candidateSourceHosts).toEqual(['jobs.example.com'])
    expect(validateDiscoveryRunRecord(run)).toEqual([])
  })

  it('derives applied, inbox-saved and discarded outcomes from existing ChangeSet semantics', () => {
    const applied = changeSet('applied', 'cs-applied', 2)
    const inbox = changeSet('discarded', 'cs-inbox', 3)
    const discarded = changeSet('discarded', 'cs-discarded', 3)
    const runs = discoveryRunsFromChangeSets([discarded, inbox, applied], new Set(['cs-inbox']))
    expect(runs.find((item) => item.changeSetId === 'cs-applied')).toMatchObject({ outcome: 'applied', selectedCount: 2 })
    expect(runs.find((item) => item.changeSetId === 'cs-inbox')).toMatchObject({ outcome: 'saved_to_inbox', selectedCount: 3 })
    expect(runs.find((item) => item.changeSetId === 'cs-discarded')).toMatchObject({ outcome: 'discarded', selectedCount: 3 })
  })

  it('rejects internally inconsistent screening counts', () => {
    const run = createDiscoveryRunRecord({
      screening: { received: 4, accepted: 2, duplicateCount: 1, rejectedCount: 1, deferredCount: 0 },
      candidateSourceUrls: ['https://jobs.example.com/a'],
      completedAt,
    })
    expect(validateDiscoveryRunRecord({ ...run, deferredCount: 2 })).toContain('Discovery Run 结果计数超过 receivedCount。')
  })
})
