import { resolveApplicationDeadline, applicationDeadlineExpired, type ResolvedApplicationDeadline } from './applicationDeadline.js'
import type { DecisionRules } from './decisionRules.js'
import { compareDeadlines } from './deadlineOrder.js'
import type { ApplicationGroup, Opportunity, DatePrecision } from './model.js'

export type PortfolioDecisionStatus = 'ready' | 'needs_rule_confirmation' | 'capacity_exhausted' | 'locked' | 'no_candidates'
export type PortfolioWarning =
  | { code: 'capacity_fields_inconsistent'; total: number; used: number; derived: number; remaining: number }
  | { code: 'current_order_context' } | { code: 'group_locked' } | { code: 'capacity_unknown' }
export interface PortfolioCandidateDecision {
  opportunityId: string
  company: string
  role: string
  roleType: Opportunity['roleType']
  deadline?: string
  deadlinePrecision?: DatePrecision
  deadlineState: 'confirmed' | 'unknown'
  processStage: Opportunity['processStage']
  participationStatus: string
  deadlineExpired: boolean
}
export interface ApplicationPortfolioDecision {
  contractVersion: 2
  groupId: string
  company: string
  status: PortfolioDecisionStatus
  capacity?: number
  totalSlots?: number
  usedSlots?: number
  candidateCount: number
  candidates: PortfolioCandidateDecision[]
  sourceRule?: string
  currentOrder?: string
  warnings: PortfolioWarning[]
  generatedAt: string
}

/** Factual quota and deadline list. It never selects, scores or fills application slots. */
export function buildApplicationPortfolioDecision(group: ApplicationGroup, opportunities: Array<Opportunity & { deadlineResolution?: ResolvedApplicationDeadline }>, _rules?: DecisionRules,
  now = new Date(), timezone = 'UTC'): ApplicationPortfolioDecision {
  const capacity = group.remaining !== undefined && Number.isFinite(group.remaining) ? Math.max(0, Math.floor(group.remaining))
    : group.total !== undefined && group.used !== undefined && Number.isFinite(group.total) && Number.isFinite(group.used)
      ? Math.max(0, Math.floor(group.total - group.used)) : undefined
  const warnings: PortfolioWarning[] = []
  if (group.total !== undefined && group.used !== undefined && group.remaining !== undefined && group.total - group.used !== group.remaining) {
    warnings.push({ code: 'capacity_fields_inconsistent', total: group.total, used: group.used, derived: group.total - group.used, remaining: group.remaining })
  }
  if (group.currentOrder) warnings.push({ code: 'current_order_context' })
  if (group.locked) warnings.push({ code: 'group_locked' })
  if (capacity === undefined) warnings.push({ code: 'capacity_unknown' })
  const candidates = opportunities.filter(item => item.applicationGroupId === group.id)
    .map(item => ({ item, resolved: item.deadlineResolution ?? resolveApplicationDeadline(item, {}) }))
    .sort((a, b) => Number(a.item.processStage === 'closed' || a.item.participationStatus === 'abandoned') - Number(b.item.processStage === 'closed' || b.item.participationStatus === 'abandoned') || compareDeadlines({ id: a.item.id, deadline: a.resolved.deadline, precision: a.resolved.precision, timezone: a.resolved.timezone },
      { id: b.item.id, deadline: b.resolved.deadline, precision: b.resolved.precision, timezone: b.resolved.timezone }, timezone)).map(({ item, resolved }) => ({
      opportunityId: item.id, company: item.company, role: item.role, roleType: item.roleType,
      deadline: resolved.deadline, deadlinePrecision: resolved.precision, deadlineState: resolved.state, processStage: item.processStage, participationStatus: item.participationStatus ?? 'active',
      deadlineExpired: applicationDeadlineExpired(resolved, now, timezone),
    }))
  return { contractVersion: 2, groupId: group.id, company: group.company,
    status: group.locked ? 'locked' : !candidates.length ? 'no_candidates' : capacity === undefined ? 'needs_rule_confirmation' : capacity === 0 ? 'capacity_exhausted' : 'ready',
    capacity, totalSlots: group.total, usedSlots: group.used, candidateCount: candidates.length, candidates,
    sourceRule: group.rule, currentOrder: group.currentOrder, warnings, generatedAt: now.toISOString() }
}
