import {
  resolvedPortfolioDecisionWeights,
  resolvedPortfolioMinimumCandidateScore,
  type DecisionRules,
  type PortfolioDecisionWeights,
} from './decisionRules.js'
import { jobRoleSimilarity } from './jobPosting.js'
import { projectOpportunityAssessment, scoreOpportunityAssessment } from './opportunityAssessment.js'
import type {
  ApplicationGroup,
  DiscoveryConfidence,
  Opportunity,
  OpportunityRole,
} from './model.js'

const HOUR = 3_600_000
const MAX_OPTIMIZED_CANDIDATES = 12
const MAX_RECOMMENDED_SLOTS = 6

const clamp = (value: number, min = 0, max = 100) => Math.max(min, Math.min(max, value))

export type PortfolioDecisionStatus =
  | 'ready'
  | 'needs_rule_confirmation'
  | 'capacity_exhausted'
  | 'locked'
  | 'no_candidates'
  | 'no_recommendation'

export type PortfolioCandidateDisposition =
  | 'recommended'
  | 'below_minimum'
  | 'overlap'
  | 'capacity'
  | 'expired'
  | 'not_pending'
  | 'not_selected'

export interface PortfolioCandidateComponents {
  opportunityValue: number
  fit: number
  rolePriority: number
  deadline?: number
  applicationEfficiency?: number
  evidenceConfidence?: number
}

export interface PortfolioCandidateDecision {
  opportunityId: string
  company: string
  role: string
  roleType: OpportunityRole
  baseScore: number
  minimumScore: number
  eligible: boolean
  disposition: PortfolioCandidateDisposition
  components: PortfolioCandidateComponents
  deadline?: string
  estimatedMinutes?: number
  maxSimilarityToRecommended?: number
  reasons: string[]
}

export interface ApplicationPortfolioDecision {
  groupId: string
  company: string
  status: PortfolioDecisionStatus
  capacity?: number
  totalSlots?: number
  usedSlots?: number
  candidateCount: number
  optimizedCandidateCount: number
  minimumCandidateScore: number
  recommended: PortfolioCandidateDecision[]
  notRecommended: PortfolioCandidateDecision[]
  objectiveScore?: number
  sourceRule?: string
  currentOrder?: string
  warnings: string[]
  generatedAt: string
}

const rolePriorityScore: Record<OpportunityRole, number> = {
  core: 100,
  reach: 90,
  backup: 72,
  lottery: 56,
  practice: 38,
}

const confidenceScore: Record<DiscoveryConfidence, number> = {
  high: 100,
  medium: 70,
  low: 40,
}

function deadlineScore(deadline: string | undefined, now: Date) {
  if (!deadline) return undefined
  const hours = (new Date(deadline).getTime() - now.getTime()) / HOUR
  if (!Number.isFinite(hours)) return undefined
  if (hours < 0) return 0
  if (hours <= 24) return 100
  if (hours <= 72) return 90
  if (hours <= 168) return 78
  if (hours <= 336) return 65
  if (hours <= 720) return 50
  return 35
}

function applicationEfficiency(minutes: number | undefined) {
  if (!minutes || !Number.isFinite(minutes) || minutes <= 0) return undefined
  return Math.round(clamp(120 - Math.sqrt(Math.max(10, minutes) / 15) * 25) * 10) / 10
}

function evidenceConfidence(opportunity: Opportunity, rules: DecisionRules) {
  if (opportunity.detail?.assessment) {
    const scored = scoreOpportunityAssessment(opportunity.detail.assessment, rules)
    return Math.round(((confidenceScore[scored.fit.confidence] + confidenceScore[scored.opportunityValue.confidence]) / 2) * 10) / 10
  }
  const discovery = opportunity.detail?.discovery
  if (!discovery) return undefined
  return Math.round(((confidenceScore[discovery.fitConfidence] + confidenceScore[discovery.opportunityValueConfidence]) / 2) * 10) / 10
}

function weightedBaseScore(components: PortfolioCandidateComponents, weights: PortfolioDecisionWeights) {
  const entries: Array<[number | undefined, number]> = [
    [components.opportunityValue, weights.opportunityValue],
    [components.fit, weights.fit],
    [components.rolePriority, weights.rolePriority],
    [components.deadline, weights.deadline],
    [components.applicationEfficiency, weights.applicationEfficiency],
    [components.evidenceConfidence, weights.evidenceConfidence],
  ]
  let numerator = 0
  let denominator = 0
  for (const [value, weight] of entries) {
    if (value === undefined || weight <= 0) continue
    numerator += value * weight
    denominator += weight
  }
  return denominator > 0 ? Math.round((numerator / denominator) * 10) / 10 : 0
}

function capacityFor(group: ApplicationGroup) {
  if (group.remaining !== undefined && Number.isFinite(group.remaining)) return Math.max(0, Math.floor(group.remaining))
  if (group.total !== undefined && group.used !== undefined && Number.isFinite(group.total) && Number.isFinite(group.used)) {
    return Math.max(0, Math.floor(group.total - group.used))
  }
  return undefined
}

function capacityWarnings(group: ApplicationGroup) {
  const warnings: string[] = []
  if (group.total !== undefined && group.used !== undefined && group.remaining !== undefined) {
    const derived = group.total - group.used
    if (Math.abs(derived - group.remaining) > 0.001) {
      warnings.push(`申请组名额字段不一致：总名额 ${group.total} - 已用 ${group.used} = ${derived}，但“剩余”记录为 ${group.remaining}；组合决策优先采用显式剩余值。`)
    }
  }
  if (group.currentOrder) warnings.push('“当前排序/首选”是历史自由文本上下文，不作为隐藏硬约束；如需固定某个志愿，请先把申请组标记为锁定或更新结构化规则。')
  return warnings
}

function candidateDecision(opportunity: Opportunity, rules: DecisionRules, now: Date): PortfolioCandidateDecision {
  const projected = projectOpportunityAssessment(opportunity, rules)
  const weights = resolvedPortfolioDecisionWeights(rules)
  const minimumScore = resolvedPortfolioMinimumCandidateScore(rules)
  const components: PortfolioCandidateComponents = {
    opportunityValue: projected.opportunityValue,
    fit: projected.fitScore,
    rolePriority: rolePriorityScore[projected.roleType],
    deadline: deadlineScore(projected.deadline, now),
    applicationEfficiency: applicationEfficiency(projected.prepEstimateMinutes),
    evidenceConfidence: evidenceConfidence(projected, rules),
  }
  const baseScore = weightedBaseScore(components, weights)
  const deadlineExpired = Boolean(projected.deadline && new Date(projected.deadline).getTime() < now.getTime())
  const pending = projected.processStage === 'not_applied' && projected.currentStageLabel === '待投'
  const reasons: string[] = []

  if (projected.opportunityValue >= 85) reasons.push('机会价值高')
  if (projected.fitScore >= 75) reasons.push('匹配度较高')
  if (projected.roleType === 'core') reasons.push('核心机会')
  if (components.applicationEfficiency !== undefined && components.applicationEfficiency >= 75) reasons.push('投递成本较低')
  if (components.deadline !== undefined && components.deadline >= 78) reasons.push('截止窗口较近')
  if (components.evidenceConfidence !== undefined && components.evidenceConfidence < 55) reasons.push('评估证据置信度偏低')

  let disposition: PortfolioCandidateDisposition = 'not_selected'
  if (deadlineExpired) disposition = 'expired'
  else if (!pending) disposition = 'not_pending'
  else if (baseScore < minimumScore) disposition = 'below_minimum'

  return {
    opportunityId: projected.id,
    company: projected.company,
    role: projected.role,
    roleType: projected.roleType,
    baseScore,
    minimumScore,
    eligible: pending && !deadlineExpired && baseScore >= minimumScore,
    disposition,
    components,
    deadline: projected.deadline,
    estimatedMinutes: projected.prepEstimateMinutes,
    reasons,
  }
}

function overlapPenalty(a: PortfolioCandidateDecision, b: PortfolioCandidateDecision, weights: PortfolioDecisionWeights) {
  const similarity = jobRoleSimilarity(a.role, b.role)
  if (similarity < 0.55 || weights.overlapPenalty <= 0) return { similarity, penalty: 0 }
  const normalized = Math.min(1, (similarity - 0.55) / 0.45)
  return { similarity, penalty: normalized * weights.overlapPenalty }
}

function combinations<T>(items: T[], maxSize: number) {
  const result: T[][] = []
  const build = (start: number, current: T[]) => {
    if (current.length > 0) result.push([...current])
    if (current.length >= maxSize) return
    for (let index = start; index < items.length; index += 1) {
      current.push(items[index])
      build(index + 1, current)
      current.pop()
    }
  }
  build(0, [])
  return result
}

function combinationObjective(
  selection: PortfolioCandidateDecision[],
  minimumScore: number,
  weights: PortfolioDecisionWeights,
) {
  let objective = selection.reduce((sum, item) => sum + Math.max(0, item.baseScore - minimumScore), 0)
  let overlap = 0
  for (let left = 0; left < selection.length; left += 1) {
    for (let right = left + 1; right < selection.length; right += 1) {
      overlap += overlapPenalty(selection[left], selection[right], weights).penalty
    }
  }
  objective -= overlap
  return Math.round(objective * 100) / 100
}

function bestSelection(
  candidates: PortfolioCandidateDecision[],
  capacity: number,
  minimumScore: number,
  weights: PortfolioDecisionWeights,
) {
  const maxSize = Math.min(capacity, MAX_RECOMMENDED_SLOTS, candidates.length)
  if (maxSize <= 0) return { selection: [] as PortfolioCandidateDecision[], objective: 0 }
  let best: PortfolioCandidateDecision[] = []
  let bestObjective = 0
  let bestBaseTotal = 0

  for (const selection of combinations(candidates, maxSize)) {
    const objective = combinationObjective(selection, minimumScore, weights)
    const baseTotal = selection.reduce((sum, item) => sum + item.baseScore, 0)
    if (
      objective > bestObjective + 1e-9 ||
      (Math.abs(objective - bestObjective) <= 1e-9 && baseTotal > bestBaseTotal + 1e-9) ||
      (Math.abs(objective - bestObjective) <= 1e-9 && Math.abs(baseTotal - bestBaseTotal) <= 1e-9 && selection.length < best.length)
    ) {
      best = selection
      bestObjective = objective
      bestBaseTotal = baseTotal
    }
  }
  return { selection: best, objective: Math.round(bestObjective * 100) / 100 }
}

function classifyNotSelected(
  candidate: PortfolioCandidateDecision,
  recommended: PortfolioCandidateDecision[],
  capacity: number | undefined,
) {
  if (!candidate.eligible) return candidate
  const similarities = recommended.map((item) => jobRoleSimilarity(candidate.role, item.role))
  const maxSimilarity = similarities.length ? Math.max(...similarities) : 0
  const recommendedFull = capacity !== undefined && recommended.length >= capacity
  const highOverlap = maxSimilarity >= 0.72
  return {
    ...candidate,
    maxSimilarityToRecommended: Math.round(maxSimilarity * 100) / 100,
    disposition: highOverlap ? 'overlap' as const : recommendedFull ? 'capacity' as const : 'not_selected' as const,
    reasons: [
      ...candidate.reasons,
      ...(highOverlap ? [`与已推荐岗位高度重叠（相似度 ${Math.round(maxSimilarity * 100)}%）`] : []),
      ...(recommendedFull && !highOverlap ? ['名额有限，组合边际价值低于已推荐岗位'] : []),
      ...(!recommendedFull && !highOverlap ? ['加入后没有提高当前组合的净边际价值'] : []),
    ],
  }
}

export function buildApplicationPortfolioDecision(
  group: ApplicationGroup,
  opportunities: Opportunity[],
  rules: DecisionRules,
  now = new Date(),
): ApplicationPortfolioDecision {
  const weights = resolvedPortfolioDecisionWeights(rules)
  const minimumScore = resolvedPortfolioMinimumCandidateScore(rules)
  const rawCandidates = opportunities.filter((item) => item.applicationGroupId === group.id)
  const evaluated = rawCandidates.map((item) => candidateDecision(item, rules, now))
  const actionable = evaluated.filter((item) => item.eligible)
    .sort((a, b) => b.baseScore - a.baseScore || a.opportunityId.localeCompare(b.opportunityId))
  const capacity = capacityFor(group)
  const warnings = capacityWarnings(group)
  const generatedAt = now.toISOString()

  if (rawCandidates.length === 0) {
    return {
      groupId: group.id,
      company: group.company,
      status: 'no_candidates',
      capacity,
      totalSlots: group.total,
      usedSlots: group.used,
      candidateCount: 0,
      optimizedCandidateCount: 0,
      minimumCandidateScore: minimumScore,
      recommended: [],
      notRecommended: [],
      sourceRule: group.rule,
      currentOrder: group.currentOrder,
      warnings,
      generatedAt,
    }
  }

  if (group.locked) {
    return {
      groupId: group.id,
      company: group.company,
      status: 'locked',
      capacity,
      totalSlots: group.total,
      usedSlots: group.used,
      candidateCount: rawCandidates.length,
      optimizedCandidateCount: 0,
      minimumCandidateScore: minimumScore,
      recommended: [],
      notRecommended: evaluated,
      sourceRule: group.rule,
      currentOrder: group.currentOrder,
      warnings: [...warnings, '申请组已锁定；PJSDAS 不会给出替换志愿建议。'],
      generatedAt,
    }
  }

  if (capacity === undefined) {
    return {
      groupId: group.id,
      company: group.company,
      status: 'needs_rule_confirmation',
      totalSlots: group.total,
      usedSlots: group.used,
      candidateCount: rawCandidates.length,
      optimizedCandidateCount: Math.min(actionable.length, MAX_OPTIMIZED_CANDIDATES),
      minimumCandidateScore: minimumScore,
      recommended: [],
      notRecommended: evaluated.sort((a, b) => b.baseScore - a.baseScore),
      sourceRule: group.rule,
      currentOrder: group.currentOrder,
      warnings: [...warnings, '剩余申请名额无法从结构化字段确定；PJSDAS 只提供候选排序，不猜测可投数量。'],
      generatedAt,
    }
  }

  if (capacity <= 0) {
    return {
      groupId: group.id,
      company: group.company,
      status: 'capacity_exhausted',
      capacity,
      totalSlots: group.total,
      usedSlots: group.used,
      candidateCount: rawCandidates.length,
      optimizedCandidateCount: 0,
      minimumCandidateScore: minimumScore,
      recommended: [],
      notRecommended: evaluated,
      sourceRule: group.rule,
      currentOrder: group.currentOrder,
      warnings,
      generatedAt,
    }
  }

  const optimized = actionable.slice(0, MAX_OPTIMIZED_CANDIDATES)
  if (actionable.length > optimized.length) {
    warnings.push(`候选超过 ${MAX_OPTIMIZED_CANDIDATES} 个；组合优化只对基础分最高的 ${MAX_OPTIMIZED_CANDIDATES} 个执行，其他候选保留在未推荐列表。`)
  }
  const result = bestSelection(optimized, capacity, minimumScore, weights)
  const recommendedIds = new Set(result.selection.map((item) => item.opportunityId))
  const recommended = result.selection
    .map((item) => ({ ...item, disposition: 'recommended' as const }))
    .sort((a, b) => b.baseScore - a.baseScore || a.opportunityId.localeCompare(b.opportunityId))
  const notRecommended = evaluated
    .filter((item) => !recommendedIds.has(item.opportunityId))
    .map((item) => classifyNotSelected(item, recommended, capacity))
    .sort((a, b) => b.baseScore - a.baseScore || a.opportunityId.localeCompare(b.opportunityId))

  return {
    groupId: group.id,
    company: group.company,
    status: recommended.length ? 'ready' : 'no_recommendation',
    capacity,
    totalSlots: group.total,
    usedSlots: group.used,
    candidateCount: rawCandidates.length,
    optimizedCandidateCount: optimized.length,
    minimumCandidateScore: minimumScore,
    recommended,
    notRecommended,
    objectiveScore: result.objective,
    sourceRule: group.rule,
    currentOrder: group.currentOrder,
    warnings,
    generatedAt,
  }
}

export function buildAllApplicationPortfolioDecisions(
  groups: ApplicationGroup[],
  opportunities: Opportunity[],
  rules: DecisionRules,
  now = new Date(),
) {
  return groups
    .map((group) => buildApplicationPortfolioDecision(group, opportunities, rules, now))
    .sort((a, b) => {
      const order: Record<PortfolioDecisionStatus, number> = {
        ready: 0,
        needs_rule_confirmation: 1,
        no_recommendation: 2,
        capacity_exhausted: 3,
        locked: 4,
        no_candidates: 5,
      }
      return order[a.status] - order[b.status] || a.company.localeCompare(b.company) || a.groupId.localeCompare(b.groupId)
    })
}
