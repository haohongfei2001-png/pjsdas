import type { IngestionRunSummary, IngestionSourceKind, TimelineRecord } from './model.js'

export interface IngestionSourcePolicy {
  version: 1
  enabled: boolean
  label?: string
  cadenceMinutes: number
  freshnessSlaMinutes: number
}

export interface RegisteredIngestionSource {
  sourceKind: IngestionSourceKind
  sourceId: string
  enabled: boolean
  label?: string
  cadenceMinutes: number
  freshnessSlaMinutes: number
  policySource: 'bootstrap' | 'run'
}

export type IngestionRunWithPolicy = IngestionRunSummary & {
  sourcePolicy?: IngestionSourcePolicy
}

export const PJSDAS_BOOTSTRAP_SOURCE_REGISTRY: RegisteredIngestionSource[] = [
  {
    sourceKind: 'gpt_monitor',
    sourceId: 'monitor:urgent-campus',
    enabled: true,
    label: '秋招紧迫岗位检查',
    cadenceMinutes: 24 * 60,
    freshnessSlaMinutes: 36 * 60,
    policySource: 'bootstrap',
  },
  {
    sourceKind: 'gpt_monitor',
    sourceId: 'monitor:state-foreign-2027',
    enabled: true,
    label: '央国企外企27届秋招',
    cadenceMinutes: 24 * 60,
    freshnessSlaMinutes: 36 * 60,
    policySource: 'bootstrap',
  },
  {
    sourceKind: 'gpt_monitor',
    sourceId: 'monitor:middle-layer',
    enabled: true,
    label: '高匹配中间层校招岗位',
    cadenceMinutes: 24 * 60,
    freshnessSlaMinutes: 36 * 60,
    policySource: 'bootstrap',
  },
  {
    sourceKind: 'gpt_monitor',
    sourceId: 'monitor:key-changes',
    enabled: true,
    label: '秋招岗位关键变化',
    cadenceMinutes: 24 * 60,
    freshnessSlaMinutes: 36 * 60,
    policySource: 'bootstrap',
  },
  {
    sourceKind: 'gmail',
    sourceId: 'gmail:primary',
    enabled: true,
    label: '招聘邮件自动摄入',
    cadenceMinutes: 60,
    freshnessSlaMinutes: 120,
    policySource: 'bootstrap',
  },
]

function sourceKey(sourceKind: IngestionSourceKind, sourceId: string) {
  return `${sourceKind}|${sourceId}`
}

function validMinutes(value: number) {
  return Number.isInteger(value) && value >= 15 && value <= 60 * 24 * 30
}

export function normalizeSourcePolicy(policy: IngestionSourcePolicy): IngestionSourcePolicy {
  if (policy.version !== 1) throw new Error('Unsupported ingestion source policy version.')
  if (!validMinutes(policy.cadenceMinutes)) throw new Error('Ingestion source cadenceMinutes is invalid.')
  if (!validMinutes(policy.freshnessSlaMinutes)) throw new Error('Ingestion source freshnessSlaMinutes is invalid.')
  if (policy.enabled && policy.freshnessSlaMinutes < policy.cadenceMinutes) {
    throw new Error('Ingestion source freshness SLA cannot be shorter than its cadence.')
  }
  return {
    version: 1,
    enabled: Boolean(policy.enabled),
    label: policy.label?.trim() || undefined,
    cadenceMinutes: policy.cadenceMinutes,
    freshnessSlaMinutes: policy.freshnessSlaMinutes,
  }
}

export function bootstrapPolicyFor(sourceKind: IngestionSourceKind, sourceId: string) {
  const found = PJSDAS_BOOTSTRAP_SOURCE_REGISTRY.find((item) =>
    item.sourceKind === sourceKind && item.sourceId === sourceId,
  )
  if (!found) return undefined
  return normalizeSourcePolicy({
    version: 1,
    enabled: found.enabled,
    label: found.label,
    cadenceMinutes: found.cadenceMinutes,
    freshnessSlaMinutes: found.freshnessSlaMinutes,
  })
}

export function resolveSourcePolicy(
  sourceKind: IngestionSourceKind,
  sourceId: string,
  explicit?: IngestionSourcePolicy,
) {
  if (explicit) return normalizeSourcePolicy(explicit)
  const bootstrap = bootstrapPolicyFor(sourceKind, sourceId)
  if (bootstrap) return bootstrap
  throw new Error(`Trusted ingestion source ${sourceKind}:${sourceId} requires an explicit sourcePolicy.`)
}

export function latestRunsBySource(timeline: TimelineRecord[] | undefined) {
  const latest = new Map<string, IngestionRunWithPolicy>()
  const runs = (timeline ?? [])
    .filter((item): item is TimelineRecord & { ingestionRun: IngestionRunSummary } => Boolean(item.ingestionRun))
    .map((item) => item.ingestionRun as IngestionRunWithPolicy)
    .sort((a, b) => b.completedAt.localeCompare(a.completedAt))
  for (const run of runs) {
    const key = sourceKey(run.sourceKind, run.sourceId)
    if (!latest.has(key)) latest.set(key, run)
  }
  return latest
}

export function effectiveSourceRegistry(timeline: TimelineRecord[] | undefined) {
  const registry = new Map<string, RegisteredIngestionSource>()
  for (const source of PJSDAS_BOOTSTRAP_SOURCE_REGISTRY) {
    registry.set(sourceKey(source.sourceKind, source.sourceId), { ...source })
  }

  for (const run of latestRunsBySource(timeline).values()) {
    if (!run.sourcePolicy) continue
    const policy = normalizeSourcePolicy(run.sourcePolicy)
    registry.set(sourceKey(run.sourceKind, run.sourceId), {
      sourceKind: run.sourceKind,
      sourceId: run.sourceId,
      enabled: policy.enabled,
      label: policy.label,
      cadenceMinutes: policy.cadenceMinutes,
      freshnessSlaMinutes: policy.freshnessSlaMinutes,
      policySource: 'run',
    })
  }

  return [...registry.values()]
    .sort((a, b) => a.sourceKind.localeCompare(b.sourceKind) || a.sourceId.localeCompare(b.sourceId))
}

export function enabledSourceRegistry(timeline: TimelineRecord[] | undefined) {
  return effectiveSourceRegistry(timeline).filter((item) => item.enabled)
}
