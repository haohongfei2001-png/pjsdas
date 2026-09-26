import type {
  DecisionRequest,
  IngestionLedgerEntry,
  IngestionResolutionOutcome,
  IngestionResolutionReason,
  IngestionResolutionRecord,
  TimelineRecord,
} from './model.js'
import { validateSnapshot, type PJSDASSnapshot } from './snapshot.js'

function stableHash(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

export function ingestionResolutionKey(input: Pick<IngestionLedgerEntry, 'sourceKind' | 'sourceId' | 'sourceRecordId'>) {
  return `${input.sourceKind}|${input.sourceId}|${input.sourceRecordId}`
}

function resolutionKey(input: IngestionResolutionRecord) {
  return `${input.sourceKind}|${input.sourceId}|${input.sourceRecordId}`
}

function normalized(value: string | undefined) {
  return value?.trim().toLocaleLowerCase() ?? ''
}

function terminalProcess(process: PJSDASSnapshot['data']['processes'][number] | undefined) {
  return Boolean(process && (
    process.stage === 'closed'
    || process.result === 'rejected'
    || process.result === 'offer'
    || process.result === 'closed_other'
    || process.participationState === 'abandoned'
  ))
}

function explicitNonActionableReason(reason: string | undefined) {
  if (!reason) return false
  return /(?:marketing|newsletter|generic recruiting ad|non[- ]?recruiting|no actionable business fact|广告|营销|推广|非招聘|无可执行(?:招聘)?事实)/i.test(reason)
}

function laterOutcomeResolution(outcome: IngestionLedgerEntry['outcome']): {
  outcome: IngestionResolutionOutcome
  reason: IngestionResolutionReason
} | undefined {
  if (outcome === 'unresolved') return undefined
  if (outcome === 'duplicate') return { outcome: 'duplicate', reason: 'later_source_state' }
  if (outcome === 'ignored' || outcome === 'filtered') return { outcome: 'ignored', reason: 'later_source_state' }
  return { outcome: 'resolved', reason: 'later_source_state' }
}

function latestIngestionRecords(records: TimelineRecord[]) {
  const byKey = new Map<string, TimelineRecord[]>()
  for (const record of records) {
    if (!record.ingestion) continue
    const key = ingestionResolutionKey(record.ingestion)
    const bucket = byKey.get(key) ?? []
    bucket.push(record)
    byKey.set(key, bucket)
  }
  for (const bucket of byKey.values()) {
    bucket.sort((a, b) => (a.ingestion?.accountedAt ?? '').localeCompare(b.ingestion?.accountedAt ?? ''))
  }
  return byKey
}

function latestResolutionRecords(records: TimelineRecord[]) {
  const byKey = new Map<string, TimelineRecord>()
  for (const record of records) {
    if (!record.ingestionResolution) continue
    const key = resolutionKey(record.ingestionResolution)
    const prior = byKey.get(key)
    if (!prior || (prior.ingestionResolution?.reconciledAt ?? '') <= record.ingestionResolution.reconciledAt) {
      byKey.set(key, record)
    }
  }
  return byKey
}

function semanticReceiptResolution(
  snapshot: PJSDASSnapshot,
  ingestion: IngestionLedgerEntry,
): { outcome: IngestionResolutionOutcome; reason: IngestionResolutionReason; evidenceRefs: string[] } | undefined {
  const receipts = (snapshot.data.semanticReceipts ?? [])
    .filter((item) =>
      item.sourceKind === ingestion.sourceKind
      && item.sourceId === ingestion.sourceId
      && item.sourceRecordId === ingestion.sourceRecordId
      && item.updatedAt >= ingestion.accountedAt)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const receipt = receipts[0]
  if (!receipt) return undefined

  if (receipt.status === 'committed') {
    return {
      outcome: 'resolved',
      reason: 'semantic_receipt_committed',
      evidenceRefs: [receipt.id, ...receipt.affectedObjects.map((item) => item.id)],
    }
  }
  if (receipt.status === 'no_write') {
    return {
      outcome: 'ignored',
      reason: 'semantic_receipt_no_write',
      evidenceRefs: [receipt.id],
    }
  }
  if (receipt.status !== 'decision_required') return undefined

  const requests = receipt.decisionRequestIds
    .map((id) => (snapshot.data.decisionRequests ?? []).find((item) => item.id === id))
    .filter((item): item is DecisionRequest => Boolean(item))
  if (!requests.length || requests.some((item) => item.state === 'open' || item.state === 'expired')) {
    return {
      outcome: 'active_unresolved',
      reason: 'semantic_decision_open',
      evidenceRefs: [receipt.id, ...requests.map((item) => item.id)],
    }
  }
  if (requests.every((item) => item.state === 'superseded')) {
    return {
      outcome: 'superseded',
      reason: 'semantic_decision_settled',
      evidenceRefs: [receipt.id, ...requests.map((item) => item.id)],
    }
  }
  if (requests.every((item) => item.state === 'answered' || item.state === 'auto_resolved' || item.state === 'superseded')) {
    return {
      outcome: 'resolved',
      reason: 'semantic_decision_settled',
      evidenceRefs: [receipt.id, ...requests.map((item) => item.id)],
    }
  }
  return {
    outcome: 'active_unresolved',
    reason: 'semantic_decision_open',
    evidenceRefs: [receipt.id, ...requests.map((item) => item.id)],
  }
}

function matchingOpportunities(snapshot: PJSDASSnapshot, record: TimelineRecord) {
  const company = normalized(record.company)
  const role = normalized(record.role)
  if (!company) return []
  return snapshot.data.opportunities.filter((item) => {
    if (normalized(item.company) !== company) return false
    return !role || normalized(item.role) === role
  })
}

function classifyUnresolved(
  snapshot: PJSDASSnapshot,
  target: TimelineRecord,
  latest: TimelineRecord,
  sourceRecords: TimelineRecord[],
  allIngestion: TimelineRecord[],
  now: Date,
): { outcome: IngestionResolutionOutcome; reason: IngestionResolutionReason; evidenceRefs: string[] } {
  void now
  const ingestion = target.ingestion!
  const latestIngestion = latest.ingestion!

  if (latest.id !== target.id && latestIngestion.outcome !== 'unresolved') {
    const mapped = laterOutcomeResolution(latestIngestion.outcome)!
    return { ...mapped, evidenceRefs: [latest.id] }
  }

  const duplicate = allIngestion.find((record) =>
    record.id !== target.id
    && record.ingestion?.sourceKind === ingestion.sourceKind
    && record.ingestion.sourceId === ingestion.sourceId
    && record.ingestion.fingerprint === ingestion.fingerprint
    && record.ingestion.outcome !== 'unresolved'
    && record.ingestion.accountedAt >= ingestion.accountedAt)
  if (duplicate) {
    return { outcome: 'duplicate', reason: 'duplicate_fingerprint', evidenceRefs: [duplicate.id] }
  }

  if (explicitNonActionableReason(ingestion.reason)) {
    return { outcome: 'ignored', reason: 'explicit_non_actionable', evidenceRefs: [target.id] }
  }

  const semantic = semanticReceiptResolution(snapshot, ingestion)
  if (semantic) return semantic

  const action = ingestion.actionId
    ? snapshot.data.actions.find((item) => item.id === ingestion.actionId)
    : undefined
  if (action?.status === 'done') {
    return { outcome: 'resolved', reason: 'linked_action_settled', evidenceRefs: [action.id] }
  }
  if (action?.status === 'skipped') {
    return { outcome: 'superseded', reason: 'linked_action_settled', evidenceRefs: [action.id] }
  }
  if (action && (action.status === 'todo' || action.status === 'doing')) {
    return { outcome: 'active_unresolved', reason: 'live_process_ambiguity', evidenceRefs: [action.id] }
  }

  const event = ingestion.processEventId
    ? snapshot.data.processEvents.find((item) => item.id === ingestion.processEventId)
    : undefined
  if (event) {
    const eventAction = snapshot.data.actions.find((item) => item.processEventId === event.id)
    if (eventAction?.status === 'done') {
      return { outcome: 'resolved', reason: 'linked_action_settled', evidenceRefs: [event.id, eventAction.id] }
    }
    if (eventAction?.status === 'skipped') {
      return { outcome: 'superseded', reason: 'linked_action_settled', evidenceRefs: [event.id, eventAction.id] }
    }
    const process = snapshot.data.processes.find((item) => item.opportunityId === event.opportunityId)
    if (terminalProcess(process)) {
      return { outcome: 'historical_only', reason: 'linked_process_terminal', evidenceRefs: [event.id, process!.id] }
    }
    return { outcome: 'active_unresolved', reason: 'live_process_ambiguity', evidenceRefs: [event.id] }
  }

  if (ingestion.opportunityId) {
    const opportunity = snapshot.data.opportunities.find((item) => item.id === ingestion.opportunityId)
    const process = snapshot.data.processes.find((item) => item.opportunityId === ingestion.opportunityId)
    if (opportunity?.participationStatus === 'abandoned' || terminalProcess(process)) {
      return {
        outcome: 'historical_only',
        reason: 'linked_process_terminal',
        evidenceRefs: [opportunity?.id, process?.id].filter((value): value is string => Boolean(value)),
      }
    }
    if (opportunity) {
      return { outcome: 'active_unresolved', reason: 'live_process_ambiguity', evidenceRefs: [opportunity.id] }
    }
  }

  const matches = matchingOpportunities(snapshot, target)
  if (matches.length > 1) {
    // Company/role text cannot establish source identity across multiple processes,
    // even when all currently known candidates are terminal.
    return {
      outcome: 'active_unresolved',
      reason: 'unlinked_unresolved',
      evidenceRefs: matches.slice(0, 4).map((item) => item.id),
    }
  }
  if (matches.length) {
    const processByOpportunity = new Map(snapshot.data.processes.flatMap((item) =>
      item.opportunityId ? [[item.opportunityId, item] as const] : []))
    const live = matches.filter((item) =>
      item.participationStatus !== 'abandoned' && !terminalProcess(processByOpportunity.get(item.id)))
    if (live.length) {
      return {
        outcome: 'active_unresolved',
        reason: 'live_process_ambiguity',
        evidenceRefs: live.slice(0, 4).map((item) => item.id),
      }
    }
    return {
      outcome: 'historical_only',
      reason: 'matching_process_terminal',
      evidenceRefs: matches.slice(0, 4).map((item) => item.id),
    }
  }

  if (ingestion.issueKinds?.includes('transport_gap')) {
    return { outcome: 'active_unresolved', reason: 'transport_gap_active', evidenceRefs: [target.id] }
  }

  // Age alone is never sufficient to clear an unresolved record. Without a later
  // canonical fact, terminal process, explicit non-actionable classification, or
  // settled semantic decision, fail closed and keep it active.
  return { outcome: 'active_unresolved', reason: 'unlinked_unresolved', evidenceRefs: [target.id] }
}

function createResolutionTimeline(input: {
  target: TimelineRecord
  outcome: IngestionResolutionOutcome
  reason: IngestionResolutionReason
  evidenceRefs: string[]
  reconciledAt: string
  previousResolutionId?: string
}): TimelineRecord {
  const ingestion = input.target.ingestion!
  const resolution: IngestionResolutionRecord = {
    version: 1,
    sourceKind: ingestion.sourceKind,
    sourceId: ingestion.sourceId,
    sourceRecordId: ingestion.sourceRecordId,
    targetIngestionTimelineId: input.target.id,
    targetFingerprint: ingestion.fingerprint,
    outcome: input.outcome,
    reason: input.reason,
    evidenceRefs: [...new Set(input.evidenceRefs)].sort(),
    reconciledAt: input.reconciledAt,
  }
  const idPayload = [
    ingestionResolutionKey(ingestion),
    input.target.id,
    resolution.targetFingerprint,
    resolution.outcome,
    resolution.reason,
    ...resolution.evidenceRefs,
    input.previousResolutionId ?? '',
  ].join('|')
  return {
    id: `timeline:ingestion-resolution:${stableHash(idPayload)}`,
    kind: 'ingestion_resolution_recorded',
    category: 'data',
    source: 'system',
    occurredAt: ingestion.receivedAt,
    recordedAt: input.reconciledAt,
    title: `Ingestion resolution · ${resolution.outcome}`,
    detail: resolution.reason,
    sourceRef: ingestion.sourceRecordId,
    ingestionResolution: resolution,
  }
}

export interface IngestionDebtReconciliationResult {
  snapshot: PJSDASSnapshot
  changed: boolean
  appended: TimelineRecord[]
  evaluatedUnresolvedKeys: number
}

/**
 * Additively reconciles lifetime unresolved ingestion debt.
 * Original ingestion ledger rows are never edited or deleted.
 */
export function reconcileIngestionDebt(
  snapshot: PJSDASSnapshot,
  now = new Date(),
  options: { maxRecords?: number } = {},
): IngestionDebtReconciliationResult {
  if (Number.isNaN(now.getTime())) throw new Error('Ingestion debt reconciliation clock is invalid.')
  const maxRecords = Math.max(1, Math.min(options.maxRecords ?? 1000, 5000))
  const next = structuredClone(snapshot)
  const timeline = next.data.timeline ?? []
  const groups = latestIngestionRecords(timeline)
  const allIngestion = timeline.filter((item) => Boolean(item.ingestion))
  const latestResolutions = latestResolutionRecords(timeline)
  const appended: TimelineRecord[] = []
  const timestamp = now.toISOString()
  let evaluatedUnresolvedKeys = 0

  for (const [key, sourceRecords] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const unresolvedRecords = sourceRecords.filter((item) => item.ingestion?.outcome === 'unresolved')
    if (!unresolvedRecords.length) continue
    evaluatedUnresolvedKeys += 1
    if (evaluatedUnresolvedKeys > maxRecords) {
      throw new Error(`Ingestion debt reconciliation exceeds the bounded ${maxRecords}-record limit.`)
    }

    const target = unresolvedRecords[unresolvedRecords.length - 1]!
    const latest = sourceRecords[sourceRecords.length - 1]!
    const proposed = classifyUnresolved(next, target, latest, sourceRecords, allIngestion, now)
    const current = latestResolutions.get(key)
    const prior = current?.ingestionResolution
    const evidenceRefs = [...new Set(proposed.evidenceRefs)].sort()
    if (prior?.targetIngestionTimelineId === target.id
      && prior.targetFingerprint === target.ingestion?.fingerprint
      && prior.outcome === proposed.outcome
      && prior.reason === proposed.reason
      && JSON.stringify(prior.evidenceRefs) === JSON.stringify(evidenceRefs)) continue
    const record = createResolutionTimeline({
      target,
      outcome: proposed.outcome,
      reason: proposed.reason,
      evidenceRefs: proposed.evidenceRefs,
      // IndexedDB reads timeline rows in key order, so timestamp ties cannot
      // carry transition order across a durable round trip.
      reconciledAt: new Date(Math.max(now.getTime(), prior ? Date.parse(prior.reconciledAt) + 1 : now.getTime())).toISOString(),
      previousResolutionId: current?.id,
    })

    if (current?.id === record.id || timeline.some((item) => item.id === record.id)) continue
    appended.push(record)
  }

  if (!appended.length) return { snapshot, changed: false, appended, evaluatedUnresolvedKeys }

  next.data.timeline = [...timeline, ...appended]
  next.exportedAt = timestamp
  validateSnapshot(next)
  return { snapshot: next, changed: true, appended, evaluatedUnresolvedKeys }
}

export function latestIngestionResolutionBySourceRecord(timeline: TimelineRecord[] | undefined) {
  return latestResolutionRecords(timeline ?? [])
}
