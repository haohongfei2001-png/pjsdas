import type { ChangeSetOperation } from './changeSet.js'
import {
  canonicalizeJobSourceUrl,
  createJobPostingEvidence,
  jobPostingForInboxItem,
  jobPostingsForOpportunity,
  mergeJobPostingEvidence,
} from './jobPosting.js'
import type { DiscoveryInboxItem, JobPostingEvidence, Opportunity, TimelineRecord } from './model.js'

export type PostingRefreshOperation = Extract<ChangeSetOperation, { kind: 'refresh_job_posting' }>

export interface PostingRefreshTarget {
  ownerKind: 'opportunity' | 'inbox'
  ownerId: string
  company: string
  role: string
  posting: JobPostingEvidence
}

function postingsForInbox(item: DiscoveryInboxItem) {
  return [jobPostingForInboxItem(item), ...(item.postingHistory ?? [])]
}

export function resolvePostingRefreshTarget(
  operation: Pick<PostingRefreshOperation, 'ownerKind' | 'ownerId' | 'expectedPostingId' | 'expectedCanonicalSourceUrl'>,
  opportunities: Opportunity[],
  inbox: DiscoveryInboxItem[],
): PostingRefreshTarget | undefined {
  const canonical = canonicalizeJobSourceUrl(operation.expectedCanonicalSourceUrl)
  if (operation.ownerKind === 'opportunity') {
    const owner = opportunities.find((item) => item.id === operation.ownerId)
    if (!owner) return undefined
    const posting = jobPostingsForOpportunity(owner).find((item) =>
      item.id === operation.expectedPostingId && item.canonicalSourceUrl === canonical
    )
    return posting ? { ownerKind: 'opportunity', ownerId: owner.id, company: owner.company, role: owner.role, posting } : undefined
  }
  const owner = inbox.find((item) => item.id === operation.ownerId)
  if (!owner) return undefined
  const posting = postingsForInbox(owner).find((item) =>
    item.id === operation.expectedPostingId && item.canonicalSourceUrl === canonical
  )
  return posting ? { ownerKind: 'inbox', ownerId: owner.id, company: owner.company, role: owner.role, posting } : undefined
}

function refreshedEvidence(
  company: string,
  role: string,
  previous: JobPostingEvidence,
  operation: PostingRefreshOperation,
) {
  const canonicalIncoming = canonicalizeJobSourceUrl(operation.sourceUrl)
  if (canonicalIncoming !== previous.canonicalSourceUrl) {
    throw new Error('刷新来源与已绑定 posting 不一致；新来源应走重新发布/替代来源审阅，而不是覆盖旧 posting。')
  }
  return createJobPostingEvidence({
    company,
    role,
    sourceUrl: operation.sourceUrl,
    sourceTitle: operation.sourceTitle,
    location: operation.location ?? previous.location,
    deadline: operation.deadline ?? previous.deadline,
    compensationText: operation.compensationText ?? previous.compensationText,
    postingStatus: operation.postingStatus,
    observedAt: operation.observedAt,
  })
}

export function applyPostingRefreshToOpportunity(
  opportunity: Opportunity,
  operation: PostingRefreshOperation,
  now = new Date(operation.observedAt),
) {
  const discovery = opportunity.detail?.discovery
  if (!discovery) throw new Error(`岗位 ${opportunity.id} 没有可刷新的公开来源。`)
  const current = jobPostingsForOpportunity(opportunity)[0]
  if (!current) throw new Error(`岗位 ${opportunity.id} 没有可刷新的 posting。`)
  const history = jobPostingsForOpportunity(opportunity).slice(1)
  const previous = [current, ...history].find((item) =>
    item.id === operation.expectedPostingId &&
    item.canonicalSourceUrl === canonicalizeJobSourceUrl(operation.expectedCanonicalSourceUrl)
  )
  if (!previous) throw new Error(`岗位 ${opportunity.id} 的 posting 已变化，请重新读取 Refresh Queue。`)
  const incoming = refreshedEvidence(opportunity.company, opportunity.role, previous, operation)
  const merged = mergeJobPostingEvidence(current, history, incoming, now)
  const active = merged.current
  return {
    ...opportunity,
    deadline: operation.deadline ?? opportunity.deadline,
    salaryReference: operation.compensationText ?? opportunity.salaryReference,
    detail: {
      ...opportunity.detail,
      salaryRaw: operation.compensationText ?? opportunity.detail?.salaryRaw,
      discovery: {
        ...discovery,
        sourceUrl: active.sourceUrl,
        sourceTitle: active.sourceTitle,
        location: active.location ?? discovery.location,
        compensationText: active.compensationText ?? discovery.compensationText,
        posting: active,
        postingHistory: merged.history.length ? merged.history : undefined,
      },
    },
  } satisfies Opportunity
}

export function applyPostingRefreshToInbox(
  item: DiscoveryInboxItem,
  operation: PostingRefreshOperation,
  now = new Date(operation.observedAt),
) {
  const current = jobPostingForInboxItem(item)
  const history = item.postingHistory ?? []
  const previous = [current, ...history].find((posting) =>
    posting.id === operation.expectedPostingId &&
    posting.canonicalSourceUrl === canonicalizeJobSourceUrl(operation.expectedCanonicalSourceUrl)
  )
  if (!previous) throw new Error(`发现箱条目 ${item.id} 的 posting 已变化，请重新读取 Refresh Queue。`)
  const incoming = refreshedEvidence(item.company, item.role, previous, operation)
  const merged = mergeJobPostingEvidence(current, history, incoming, now)
  const active = merged.current
  return {
    ...item,
    sourceUrl: active.sourceUrl,
    sourceTitle: active.sourceTitle,
    location: active.location ?? item.location,
    deadline: operation.deadline ?? item.deadline,
    compensationText: operation.compensationText ?? item.compensationText,
    posting: active,
    postingHistory: merged.history.length ? merged.history : undefined,
    updatedAt: operation.observedAt,
  } satisfies DiscoveryInboxItem
}

export function postingRefreshTimeline(
  operation: PostingRefreshOperation,
  target: PostingRefreshTarget,
  changeSetId: string,
): TimelineRecord {
  return {
    id: `timeline:posting-refresh:${changeSetId}:${operation.id}`,
    kind: 'opportunity_updated',
    category: 'opportunity',
    source: 'changeset',
    occurredAt: operation.observedAt,
    recordedAt: new Date().toISOString(),
    title: '复核公开招聘来源',
    detail: `${operation.sourceTitle} · 状态 ${operation.postingStatus}${operation.deadline ? ` · 截止 ${operation.deadline}` : ''}`,
    opportunityId: target.ownerKind === 'opportunity' ? target.ownerId : undefined,
    changeSetId,
    company: target.company,
    role: target.role,
    sourceRef: operation.sourceUrl,
  }
}
