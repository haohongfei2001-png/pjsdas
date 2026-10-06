import { describe, expect, it } from 'vitest'
import {
  discoveryDecisionSummary,
  sortDiscoveryInboxItems,
} from '../src/discoveryDecision.js'
import { createJobPostingEvidence } from '../src/jobPosting.js'
import type { DiscoveryInboxItem } from '../src/model.js'

function candidate(overrides: Partial<DiscoveryInboxItem> = {}): DiscoveryInboxItem {
  return {
    id: 'inbox:job-1',
    candidateOpportunityId: 'job-1',
    company: '甲公司',
    role: 'AI 产品经理',
    roleType: 'core',
    sourceUrl: 'https://careers.example.com/job-1',
    sourceTitle: '甲公司 AI 产品经理',
    location: '北京',
    deadline: '2026-09-30T23:59:59+08:00',
    compensationText: '25-35 万/年',
    rationale: '匹配 AI 产品方向。',
    opportunityValue: 90,
    fitScore: 86,
    fitConfidence: 'high',
    opportunityValueConfidence: 'medium',
    status: 'new',
    discoveredAt: '2026-09-12T08:00:00.000Z',
    createdAt: '2026-09-12T08:00:00.000Z',
    updatedAt: '2026-09-12T08:00:00.000Z',
    ...overrides,
  }
}

describe('v1.4 round 2/3 discovery decision workspace', () => {
  it('reports missing decision facts without fabricating unknown values', () => {
    const summary = discoveryDecisionSummary(candidate({ location: undefined, compensationText: undefined }))
    expect(summary.knownFacts).toBe(1)
    expect(summary.totalFacts).toBe(3)
    expect(summary.completenessPercent).toBe(33)
    expect(summary.missing.map((entry) => entry.key)).toEqual(['location', 'compensation'])
  })

  it('surfaces source status and near-deadline risks without score-confidence judgments', () => {
    const summary = discoveryDecisionSummary(candidate({
      deadline: '2026-09-14T10:00:00.000Z',
      fitConfidence: 'low',
      opportunityValueConfidence: 'low',
      profileWarnings: ['地点不在首选范围'],
    }), new Date('2026-09-12T10:00:00.000Z'))
    expect(summary.risks.map((entry) => entry.key)).toEqual([
      'profile-warnings',
      'posting-status-unknown',
      'deadline-soon',
    ])
  })

  it('surfaces stale source evidence separately from score uncertainty', () => {
    const posting = createJobPostingEvidence({
      company: '甲公司', role: 'AI 产品经理', sourceUrl: 'https://careers.example.com/job-1', sourceTitle: '甲公司 AI 产品经理',
      location: '北京', postingStatus: 'open', observedAt: '2026-08-01T00:00:00.000Z',
    })
    const summary = discoveryDecisionSummary(candidate({ posting }), new Date('2026-09-12T10:00:00.000Z'))
    expect(summary.risks.map((entry) => entry.key)).toContain('source-stale')
    expect(summary.strengths.map((entry) => entry.key)).not.toContain('source-fresh-open')
  })

  it('marks a recently verified open source as a positive signal', () => {
    const posting = createJobPostingEvidence({
      company: '甲公司', role: 'AI 产品经理', sourceUrl: 'https://careers.example.com/job-1', sourceTitle: '甲公司 AI 产品经理',
      location: '北京', postingStatus: 'open', observedAt: '2026-09-11T00:00:00.000Z',
    })
    const summary = discoveryDecisionSummary(candidate({ posting }), new Date('2026-09-12T10:00:00.000Z'))
    expect(summary.strengths.map((entry) => entry.key)).toContain('source-fresh-open')
    expect(summary.risks.map((entry) => entry.key)).not.toContain('posting-status-unknown')
  })

  it('orders every status by deadline and ignores legacy scores, confidence and timestamps', () => {
    const earlier = candidate({ id: 'earlier', deadline: '2026-09-15T00:00:00.000Z', fitScore: 1, opportunityValue: 1, status: 'promoted', fitConfidence: 'low' })
    const later = candidate({ id: 'later', deadline: '2026-09-20T00:00:00.000Z', fitScore: 99, opportunityValue: 99, status: 'new' })
    expect(sortDiscoveryInboxItems([later, earlier]).map((item) => item.id)).toEqual(['earlier', 'later'])
  })

  it('puts unknown or invalid deadlines last, breaks equal dates by stable ID, and does not mutate inputs', () => {
    const a = candidate({ id: 'a', deadline: '2026-09-20T00:00:00.000Z' })
    const b = candidate({ id: 'b', deadline: '2026-09-20T00:00:00.000Z' })
    const unknown = candidate({ id: 'unknown', deadline: undefined })
    const invalid = candidate({ id: 'invalid', deadline: 'invalid' })
    const items = [unknown, b, invalid, a]
    expect(sortDiscoveryInboxItems(items).map((item) => item.id)).toEqual(['a', 'b', 'invalid', 'unknown'])
    expect(items.map((item) => item.id)).toEqual(['unknown', 'b', 'invalid', 'a'])
  })

  it('preserves factual summaries identically regardless of legacy score values', () => {
    const low = candidate({ fitScore: 0, opportunityValue: 0, fitConfidence: 'low', opportunityValueConfidence: 'low' })
    const high = candidate({ fitScore: 100, opportunityValue: 100, fitConfidence: 'high', opportunityValueConfidence: 'high' })
    const now = new Date('2026-09-12T10:00:00.000Z')
    expect(discoveryDecisionSummary(low, now)).toEqual(discoveryDecisionSummary(high, now))
    expect(discoveryDecisionSummary(high, now)).not.toHaveProperty('reviewScore')
  })
})
