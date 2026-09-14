import type { PrepGraphLink, PrepOpportunityNeed } from './prepGraph.js'
import { presentPrepSourceState } from './prepSemantics.js'

function matchedNeed(link: PrepGraphLink, needs: PrepOpportunityNeed[]) {
  for (const id of link.matchedNeedIds) {
    const need = needs.find((item) => item.id === id)
    if (need) return need
  }
  return undefined
}

export function presentPrepGraphLinkExplanation(
  link: PrepGraphLink,
  needs: PrepOpportunityNeed[],
  zh: boolean,
) {
  if (zh) return link.explanation

  const need = matchedNeed(link, needs)
  switch (link.source) {
    case 'explicit_trigger':
      return 'This Prep explicitly names the opportunity or its application group as a trigger.'
    case 'process_pack':
      return 'The active recruiting process explicitly links this Prep through its preparation pack.'
    case 'structured_requirement':
      return need
        ? `The Prep text exactly matches the structured requirement “${need.label}”.`
        : 'The Prep text exactly matches a structured role requirement.'
    case 'structured_gap':
    case 'legacy_gap':
      return need
        ? `The Prep text exactly matches the current capability gap “${need.label}”.`
        : 'The Prep text exactly matches a current capability gap.'
    case 'process_stage':
      return need
        ? `The Prep text exactly matches the current process-preparation need “${need.label}”.`
        : 'The Prep text exactly matches a current process-preparation need.'
  }
}

export const presentPrepSourceStatus = presentPrepSourceState
