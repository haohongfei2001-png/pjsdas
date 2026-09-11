import { describe, expect, it } from 'vitest'
import { listOpportunitiesSchema } from '../gateway/readTools.js'
import { enrichOpportunityListWithFacts } from '../src/ai/richOpportunityRead.js'
import { createOpportunityFacts } from '../src/richOpportunity.js'
import type { PJSDASSnapshot } from '../src/snapshot.js'

const facts = createOpportunityFacts({
  sourceUrl: 'https://careers.example.com/rich-read',
  sourceTitle: '读取科技 AI 产品经理',
  verifiedAt: '2026-09-12T09:00:00.000Z',
  location: '北京',
  facts: {
    responsibilities: ['负责 AI 产品规划'],
    requirements: ['具备结构化分析能力'],
    skills: ['SQL'],
  },
})

const snapshot: PJSDASSnapshot = {
  schema: 'pjsdas-local-snapshot',
  version: 1,
  exportedAt: '2026-09-12T10:00:00.000Z',
  data: {
    opportunities: [{
      id: 'rich-1',
      company: '读取科技',
      role: 'AI 产品经理',
      currentStageLabel: '待投',
      processStage: 'not_applied',
      roleType: 'core',
      early: false,
      opportunityValue: 88,
      fitScore: 84,
      importedAt: '2026-09-12T09:00:00.000Z',
      detail: { facts },
    }],
    processes: [],
    processEvents: [],
    actions: [],
    prep: [],
    applicationGroups: [],
  },
}

const baseOutput = {
  meta: { generatedAt: '2026-09-12T10:00:00.000Z', timezone: 'Asia/Shanghai', source: 'pjsdas' as const },
  opportunities: [{ opportunityId: 'rich-1', company: '读取科技', role: 'AI 产品经理' }],
  truncated: false,
}

describe('v1.5 Round 1 Rich Opportunity read projection', () => {
  it('returns completeness without dumping full facts by default', () => {
    const result = enrichOpportunityListWithFacts(snapshot, baseOutput, false)
    expect(result.opportunities[0].factsAvailable).toBe(true)
    expect(result.opportunities[0].factCompleteness.percent).toBeGreaterThan(0)
    expect(result.opportunities[0].facts).toBeUndefined()
  })

  it('returns source-backed facts only when explicitly requested', () => {
    const result = enrichOpportunityListWithFacts(snapshot, baseOutput, true)
    expect(result.opportunities[0].facts?.role.responsibilities).toEqual(['负责 AI 产品规划'])
    expect(result.opportunities[0].facts?.unknownFields).toContain('education')
  })

  it('bounds includeFacts queries to twenty opportunities', () => {
    expect(listOpportunitiesSchema.safeParse({ includeFacts: true, limit: 20 }).success).toBe(true)
    expect(listOpportunitiesSchema.safeParse({ includeFacts: true, limit: 21 }).success).toBe(false)
    expect(listOpportunitiesSchema.safeParse({ limit: 30 }).success).toBe(true)
  })
})
