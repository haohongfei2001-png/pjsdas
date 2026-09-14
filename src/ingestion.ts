import type {
  IngestionLedgerEntry,
  IngestionOutcome,
  IngestionRunSummary,
  IngestionSourceKind,
  TimelineRecord,
} from './model.js'
import {
  PJSDAS_BOOTSTRAP_SOURCE_REGISTRY,
  enabledSourceRegistry,
  type IngestionSourcePolicy,
  type IngestionRunWithPolicy,
} from './sourceRegistry.js'

export interface IngestionLedgerInput {
  sourceKind: IngestionSourceKind
  sourceId: string
  sourceRecordId: string
  runId: string
  recordType: IngestionLedgerEntry['recordType']
  outcome: IngestionOutcome
  fingerprint: string
  receivedAt: string
  accountedAt?: string
  reason?: string
  opportunityId?: string
  processEventId?: string
  actionId?: string
  company?: string
  role?: string
  sourceRef?: string
}

export interface ExpectedIngestionSource {
  sourceKind: IngestionSourceKind
  sourceId: string
  maxAgeHours: number
  label?: string
  cadenceMinutes?: number
  freshnessSlaMinutes?: number
  policySource?: 'bootstrap' | 'run'
}

export const PJSDAS_EXPECTED_INGESTION_SOURCES: ExpectedIngestionSource[] = PJSDAS_BOOTSTRAP_SOURCE_REGISTRY
  .filter((item) => item.enabled)
  .map((item) => ({ sourceKind: item.sourceKind, sourceId: item.sourceId, maxAgeHours: item.freshnessSlaMinutes / 60, label: item.label, cadenceMinutes: item.cadenceMinutes, freshnessSlaMinutes: item.freshnessSlaMinutes, policySource: item.policySource }))

export interface CoverageSourceSummary {
  sourceKind: IngestionSourceKind
  sourceId: string
  label?: string
  lastCompletedAt: string
  receivedCount: number
  accountedCount: number
  unresolvedCount: number
  outcomes: Partial<Record<IngestionOutcome, number>>
  balanced: boolean
  maxAgeHours?: number
  cadenceMinutes?: number
  freshnessSlaMinutes?: number
  policySource?: 'bootstrap' | 'run'
  ageHours?: number
  stale: boolean
}

export interface CoverageSummary {
  allCaughtUp: boolean
  sourceCount: number
  expectedSourceCount: number
  latestCompletedAt?: string
  totalReceived: number
  totalAccounted: number
  unresolvedCount: number
  staleSourceCount: number
  missingSourceCount: number
  sources: CoverageSourceSummary[]
  missingSources: ExpectedIngestionSource[]
  exceptions: TimelineRecord[]
}

export interface CoverageOptions {
  now?: Date
  /** Global callers pass registry-derived expected sources; omitted means local reconciliation only. */
  expectedSources?: ExpectedIngestionSource[]
}

export function stableIngestionHash(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function sourceFor(kind: IngestionSourceKind): TimelineRecord['source'] {
  if (kind === 'gmail') return 'gmail'
  if (kind === 'natural_language') return 'natural_language'
  if (kind === 'manual') return 'user_action'
  return 'automation'
}

function outcomeLabel(outcome: IngestionOutcome) {
  const labels: Record<IngestionOutcome, string> = { created: '新建', merged: '归并', updated: '更新', duplicate: '重复', filtered: '过滤', ignored: '忽略', unresolved: '待解析' }
  return labels[outcome]
}

export function ingestionSourceRecordKey(input: Pick<IngestionLedgerEntry, 'sourceKind' | 'sourceId' | 'sourceRecordId'>) {
  return `${input.sourceKind}|${input.sourceId}|${input.sourceRecordId}`
}

export function createIngestionLedgerTimeline(input: IngestionLedgerInput): TimelineRecord {
  const accountedAt = input.accountedAt ?? new Date().toISOString()
  const ingestion: IngestionLedgerEntry = {
    version: 1,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    sourceRecordId: input.sourceRecordId,
    runId: input.runId,
    recordType: input.recordType,
    outcome: input.outcome,
    fingerprint: input.fingerprint,
    receivedAt: input.receivedAt,
    accountedAt,
    reason: input.reason,
    opportunityId: input.opportunityId,
    processEventId: input.processEventId,
    actionId: input.actionId,
  }
  const idPayload = `${input.runId}|${ingestionSourceRecordKey(ingestion)}|${input.fingerprint}|${input.outcome}`
  return {
    id: `timeline:ingestion:${stableIngestionHash(idPayload)}`,
    kind: 'ingestion_recorded', category: 'data', source: sourceFor(input.sourceKind),
    occurredAt: input.receivedAt, recordedAt: accountedAt,
    title: `${outcomeLabel(input.outcome)}｜${input.company && input.role ? `${input.company}｜${input.role}` : input.sourceRecordId}`,
    detail: input.reason, opportunityId: input.opportunityId, actionId: input.actionId, processEventId: input.processEventId,
    company: input.company, role: input.role, sourceRef: input.sourceRef ?? input.sourceRecordId, ingestion,
  }
}

export function buildIngestionRunSummary(input: {
  runId: string
  sourceKind: IngestionSourceKind
  sourceId: string
  startedAt: string
  completedAt: string
  records: TimelineRecord[]
  cursor?: string
  sourcePolicy?: IngestionSourcePolicy
}): IngestionRunWithPolicy {
  const records = input.records.filter((item) => item.ingestion?.runId === input.runId)
  const outcomes: Partial<Record<IngestionOutcome, number>> = {}
  for (const record of records) {
    const outcome = record.ingestion!.outcome
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
  }
  return { version: 1, runId: input.runId, sourceKind: input.sourceKind, sourceId: input.sourceId, startedAt: input.startedAt, completedAt: input.completedAt, receivedCount: records.length, accountedCount: records.length, outcomes, cursor: input.cursor, sourcePolicy: input.sourcePolicy }
}

export function createIngestionRunTimeline(summary: IngestionRunSummary): TimelineRecord {
  const outcomeTotal = Object.values(summary.outcomes).reduce((sum, value) => sum + (value ?? 0), 0)
  if (summary.receivedCount !== summary.accountedCount || summary.accountedCount !== outcomeTotal) throw new Error(`Ingestion run ${summary.runId} is not balanced.`)
  return {
    id: `timeline:ingestion-run:${stableIngestionHash(`${summary.sourceKind}|${summary.sourceId}|${summary.runId}`)}`,
    kind: 'ingestion_run_completed', category: 'data', source: sourceFor(summary.sourceKind),
    occurredAt: summary.completedAt, recordedAt: summary.completedAt,
    title: `摄入完成｜${summary.sourceId}｜${summary.receivedCount} 条全部对账`,
    detail: Object.entries(summary.outcomes).filter(([, value]) => Boolean(value)).map(([key, value]) => `${key}:${value}`).join(' · '),
    sourceRef: summary.runId, ingestionRun: summary,
  }
}

export function alreadyIngested(timeline: TimelineRecord[] | undefined, input: Pick<IngestionLedgerEntry, 'sourceKind' | 'sourceId' | 'sourceRecordId'>) {
  const key = ingestionSourceRecordKey(input)
  return (timeline ?? []).filter((item) => item.ingestion && ingestionSourceRecordKey(item.ingestion) === key).sort((a, b) => (b.ingestion?.accountedAt ?? '').localeCompare(a.ingestion?.accountedAt ?? ''))[0]
}

function latestRecordStates(timeline: TimelineRecord[]) {
  const bySourceRecord = new Map<string, TimelineRecord>()
  for (const record of timeline) {
    if (!record.ingestion) continue
    const key = ingestionSourceRecordKey(record.ingestion)
    const previous = bySourceRecord.get(key)
    if (!previous || record.ingestion.accountedAt > previous.ingestion!.accountedAt) bySourceRecord.set(key, record)
  }
  return [...bySourceRecord.values()]
}

function sourceKey(sourceKind: IngestionSourceKind, sourceId: string) { return `${sourceKind}|${sourceId}` }

export function expectedSourcesFromRegistry(records: TimelineRecord[] | undefined): ExpectedIngestionSource[] {
  return enabledSourceRegistry(records).map((item) => ({ sourceKind: item.sourceKind, sourceId: item.sourceId, maxAgeHours: item.freshnessSlaMinutes / 60, label: item.label, cadenceMinutes: item.cadenceMinutes, freshnessSlaMinutes: item.freshnessSlaMinutes, policySource: item.policySource }))
}

export function summarizeCoverage(timeline: TimelineRecord[] | undefined, options: CoverageOptions = {}): CoverageSummary {
  const records = timeline ?? []
  const runs = records.filter((item): item is TimelineRecord & { ingestionRun: IngestionRunSummary } => Boolean(item.ingestionRun)).sort((a, b) => b.ingestionRun.completedAt.localeCompare(a.ingestionRun.completedAt))
  const latestBySource = new Map<string, IngestionRunSummary>()
  for (const record of runs) {
    const run = record.ingestionRun
    const key = sourceKey(run.sourceKind, run.sourceId)
    if (!latestBySource.has(key)) latestBySource.set(key, run)
  }

  const globalMode = options.expectedSources !== undefined
  const expected = options.expectedSources ?? []
  const expectedByKey = new Map(expected.map((item) => [sourceKey(item.sourceKind, item.sourceId), item]))
  const missingSources = expected.filter((item) => !latestBySource.has(sourceKey(item.sourceKind, item.sourceId)))
  const nowMs = options.now?.getTime()

  const latestRecords = latestRecordStates(records)
  const allUnresolved = latestRecords.filter((item) => item.ingestion?.outcome === 'unresolved')
  const unresolved = globalMode
    ? allUnresolved.filter((item) => item.ingestion && expectedByKey.has(sourceKey(item.ingestion.sourceKind, item.ingestion.sourceId)))
    : allUnresolved

  const sourceSummaries: CoverageSourceSummary[] = [...latestBySource.values()].map((run) => {
    const sourceUnresolved = unresolved.filter((item) => item.ingestion?.sourceKind === run.sourceKind && item.ingestion?.sourceId === run.sourceId).length
    const outcomeTotal = Object.values(run.outcomes).reduce((sum, value) => sum + (value ?? 0), 0)
    const policy = expectedByKey.get(sourceKey(run.sourceKind, run.sourceId))
    const completedMs = new Date(run.completedAt).getTime()
    const ageHours = nowMs !== undefined && Number.isFinite(nowMs) && Number.isFinite(completedMs) ? Math.max(0, (nowMs - completedMs) / 3_600_000) : undefined
    const stale = Boolean(policy && ageHours !== undefined && ageHours > policy.maxAgeHours)
    return {
      sourceKind: run.sourceKind, sourceId: run.sourceId, label: policy?.label, lastCompletedAt: run.completedAt,
      receivedCount: run.receivedCount, accountedCount: run.accountedCount, unresolvedCount: sourceUnresolved,
      outcomes: { ...run.outcomes }, balanced: run.receivedCount === run.accountedCount && run.accountedCount === outcomeTotal,
      maxAgeHours: policy?.maxAgeHours, cadenceMinutes: policy?.cadenceMinutes, freshnessSlaMinutes: policy?.freshnessSlaMinutes, policySource: policy?.policySource,
      ageHours, stale,
    }
  }).sort((a, b) => b.lastCompletedAt.localeCompare(a.lastCompletedAt))

  const relevantSources = globalMode
    ? sourceSummaries.filter((item) => expectedByKey.has(sourceKey(item.sourceKind, item.sourceId)))
    : sourceSummaries
  const totalReceived = relevantSources.reduce((sum, item) => sum + item.receivedCount, 0)
  const totalAccounted = relevantSources.reduce((sum, item) => sum + item.accountedCount, 0)
  const staleSourceCount = relevantSources.filter((item) => item.stale).length
  return {
    allCaughtUp:
      relevantSources.length > 0 &&
      relevantSources.every((item) => item.balanced && !item.stale) &&
      unresolved.length === 0 &&
      missingSources.length === 0,
    sourceCount: relevantSources.length,
    expectedSourceCount: expected.length,
    latestCompletedAt: relevantSources[0]?.lastCompletedAt,
    totalReceived, totalAccounted, unresolvedCount: unresolved.length, staleSourceCount, missingSourceCount: missingSources.length,
    sources: relevantSources, missingSources,
    exceptions: unresolved.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)),
  }
}
