import type {
  DiscoveryInboxItem,
  DiscoveryInboxStatus,
  JobPostingEvidence,
  JobPostingFreshness,
  JobPostingStatus,
  Opportunity,
} from './model.js'

const DAY_MS = 24 * 60 * 60 * 1000
const FRESH_DAYS = 7
const STALE_DAYS = 21
const MAX_POSTING_HISTORY = 8

const TRACKING_KEYS = new Set([
  'ref',
  'referrer',
  'source',
  'src',
  'campaign',
  'campaignid',
  'tracking',
  'trackingid',
  'from',
  'spm',
  'fbclid',
  'gclid',
])

function stableHash(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

export function compactJobIdentityText(value: string) {
  return value.toLocaleLowerCase().replace(/[\s\u3000·•｜|（）()【】\[\]，,。.!！?？:：;；/\\_-]+/g, '')
}

export function normalizeJobCompany(value: string) {
  return compactJobIdentityText(value).replace(/(股份有限公司|有限责任公司|有限公司|集团公司|公司|ltd|inc)$/gi, '')
}

export function normalizeJobRole(value: string) {
  return compactJobIdentityText(value)
    .replace(/20\d{2}届/g, '')
    .replace(/20\d{2}(秋招|春招|校招)/g, '')
    .replace(/(校园招聘|校招|秋招|春招|应届生|应届|全职|职位|岗位|方向)$/g, '')
}

export function normalizeJobLocation(value: string | undefined) {
  return value ? compactJobIdentityText(value) : ''
}

function bigrams(value: string) {
  const chars = Array.from(value)
  if (chars.length < 2) return new Set(chars)
  const result = new Set<string>()
  for (let index = 0; index < chars.length - 1; index += 1) result.add(`${chars[index]}${chars[index + 1]}`)
  return result
}

export function jobRoleSimilarity(a: string, b: string) {
  const left = normalizeJobRole(a)
  const right = normalizeJobRole(b)
  if (!left || !right) return 0
  if (left === right) return 1
  const shorter = left.length <= right.length ? left : right
  const longer = left.length > right.length ? left : right
  if (shorter.length >= 4 && longer.includes(shorter)) return 0.9

  const leftPairs = bigrams(left)
  const rightPairs = bigrams(right)
  let overlap = 0
  for (const pair of leftPairs) if (rightPairs.has(pair)) overlap += 1
  const denominator = leftPairs.size + rightPairs.size
  return denominator ? (2 * overlap) / denominator : 0
}

export function jobIdentityKey(company: string, role: string, location?: string) {
  const locationKey = normalizeJobLocation(location)
  return [normalizeJobCompany(company), normalizeJobRole(role), locationKey].filter(Boolean).join('|')
}

export function logicalJobMatches(
  a: { company: string; role: string; location?: string },
  b: { company: string; role: string; location?: string },
) {
  if (normalizeJobCompany(a.company) !== normalizeJobCompany(b.company)) return false
  if (jobRoleSimilarity(a.role, b.role) < 0.72) return false
  const leftLocation = normalizeJobLocation(a.location)
  const rightLocation = normalizeJobLocation(b.location)
  if (!leftLocation || !rightLocation) return true
  return leftLocation === rightLocation || leftLocation.includes(rightLocation) || rightLocation.includes(leftLocation)
}

function isTrackingParam(key: string) {
  const normalized = key.toLocaleLowerCase()
  return normalized.startsWith('utm_') || TRACKING_KEYS.has(normalized)
}

export function canonicalizeJobSourceUrl(value: string) {
  const url = new URL(value)
  url.hash = ''
  url.hostname = url.hostname.toLocaleLowerCase()
  const entries = [...url.searchParams.entries()]
    .filter(([key]) => !isTrackingParam(key))
    .sort(([aKey, aValue], [bKey, bValue]) => aKey.localeCompare(bKey) || aValue.localeCompare(bValue))
  url.search = ''
  for (const [key, entryValue] of entries) url.searchParams.append(key, entryValue)
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString()
}

export function jobSourceHost(sourceUrl: string) {
  return new URL(sourceUrl).hostname.toLocaleLowerCase().replace(/^www\./, '')
}

export interface CreateJobPostingEvidenceInput {
  company: string
  role: string
  sourceUrl: string
  sourceTitle: string
  location?: string
  deadline?: string
  compensationText?: string
  postingStatus?: JobPostingStatus
  observedAt: string
}

export function createJobPostingEvidence(input: CreateJobPostingEvidenceInput): JobPostingEvidence {
  const canonicalSourceUrl = canonicalizeJobSourceUrl(input.sourceUrl)
  const identityKey = jobIdentityKey(input.company, input.role, input.location)
  const postingStatus = input.postingStatus ?? 'unknown'
  const fingerprintPayload = [
    identityKey,
    canonicalSourceUrl,
    input.sourceTitle.trim(),
    postingStatus,
    input.deadline ?? '',
    input.compensationText ?? '',
  ].join('|')
  return {
    id: `posting:${stableHash(canonicalSourceUrl)}`,
    identityKey,
    sourceUrl: input.sourceUrl,
    canonicalSourceUrl,
    sourceHost: jobSourceHost(input.sourceUrl),
    sourceTitle: input.sourceTitle,
    postingStatus,
    location: input.location,
    deadline: input.deadline,
    compensationText: input.compensationText,
    firstSeenAt: input.observedAt,
    lastSeenAt: input.observedAt,
    lastVerifiedAt: input.observedAt,
    fingerprint: stableHash(fingerprintPayload),
  }
}

function dateValue(value: string | undefined) {
  if (!value) return Number.NaN
  return new Date(value).getTime()
}

export function jobPostingFreshness(posting: JobPostingEvidence, now = new Date()): JobPostingFreshness {
  if (posting.postingStatus === 'closed') return 'closed'
  const deadline = dateValue(posting.deadline)
  if (Number.isFinite(deadline) && deadline < now.getTime()) return 'closed'
  const checkedAt = dateValue(posting.lastVerifiedAt)
  if (!Number.isFinite(checkedAt)) return 'unknown'
  const ageDays = Math.max(0, (now.getTime() - checkedAt) / DAY_MS)
  if (ageDays <= FRESH_DAYS) return 'fresh'
  if (ageDays <= STALE_DAYS) return 'aging'
  return 'stale'
}

export function validateJobPostingEvidence(posting: JobPostingEvidence) {
  const errors: string[] = []
  if (!posting.id?.trim() || !posting.identityKey?.trim() || !posting.fingerprint?.trim()) errors.push('岗位发布记录缺少稳定身份字段。')
  if (!posting.sourceUrl?.trim() || !posting.canonicalSourceUrl?.trim() || !posting.sourceHost?.trim() || !posting.sourceTitle?.trim()) errors.push('岗位发布记录缺少来源字段。')
  try {
    if (canonicalizeJobSourceUrl(posting.sourceUrl) !== posting.canonicalSourceUrl) errors.push('岗位发布记录 canonicalSourceUrl 与来源不一致。')
  } catch {
    errors.push('岗位发布记录来源 URL 无效。')
  }
  if (!(['open', 'closed', 'unknown'] as JobPostingStatus[]).includes(posting.postingStatus)) errors.push('岗位发布状态无效。')
  for (const [label, value] of [
    ['firstSeenAt', posting.firstSeenAt],
    ['lastSeenAt', posting.lastSeenAt],
    ['lastVerifiedAt', posting.lastVerifiedAt],
  ] as const) {
    if (Number.isNaN(new Date(value).getTime())) errors.push(`岗位发布记录 ${label} 无效。`)
  }
  if (posting.deadline && Number.isNaN(new Date(posting.deadline).getTime())) errors.push('岗位发布记录 deadline 无效。')
  return errors
}

function newerIso(a: string, b: string) {
  return a >= b ? a : b
}

function mergeSameSource(previous: JobPostingEvidence, incoming: JobPostingEvidence): JobPostingEvidence {
  return {
    ...previous,
    ...incoming,
    firstSeenAt: previous.firstSeenAt <= incoming.firstSeenAt ? previous.firstSeenAt : incoming.firstSeenAt,
    lastSeenAt: newerIso(previous.lastSeenAt, incoming.lastSeenAt),
    lastVerifiedAt: newerIso(previous.lastVerifiedAt, incoming.lastVerifiedAt),
    supersededByPostingId: incoming.postingStatus === 'open' ? undefined : previous.supersededByPostingId,
  }
}

export function mergeJobPostingEvidence(
  current: JobPostingEvidence,
  history: JobPostingEvidence[] | undefined,
  incoming: JobPostingEvidence,
  now = new Date(),
) {
  const byId = new Map<string, JobPostingEvidence>()
  for (const posting of [current, ...(history ?? [])]) byId.set(posting.id, posting)
  const previousSameSource = byId.get(incoming.id)
  byId.set(incoming.id, previousSameSource ? mergeSameSource(previousSameSource, incoming) : incoming)

  const records = [...byId.values()]
  const selected = [...records].sort((a, b) =>
    b.lastVerifiedAt.localeCompare(a.lastVerifiedAt) || b.lastSeenAt.localeCompare(a.lastSeenAt) || a.id.localeCompare(b.id)
  )[0]

  if (selected.id === incoming.id && incoming.postingStatus === 'open') {
    for (const posting of records) {
      if (posting.id === selected.id) continue
      const freshness = jobPostingFreshness(posting, now)
      if (freshness === 'closed' || freshness === 'stale') {
        byId.set(posting.id, { ...posting, supersededByPostingId: incoming.id })
      }
    }
  }

  const mergedCurrent = byId.get(selected.id) ?? selected
  const mergedHistory = [...byId.values()]
    .filter((posting) => posting.id !== mergedCurrent.id)
    .sort((a, b) => b.lastVerifiedAt.localeCompare(a.lastVerifiedAt) || a.id.localeCompare(b.id))
    .slice(0, MAX_POSTING_HISTORY)
  return { current: mergedCurrent, history: mergedHistory }
}

export function jobPostingForInboxItem(item: DiscoveryInboxItem): JobPostingEvidence {
  return item.posting ?? createJobPostingEvidence({
    company: item.company,
    role: item.role,
    sourceUrl: item.sourceUrl,
    sourceTitle: item.sourceTitle,
    location: item.location,
    deadline: item.deadline,
    compensationText: item.compensationText,
    postingStatus: 'unknown',
    observedAt: item.discoveredAt,
  })
}

export function jobPostingsForOpportunity(opportunity: Opportunity) {
  const discovery = opportunity.detail?.discovery
  if (!discovery) return []
  const current = discovery.posting ?? createJobPostingEvidence({
    company: opportunity.company,
    role: opportunity.role,
    sourceUrl: discovery.sourceUrl,
    sourceTitle: discovery.sourceTitle,
    location: discovery.location,
    deadline: opportunity.deadline,
    compensationText: discovery.compensationText,
    postingStatus: 'unknown',
    observedAt: discovery.discoveredAt,
  })
  return [current, ...(discovery.postingHistory ?? [])]
}

export interface KnownJobPosting {
  posting: JobPostingEvidence
  ownerKind: 'opportunity' | 'inbox'
  ownerId: string
  inboxStatus?: DiscoveryInboxStatus
  ownerUpdatedAt: string
  company: string
  role: string
  location?: string
}

export function knownJobPostings(opportunities: Opportunity[], inbox: DiscoveryInboxItem[]) {
  const byOwnerAndPosting = new Map<string, KnownJobPosting>()
  for (const opportunity of opportunities) {
    for (const posting of jobPostingsForOpportunity(opportunity)) {
      byOwnerAndPosting.set(`opportunity:${opportunity.id}:${posting.id}`, {
        posting,
        ownerKind: 'opportunity',
        ownerId: opportunity.id,
        ownerUpdatedAt: opportunity.importedAt,
        company: opportunity.company,
        role: opportunity.role,
        location: opportunity.detail?.discovery?.location,
      })
    }
  }
  for (const item of inbox) {
    const postings = [jobPostingForInboxItem(item), ...(item.postingHistory ?? [])]
    for (const posting of postings) {
      byOwnerAndPosting.set(`inbox:${item.id}:${posting.id}`, {
        posting,
        ownerKind: 'inbox',
        ownerId: item.id,
        inboxStatus: item.status,
        ownerUpdatedAt: item.updatedAt,
        company: item.company,
        role: item.role,
        location: item.location,
      })
    }
  }
  return [...byOwnerAndPosting.values()]
}
