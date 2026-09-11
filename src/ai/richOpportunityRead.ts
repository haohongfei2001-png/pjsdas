import { cloneOpportunityFacts, opportunityFactsCompleteness } from '../richOpportunity.js'
import type { PJSDASSnapshot } from '../snapshot.js'

export function enrichOpportunityListWithFacts<
  T extends { opportunities: Array<{ opportunityId: string }> },
>(snapshot: PJSDASSnapshot, output: T, includeFacts = false) {
  const byId = new Map(snapshot.data.opportunities.map((item) => [item.id, item]))
  return {
    ...output,
    opportunities: output.opportunities.map((item) => {
      const opportunity = byId.get(item.opportunityId)
      const facts = opportunity?.detail?.facts
      return {
        ...item,
        factCompleteness: opportunityFactsCompleteness(facts),
        factsAvailable: Boolean(facts),
        facts: includeFacts ? cloneOpportunityFacts(facts) : undefined,
      }
    }),
  }
}
