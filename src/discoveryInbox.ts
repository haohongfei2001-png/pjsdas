import { assertChangeSetValid, type ChangeSetRecord } from './changeSet.js'
import type {
  DiscoveryInboxItem,
  DiscoveryRejectionReason,
  Opportunity,
  TimelineRecord,
} from './model.js'

type DiscoveryOperation = Extract<ChangeSetRecord['operations'][number], { kind: 'add_discovered_opportunity' }>

function compact(value: string) {
  return value.toLocaleLowerCase().replace(/[\s\u3000·•｜|（）()【】\[\]，,。.!！?？:：;；/\\_-]+/g, '')
}

export function discoveryInboxIdentity(company: string, role: string) {
  return `${compact(company)}|${compact(role)}`
}

function changeSetId(now: Date) {
  const stamp = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  const suffix = Math.random().toString(36).slice(2, 7).toUpperCase().padEnd(5, '0')
  return `CS-INBOX-${stamp}-${suffix}`
}

export function validateDiscoveryInboxItem(item: DiscoveryInboxItem): string[] {
  const errors: string[] = []
  const statuses = new Set(['new', 'seen', 'later', 'dismissed', 'promoted'])
  const roleTypes = new Set(['core', 'backup', 'reach', 'lottery', 'practice'])
  const confidences = new Set(['high', 'medium', 'low'])
  if (!item.id?.trim()) errors.push('发现箱条目缺少 ID。')
  if (!item.candidateOpportunityId?.trim()) errors.push('发现箱条目缺少候选岗位 ID。')
  if (!item.company?.trim() || !item.role?.trim()) errors.push('发现箱条目缺少公司或岗位。')
  if (!roleTypes.has(item.roleType)) errors.push('发现箱岗位类型无效。')
  if (!statuses.has(item.status)) errors.push('发现箱状态无效。')
  if (!item.sourceUrl?.startsWith('http://') && !item.sourceUrl?.startsWith('https://')) errors.push('发现箱来源 URL 无效。')
  if (!item.sourceTitle?.trim() || !item.rationale?.trim()) errors.push('发现箱来源证据不完整。')
  if (!Number.isFinite(item.opportunityValue) || item.opportunityValue < 0 || item.opportunityValue > 100) errors.push('发现箱机会价值无效。')
  if (!Number.isFinite(item.fitScore) || item.fitScore < 0 || item.fitScore > 100) errors.push('发现箱匹配度无效。')
  if (!confidences.has(item.fitConfidence) || !confidences.has(item.opportunityValueConfidence)) errors.push('发现箱置信度无效。')
  for (const [label, value] of [['discoveredAt', item.discoveredAt], ['createdAt', item.createdAt], ['updatedAt', item.updatedAt]] as const) {
    if (Number.isNaN(new Date(value).getTime())) errors.push(`发现箱 ${label} 无效。`)
  }
  if (item.deadline && Number.isNaN(new Date(item.deadline).getTime())) errors.push('发现箱截止时间无效。')
  if (item.seenAt && Number.isNaN(new Date(item.seenAt).getTime())) errors.push('发现箱 seenAt 无效。')
  return errors
}

function fromOperation(operation: DiscoveryOperation, changeSet: ChangeSetRecord, now: Date): DiscoveryInboxItem {
  const opportunity = operation.opportunity
  const evidence = opportunity.detail?.discovery
  if (!evidence) throw new Error(`发现岗位 ${opportunity.company}｜${opportunity.role} 缺少来源证据。`)
  const timestamp = now.toISOString()
  const item: DiscoveryInboxItem = {
    id: `inbox:${opportunity.id}`,
    candidateOpportunityId: opportunity.id,
    company: opportunity.company,
    role: opportunity.role,
    roleType: opportunity.roleType,
    sourceUrl: evidence.sourceUrl,
    sourceTitle: evidence.sourceTitle,
    location: evidence.location,
    deadline: opportunity.deadline,
    compensationText: evidence.compensationText,
    rationale: evidence.rationale,
    opportunityValue: opportunity.opportunityValue,
    fitScore: opportunity.fitScore,
    fitConfidence: evidence.fitConfidence,
    opportunityValueConfidence: evidence.opportunityValueConfidence,
    profileWarnings: evidence.profileWarnings ? [...evidence.profileWarnings] : undefined,
    status: 'new',
    sourceChangeSetId: changeSet.id,
    sourceOperationId: operation.id,
    discoveredAt: evidence.discoveredAt,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  const errors = validateDiscoveryInboxItem(item)
  if (errors.length) throw new Error(errors[0])
  return item
}

export function discoveryInboxItemsFromChangeSet(changeSet: ChangeSetRecord, now = new Date()) {
  const operations = changeSet.operations.filter(
    (operation): operation is DiscoveryOperation => operation.kind === 'add_discovered_opportunity',
  )
  if (!operations.length || operations.length !== changeSet.operations.length) {
    throw new Error('只有独立岗位发现 ChangeSet 可以保存到发现箱。')
  }
  return operations.map((operation) => fromOperation(operation, changeSet, now))
}

export function mergeDiscoveryInboxItems(existing: DiscoveryInboxItem[], incoming: DiscoveryInboxItem[]) {
  const byIdentity = new Map(existing.map((item) => [discoveryInboxIdentity(item.company, item.role), item]))
  const result = [...existing]
  for (const candidate of incoming) {
    const key = discoveryInboxIdentity(candidate.company, candidate.role)
    const previous = byIdentity.get(key)
    if (!previous) {
      result.push(candidate)
      byIdentity.set(key, candidate)
      continue
    }
    const merged: DiscoveryInboxItem = {
      ...candidate,
      id: previous.id,
      candidateOpportunityId: previous.candidateOpportunityId || candidate.candidateOpportunityId,
      status: previous.status,
      rejectionReason: previous.rejectionReason,
      createdAt: previous.createdAt,
      seenAt: previous.seenAt,
      promotedOpportunityId: previous.promotedOpportunityId,
      updatedAt: candidate.updatedAt,
    }
    const index = result.findIndex((item) => item.id === previous.id)
    result[index] = merged
    byIdentity.set(key, merged)
  }
  return result
}

export function inboxOpportunity(item: DiscoveryInboxItem, now = new Date()): Opportunity {
  return {
    id: item.candidateOpportunityId,
    company: item.company,
    role: item.role,
    currentStageLabel: '待投',
    processStage: 'not_applied',
    roleType: item.roleType,
    early: false,
    deadline: item.deadline,
    sourcePriority: 'AI 岗位发现 · 发现箱',
    salaryReference: item.compensationText,
    nextActionLabel: '审阅并投递',
    prepEstimateMinutes: 45,
    opportunityValue: item.opportunityValue,
    fitScore: item.fitScore,
    locallyManaged: true,
    importedAt: now.toISOString(),
    detail: {
      salaryRaw: item.compensationText,
      discovery: {
        sourceUrl: item.sourceUrl,
        sourceTitle: item.sourceTitle,
        location: item.location,
        compensationText: item.compensationText,
        rationale: item.rationale,
        discoveredAt: item.discoveredAt,
        fitConfidence: item.fitConfidence,
        opportunityValueConfidence: item.opportunityValueConfidence,
        profileWarnings: item.profileWarnings ? [...item.profileWarnings] : undefined,
      },
    },
  }
}

export function createInboxPromotionChangeSet(item: DiscoveryInboxItem, now = new Date()): ChangeSetRecord {
  const opportunity = inboxOpportunity(item, now)
  const timestamp = now.toISOString()
  const changeSet: ChangeSetRecord = {
    id: changeSetId(now),
    version: 1,
    source: 'user_action',
    status: 'pending',
    title: `发现箱加入机会池｜${item.company}｜${item.role}`,
    createdAt: timestamp,
    updatedAt: timestamp,
    operations: [{
      id: `discovery:add:${opportunity.id}`,
      kind: 'add_discovered_opportunity',
      summary: `新增发现岗位｜${opportunity.company}｜${opportunity.role}`,
      opportunity,
    }],
  }
  assertChangeSetValid(changeSet)
  return changeSet
}

export function discoveryInboxDecisionTimeline(
  item: DiscoveryInboxItem,
  decision: 'accepted' | 'rejected',
  now = new Date(),
  reason?: DiscoveryRejectionReason,
): TimelineRecord {
  const timestamp = now.toISOString()
  return {
    id: `timeline:discovery-inbox:${item.id}:${decision}:${now.getTime()}`,
    kind: decision === 'accepted' ? 'discovery_accepted' : 'discovery_rejected',
    category: 'opportunity',
    source: 'user_action',
    occurredAt: timestamp,
    recordedAt: timestamp,
    title: decision === 'accepted' ? '从发现箱加入机会池' : '发现箱标记不感兴趣',
    detail: decision === 'accepted' ? item.rationale : reason,
    opportunityId: decision === 'accepted' ? item.candidateOpportunityId : undefined,
    company: item.company,
    role: item.role,
    sourceRef: item.sourceUrl,
    discoveryDecision: decision,
    discoveryReasonCode: decision === 'rejected' ? reason : undefined,
  }
}
