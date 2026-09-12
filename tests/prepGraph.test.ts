import { describe, expect, it } from 'vitest'
import { buildPrepGraph, enrichPrepActionsWithGraph, prepGraphReasonFromAction } from '../src/prepGraph.js'
import type { Action, Opportunity, Prep, ProcessRecord } from '../src/model.js'

const now = new Date('2026-09-12T08:00:00+08:00')

function opportunity(input: Partial<Opportunity> & Pick<Opportunity, 'id' | 'company' | 'role'>): Opportunity {
  return {
    id: input.id,
    company: input.company,
    role: input.role,
    currentStageLabel: input.currentStageLabel ?? '待投',
    processStage: input.processStage ?? 'not_applied',
    roleType: input.roleType ?? 'core',
    early: input.early ?? false,
    deadline: input.deadline,
    applicationGroupId: input.applicationGroupId,
    opportunityValue: input.opportunityValue ?? 86,
    fitScore: input.fitScore ?? 80,
    detail: input.detail,
    importedAt: input.importedAt ?? now.toISOString(),
  }
}

function prep(input: Partial<Prep> & Pick<Prep, 'id' | 'title'>): Prep {
  return {
    id: input.id,
    title: input.title,
    triggeredBy: input.triggeredBy,
    priorityLabel: input.priorityLabel,
    recentNodeAt: input.recentNodeAt,
    minimumOutput: input.minimumOutput,
    estimatedMinutes: input.estimatedMinutes ?? 90,
    triggerRule: input.triggerRule,
    sourceStatus: input.sourceStatus,
    createdAt: input.createdAt ?? now.toISOString(),
    updatedAt: input.updatedAt ?? now.toISOString(),
  }
}

describe('v1.6 Round 2 Prep Graph', () => {
  it('links an explicit trigger to a structured opportunity and raises leverage without lowering explicit priority', () => {
    const opp = opportunity({
      id: 'opp-ai-pm', company: '示例科技', role: 'AI 产品经理', deadline: '2026-09-14T23:59:00+08:00', opportunityValue: 94,
    })
    const pack = prep({ id: 'prep:project', title: '项目讲解', triggeredBy: 'opp-ai-pm', sourceStatus: '进行中' })
    const graph = buildPrepGraph([pack], [opp], [], now)
    const node = graph.nodes[0]
    expect(node.coveredOpportunityIds).toEqual(['opp-ai-pm'])
    expect(node.links[0]).toMatchObject({ source: 'explicit_trigger', confidence: 'high' })
    expect(node.leverageScore).toBeGreaterThan(50)

    const action: Action = {
      id: 'prep-action:project', kind: 'prep', title: '准备｜项目讲解', prepId: pack.id,
      estimatedMinutes: 90, leverage: 40, delayCost: 30, status: 'todo', createdAt: now.toISOString(), updatedAt: now.toISOString(),
    }
    const [enriched] = enrichPrepActionsWithGraph([action], graph)
    expect(enriched.leverage).toBeGreaterThan(40)
    expect(enriched.dueAt).toBe('2026-09-14T15:59:00.000Z')
    expect(prepGraphReasonFromAction(enriched)).toContain('覆盖1岗')
  })

  it('creates an explainable structured gap link from a low skill component and exact skill match', () => {
    const opp = opportunity({
      id: 'opp-data', company: '数据科技', role: '商业分析',
      detail: {
        facts: {
          version: 1,
          identity: {},
          role: { skills: ['SQL', 'Python'] },
          application: {},
          compensation: {},
          evidence: { sourceUrl: 'https://example.com/job', sourceTitle: 'job', verifiedAt: now.toISOString() },
          unknownFields: [],
        },
        assessment: {
          version: 1,
          mode: 'component',
          fit: { skills: { score: 55, confidence: 'high', rationale: 'SQL 基础需要补强。' } },
          opportunityValue: { companyQuality: { score: 80, confidence: 'high', rationale: '平台稳定。' } },
          assessedAt: now.toISOString(),
        },
      },
    })
    const sql = prep({ id: 'prep:sql', title: 'SQL 刷题', minimumOutput: '完成 SQL 高频题', sourceStatus: '进行中' })
    const graph = buildPrepGraph([sql], [opp], [], now)
    const node = graph.nodes[0]
    expect(node.coveredOpportunityIds).toContain('opp-data')
    expect(node.matchedNeedCount).toBeGreaterThan(0)
    expect(node.links[0].source).toBe('structured_gap')
    expect(graph.uncoveredNeeds.some((need) => need.label === 'Python')).toBe(true)
  })

  it('uses explicit process prep packs and suggests activation for waiting prep without silently creating an Action', () => {
    const opp = opportunity({ id: 'opp-interview', company: '示例汽车', role: '战略规划', processStage: 'interview' })
    const pack = prep({ id: 'prep:case', title: 'Case 面试', sourceStatus: '等待触发' })
    const processes: ProcessRecord[] = [{
      id: 'process:1', opportunityId: opp.id, company: opp.company, role: opp.role,
      stage: 'interview', stageLabel: '一面', prepPack: 'Case 面试', locallyManaged: true,
    }]
    const graph = buildPrepGraph([pack], [opp], processes, now)
    const node = graph.nodes[0]
    expect(node.links.some((link) => link.source === 'process_pack')).toBe(true)
    expect(node.triggerSuggested).toBe(true)
    expect(enrichPrepActionsWithGraph([], graph)).toEqual([])
  })

  it('does not connect generic words such as 产品 or 分析 as capability edges', () => {
    const opp = opportunity({
      id: 'opp-product', company: '普通科技', role: '产品运营',
      detail: {
        facts: {
          version: 1,
          identity: {}, role: { skills: ['产品分析'] }, application: {}, compensation: {},
          evidence: { sourceUrl: 'https://example.com/p', sourceTitle: 'p', verifiedAt: now.toISOString() }, unknownFields: [],
        },
      },
    })
    const generic = prep({ id: 'prep:generic', title: '分析', sourceStatus: '进行中' })
    const graph = buildPrepGraph([generic], [opp], [], now)
    expect(graph.nodes[0].coverageCount).toBe(0)
  })

  it('ignores closed opportunities when calculating prep leverage', () => {
    const closed = opportunity({ id: 'opp-closed', company: '结束公司', role: 'SQL 分析', processStage: 'closed', detail: { gap: 'SQL' } })
    const sql = prep({ id: 'prep:sql', title: 'SQL', triggeredBy: 'opp-closed', sourceStatus: '进行中' })
    const graph = buildPrepGraph([sql], [closed], [], now)
    expect(graph.nodes[0].coverageCount).toBe(0)
  })
})
