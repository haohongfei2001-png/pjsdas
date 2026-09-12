import { jobSourceHost } from './jobPosting.js'
import type { ChangeSetRecord } from './changeSet.js'

export type DiscoveryRunMode = 'ad_hoc' | 'full' | 'incremental' | 'refresh'

export interface DiscoveryRunRecord {
  version: 1
  id: string
  mode: DiscoveryRunMode
  startedAt: string
  completedAt: string
  profileUpdatedAt?: string
  baselineWorkspaceVersion?: string
  queries: string[]
  searchedSourceHosts: string[]
  candidateSourceHosts: string[]
  receivedCount: number
  reviewCandidateCount: number
  duplicateCount: number
  filteredCount: number
  deferredCount: number
}

export interface DiscoveryRunContextInput {
  mode?: DiscoveryRunMode
  startedAt?: string
  queries?: string[]
  searchedSourceHosts?: string[]
}

export interface DiscoveryRunScreeningCounts {
  received: number
  accepted: number
  duplicateCount: number
  rejectedCount: number
  deferredCount: number
}

declare module './changeSet.js' {
  interface ChangeSetRecord {
    discoveryRun?: DiscoveryRunRecord
  }
}

function validIso(value: string | undefined) {
  return Boolean(value && !Number.isNaN(new Date(value).getTime()))
}

function cleanText(value: string, maxLength: number) {
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLength)
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))]
}

export function normalizeSourceHost(value: string) {
  const raw = value.trim().toLocaleLowerCase()
  if (!raw) return ''
  try {
    const url = raw.includes('://') ? new URL(raw) : new URL(`https://${raw}`)
    return url.hostname.toLocaleLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

function runId(completedAt: string, workspaceVersion?: string) {
  const stamp = completedAt.replace(/[-:TZ.]/g, '').slice(0, 14)
  const suffix = (workspaceVersion ?? 'local').replace(/[^a-z0-9]/gi, '').slice(-8) || 'local'
  return `discovery-run:${stamp}:${suffix}`
}

export function createDiscoveryRunRecord(input: {
  context?: DiscoveryRunContextInput
  screening: DiscoveryRunScreeningCounts
  candidateSourceUrls: string[]
  profileUpdatedAt?: string
  workspaceVersion?: string
  defaultMode?: DiscoveryRunMode
  completedAt: string
}): DiscoveryRunRecord {
  const context = input.context ?? {}
  const candidateSourceHosts = unique(input.candidateSourceUrls.flatMap((url) => {
    try { return [jobSourceHost(url)] } catch { return [] }
  })).slice(0, 32)
  const searchedSourceHosts = unique([
    ...(context.searchedSourceHosts ?? []).map(normalizeSourceHost).filter(Boolean),
    ...candidateSourceHosts,
  ]).slice(0, 32)
  const queries = unique((context.queries ?? []).map((value) => cleanText(value, 240)).filter(Boolean)).slice(0, 20)
  const startedAt = validIso(context.startedAt) && new Date(context.startedAt!).getTime() <= new Date(input.completedAt).getTime()
    ? context.startedAt!
    : input.completedAt
  const record: DiscoveryRunRecord = {
    version: 1,
    id: runId(input.completedAt, input.workspaceVersion),
    mode: context.mode ?? input.defaultMode ?? 'ad_hoc',
    startedAt,
    completedAt: input.completedAt,
    profileUpdatedAt: input.profileUpdatedAt,
    baselineWorkspaceVersion: input.workspaceVersion,
    queries,
    searchedSourceHosts,
    candidateSourceHosts,
    receivedCount: input.screening.received,
    reviewCandidateCount: input.screening.accepted,
    duplicateCount: input.screening.duplicateCount,
    filteredCount: input.screening.rejectedCount,
    deferredCount: input.screening.deferredCount,
  }
  const errors = validateDiscoveryRunRecord(record)
  if (errors.length) throw new Error(errors[0])
  return record
}

export function validateDiscoveryRunRecord(value: unknown): string[] {
  const errors: string[] = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['Discovery Run 必须是对象。']
  const run = value as DiscoveryRunRecord
  if (run.version !== 1) errors.push('Discovery Run version 必须为 1。')
  if (!run.id?.trim() || run.id.length > 160) errors.push('Discovery Run ID 无效。')
  if (!(['ad_hoc', 'full', 'incremental', 'refresh'] as DiscoveryRunMode[]).includes(run.mode)) errors.push('Discovery Run mode 无效。')
  if (!validIso(run.startedAt) || !validIso(run.completedAt)) errors.push('Discovery Run 时间字段无效。')
  else if (new Date(run.startedAt).getTime() > new Date(run.completedAt).getTime()) errors.push('Discovery Run startedAt 不能晚于 completedAt。')
  if (run.profileUpdatedAt !== undefined && !validIso(run.profileUpdatedAt)) errors.push('Discovery Run profileUpdatedAt 无效。')
  if (run.baselineWorkspaceVersion !== undefined && (!run.baselineWorkspaceVersion.trim() || run.baselineWorkspaceVersion.length > 160)) errors.push('Discovery Run workspace version 无效。')
  if (!Array.isArray(run.queries) || run.queries.length > 20 || run.queries.some((item) => typeof item !== 'string' || !item.trim() || item.length > 240)) errors.push('Discovery Run queries 无效。')
  for (const [label, values] of [['searchedSourceHosts', run.searchedSourceHosts], ['candidateSourceHosts', run.candidateSourceHosts]] as const) {
    if (!Array.isArray(values) || values.length > 32 || values.some((item) => typeof item !== 'string' || !item.trim() || item.length > 253 || normalizeSourceHost(item) !== item)) errors.push(`Discovery Run ${label} 无效。`)
  }
  for (const [label, count] of [
    ['receivedCount', run.receivedCount],
    ['reviewCandidateCount', run.reviewCandidateCount],
    ['duplicateCount', run.duplicateCount],
    ['filteredCount', run.filteredCount],
    ['deferredCount', run.deferredCount],
  ] as const) {
    if (!Number.isInteger(count) || count < 0 || count > 200) errors.push(`Discovery Run ${label} 无效。`)
  }
  if (run.reviewCandidateCount + run.duplicateCount + run.filteredCount + run.deferredCount > run.receivedCount) {
    errors.push('Discovery Run 结果计数超过 receivedCount。')
  }
  return errors
}

export function discoveryRunFromChangeSet(changeSet: ChangeSetRecord) {
  const run = changeSet.discoveryRun
  if (!run || validateDiscoveryRunRecord(run).length) return undefined
  return run
}

export interface StoredDiscoveryRun extends DiscoveryRunRecord {
  changeSetId: string
  changeSetStatus: ChangeSetRecord['status']
  recordedAt: string
  outcome: 'applied' | 'saved_to_inbox' | 'discarded' | 'pending' | 'failed'
  selectedCount: number
}

export function discoveryRunsFromChangeSets(
  changeSets: ChangeSetRecord[],
  inboxSourceChangeSetIds: ReadonlySet<string> = new Set(),
): StoredDiscoveryRun[] {
  return changeSets.flatMap((changeSet) => {
    const run = discoveryRunFromChangeSet(changeSet)
    if (!run) return []
    const operationCount = changeSet.operations.filter((operation) =>
      operation.kind === 'add_discovered_opportunity' || operation.kind === 'refresh_job_posting'
    ).length
    const outcome: StoredDiscoveryRun['outcome'] = changeSet.status === 'applied'
      ? 'applied'
      : changeSet.status === 'failed'
        ? 'failed'
        : changeSet.status === 'pending'
          ? 'pending'
          : inboxSourceChangeSetIds.has(changeSet.id)
            ? 'saved_to_inbox'
            : 'discarded'
    const selectedCount = outcome === 'applied' || outcome === 'saved_to_inbox' ? operationCount : 0
    return [{
      ...run,
      changeSetId: changeSet.id,
      changeSetStatus: changeSet.status,
      recordedAt: changeSet.updatedAt,
      outcome,
      selectedCount,
    }]
  }).sort((a, b) => b.completedAt.localeCompare(a.completedAt) || b.recordedAt.localeCompare(a.recordedAt))
}