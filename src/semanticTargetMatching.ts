import { jobRoleSimilarity, normalizeJobCompany } from './jobPosting.js'
import type { Opportunity, SemanticTargetRef } from './model.js'

export type OpportunityResolution =
  | { status: 'unique'; opportunity: Opportunity }
  | { status: 'ambiguous'; opportunities: Opportunity[] }
  | { status: 'missing'; opportunities: Opportunity[] }

function normalCompany(value: string) {
  return normalizeJobCompany(value).replace(/(?:校园招聘|校园|校招|招聘)$/g, '').trim()
}

/** Shared identity rules for applying a candidate and displaying its choices. */
export function resolveOpportunityTarget(opportunities: Opportunity[], target?: SemanticTargetRef): OpportunityResolution {
  if (!target || (!target.opportunityId && !target.company?.trim() && !target.role?.trim())) {
    return { status: 'missing', opportunities: [] }
  }
  if (target.opportunityId) {
    const exact = opportunities.find(item => item.id === target.opportunityId)
    return exact ? { status: 'unique', opportunity: exact } : { status: 'missing', opportunities: [] }
  }

  let pool = opportunities
  if (target.company?.trim()) {
    const company = normalCompany(target.company)
    pool = pool.filter(item => normalCompany(item.company) === company)
  }
  if (target.role?.trim()) {
    const role = target.role.trim()
    const scored = pool
      .map(item => ({ item, score: jobRoleSimilarity(role, item.role) }))
      .filter(item => item.score >= 0.84)
      .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id))
    if (scored.length === 1) return { status: 'unique', opportunity: scored[0]!.item }
    if (scored.length > 1 && scored[0]!.score >= 0.94 && scored[0]!.score - scored[1]!.score >= 0.12) {
      return { status: 'unique', opportunity: scored[0]!.item }
    }
    pool = scored.map(item => item.item)
  }

  const active = pool.filter(item => item.processStage !== 'closed')
  if (active.length === 1) return { status: 'unique', opportunity: active[0]! }
  if (active.length > 1) return { status: 'ambiguous', opportunities: active }
  if (pool.length === 1) return { status: 'unique', opportunity: pool[0]! }
  return pool.length > 1
    ? { status: 'ambiguous', opportunities: pool }
    : { status: 'missing', opportunities: [] }
}
