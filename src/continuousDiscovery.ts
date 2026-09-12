import { discoveryRunsFromChangeSets, type StoredDiscoveryRun } from './discoveryRun.js'
import { jobPostingFreshness, knownJobPostings } from './jobPosting.js'
import type { ChangeSetRecord } from './changeSet.js'
import type { DiscoveryInboxItem, Opportunity } from './model.js'

export interface DiscoverySourceCoverage {
  host: string
  runCount: number
  candidateRunCount: number
  candidateCount: number
  lastRunAt: string
}

export interface DiscoveryRefreshTarget {
  ownerKind: 'opportunity' | 'inbox'
  ownerId: string
  postingId: string
  canonicalSourceUrl: string
  company: string
  role: string
  sourceUrl: string
  sourceHost: string
  freshness: 'aging' | 'stale' | 'unknown'
  postingStatus: 'open' | 'unknown'
  lastVerifiedAt: string
}

export interface ContinuousDiscoverySummary {
  runCount: number
  lastRun?: StoredDiscoveryRun
  suggestedMode: 'full' | 'incremental' | 'refresh'
  incrementalSince?: string
  recentQueries: string[]
  sourceCoverage: DiscoverySourceCoverage[]
  refreshQueue: DiscoveryRefreshTarget[]
  totals: {
    received: number
    reviewCandidates: number
    duplicates: number
    filtered: number
    deferred: number
    appliedSelections: number
  }
}

function sourceCoverage(runs: StoredDiscoveryRun[]): DiscoverySourceCoverage[] {
  const map = new Map<string, DiscoverySourceCoverage>()
  for (const run of runs) {
    const searched = new Set(run.searchedSourceHosts)
    const candidate = new Set(run.candidateSourceHosts)
    for (const host of searched) {
      const current = map.get(host) ?? {
        host,
        runCount: 0,
        candidateRunCount: 0,
        candidateCount: 0,
        lastRunAt: run.completedAt,
      }
      current.runCount += 1
      if (candidate.has(host)) current.candidateRunCount += 1
      current.lastRunAt = current.lastRunAt >= run.completedAt ? current.lastRunAt : run.completedAt
      map.set(host, current)
    }
    for (const host of candidate) {
      const current = map.get(host) ?? {
        host,
        runCount: 0,
        candidateRunCount: 0,
        candidateCount: 0,
        lastRunAt: run.completedAt,
      }
      current.candidateCount += 1
      if (!searched.has(host)) {
        current.runCount += 1
        current.candidateRunCount += 1
      }
      current.lastRunAt = current.lastRunAt >= run.completedAt ? current.lastRunAt : run.completedAt
      map.set(host, current)
    }
  }
  return [...map.values()].sort((a, b) =>
    b.candidateRunCount - a.candidateRunCount ||
    b.runCount - a.runCount ||
    b.lastRunAt.localeCompare(a.lastRunAt) ||
    a.host.localeCompare(b.host)
  )
}

function buildRefreshQueue(opportunities: Opportunity[], inbox: DiscoveryInboxItem[], now: Date) {
  const seen = new Set<string>()
  const targets: DiscoveryRefreshTarget[] = []
  for (const item of knownJobPostings(opportunities, inbox)) {
    if (item.inboxStatus === 'dismissed' || item.inboxStatus === 'promoted') continue
    if (item.posting.postingStatus === 'closed' || item.posting.supersededByPostingId) continue
    const freshness = jobPostingFreshness(item.posting, now)
    if (freshness === 'fresh' || freshness === 'closed') continue
    const normalizedFreshness = freshness === 'aging' || freshness === 'stale' ? freshness : 'unknown'
    const key = `${item.ownerKind}:${item.ownerId}:${item.posting.canonicalSourceUrl}`
    if (seen.has(key)) continue
    seen.add(key)
    targets.push({
      ownerKind: item.ownerKind,
      ownerId: item.ownerId,
      postingId: item.posting.id,
      canonicalSourceUrl: item.posting.canonicalSourceUrl,
      company: item.company,
      role: item.role,
      sourceUrl: item.posting.sourceUrl,
      sourceHost: item.posting.sourceHost,
      freshness: normalizedFreshness,
      postingStatus: item.posting.postingStatus === 'open' ? 'open' : 'unknown',
      lastVerifiedAt: item.posting.lastVerifiedAt,
    })
  }
  const rank = { stale: 0, unknown: 1, aging: 2 } as const
  return targets.sort((a, b) =>
    rank[a.freshness] - rank[b.freshness] ||
    a.lastVerifiedAt.localeCompare(b.lastVerifiedAt) ||
    a.company.localeCompare(b.company) ||
    a.role.localeCompare(b.role)
  )
}

export function buildContinuousDiscoverySummary(input: {
  changeSets: ChangeSetRecord[]
  opportunities: Opportunity[]
  inbox: DiscoveryInboxItem[]
  now?: Date
}): ContinuousDiscoverySummary {
  const now = input.now ?? new Date()
  const inboxSourceIds = new Set(input.inbox.map((item) => item.sourceChangeSetId).filter((value): value is string => Boolean(value)))
  const runs = discoveryRunsFromChangeSets(input.changeSets, inboxSourceIds)
  const lastRun = runs[0]
  const refreshQueue = buildRefreshQueue(input.opportunities, input.inbox, now)
  const recentQueries = [...new Set(runs.flatMap((run) => run.queries).filter(Boolean))].slice(0, 20)
  const totals = runs.reduce((acc, run) => {
    acc.received += run.receivedCount
    acc.reviewCandidates += run.reviewCandidateCount
    acc.duplicates += run.duplicateCount
    acc.filtered += run.filteredCount
    acc.deferred += run.deferredCount
    if (run.outcome === 'applied') acc.appliedSelections += run.selectedCount
    return acc
  }, { received: 0, reviewCandidates: 0, duplicates: 0, filtered: 0, deferred: 0, appliedSelections: 0 })
  const suggestedMode: ContinuousDiscoverySummary['suggestedMode'] = refreshQueue.some((item) => item.freshness === 'stale')
    ? 'refresh'
    : lastRun
      ? 'incremental'
      : 'full'
  return {
    runCount: runs.length,
    lastRun,
    suggestedMode,
    incrementalSince: lastRun?.completedAt,
    recentQueries,
    sourceCoverage: sourceCoverage(runs),
    refreshQueue: refreshQueue.slice(0, 30),
    totals,
  }
}