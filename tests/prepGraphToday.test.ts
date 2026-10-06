import { describe, expect, it } from 'vitest'
import { rankActions } from '../src/decisionV3.js'
import type { Action, Opportunity } from '../src/model.js'

const now = new Date('2026-09-12T08:00:00+08:00')

const sqlOpportunity: Opportunity = {
  id: 'opp-sql',
  company: '分析科技',
  role: '数据分析',
  currentStageLabel: '待投',
  processStage: 'not_applied',
  roleType: 'core',
  early: false,
  deadline: '2026-09-14T23:59:00+08:00',
  opportunityValue: 92,
  fitScore: 78,
  detail: {
    facts: {
      version: 1,
      identity: {},
      role: { skills: ['SQL'] },
      application: {},
      compensation: {},
      evidence: { sourceUrl: 'https://example.com/sql', sourceTitle: 'sql', verifiedAt: now.toISOString() },
      unknownFields: [],
    },
    assessment: {
      version: 1,
      mode: 'component',
      fit: { skills: { score: 55, confidence: 'high', rationale: 'SQL 需要补强。' } },
      opportunityValue: { companyQuality: { score: 90, confidence: 'high', rationale: '平台较强。' } },
      assessedAt: now.toISOString(),
    },
  },
  importedAt: now.toISOString(),
}

function prepAction(title: string): Action {
  return {
    id: `prep:${title}`,
    kind: 'prep',
    title: `准备｜${title}`,
    prepId: `prep:${title}`,
    estimatedMinutes: 90,
    leverage: 30,
    delayCost: 20,
    status: 'todo',
    sourceLabel: '准备中心',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }
}

describe('v1.6 Round 2 Today Prep Graph projection', () => {
  it('does not turn a title match or legacy fit assessment into a preparation priority boost', () => {
    const original = prepAction('SQL 刷题')
    const ranked = rankActions([original], [sqlOpportunity], now)
    expect(ranked).toHaveLength(1)
    expect(ranked[0].action.leverage).toBe(original.leverage)
    expect(ranked[0].action.delayCost).toBe(original.delayCost)
    expect(ranked[0].action.sourceLabel).toBe(original.sourceLabel)
    expect(ranked[0].reasons.join(' ')).not.toContain('覆盖1岗')
    expect(original).toMatchObject({ leverage: 30, delayCost: 20, sourceLabel: '准备中心' })
    expect(original).not.toHaveProperty('dueAt')
  })

  it('does not make an unlinked Prep claim that it is reusable across roles', () => {
    const original = prepAction('随手整理')
    const ranked = rankActions([original], [sqlOpportunity], now)
    expect(ranked[0].action.leverage).toBe(30)
    expect(ranked[0].reasons).toContain('截止日期未明确，排在已知截止之后')
    expect(ranked[0].reasons).not.toContain('可复用于多个岗位')
  })
})
