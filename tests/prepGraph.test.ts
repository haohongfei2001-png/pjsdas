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
  it('links explicit preparation to the real deadline without changing legacy priority fields', () => {
    const opp = opportunity({
      id: 'opp-ai-pm', company: '示例科技', role: 'AI 产品经理', deadline: '2026-09-14T23:59:00+08:00', opportunityValue: 94,
    })
    const pack = prep({ id: 'prep:project', title: '项目讲解', triggeredBy: 'opp-ai-pm', sourceStatus: '进行中' })
    const graph = buildPrepGraph([pack], [opp], [], now)
    const node = graph.nodes[0]
    expect(node.coveredOpportunityIds).toEqual(['opp-ai-pm'])
    expect(node.links[0]).toMatchObject({ source: 'explicit_trigger', confidence: 'high' })
    expect(node).not.toHaveProperty('leverageScore')

    const action: Action = {
      id: 'prep-action:project', kind: 'prep', title: '准备｜项目讲解', prepId: pack.id,
      estimatedMinutes: 90, leverage: 40, delayCost: 30, status: 'todo', createdAt: now.toISOString(), updatedAt: now.toISOString(),
    }
    const [enriched] = enrichPrepActionsWithGraph([action], graph)
    expect(enriched.leverage).toBe(40)
    expect(enriched.delayCost).toBe(30)
    expect(new Date(enriched.dueAt!).toISOString()).toBe('2026-09-14T15:59:00.000Z')
    expect(prepGraphReasonFromAction(enriched)).toContain('覆盖1岗')
  })

  it('links explicit skill requirements without creating gaps from legacy component scores', () => {
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
    expect(node.matchedNeedCount).toBe(0)
    expect(node.links[0].source).toBe('structured_requirement')
    expect(graph.needs.some((need) => need.kind === 'requirement' && need.label === 'Python')).toBe(true)
    expect(graph.needs.some((need) => need.kind === 'gap')).toBe(false)
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

  it('ignores closed opportunities when linking preparation', () => {
    const closed = opportunity({ id: 'opp-closed', company: '结束公司', role: 'SQL 分析', processStage: 'closed', detail: { gap: 'SQL' } })
    const sql = prep({ id: 'prep:sql', title: 'SQL', triggeredBy: 'opp-closed', sourceStatus: '进行中' })
    const graph = buildPrepGraph([sql], [closed], [], now)
    expect(graph.nodes[0].coverageCount).toBe(0)
  })

  it('orders preparation by actual dates, with stable IDs for undated items, regardless of legacy scores and labels', () => {
    const earlier = opportunity({ id: 'early', company: 'Earlier', role: 'Analyst', deadline: '2026-09-13T10:00:00.000Z', fitScore: 1, opportunityValue: 1 })
    const later = opportunity({ id: 'late', company: 'Later', role: 'Manager', deadline: '2026-09-20T10:00:00.000Z', fitScore: 100, opportunityValue: 100 })
    const packs = [
      prep({ id: 'z-late', title: 'Late', triggeredBy: later.id, priorityLabel: 'P0' }),
      prep({ id: 'c-undated', title: 'Undated C', priorityLabel: 'P0' }),
      prep({ id: 'a-early', title: 'Early', triggeredBy: earlier.id, priorityLabel: 'P2' }),
      prep({ id: 'b-undated', title: 'Undated B', priorityLabel: 'P2' }),
    ]
    const graph = buildPrepGraph(packs, [later, earlier], [], now)
    expect(graph.nodes.map((node) => node.prepId)).toEqual(['a-early', 'z-late', 'b-undated', 'c-undated'])
    const changedScores = buildPrepGraph(packs, [{ ...later, fitScore: 0, opportunityValue: 0 }, { ...earlier, fitScore: 100, opportunityValue: 100 }], [], now)
    expect(changedScores).toEqual(graph)
    expect(packs[0].id).toBe('z-late')
  })

  it('preserves an explicit capability gap and an explicit preparation deadline', () => {
    const opp = opportunity({ id: 'job', company: 'Example', role: 'Data', detail: { gap: 'SQL' } })
    const item = prep({ id: 'sql', title: 'SQL practice', recentNodeAt: '2026-09-14T10:00:00.000Z' })
    const graph = buildPrepGraph([item], [opp], [], now)
    expect(graph.nodes[0].nextRelevantAt).toBe('2026-09-14T10:00:00.000Z')
    expect(graph.nodes[0].links[0].source).toBe('legacy_gap')
    expect(graph.needs[0]).toMatchObject({ kind: 'gap', label: 'SQL' })
    expect(graph.needs[0]).not.toHaveProperty('severity')
  })


  it('keeps elapsed real preparation dates ahead of later or unknown dates instead of inventing a future date', () => {
    const items = [
      prep({ id: 'undated', title: 'No date' }),
      prep({ id: 'tomorrow', title: 'Tomorrow', recentNodeAt: '2026-09-13' }),
      prep({ id: 'elapsed', title: 'Elapsed', recentNodeAt: '2026-09-11' }),
    ]
    const graph = buildPrepGraph(items, [], [], now)
    expect(graph.nodes.map((node) => node.prepId)).toEqual(['elapsed', 'tomorrow', 'undated'])
    expect(graph.nodes[0].nextRelevantAt).toBe('2026-09-11')
    expect(graph.nodes[2].nextRelevantAt).toBeUndefined()
  })

})
