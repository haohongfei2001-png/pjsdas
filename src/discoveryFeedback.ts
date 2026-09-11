import { assertChangeSetValid, type ChangeSetRecord } from './changeSet.js'
import type { McpDiscoveryReview } from './ai/mcpProposal.js'
import type {
  DiscoveryRejectionReason,
  DiscoveryReviewDecision,
  TimelineRecord,
} from './model.js'

type DiscoveryOperation = Extract<ChangeSetRecord['operations'][number], { kind: 'add_discovered_opportunity' }>

export const DISCOVERY_REJECTION_REASON_OPTIONS: Array<{
  value: DiscoveryRejectionReason
  zh: string
  en: string
}> = [
  { value: 'location', zh: '地点不合适', en: 'Location' },
  { value: 'compensation', zh: '薪资不合适', en: 'Compensation' },
  { value: 'role_direction', zh: '岗位方向不合适', en: 'Role direction' },
  { value: 'company_value', zh: '公司 / 机会价值不足', en: 'Company / opportunity value' },
  { value: 'requirements', zh: '要求不匹配', en: 'Requirements mismatch' },
  { value: 'already_have_better', zh: '已有更好的相似岗位', en: 'Better similar option exists' },
  { value: 'not_interested', zh: '暂时不感兴趣', en: 'Not interested' },
  { value: 'other', zh: '其他', en: 'Other' },
]

export interface DiscoveryRejectionSelection {
  code: DiscoveryRejectionReason
  note?: string
}

function compactIdentity(value: string) {
  return value.toLocaleLowerCase().replace(/[\s\u3000·•｜|（）()【】\[\]，,。.!！?？:：;；/\\_-]+/g, '')
}

function identity(company: string, role: string) {
  return `${compactIdentity(company)}|${compactIdentity(role)}`
}

function stableHash(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function reasonLabel(code: DiscoveryRejectionReason) {
  return DISCOVERY_REJECTION_REASON_OPTIONS.find((item) => item.value === code)?.zh ?? code
}

function feedbackId(changeSetId: string, decision: DiscoveryReviewDecision, company: string, role: string) {
  return `timeline:discovery-feedback:${changeSetId}:${decision}:${stableHash(identity(company, role))}`
}

function feedbackRecord(input: {
  changeSetId: string
  decision: DiscoveryReviewDecision
  company: string
  role: string
  occurredAt: string
  title: string
  detail?: string
  sourceRef?: string
  opportunityId?: string
  reasonCode?: DiscoveryRejectionReason
  qualityScore?: number
  source: 'user_action' | 'changeset'
}): TimelineRecord {
  return {
    id: feedbackId(input.changeSetId, input.decision, input.company, input.role),
    kind: input.decision === 'accepted'
      ? 'discovery_accepted'
      : input.decision === 'rejected'
        ? 'discovery_rejected'
        : input.decision === 'filtered'
          ? 'discovery_filtered'
          : input.decision === 'duplicate'
            ? 'discovery_duplicate'
            : 'discovery_deferred',
    category: 'opportunity',
    source: input.source,
    occurredAt: input.occurredAt,
    recordedAt: input.occurredAt,
    title: input.title,
    detail: input.detail,
    company: input.company,
    role: input.role,
    opportunityId: input.opportunityId,
    changeSetId: input.changeSetId,
    sourceRef: input.sourceRef,
    discoveryDecision: input.decision,
    discoveryReasonCode: input.reasonCode,
    discoveryQualityScore: input.qualityScore,
  }
}

export function deriveDiscoveryReviewChangeSet(
  changeSet: ChangeSetRecord,
  selectedOperationIds: ReadonlySet<string>,
) {
  const discovery = changeSet.operations.filter(
    (operation): operation is DiscoveryOperation => operation.kind === 'add_discovered_opportunity',
  )
  if (!discovery.length || discovery.length !== changeSet.operations.length) {
    throw new Error('只有独立的岗位发现 ChangeSet 支持逐岗位选择。')
  }

  const known = new Set(discovery.map((operation) => operation.id))
  for (const id of selectedOperationIds) {
    if (!known.has(id)) throw new Error(`岗位发现审阅包含未知 operation：${id}。`)
  }
  const selected = discovery.filter((operation) => selectedOperationIds.has(operation.id))
  if (!selected.length) throw new Error('至少选择一个岗位后才能应用；如整批都不要，请选择“放弃整批”。')

  const reviewed: ChangeSetRecord = {
    ...changeSet,
    title: `${changeSet.title} · 已选 ${selected.length}/${discovery.length}`,
    operations: selected,
  }
  assertChangeSetValid(reviewed)
  return reviewed
}

export function createDiscoveryFeedbackRecords(
  changeSet: ChangeSetRecord,
  selectedOperationIds: ReadonlySet<string>,
  rejectionSelections: Record<string, DiscoveryRejectionSelection> = {},
  screening?: McpDiscoveryReview,
  now = new Date(),
) {
  const occurredAt = now.toISOString()
  const records: TimelineRecord[] = []
  const discovery = changeSet.operations.filter(
    (operation): operation is DiscoveryOperation => operation.kind === 'add_discovered_opportunity',
  )

  for (const operation of discovery) {
    const item = operation.opportunity
    const evidence = item.detail?.discovery
    if (selectedOperationIds.has(operation.id)) {
      records.push(feedbackRecord({
        changeSetId: changeSet.id,
        decision: 'accepted',
        company: item.company,
        role: item.role,
        occurredAt,
        title: '接受 AI 发现岗位',
        detail: evidence?.rationale,
        sourceRef: evidence?.sourceUrl,
        opportunityId: item.id,
        source: 'user_action',
      }))
      continue
    }

    const selection = rejectionSelections[operation.id] ?? { code: 'not_interested' as const }
    const note = selection.note?.trim()
    records.push(feedbackRecord({
      changeSetId: changeSet.id,
      decision: 'rejected',
      company: item.company,
      role: item.role,
      occurredAt,
      title: '拒绝 AI 发现岗位',
      detail: note ? `${reasonLabel(selection.code)}：${note}` : reasonLabel(selection.code),
      sourceRef: evidence?.sourceUrl,
      reasonCode: selection.code,
      source: 'user_action',
    }))
  }

  for (const item of screening?.skippedDuplicates ?? []) {
    records.push(feedbackRecord({
      changeSetId: changeSet.id,
      decision: 'duplicate',
      company: item.company,
      role: item.role,
      occurredAt,
      title: '岗位发现去重',
      detail: item.reason,
      source: 'changeset',
    }))
  }
  for (const item of screening?.rejectedCandidates ?? []) {
    records.push(feedbackRecord({
      changeSetId: changeSet.id,
      decision: 'filtered',
      company: item.company,
      role: item.role,
      occurredAt,
      title: '岗位发现质量闸门过滤',
      detail: item.reasons?.join('；') ?? '质量闸门过滤。',
      source: 'changeset',
    }))
  }
  for (const item of screening?.deferredCandidates ?? []) {
    records.push(feedbackRecord({
      changeSetId: changeSet.id,
      decision: 'deferred',
      company: item.company,
      role: item.role,
      occurredAt,
      title: '岗位发现暂缓审阅',
      detail: item.reason,
      qualityScore: item.qualityScore,
      source: 'changeset',
    }))
  }

  return records
}

function feedbackRecords(timeline: TimelineRecord[]) {
  return timeline.filter((item): item is TimelineRecord & {
    company: string
    role: string
    discoveryDecision: DiscoveryReviewDecision
  } => Boolean(item.company && item.role && item.discoveryDecision))
}

export function discoveryFeedbackSummary(timeline: TimelineRecord[]) {
  const latest = new Map<string, ReturnType<typeof feedbackRecords>[number]>()
  const sorted = feedbackRecords(timeline)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.recordedAt.localeCompare(a.recordedAt))
  for (const item of sorted) {
    const key = identity(item.company, item.role)
    if (!latest.has(key)) latest.set(key, item)
  }
  const summary = { accepted: 0, rejected: 0, filtered: 0, duplicate: 0, deferred: 0 }
  for (const item of latest.values()) summary[item.discoveryDecision] += 1
  return summary
}

export function recentRejectedDiscoveryFeedback(
  timeline: TimelineRecord[],
  now = new Date(),
  windowDays = 120,
) {
  const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000
  const latestUserDecision = new Map<string, ReturnType<typeof feedbackRecords>[number]>()
  const sorted = feedbackRecords(timeline)
    .filter((item) => item.discoveryDecision === 'accepted' || item.discoveryDecision === 'rejected')
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.recordedAt.localeCompare(a.recordedAt))

  for (const item of sorted) {
    const key = identity(item.company, item.role)
    if (!latestUserDecision.has(key)) latestUserDecision.set(key, item)
  }

  return [...latestUserDecision.values()]
    .filter((item) => item.discoveryDecision === 'rejected' && new Date(item.occurredAt).getTime() >= cutoff)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
}
