import type { DecisionWeights } from './decisionRules.js'
import { discoveryProfileForSnapshot, type DiscoveryProfile } from './discoveryProfile.js'
import {
  presentDiscoveryQualityReason,
  type DiscoveryQualityReasonDetail,
} from './discoveryQualityReason.js'
import {
  createJobPostingEvidence,
  jobPostingFreshness,
  jobRoleSimilarity,
  knownJobPostings,
  logicalJobMatches,
  normalizeJobCompany,
} from './jobPosting.js'
import type {
  DiscoveryConfidence,
  DiscoveryInboxItem,
  JobPostingStatus,
  Opportunity,
  OpportunityRole,
  TimelineRecord,
} from './model.js'

export type DiscoveryPostingStatus = JobPostingStatus

export interface DiscoveryCandidateForQuality {
  company: string
  role: string
  sourceUrl: string
  sourceTitle: string
  location?: string
  deadline?: string
  compensationText?: string
  annualCompensationMinWan?: number
  sourceEvidenceText?: string
  postingStatus?: DiscoveryPostingStatus
  roleType: OpportunityRole
  opportunityValue: number
  fitScore: number
  fitConfidence: DiscoveryConfidence
  opportunityValueConfidence: DiscoveryConfidence
  discoveredAt?: string
}

export interface ScreenedDiscoveryCandidate<T extends DiscoveryCandidateForQuality = DiscoveryCandidateForQuality> {
  candidate: T
  qualityScore: number
  warnings: string[]
}

export interface DiscoveryScreeningResult<T extends DiscoveryCandidateForQuality = DiscoveryCandidateForQuality> {
  received: number
  accepted: ScreenedDiscoveryCandidate<T>[]
  skippedDuplicates: Array<{ company: string; role: string; reason: string; reasonDetail?: DiscoveryQualityReasonDetail }>
  rejectedCandidates: Array<{ company: string; role: string; reasons: string[]; reasonDetails?: DiscoveryQualityReasonDetail[] }>
  deferredCandidates: Array<{ company: string; role: string; qualityScore: number; reason: string; reasonDetail?: DiscoveryQualityReasonDetail }>
}

function compact(value: string) {
  return value.toLocaleLowerCase().replace(/[\s\u3000·•｜|（）()【】\[\]，,。.!！?？:：;；/\\_-]+/g, '')
}

export const discoveryRoleSimilarity = jobRoleSimilarity

export function findSimilarOpportunity(
  candidate: Pick<DiscoveryCandidateForQuality, 'company' | 'role'> & { location?: string },
  opportunities: Opportunity[],
) {
  return opportunities.find((item) => logicalJobMatches(
    { company: candidate.company, role: candidate.role, location: candidate.location },
    { company: item.company, role: item.role, location: item.detail?.discovery?.location },
  ))
}

function similarCandidate(
  a: Pick<DiscoveryCandidateForQuality, 'company' | 'role' | 'location'>,
  b: Pick<DiscoveryCandidateForQuality, 'company' | 'role' | 'location'>,
) {
  return logicalJobMatches(a, b)
}

function latestExplicitFeedbackForCandidate(
  timeline: TimelineRecord[],
  candidate: Pick<DiscoveryCandidateForQuality, 'company' | 'role'>,
  now: Date,
  windowDays = 120,
) {
  const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000
  return timeline
    .filter((item) =>
      (item.discoveryDecision === 'accepted' || item.discoveryDecision === 'rejected') &&
      Boolean(item.company && item.role) &&
      new Date(item.occurredAt).getTime() >= cutoff &&
      normalizeJobCompany(item.company!) === normalizeJobCompany(candidate.company) &&
      discoveryRoleSimilarity(item.role!, candidate.role) >= 0.72
    )
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.recordedAt.localeCompare(a.recordedAt))[0]
}

function candidateEvidence(candidate: DiscoveryCandidateForQuality) {
  return compact([
    candidate.company,
    candidate.role,
    candidate.sourceTitle,
    candidate.location,
    candidate.compensationText,
    candidate.sourceEvidenceText,
  ].filter(Boolean).join(' '))
}

function literalRulePresent(rule: string, evidence: string) {
  const token = compact(rule)
  return token.length >= 2 && evidence.includes(token)
}

function deadlineInstant(value: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T23:59:59.999Z`).getTime()
  return new Date(value).getTime()
}

function locationMatches(profile: DiscoveryProfile, location: string) {
  const actual = compact(location)
  return profile.preferredLocations.some((item) => {
    const preferred = compact(item)
    return actual.includes(preferred) || preferred.includes(actual)
  })
}

function confidencePenalty(value: DiscoveryConfidence) {
  if (value === 'low') return 6
  if (value === 'medium') return 2
  return 0
}

export function discoveryQualityScore(candidate: DiscoveryCandidateForQuality, weights: DecisionWeights) {
  const fitWeight = Math.max(1, weights.fit)
  const opportunityWeight = Math.max(1, weights.opportunity)
  const base = (
    candidate.fitScore * fitWeight + candidate.opportunityValue * opportunityWeight
  ) / (fitWeight + opportunityWeight)
  const penalty = confidencePenalty(candidate.fitConfidence) + confidencePenalty(candidate.opportunityValueConfidence)
  return Math.max(0, Math.min(100, Math.round((base - penalty) * 10) / 10))
}

export function evaluateDiscoveryCandidate(
  rawProfile: DiscoveryProfile,
  candidate: DiscoveryCandidateForQuality,
  weights: DecisionWeights,
  now = new Date(),
) {
  const profile = discoveryProfileForSnapshot(rawProfile)
  const hardRejectReasons: string[] = []
  const hardRejectDetails: DiscoveryQualityReasonDetail[] = []
  const warnings: string[] = []
  const evidence = candidateEvidence(candidate)
  const reject = (detail: DiscoveryQualityReasonDetail) => {
    hardRejectDetails.push(detail)
    hardRejectReasons.push(presentDiscoveryQualityReason(detail, true))
  }

  if (candidate.postingStatus === 'closed') {
    reject({ code: 'posting_closed' })
  } else if (!candidate.postingStatus || candidate.postingStatus === 'unknown') {
    warnings.push('公开来源没有明确验证岗位仍开放。')
  }

  if (candidate.deadline && deadlineInstant(candidate.deadline) < now.getTime()) {
    reject({ code: 'deadline_expired', params: { deadline: candidate.deadline } })
  }

  const preferredRoleTypes = profile.preferredRoleTypes ?? []
  if (preferredRoleTypes.length > 0 && !preferredRoleTypes.includes(candidate.roleType)) {
    reject({ code: 'role_type_not_allowed', params: { roleType: candidate.roleType } })
  }

  if (profile.minimumFitScore !== undefined && candidate.fitScore < profile.minimumFitScore) {
    reject({ code: 'fit_below_minimum', params: { score: candidate.fitScore, minimum: profile.minimumFitScore } })
  }
  if (profile.minimumOpportunityValue !== undefined && candidate.opportunityValue < profile.minimumOpportunityValue) {
    reject({ code: 'opportunity_value_below_minimum', params: { score: candidate.opportunityValue, minimum: profile.minimumOpportunityValue } })
  }

  for (const exclusion of profile.mustNotHave) {
    if (literalRulePresent(exclusion, evidence)) {
      reject({ code: 'exclusion_match', params: { rule: exclusion } })
    }
  }

  for (const requirement of profile.mustHave) {
    if (!literalRulePresent(requirement, evidence)) {
      warnings.push(`尚未从提交的来源证据中确认必须条件“${requirement}”。`)
    }
  }

  if (profile.preferredLocations.length > 0) {
    const strict = (profile.locationPolicy ?? 'prefer') === 'strict'
    if (!candidate.location) {
      if (strict) reject({ code: 'strict_location_missing' })
      else warnings.push('来源没有明确岗位地点，无法验证地点偏好。')
    } else if (!locationMatches(profile, candidate.location)) {
      if (strict) reject({ code: 'strict_location_mismatch', params: { location: candidate.location } })
      else warnings.push(`岗位地点“${candidate.location}”不在显式偏好列表中；请结合地点例外规则人工确认。`)
    }
  }

  if (profile.minimumAnnualCompensationWan !== undefined) {
    if (candidate.annualCompensationMinWan === undefined) {
      warnings.push(`来源没有可结构化验证的最低年薪，无法确认 ${profile.minimumAnnualCompensationWan} 万元薪资门槛。`)
    } else if (candidate.annualCompensationMinWan < profile.minimumAnnualCompensationWan) {
      reject({
        code: 'compensation_below_minimum',
        params: { actual: candidate.annualCompensationMinWan, minimum: profile.minimumAnnualCompensationWan },
      })
    }
  }

  return {
    accepted: hardRejectReasons.length === 0,
    hardRejectReasons,
    hardRejectDetails,
    warnings: warnings.slice(0, 10),
    qualityScore: discoveryQualityScore(candidate, weights),
  }
}

function postingRefreshWarnings(
  candidate: DiscoveryCandidateForQuality,
  existing: Opportunity[],
  inbox: DiscoveryInboxItem[],
  now: Date,
) {
  const known = knownJobPostings(existing, inbox)
  const incomingPosting = createJobPostingEvidence({
    company: candidate.company,
    role: candidate.role,
    sourceUrl: candidate.sourceUrl,
    sourceTitle: candidate.sourceTitle,
    location: candidate.location,
    deadline: candidate.deadline,
    compensationText: candidate.compensationText,
    postingStatus: candidate.postingStatus ?? 'unknown',
    observedAt: candidate.discoveredAt ?? now.toISOString(),
  })
  const logicalMatches = known.filter((entry) => logicalJobMatches(
    { company: candidate.company, role: candidate.role, location: candidate.location },
    { company: entry.company, role: entry.role, location: entry.location },
  ))
  const sourceMatches = logicalMatches.filter((entry) => entry.posting.canonicalSourceUrl === incomingPosting.canonicalSourceUrl)
  return { incomingPosting, logicalMatches, sourceMatches }
}

export function screenDiscoveryCandidates<T extends DiscoveryCandidateForQuality>(
  rawProfile: DiscoveryProfile,
  candidates: T[],
  existing: Opportunity[],
  weights: DecisionWeights,
  now = new Date(),
  timeline: TimelineRecord[] = [],
  inbox: DiscoveryInboxItem[] = [],
): DiscoveryScreeningResult<T> {
  const profile = discoveryProfileForSnapshot(rawProfile)
  const eligible: ScreenedDiscoveryCandidate<T>[] = []
  const skippedDuplicates: DiscoveryScreeningResult<T>['skippedDuplicates'] = []
  const rejectedCandidates: DiscoveryScreeningResult<T>['rejectedCandidates'] = []

  for (const candidate of candidates) {
    const postingWarnings: string[] = []
    const postingState = postingRefreshWarnings(candidate, existing, inbox, now)
    const opportunityPosting = postingState.logicalMatches.find((entry) => entry.ownerKind === 'opportunity')
    if (opportunityPosting) {
      const reasonDetail: DiscoveryQualityReasonDetail = {
        code: 'existing_opportunity_source_duplicate',
        params: {
          company: opportunityPosting.company,
          role: opportunityPosting.role,
          sourceHost: opportunityPosting.posting.sourceHost,
        },
      }
      skippedDuplicates.push({
        company: candidate.company,
        role: candidate.role,
        reason: presentDiscoveryQualityReason(reasonDetail, true),
        reasonDetail,
      })
      continue
    }

    const inboxMatches = postingState.logicalMatches.filter((entry) => entry.ownerKind === 'inbox')
    const recentlyDismissed = inboxMatches.find((entry) => {
      if (entry.inboxStatus !== 'dismissed') return false
      return now.getTime() - new Date(entry.ownerUpdatedAt).getTime() <= 120 * 24 * 60 * 60 * 1000
    })
    if (recentlyDismissed) {
      const reasonDetail: DiscoveryQualityReasonDetail = {
        code: 'recently_dismissed_inbox',
        params: { company: recentlyDismissed.company, role: recentlyDismissed.role },
      }
      rejectedCandidates.push({
        company: candidate.company,
        role: candidate.role,
        reasons: [presentDiscoveryQualityReason(reasonDetail, true)],
        reasonDetails: [reasonDetail],
      })
      continue
    }

    const activeInboxMatches = inboxMatches.filter((entry) => entry.inboxStatus === 'new' || entry.inboxStatus === 'seen' || entry.inboxStatus === 'later')
    const freshActive = activeInboxMatches.find((entry) => {
      const freshness = jobPostingFreshness(entry.posting, now)
      return freshness === 'fresh' || freshness === 'aging'
    })
    if (freshActive) {
      const sameSource = freshActive.posting.canonicalSourceUrl === postingState.incomingPosting.canonicalSourceUrl
      const reasonDetail: DiscoveryQualityReasonDetail = sameSource
        ? {
            code: 'active_inbox_same_source',
            params: { status: freshActive.inboxStatus ?? 'unknown', lastVerifiedAt: freshActive.posting.lastVerifiedAt },
          }
        : {
            code: 'active_inbox_cross_source',
            params: { status: freshActive.inboxStatus ?? 'unknown', sourceHost: freshActive.posting.sourceHost },
          }
      skippedDuplicates.push({
        company: candidate.company,
        role: candidate.role,
        reason: presentDiscoveryQualityReason(reasonDetail, true),
        reasonDetail,
      })
      continue
    }

    if (activeInboxMatches.length > 0) {
      const sameSourceStale = postingState.sourceMatches.find((entry) => entry.ownerKind === 'inbox')
      postingWarnings.push(sameSourceStale
        ? '同一公开招聘来源此前已经记录，但来源证据已陈旧；本次候选用于刷新岗位状态与来源事实。'
        : '发现箱中存在同一逻辑岗位的陈旧来源；本次新来源可能是重新发布或替代发布，请在审阅时确认。')
    }

    const latestFeedback = latestExplicitFeedbackForCandidate(timeline, candidate, now)
    if (latestFeedback?.discoveryDecision === 'rejected') {
      const reasonDetail: DiscoveryQualityReasonDetail = {
        code: 'recent_user_rejection',
        params: { company: latestFeedback.company ?? '', role: latestFeedback.role ?? '' },
      }
      rejectedCandidates.push({
        company: candidate.company,
        role: candidate.role,
        reasons: [presentDiscoveryQualityReason(reasonDetail, true)],
        reasonDetails: [reasonDetail],
      })
      continue
    }

    const duplicate = findSimilarOpportunity(candidate, existing)
    if (duplicate) {
      const reasonDetail: DiscoveryQualityReasonDetail = {
        code: 'existing_opportunity_duplicate',
        params: { company: duplicate.company, role: duplicate.role },
      }
      skippedDuplicates.push({
        company: candidate.company,
        role: candidate.role,
        reason: presentDiscoveryQualityReason(reasonDetail, true),
        reasonDetail,
      })
      continue
    }

    const batchDuplicate = eligible.find((item) => similarCandidate(item.candidate, candidate))
    if (batchDuplicate) {
      const reasonDetail: DiscoveryQualityReasonDetail = {
        code: 'batch_duplicate',
        params: { company: batchDuplicate.candidate.company, role: batchDuplicate.candidate.role },
      }
      skippedDuplicates.push({
        company: candidate.company,
        role: candidate.role,
        reason: presentDiscoveryQualityReason(reasonDetail, true),
        reasonDetail,
      })
      continue
    }

    const evaluated = evaluateDiscoveryCandidate(profile, candidate, weights, now)
    if (!evaluated.accepted) {
      rejectedCandidates.push({
        company: candidate.company,
        role: candidate.role,
        reasons: evaluated.hardRejectReasons,
        reasonDetails: evaluated.hardRejectDetails,
      })
      continue
    }

    eligible.push({
      candidate,
      qualityScore: evaluated.qualityScore,
      warnings: [...postingWarnings, ...evaluated.warnings].slice(0, 10),
    })
  }

  eligible.sort((a, b) =>
    b.qualityScore - a.qualityScore ||
    b.candidate.fitScore - a.candidate.fitScore ||
    b.candidate.opportunityValue - a.candidate.opportunityValue ||
    a.candidate.company.localeCompare(b.candidate.company) ||
    a.candidate.role.localeCompare(b.candidate.role),
  )

  const maxReviewCandidates = Math.max(1, Math.min(12, profile.maxReviewCandidates ?? 6))
  const accepted = eligible.slice(0, maxReviewCandidates)
  const deferredCandidates = eligible.slice(maxReviewCandidates).map((item) => {
    const reasonDetail: DiscoveryQualityReasonDetail = {
      code: 'review_batch_limit',
      params: { limit: maxReviewCandidates },
    }
    return {
      company: item.candidate.company,
      role: item.candidate.role,
      qualityScore: item.qualityScore,
      reason: presentDiscoveryQualityReason(reasonDetail, true),
      reasonDetail,
    }
  })

  return {
    received: candidates.length,
    accepted,
    skippedDuplicates,
    rejectedCandidates,
    deferredCandidates,
  }
}
