import { describe, expect, it } from 'vitest'
import {
  discoveryDecisionSummary,
  discoveryReviewScore,
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
  it('keeps the inbox review reference transparent and separate from formal priority', () => {
    expect(discoveryReviewScore(candidate({ fitScore: 82, opportunityValue: 94 }))).toBe(88)
  })

  it('reports missing decision facts without fabricating unknown values', () => {
    const summary = discoveryDecisionSummary(candidate({ location: undefined, compensationText: undefined }))
    expect(summary.knownFacts).toBe(1)
    expect(summary.totalFacts).toBe(3)
    expect(summary.completenessPercent).toBe(33)
    expect(summary.missing.map((entry) => entry.key)).toEqual(['location', 'compensation'])
  })

  it('surfaces low-confidence, unknown source status and near-deadline risks deterministically', () => {
    const summary = discoveryDecisionSummary(candidate({
      deadline: '2026-09-14T10:00:00.000Z',
      fitConfidence: 'low',
      opportunityValueConfidence: 'low',
      profileWarnings: ['地点不在首选范围'],
    }), new Date('2026-09-12T10:00:00.000Z'))
    expect(summary.risks.map((entry) => entry.key)).toEqual([
      'fit-low-confidence',
      'opportunity-low-confidence',
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

  it('keeps active candidates ahead of archived candidates in review-priority sorting', () => {
    const active = candidate({ id: 'active', fitScore: 80, opportunityValue: 80, status: 'new' })
    const promoted = candidate({ id: 'promoted', fitScore: 99, opportunityValue: 99, status: 'promoted' })
    expect(sortDiscoveryInboxItems([promoted, active], 'review_priority').map((item) => item.id)).toEqual(['active', 'promoted'])
  })

  it('can sort by information completeness and deadline without treating unknown deadlines as urgent', () => {
    const complete = candidate({ id: 'complete', deadline: '2026-09-20T00:00:00.000Z' })
    const incomplete = candidate({ id: 'incomplete', location: undefined, compensationText: undefined, deadline: undefined })
    expect(sortDiscoveryInboxItems([incomplete, complete], 'completeness').map((item) => item.id)).toEqual(['complete', 'incomplete'])
    expect(sortDiscoveryInboxItems([incomplete, complete], 'deadline').map((item) => item.id)).toEqual(['complete', 'incomplete'])
  })
})
