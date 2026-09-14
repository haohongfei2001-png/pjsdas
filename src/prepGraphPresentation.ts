import type { PrepGraphLink } from './prepGraph.js'

export function prepGraphLinkExplanation(link: PrepGraphLink, zh: boolean) {
  if (zh) return link.explanation

  switch (link.source) {
    case 'explicit_trigger':
      return 'This Prep explicitly targets the opportunity or its Application Group.'
    case 'process_pack':
      return 'The active recruiting process explicitly references a prep pack that matches this Prep.'
    case 'structured_requirement':
      return 'This Prep deterministically matches a structured role requirement.'
    case 'structured_gap':
      return 'This Prep deterministically matches a structured capability gap.'
    case 'legacy_gap':
      return 'This Prep deterministically matches an explicit opportunity gap.'
    case 'process_stage':
      return 'This Prep deterministically matches preparation required by the current recruiting stage.'
  }
}
