import { describe, expect, it } from 'vitest'
import {
  createDiscoveryFeedbackRecords,
  deriveDiscoveryReviewChangeSet,
  recentRejectedDiscoveryFeedback,
} from '../src/discoveryFeedback.js'
import type { ChangeSetRecord } from '../src/changeSet.js'
import type { Opportunity, TimelineRecord } from '../src/model.js'

function opportunity(id: string, company: string, role: string): Opportunity {
  return {
    id,
    company,
    role,
    currentStageLabel: '待投',
    processStage: 'not_applied',
    roleType: 'core',
    early: false,
    opportunityValue: 85,
    fitScore: 78,
    locallyManaged: true,
    importedAt: '2026-09-11T10:00:00.000Z',
    detail: {
      discovery: {
        sourceUrl: `https://careers.example.com/${id}`,
        sourceTitle: `${company} ${role}`,
        rationale: '测试来源证据',
        discoveredAt: '2026-09-11T10:00:00.000Z',
        fitConfidence: 'medium',
        opportunityValueConfidence: 'medium',
      },
    },
  }
}

const changeSet: ChangeSetRecord = {
  id: 'CS-MCP-ROUND3',
  version: 1,
  source: 'mcp',
  status: 'pending',
  title: 'ChatGPT 岗位发现 · 2 个候选',
  createdAt: '2026-09-11T10:00:00.000Z',
  updatedAt: '2026-09-11T10:00:00.000Z',
  operations: [
    { id: 'discovery:add:a', kind: 'add_discovered_opportunity', summary: '新增 A', opportunity: opportunity('a', '甲公司', 'AI 产品经理') },
    { id: 'discovery:add:b', kind: 'add_discovered_opportunity', summary: '新增 B', opportunity: opportunity('b', '乙公司', '商业分析') },
  ],
}

describe('Round 3 discovery review feedback', () => {
  it('derives an auditable subset ChangeSet from the signed discovery operations only', () => {
    const reviewed = deriveDiscoveryReviewChangeSet(changeSet, new Set(['discovery:add:a']))
    expect(reviewed.operations).toHaveLength(1)
    expect(reviewed.operations[0].id).toBe('discovery:add:a')
    expect(reviewed.title).toContain('已选 1/2')
  })

  it('records accepted, rejected, filtered, duplicate and deferred outcomes after explicit review', () => {
    const records = createDiscoveryFeedbackRecords(
      changeSet,
      new Set(['discovery:add:a']),
      { 'discovery:add:b': { code: 'location' } },
      {
        received: 5,
        accepted: 2,
        duplicateCount: 1,
        rejectedCount: 1,
        deferredCount: 1,
        skippedDuplicates: [{ company: '丙公司', role: 'AI 产品经理', reason: '重复' }],
        rejectedCandidates: [{ company: '丁公司', role: '销售', reasons: ['命中排除条件'] }],
        deferredCandidates: [{ company: '戊公司', role: '产品运营', qualityScore: 71, reason: '超过审阅上限' }],
      },
      new Date('2026-09-11T12:00:00.000Z'),
    )
    expect(records.map((item) => item.discoveryDecision)).toEqual([
      'accepted', 'rejected', 'duplicate', 'filtered', 'deferred',
    ])
    expect(records.find((item) => item.discoveryDecision === 'rejected')?.discoveryReasonCode).toBe('location')
  })

  it('treats a later accepted decision as overriding an earlier rejection for rediscovery suppression', () => {
    const timeline: TimelineRecord[] = [
      {
        id: 'r1', kind: 'discovery_rejected', category: 'opportunity', source: 'user_action',
        occurredAt: '2026-09-01T00:00:00.000Z', recordedAt: '2026-09-01T00:00:00.000Z',
        title: '拒绝', company: '甲公司', role: 'AI 产品经理', discoveryDecision: 'rejected',
      },
      {
        id: 'a1', kind: 'discovery_accepted', category: 'opportunity', source: 'user_action',
        occurredAt: '2026-09-05T00:00:00.000Z', recordedAt: '2026-09-05T00:00:00.000Z',
        title: '接受', company: '甲公司', role: 'AI 产品经理', discoveryDecision: 'accepted',
      },
    ]
    expect(recentRejectedDiscoveryFeedback(timeline, new Date('2026-09-11T00:00:00.000Z'))).toHaveLength(0)
  })
})
