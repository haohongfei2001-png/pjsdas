import type { DiscoveryInboxItem, DiscoveryInboxStatus } from './model.js'

export type DiscoveryInboxSort =
  | 'review_priority'
  | 'newest'
  | 'fit'
  | 'opportunity'
  | 'completeness'
  | 'deadline'

export interface DiscoveryDecisionSignal {
  key: string
  zh: string
  en: string
}

export interface DiscoveryDecisionSummary {
  reviewScore: number
  knownFacts: number
  totalFacts: number
  completenessPercent: number
  strengths: DiscoveryDecisionSignal[]
  risks: DiscoveryDecisionSignal[]
  missing: DiscoveryDecisionSignal[]
}

const DAY_MS = 24 * 60 * 60 * 1000
const ACTIVE_STATUS: DiscoveryInboxStatus[] = ['new', 'later', 'seen']

function signal(key: string, zh: string, en: string): DiscoveryDecisionSignal {
  return { key, zh, en }
}

export function discoveryReviewScore(item: DiscoveryInboxItem) {
  return Math.round((item.fitScore + item.opportunityValue) / 2)
}

export function discoveryDecisionSummary(item: DiscoveryInboxItem, now = new Date()): DiscoveryDecisionSummary {
  const missing: DiscoveryDecisionSignal[] = []
  if (!item.location?.trim()) missing.push(signal('location', '地点未明确', 'Location not stated'))
  if (!item.deadline?.trim()) missing.push(signal('deadline', '截止时间未明确', 'Deadline not stated'))
  if (!item.compensationText?.trim()) missing.push(signal('compensation', '薪资未明确', 'Compensation not stated'))

  const totalFacts = 3
  const knownFacts = totalFacts - missing.length
  const completenessPercent = Math.round((knownFacts / totalFacts) * 100)

  const strengths: DiscoveryDecisionSignal[] = []
  if (item.fitScore >= 85) strengths.push(signal('fit-high', '匹配度较高', 'High fit score'))
  if (item.opportunityValue >= 85) strengths.push(signal('opportunity-high', '机会价值较高', 'High opportunity value'))
  if (item.fitConfidence === 'high' && item.opportunityValueConfidence === 'high') {
    strengths.push(signal('confidence-high', '两项评分置信度均高', 'Both score estimates have high confidence'))
  }
  if (!item.profileWarnings?.length) strengths.push(signal('no-profile-warning', '暂无偏好或证据警告', 'No profile or evidence warnings'))

  const risks: DiscoveryDecisionSignal[] = []
  if (item.fitConfidence === 'low') risks.push(signal('fit-low-confidence', '匹配度估计置信度低', 'Fit estimate has low confidence'))
  if (item.opportunityValueConfidence === 'low') risks.push(signal('opportunity-low-confidence', '机会价值估计置信度低', 'Opportunity-value estimate has low confidence'))
  if (item.profileWarnings?.length) {
    risks.push(signal('profile-warnings', `存在 ${item.profileWarnings.length} 条偏好或证据警告`, `${item.profileWarnings.length} profile or evidence warning(s)`))
  }
  if (item.deadline) {
    const deadline = new Date(item.deadline).getTime()
    if (!Number.isNaN(deadline)) {
      const remaining = deadline - now.getTime()
      if (remaining < 0) risks.push(signal('deadline-passed', '公开截止时间已经过去', 'Public deadline has passed'))
      else if (remaining <= 3 * DAY_MS) risks.push(signal('deadline-soon', '距离截止不足 72 小时', 'Deadline is within 72 hours'))
    }
  }

  return {
    reviewScore: discoveryReviewScore(item),
    knownFacts,
    totalFacts,
    completenessPercent,
    strengths,
    risks,
    missing,
  }
}

function activeRank(item: DiscoveryInboxItem) {
  return ACTIVE_STATUS.includes(item.status) ? 0 : 1
}

function deadlineValue(item: DiscoveryInboxItem) {
  if (!item.deadline) return Number.POSITIVE_INFINITY
  const parsed = new Date(item.deadline).getTime()
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed
}

export function sortDiscoveryInboxItems(
  items: DiscoveryInboxItem[],
  sort: DiscoveryInboxSort,
  now = new Date(),
) {
  return [...items].sort((a, b) => {
    if (sort === 'review_priority') {
      const activeDifference = activeRank(a) - activeRank(b)
      if (activeDifference) return activeDifference
      const scoreDifference = discoveryReviewScore(b) - discoveryReviewScore(a)
      if (scoreDifference) return scoreDifference
      const completenessDifference = discoveryDecisionSummary(b, now).completenessPercent - discoveryDecisionSummary(a, now).completenessPercent
      if (completenessDifference) return completenessDifference
    }
    if (sort === 'fit') {
      const difference = b.fitScore - a.fitScore
      if (difference) return difference
    }
    if (sort === 'opportunity') {
      const difference = b.opportunityValue - a.opportunityValue
      if (difference) return difference
    }
    if (sort === 'completeness') {
      const difference = discoveryDecisionSummary(b, now).completenessPercent - discoveryDecisionSummary(a, now).completenessPercent
      if (difference) return difference
    }
    if (sort === 'deadline') {
      const difference = deadlineValue(a) - deadlineValue(b)
      if (difference) return difference
    }
    if (sort === 'newest') {
      const difference = b.discoveredAt.localeCompare(a.discoveredAt)
      if (difference) return difference
    }
    return b.updatedAt.localeCompare(a.updatedAt) || a.company.localeCompare(b.company)
  })
}
