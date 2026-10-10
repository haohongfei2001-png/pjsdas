import { verifiedDiscoveryObservationSchema } from './verifiedDiscoveryCommand.js'
import type { MonitorJobObservation } from './autonomousIngestion.js'
import type { ChangeSetOperation } from './changeSet.js'
import {
  canonicalizeVerifiedJobSourceUrl,
  isOlderVerifiedPosting,
  normalizeJobLocation,
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
  const canonical = canonicalizeVerifiedJobSourceUrl(operation.expectedCanonicalSourceUrl)
  if (operation.ownerKind === 'opportunity') {
    const owner = opportunities.find((item) => item.id === operation.ownerId)
    if (!owner) return undefined
    const matches = jobPostingsForOpportunity(owner).filter((item) =>
      item.id === operation.expectedPostingId && (item.canonicalSourceUrl === operation.expectedCanonicalSourceUrl || canonicalizeVerifiedJobSourceUrl(item.sourceUrl) === canonical)
    )
    const posting = matches.length === 1 ? matches[0] : undefined
    return posting ? { ownerKind: 'opportunity', ownerId: owner.id, company: owner.company, role: owner.role, posting } : undefined
  }
  const owner = inbox.find((item) => item.id === operation.ownerId)
  if (!owner) return undefined
  const matches = postingsForInbox(owner).filter((item) =>
    item.id === operation.expectedPostingId && (item.canonicalSourceUrl === operation.expectedCanonicalSourceUrl || canonicalizeVerifiedJobSourceUrl(item.sourceUrl) === canonical)
  )
  const posting = matches.length === 1 ? matches[0] : undefined
  return posting ? { ownerKind: 'inbox', ownerId: owner.id, company: owner.company, role: owner.role, posting } : undefined
}

export function bindVerifiedPostingRefresh(operation: PostingRefreshOperation, observation: MonitorJobObservation): PostingRefreshOperation {
  const verified = verifiedDiscoveryObservationSchema.parse(observation)
  if (verified.sourceVerification !== 'verified' || !verified.sourceProof) throw new Error('DISCOVERY_VERIFICATION_REQUIRED: a source refresh requires independent fact proof.')
  return { ...operation, summary: `复核招聘来源｜${verified.sourceTitle}｜${verified.postingStatus ?? 'unknown'}`, sourceUrl: verified.sourceUrl, sourceTitle: verified.sourceTitle, postingStatus: verified.postingStatus ?? 'unknown',
    observedAt: verified.sourceVerifiedAt!, location: verified.location, deadline: verified.deadline, compensationText: undefined,
    verifiedObservation: verified }
}

function refreshedEvidence(company: string, role: string, previous: JobPostingEvidence, operation: PostingRefreshOperation) {
  const canonicalIncoming = canonicalizeVerifiedJobSourceUrl(operation.sourceUrl)
  if (canonicalIncoming !== canonicalizeVerifiedJobSourceUrl(previous.sourceUrl)) {
    throw new Error('刷新来源与已绑定 posting 不一致；新来源应走重新发布/替代来源审阅，而不是覆盖旧 posting。')
  }
  if (!operation.verifiedObservation) throw new Error('DISCOVERY_VERIFICATION_REQUIRED: refresh this source before applying its facts.')
  const verified = verifiedDiscoveryObservationSchema.parse(operation.verifiedObservation)
  const identityText = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase()
  if (verified.sourceVerification !== 'verified' || !verified.sourceProof || identityText(verified.company) !== identityText(company) || identityText(verified.role) !== identityText(role)
    || canonicalizeVerifiedJobSourceUrl(verified.sourceUrl) !== canonicalIncoming
    || previous.sourceProof && previous.sourceProof.postingIdentity !== verified.sourceProof.postingIdentity
    || previous.location && verified.location && normalizeJobLocation(previous.location) !== normalizeJobLocation(verified.location)
    || previous.publishedAt && verified.publishedAt && previous.publishedAt !== verified.publishedAt
    || previous.recruitmentBatch && verified.recruitmentBatch && previous.recruitmentBatch !== verified.recruitmentBatch) {
    throw new Error('Verified source facts do not belong to this exact recruiting posting.')
  }
  // The exact target/source binding above owns identity, including a legacy
  // historical source receiving its first independent proof.
  return { ...createJobPostingEvidence({ ...verified, observedAt: verified.sourceVerifiedAt! }), id: previous.id }
}

function mergeExplicitRefreshTarget(current: JobPostingEvidence, history: JobPostingEvidence[], previous: JobPostingEvidence, incoming: JobPostingEvidence, now: Date) {
  if (previous === current) return mergeJobPostingEvidence(current, history, incoming, now)
  const index = history.findIndex(posting => posting.id === previous.id && posting.sourceUrl === previous.sourceUrl)
  if (index < 0) throw new Error('The explicitly selected historical posting is no longer present.')
  // A newly established native identity can also match the active alias. The
  // explicit historical target still owns this refresh; never reselect current.
  const refreshed = mergeJobPostingEvidence(previous, [], incoming, now).current
  return { current, history: history.map((posting, position) => position === index ? refreshed : posting) }
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
  const matches = [current, ...history].filter((item) =>
    item.id === operation.expectedPostingId &&
    (item.canonicalSourceUrl === operation.expectedCanonicalSourceUrl || canonicalizeVerifiedJobSourceUrl(item.sourceUrl) === canonicalizeVerifiedJobSourceUrl(operation.expectedCanonicalSourceUrl))
  )
  const previous = matches.length === 1 ? matches[0] : undefined
  if (!previous) throw new Error(`岗位 ${opportunity.id} 的 posting 已变化，请重新读取 Refresh Queue。`)
  const incoming = refreshedEvidence(opportunity.company, opportunity.role, previous, operation)
  if (isOlderVerifiedPosting(previous, incoming)) throw new Error('SOURCE_EVIDENCE_STALE: a newer verification is already saved.')
  const merged = mergeExplicitRefreshTarget(current, history, previous, incoming, now)
  const active = merged.current
  return {
    ...opportunity,
    deadline: active.deadline ?? opportunity.deadline,
    deadlinePrecision: active.deadline ? active.deadlinePrecision : opportunity.deadlinePrecision,
    detail: {
      ...opportunity.detail,
      discovery: {
        ...discovery,
        sourceUrl: active.sourceUrl,
        sourceTitle: active.sourceTitle,
        location: active.location ?? discovery.location,
        compensationText: active.compensationText ?? discovery.compensationText,
        sourceProof: active.sourceProof, sourceVerification: active.sourceProof ? 'verified' : discovery.sourceVerification,
        sourceVerifiedAt: active.sourceProof?.verifiedAt ?? discovery.sourceVerifiedAt,
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
  const matches = [current, ...history].filter((posting) =>
    posting.id === operation.expectedPostingId &&
    (posting.canonicalSourceUrl === operation.expectedCanonicalSourceUrl || canonicalizeVerifiedJobSourceUrl(posting.sourceUrl) === canonicalizeVerifiedJobSourceUrl(operation.expectedCanonicalSourceUrl))
  )
  const previous = matches.length === 1 ? matches[0] : undefined
  if (!previous) throw new Error(`发现箱条目 ${item.id} 的 posting 已变化，请重新读取 Refresh Queue。`)
  const incoming = refreshedEvidence(item.company, item.role, previous, operation)
  if (isOlderVerifiedPosting(previous, incoming)) throw new Error('SOURCE_EVIDENCE_STALE: a newer verification is already saved.')
  const merged = mergeExplicitRefreshTarget(current, history, previous, incoming, now)
  const active = merged.current
  return {
    ...item,
    sourceUrl: active.sourceUrl,
    sourceTitle: active.sourceTitle,
    location: active.location ?? item.location,
    deadline: active.deadline ?? item.deadline,
    compensationText: item.compensationText,
    posting: active,
    postingHistory: merged.history.length ? merged.history : undefined,
    updatedAt: operation.observedAt,
  } satisfies DiscoveryInboxItem
}

export function postingRefreshTimeline(
  operation: PostingRefreshOperation,
  target: PostingRefreshTarget,
  changeSetId: string,
  now = new Date(),
): TimelineRecord {
  return {
    id: `timeline:posting-refresh:${changeSetId}:${operation.id}`,
    kind: 'opportunity_updated',
    category: 'opportunity',
    source: 'changeset',
    occurredAt: operation.observedAt,
    recordedAt: now.toISOString(),
    title: '复核公开招聘来源',
    detail: `${operation.sourceTitle} · 状态 ${operation.postingStatus}${operation.deadline ? ` · 截止 ${operation.deadline}` : ''}`,
    opportunityId: target.ownerKind === 'opportunity' ? target.ownerId : undefined,
    changeSetId,
    company: target.company,
    role: target.role,
    sourceRef: operation.sourceUrl,
  }
}
