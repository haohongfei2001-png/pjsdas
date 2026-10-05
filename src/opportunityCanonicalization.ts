import type { Opportunity, SemanticTargetRef } from './model.js'
import type { PJSDASSnapshot } from './snapshot.js'
import { resolveOpportunityTarget } from './semanticTargetMatching.js'
import { canonicalizeJobSourceUrl, resolveOpportunityPostingIdentity, type OpportunityPostingIdentityResolution } from './jobPosting.js'

/** Resolve only explicit, persisted aliases; never guess through missing identities. */
export function canonicalOpportunityId(snapshot: PJSDASSnapshot, id: string): string {
  const aliases = snapshot.data.opportunityAliases ?? []
  const alias = aliases.find(item => item.id === id)
  if (!alias) return id
  if (snapshot.data.opportunities.some(item => item.id === id) || aliases.some(item => item.id === alias.canonicalOpportunityId)
    || !snapshot.data.opportunities.some(item => item.id === alias.canonicalOpportunityId)) throw new Error('Invalid or conflicting opportunity alias.')
  return alias.canonicalOpportunityId
}
export function opportunityIdentityCandidates(snapshot: PJSDASSnapshot): Opportunity[] {
  return [...snapshot.data.opportunities, ...(snapshot.data.opportunityAliases ?? []).map(alias => ({ ...alias.originalOpportunity, id: canonicalOpportunityId(snapshot, alias.id) }))]
}
export function resolveCanonicalOpportunityTarget(snapshot: PJSDASSnapshot, target?: SemanticTargetRef) {
  return resolveOpportunityTarget(snapshot.data.opportunities, target?.opportunityId ? { ...target, opportunityId: canonicalOpportunityId(snapshot, target.opportunityId) } : target)
}
export function resolveCanonicalPostingIdentity(snapshot: PJSDASSnapshot, observation: Parameters<typeof resolveOpportunityPostingIdentity>[0]): OpportunityPostingIdentityResolution {
  // Check each source identity independently, then collapse aliases before deciding ambiguity.
  const matches = opportunityIdentityCandidates(snapshot).map(item => resolveOpportunityPostingIdentity(observation, [item]))
  const exact = [...new Set(matches.flatMap(result => result.kind === 'same_posting' ? [result.opportunity.id] : []))]
  if (exact.length === 1) return { kind: 'same_posting' as const, opportunity: snapshot.data.opportunities.find(item => item.id === exact[0])!, canonicalSourceUrl: canonicalizeJobSourceUrl(observation.sourceUrl) }
  if (exact.length > 1) return { kind: 'ambiguous', opportunities: snapshot.data.opportunities.filter(item => exact.includes(item.id)), canonicalSourceUrl: canonicalizeJobSourceUrl(observation.sourceUrl), reason: 'multiple_same_posting' }
  return resolveOpportunityPostingIdentity(observation, snapshot.data.opportunities)
}

/** Compare semantic identity without rewriting immutable source receipts or their dictionary keys. */
export function canonicalSemanticFactKey(snapshot: PJSDASSnapshot, key: string): string {
  const prefix = /^(application_submitted|opportunity_deadline|abandon_opportunity|process_event|external_withdrawal)\|opp:/.exec(key)?.[0]
  if (!prefix) return key
  const identity = key.slice(prefix.length)
  const ids = [...snapshot.data.opportunities.map(item => item.id), ...(snapshot.data.opportunityAliases ?? []).map(item => item.id)].sort((a, b) => b.length - a.length)
  const id = ids.find(item => identity === item || identity.startsWith(`${item}|`))
  return id ? `${prefix}${canonicalOpportunityId(snapshot, id)}${identity.slice(id.length)}` : key
}
export function sameSemanticFactKey(snapshot: PJSDASSnapshot, a: string, b: string): boolean {
  return canonicalSemanticFactKey(snapshot, a) === canonicalSemanticFactKey(snapshot, b)
}
