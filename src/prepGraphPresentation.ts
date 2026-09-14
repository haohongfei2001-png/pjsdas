import type { PrepGraphLink, PrepOpportunityNeed } from './prepGraph.js'

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

export function presentPrepSourceStatus(value: string | undefined, zh: boolean) {
  if (!value) return zh ? '状态未知' : 'Unknown status'
  const normalized = value.trim().toLocaleLowerCase()
  if (normalized === '等待触发' || normalized === 'waiting') return zh ? '等待触发' : 'Waiting'
  if (normalized === 'active' || normalized === '已激活' || normalized === '进行中') return zh ? '进行中' : 'Active'
  if (normalized === 'done' || normalized === 'completed' || normalized === '已完成') return zh ? '已完成' : 'Completed'
  if (normalized === 'paused' || normalized === '暂停') return zh ? '暂停' : 'Paused'
  return value
}
