import type { ContinuousDiscoverySummary, DiscoveryRefreshTarget } from './continuousDiscovery.js'
import { discoveryProfileForSnapshot, type DiscoveryProfile } from './discoveryProfile.js'
import type { RegisteredIngestionSource } from './sourceRegistry.js'

export interface DiscoveryAutomationSourcePlan {
  sourceId: string
  label?: string
  cadenceMinutes: number
  freshnessSlaMinutes: number
  objective: string
  queryHints: string[]
  refreshTargets: DiscoveryRefreshTarget[]
  maxObservations: number
}

export interface DiscoveryAutomationPlan {
  version: 1
  enabled: boolean
  suggestedMode: ContinuousDiscoverySummary['suggestedMode']
  incrementalSince?: string
  maxReviewCandidates: number
  sourceRuns: DiscoveryAutomationSourcePlan[]
  executionRules: string[]
}

function compact(values: string[], limit: number) {
  const seen = new Set<string>()
  const output: string[] = []
  for (const raw of values) {
    const value = raw.trim().replace(/\s+/g, ' ')
    if (!value) continue
    const key = value.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    output.push(value)
    if (output.length >= limit) break
  }
  return output
}

function profileQueries(profile: DiscoveryProfile, suffix = '') {
  const roles = profile.targetRoleQueries.length ? profile.targetRoleQueries.slice(0, 6) : ['校园招聘']
  const locations = profile.preferredLocations.length ? profile.preferredLocations.slice(0, 4) : ['']
  const queries: string[] = []
  for (const role of roles) {
    for (const location of locations) {
      queries.push([role, location, suffix].filter(Boolean).join(' '))
      if (queries.length >= 12) return compact(queries, 12)
    }
  }
  return compact(queries, 12)
}

function objectiveFor(sourceId: string) {
  switch (sourceId) {
    case 'monitor:urgent-campus':
      return 'Find new or materially updated time-sensitive campus/graduate roles that match the Discovery Profile, prioritizing explicit application deadlines and newly opened postings.'
    case 'monitor:state-foreign-2027':
      return 'Cover 2027 graduate recruitment from state-owned/public-sector and foreign-company employers that matches the Discovery Profile.'
    case 'monitor:middle-layer':
      return 'Look beyond the most obvious head companies for high-fit roles across the profile role/location space, while keeping source quality and role identity strict.'
    case 'monitor:key-changes':
      return 'Verify aging/stale/unknown canonical posting URLs and detect material posting changes or re-posts without conflating posting lifecycle with recruiting-process state.'
    default:
      return 'Run a bounded source-backed discovery pass that follows the Discovery Profile and TodayAction ingestion contract.'
  }
}

function queryHintsFor(sourceId: string, profile: DiscoveryProfile, summary: ContinuousDiscoverySummary) {
  switch (sourceId) {
    case 'monitor:urgent-campus':
      return profileQueries(profile, '校招 截止 新增')
    case 'monitor:state-foreign-2027':
      return profileQueries(profile, '2027 校园招聘 国企 央企 外企')
    case 'monitor:middle-layer':
      return profileQueries(profile, '校招 招聘')
    case 'monitor:key-changes':
      return compact(summary.recentQueries, 12)
    default:
      return profileQueries(profile)
  }
}

export function buildDiscoveryAutomationPlan(input: {
  profile?: DiscoveryProfile
  continuousDiscovery: ContinuousDiscoverySummary
  sources: RegisteredIngestionSource[]
}): DiscoveryAutomationPlan {
  const profile = discoveryProfileForSnapshot(input.profile)
  const monitorSources = input.sources
    .filter((source) => source.enabled && source.sourceKind === 'gpt_monitor')
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId))

  const sourceRuns = monitorSources.map((source): DiscoveryAutomationSourcePlan => {
    const refreshTargets = source.sourceId === 'monitor:key-changes'
      ? input.continuousDiscovery.refreshQueue.slice(0, 20)
      : []
    return {
      sourceId: source.sourceId,
      label: source.label,
      cadenceMinutes: source.cadenceMinutes,
      freshnessSlaMinutes: source.freshnessSlaMinutes,
      objective: objectiveFor(source.sourceId),
      queryHints: queryHintsFor(source.sourceId, profile, input.continuousDiscovery),
      refreshTargets,
      maxObservations: Math.min(25, Math.max(6, (profile.maxReviewCandidates ?? 6) * 3)),
    }
  })

  return {
    version: 1,
    enabled: sourceRuns.length > 0,
    suggestedMode: input.continuousDiscovery.suggestedMode,
    incrementalSince: input.continuousDiscovery.incrementalSince,
    maxReviewCandidates: profile.maxReviewCandidates ?? 6,
    sourceRuns,
    executionRules: [
      'Execute each enabled sourceRun separately and preserve its exact sourceId in ingest_discovery_run.',
      input.continuousDiscovery.incrementalSince
        ? `For normal discovery, prefer postings first published or materially updated since ${input.continuousDiscovery.incrementalSince}; do not repeat an unbounded historical search.`
        : 'No durable discovery baseline exists yet; keep the first pass bounded and establish a baseline rather than attempting exhaustive web coverage.',
      'Use public source-backed URLs. Keep unknown location, deadline, compensation, posting status, or other facts unknown instead of inferring them.',
      'Use a stable sourceRecordId for every submitted posting, preferably a source-native posting id or canonical URL identity.',
      'Every completed sourceRun must be ingested even when observations is empty so Source Registry freshness reflects execution rather than assumed coverage.',
      'For monitor:key-changes, verify refreshTargets by canonicalSourceUrl. A changed canonical URL is a new/re-posted source and must return through normal discovery instead of overwriting the existing posting identity.',
      'Do not silently rewrite Discovery Profile, Decision Rules, rejection decisions, deletions, or other user-controlled state.',
    ],
  }
}
