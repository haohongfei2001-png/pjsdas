import type { DecisionWeights } from './decisionRules.js'
import { discoveryProfileForSnapshot, type DiscoveryProfile } from './discoveryProfile.js'
import type { DiscoveryConfidence, Opportunity, OpportunityRole, TimelineRecord } from './model.js'

export type DiscoveryPostingStatus = 'open' | 'closed' | 'unknown'

export interface DiscoveryCandidateForQuality {
  company: string
  role: string
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
}

export interface ScreenedDiscoveryCandidate<T extends DiscoveryCandidateForQuality = DiscoveryCandidateForQuality> {
  candidate: T
  qualityScore: number
  warnings: string[]
}

export interface DiscoveryScreeningResult<T extends DiscoveryCandidateForQuality = DiscoveryCandidateForQuality> {
  received: number
  accepted: ScreenedDiscoveryCandidate<T>[]
  skippedDuplicates: Array<{ company: string; role: string; reason: string }>
  rejectedCandidates: Array<{ company: string; role: string; reasons: string[] }>
  deferredCandidates: Array<{ company: string; role: string; qualityScore: number; reason: string }>
}

function compact(value: string) {
  return value.toLocaleLowerCase().replace(/[\s\u3000·•｜|（）()【】\[\]，,。.!！?？:：;；/\\_-]+/g, '')
}

function normalizedCompany(value: string) {
  return compact(value).replace(/(股份有限公司|有限责任公司|有限公司|集团公司|公司|ltd|inc)$/gi, '')
}

function normalizedRole(value: string) {
  return compact(value)
    .replace(/20\d{2}届/g, '')
    .replace(/20\d{2}(秋招|春招|校招)/g, '')
    .replace(/(校园招聘|校招|秋招|春招|应届生|应届|全职|职位|岗位|方向)$/g, '')
}

function bigrams(value: string) {
  const chars = Array.from(value)
  if (chars.length < 2) return new Set(chars)
  const result = new Set<string>()
  for (let index = 0; index < chars.length - 1; index += 1) result.add(`${chars[index]}${chars[index + 1]}`)
  return result
}

export function discoveryRoleSimilarity(a: string, b: string) {
  const left = normalizedRole(a)
  const right = normalizedRole(b)
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

export function findSimilarOpportunity(
  candidate: Pick<DiscoveryCandidateForQuality, 'company' | 'role'>,
  opportunities: Opportunity[],
) {
  const company = normalizedCompany(candidate.company)
  return opportunities.find((item) => {
    if (normalizedCompany(item.company) !== company) return false
    return discoveryRoleSimilarity(item.role, candidate.role) >= 0.72
  })
}

function similarCandidate(
  a: Pick<DiscoveryCandidateForQuality, 'company' | 'role'>,
  b: Pick<DiscoveryCandidateForQuality, 'company' | 'role'>,
) {
  return normalizedCompany(a.company) === normalizedCompany(b.company) && discoveryRoleSimilarity(a.role, b.role) >= 0.72
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
      normalizedCompany(item.company!) === normalizedCompany(candidate.company) &&
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
  const warnings: string[] = []
  const evidence = candidateEvidence(candidate)

  if (candidate.postingStatus === 'closed') {
    hardRejectReasons.push('公开来源明确显示岗位已关闭。')
  } else if (!candidate.postingStatus || candidate.postingStatus === 'unknown') {
    warnings.push('公开来源没有明确验证岗位仍开放。')
  }

  if (candidate.deadline && deadlineInstant(candidate.deadline) < now.getTime()) {
    hardRejectReasons.push(`岗位截止时间 ${candidate.deadline} 已过去。`)
  }

  const preferredRoleTypes = profile.preferredRoleTypes ?? []
  if (preferredRoleTypes.length > 0 && !preferredRoleTypes.includes(candidate.roleType)) {
    hardRejectReasons.push(`岗位类型 ${candidate.roleType} 不在显式允许类型中。`)
  }

  if (profile.minimumFitScore !== undefined && candidate.fitScore < profile.minimumFitScore) {
    hardRejectReasons.push(`匹配度 ${candidate.fitScore} 低于显式门槛 ${profile.minimumFitScore}。`)
  }
  if (profile.minimumOpportunityValue !== undefined && candidate.opportunityValue < profile.minimumOpportunityValue) {
    hardRejectReasons.push(`机会价值 ${candidate.opportunityValue} 低于显式门槛 ${profile.minimumOpportunityValue}。`)
  }

  for (const exclusion of profile.mustNotHave) {
    if (literalRulePresent(exclusion, evidence)) {
      hardRejectReasons.push(`来源证据命中明确排除条件“${exclusion}”。`)
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
      if (strict) hardRejectReasons.push('地点为严格约束，但公开来源没有明确岗位地点。')
      else warnings.push('来源没有明确岗位地点，无法验证地点偏好。')
    } else if (!locationMatches(profile, candidate.location)) {
      if (strict) hardRejectReasons.push(`岗位地点“${candidate.location}”不符合严格地点约束。`)
      else warnings.push(`岗位地点“${candidate.location}”不在显式偏好列表中；请结合地点例外规则人工确认。`)
    }
  }

  if (profile.minimumAnnualCompensationWan !== undefined) {
    if (candidate.annualCompensationMinWan === undefined) {
      warnings.push(`来源没有可结构化验证的最低年薪，无法确认 ${profile.minimumAnnualCompensationWan} 万元薪资门槛。`)
    } else if (candidate.annualCompensationMinWan < profile.minimumAnnualCompensationWan) {
      hardRejectReasons.push(`来源可验证最低年薪 ${candidate.annualCompensationMinWan} 万元，低于显式门槛 ${profile.minimumAnnualCompensationWan} 万元。`)
    }
  }

  return {
    accepted: hardRejectReasons.length === 0,
    hardRejectReasons,
    warnings: warnings.slice(0, 10),
    qualityScore: discoveryQualityScore(candidate, weights),
  }
}

export function screenDiscoveryCandidates<T extends DiscoveryCandidateForQuality>(
  rawProfile: DiscoveryProfile,
  candidates: T[],
  existing: Opportunity[],
  weights: DecisionWeights,
  now = new Date(),
  timeline: TimelineRecord[] = [],
): DiscoveryScreeningResult<T> {
  const profile = discoveryProfileForSnapshot(rawProfile)
  const eligible: ScreenedDiscoveryCandidate<T>[] = []
  const skippedDuplicates: DiscoveryScreeningResult<T>['skippedDuplicates'] = []
  const rejectedCandidates: DiscoveryScreeningResult<T>['rejectedCandidates'] = []

  for (const candidate of candidates) {
    const latestFeedback = latestExplicitFeedbackForCandidate(timeline, candidate, now)
    if (latestFeedback?.discoveryDecision === 'rejected') {
      rejectedCandidates.push({
        company: candidate.company,
        role: candidate.role,
        reasons: [`用户在最近 120 天已明确拒绝高度相似岗位“${latestFeedback.company}｜${latestFeedback.role}”。`],
      })
      continue
    }

    const duplicate = findSimilarOpportunity(candidate, existing)
    if (duplicate) {
      skippedDuplicates.push({
        company: candidate.company,
        role: candidate.role,
        reason: `PJSDAS 已存在相同或高度相似岗位“${duplicate.company}｜${duplicate.role}”。`,
      })
      continue
    }

    const batchDuplicate = eligible.find((item) => similarCandidate(item.candidate, candidate))
    if (batchDuplicate) {
      skippedDuplicates.push({
        company: candidate.company,
        role: candidate.role,
        reason: `本次候选中已存在高度相似岗位“${batchDuplicate.candidate.company}｜${batchDuplicate.candidate.role}”。`,
      })
      continue
    }

    const evaluated = evaluateDiscoveryCandidate(profile, candidate, weights, now)
    if (!evaluated.accepted) {
      rejectedCandidates.push({
        company: candidate.company,
        role: candidate.role,
        reasons: evaluated.hardRejectReasons,
      })
      continue
    }

    eligible.push({
      candidate,
      qualityScore: evaluated.qualityScore,
      warnings: evaluated.warnings,
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
  const deferredCandidates = eligible.slice(maxReviewCandidates).map((item) => ({
    company: item.candidate.company,
    role: item.candidate.role,
    qualityScore: item.qualityScore,
    reason: `超过单批审阅上限 ${maxReviewCandidates}，按发现质量得分暂缓。`,
  }))

  return {
    received: candidates.length,
    accepted,
    skippedDuplicates,
    rejectedCandidates,
    deferredCandidates,
  }
}
