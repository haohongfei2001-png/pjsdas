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

describe('retired preparation Today projection', () => {
  it.each(['SQL 刷题', '随手整理'])('never recommends retained preparation: %s', title => {
    const original = prepAction(title), before = structuredClone(original)
    expect(rankActions([original], [sqlOpportunity], now)).toEqual([])
    expect(original).toEqual(before)
  })
})
