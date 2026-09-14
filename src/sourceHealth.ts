import type { IngestionOutcome, IngestionRunSummary, TimelineRecord } from './model.js'
import { effectiveSourceRegistry, type IngestionRunWithPolicy } from './sourceRegistry.js'

export type SourceHealthState = 'healthy' | 'missing' | 'stale' | 'unresolved' | 'unbalanced' | 'disabled'

export interface SourceRunHealth {
  runId: string
  completedAt: string
  receivedCount: number
  accountedCount: number
  outcomes: Partial<Record<IngestionOutcome, number>>
  balanced: boolean
  unresolvedCount: number
  healthy: boolean
}

export interface SourceHealthSummary {
  sourceKind: string
  sourceId: string
  label?: string
  enabled: boolean
  state: SourceHealthState
  cadenceMinutes: number
  freshnessSlaMinutes: number
  lastCompletedAt?: string
  nextExpectedBy?: string
  freshnessDeadline?: string
  ageMinutes?: number
  runCount24h: number
  runCount7d: number
  healthyRunCount7d: number
  consecutiveHealthyRuns: number
  recentRuns: SourceRunHealth[]
}

function key(kind: string, id: string) { return `${kind}|${id}` }

function runHealth(run: IngestionRunSummary): SourceRunHealth {
  const outcomeTotal = Object.values(run.outcomes).reduce((sum, value) => sum + (value ?? 0), 0)
  const unresolvedCount = run.outcomes.unresolved ?? 0
  const balanced = run.receivedCount === run.accountedCount && run.accountedCount === outcomeTotal
  return {
    runId: run.runId,
    completedAt: run.completedAt,
    receivedCount: run.receivedCount,
    accountedCount: run.accountedCount,
    outcomes: { ...run.outcomes },
    balanced,
    unresolvedCount,
    healthy: balanced && unresolvedCount === 0,
  }
}

export function summarizeSourceHealth(timeline: TimelineRecord[] | undefined, now = new Date()): SourceHealthSummary[] {
  const runsBySource = new Map<string, IngestionRunWithPolicy[]>()
  for (const record of timeline ?? []) {
    if (!record.ingestionRun) continue
    const run = record.ingestionRun as IngestionRunWithPolicy
    const sourceRuns = runsBySource.get(key(run.sourceKind, run.sourceId)) ?? []
    sourceRuns.push(run)
    runsBySource.set(key(run.sourceKind, run.sourceId), sourceRuns)
  }
  for (const runs of runsBySource.values()) runs.sort((a, b) => b.completedAt.localeCompare(a.completedAt))

  const nowMs = now.getTime()
  const cutoff24h = nowMs - 24 * 60 * 60 * 1000
  const cutoff7d = nowMs - 7 * 24 * 60 * 60 * 1000

  return effectiveSourceRegistry(timeline).map((source) => {
    const runs = runsBySource.get(key(source.sourceKind, source.sourceId)) ?? []
    const recent = runs.slice(0, 8).map(runHealth)
    const latest = recent[0]
    const completedMs = latest ? new Date(latest.completedAt).getTime() : undefined
    const ageMinutes = completedMs !== undefined && Number.isFinite(completedMs) ? Math.max(0, (nowMs - completedMs) / 60_000) : undefined
    const stale = source.enabled && ageMinutes !== undefined && ageMinutes > source.freshnessSlaMinutes
    let consecutiveHealthyRuns = 0
    for (const run of runs.map(runHealth)) {
      if (!run.healthy) break
      consecutiveHealthyRuns += 1
    }
    const in24h = runs.filter((run) => new Date(run.completedAt).getTime() >= cutoff24h)
    const in7d = runs.filter((run) => new Date(run.completedAt).getTime() >= cutoff7d)
    const healthy7d = in7d.map(runHealth).filter((run) => run.healthy).length
    const state: SourceHealthState = !source.enabled
      ? 'disabled'
      : !latest
        ? 'missing'
        : !latest.balanced
          ? 'unbalanced'
          : latest.unresolvedCount > 0
            ? 'unresolved'
            : stale
              ? 'stale'
              : 'healthy'
    return {
      sourceKind: source.sourceKind,
      sourceId: source.sourceId,
      label: source.label,
      enabled: source.enabled,
      state,
      cadenceMinutes: source.cadenceMinutes,
      freshnessSlaMinutes: source.freshnessSlaMinutes,
      lastCompletedAt: latest?.completedAt,
      nextExpectedBy: completedMs !== undefined ? new Date(completedMs + source.cadenceMinutes * 60_000).toISOString() : undefined,
      freshnessDeadline: completedMs !== undefined ? new Date(completedMs + source.freshnessSlaMinutes * 60_000).toISOString() : undefined,
      ageMinutes,
      runCount24h: in24h.length,
      runCount7d: in7d.length,
      healthyRunCount7d: healthy7d,
      consecutiveHealthyRuns,
      recentRuns: recent,
    }
  }).sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.label ?? a.sourceId).localeCompare(b.label ?? b.sourceId))
}
