import type { ContinuousDiscoverySummary, DiscoveryRefreshTarget } from './continuousDiscovery.js'
import { discoveryProfileForSnapshot, isDiscoverySearchScopeConfirmed, type DiscoveryProfile } from './discoveryProfile.js'
import type { RegisteredIngestionSource } from './sourceRegistry.js'
import { buildDiscoveryWebQueries, type DiscoveryWebQuery } from './discoveryQueryPlan.js'

export interface DiscoveryAutomationSourcePlan {
  sourceId: string
  label?: string
  cadenceMinutes: number
  freshnessSlaMinutes: number
  objective: string
  queryHints: string[]
  webQueries?: DiscoveryWebQuery[]
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
  const roles = profile.targetRoleQueries.length ? profile.targetRoleQueries.slice(0, 6) : profile.searchGoal?.trim() ? [profile.searchGoal.trim()] : []
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
  return sourceId === 'monitor:key-changes'
    ? 'Verify the exact previously known job sources; source availability never changes the personal recruiting process.'
    : 'Find source-backed jobs matching only the explicitly confirmed search scope. Do not infer a campus year, employer class, role tier or job value.'
}

function queryHintsFor(_sourceId: string, profile: DiscoveryProfile, _summary: ContinuousDiscoverySummary) {
  return profileQueries(profile)
}

export function buildDiscoveryAutomationPlan(input: {
  profile?: DiscoveryProfile
  continuousDiscovery: ContinuousDiscoverySummary
  sources: RegisteredIngestionSource[]
}): DiscoveryAutomationPlan {
  const profile = discoveryProfileForSnapshot(input.profile)
  const monitorSources = input.sources
    .filter((source) => isDiscoverySearchScopeConfirmed(profile) && source.enabled && source.sourceKind === 'gpt_monitor')
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId))
  const webPlan = buildDiscoveryWebQueries(profile)

  const sourceRuns = monitorSources.map((source, index): DiscoveryAutomationSourcePlan => {
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
      // Partition a single broad plan across existing cadence identities. A
      // disabled identity does not silently remove an entire source category.
      webQueries: webPlan.queries.filter((_, queryIndex) => queryIndex % monitorSources.length === index),
      refreshTargets,
      maxObservations: 18,
    }
  })

  return {
    version: 1,
    enabled: sourceRuns.length > 0,
    suggestedMode: input.continuousDiscovery.suggestedMode,
    incrementalSince: input.continuousDiscovery.incrementalSince,
    maxReviewCandidates: 18,
    sourceRuns,
    executionRules: [
      'Execute each enabled sourceRun separately and preserve its exact sourceId in ingest_discovery_run.',
      input.continuousDiscovery.incrementalSince
        ? `For normal discovery, prefer postings first published or materially updated since ${input.continuousDiscovery.incrementalSince}; do not repeat an unbounded historical search.`
        : 'No durable discovery baseline exists yet; keep the first pass bounded and establish a baseline rather than attempting exhaustive web coverage.',
      'Use public source-backed URLs. Keep unknown location, deadline, publication time, posting status, or other facts unknown instead of inferring them.',
      'Use a stable sourceRecordId for every submitted posting, preferably a source-native posting id or canonical URL identity.',
      'Every completed sourceRun must be ingested even when observations is empty so Source Registry freshness reflects execution rather than assumed coverage.',
      'For monitor:key-changes, verify refreshTargets by canonicalSourceUrl. A changed canonical URL is a new/re-posted source and must return through normal discovery instead of overwriting the existing posting identity.',
      'Do not silently rewrite Discovery Profile, Decision Rules, rejection decisions, deletions, or other user-controlled state.',
    ],
  }
}
