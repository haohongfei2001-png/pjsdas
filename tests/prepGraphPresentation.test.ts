import { describe, expect, it } from 'vitest'
import { presentPrepGraphLinkExplanation, presentPrepSourceStatus } from '../src/prepGraphPresentation.js'
import type { PrepGraphLink, PrepOpportunityNeed } from '../src/prepGraph.js'

const need: PrepOpportunityNeed = {
  id: 'job-1:gap:sql',
  opportunityId: 'job-1',
  company: 'Example',
  role: 'AI PM',
  kind: 'gap',
  label: 'SQL',
  severity: 80,
  source: 'Fit assessment · skills 55',
}

function link(source: PrepGraphLink['source'], matchedNeedIds: string[] = []): PrepGraphLink {
  return {
    prepId: 'prep-1',
    opportunityId: 'job-1',
    source,
    confidence: 'high',
    matchedNeedIds,
    explanation: '中文原始解释',
  }
}

describe('Prep Graph presentation', () => {
  it('keeps the stored Chinese explanation in Chinese UI', () => {
    expect(presentPrepGraphLinkExplanation(link('structured_gap', [need.id]), [need], true)).toBe('中文原始解释')
  })

  it('renders structured gap explanations in English without mutating the graph fact', () => {
    expect(presentPrepGraphLinkExplanation(link('structured_gap', [need.id]), [need], false)).toBe(
      'The Prep text exactly matches the current capability gap “SQL”.',
    )
  })

  it('renders explicit trigger and process-pack semantics directly', () => {
    expect(presentPrepGraphLinkExplanation(link('explicit_trigger'), [], false)).toContain('explicitly names the opportunity')
    expect(presentPrepGraphLinkExplanation(link('process_pack'), [], false)).toContain('preparation pack')
  })

  it('localizes only known source-status values and preserves unknown source text', () => {
    expect(presentPrepSourceStatus('等待触发', false)).toBe('Waiting')
    expect(presentPrepSourceStatus('active', true)).toBe('进行中')
    expect(presentPrepSourceStatus('custom-source-state', false)).toBe('custom-source-state')
  })
})
