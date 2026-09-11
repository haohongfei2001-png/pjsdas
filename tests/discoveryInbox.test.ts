import { describe, expect, it } from 'vitest'
import {
  createInboxPromotionChangeSet,
  discoveryInboxItemsFromChangeSet,
  mergeDiscoveryInboxItems,
  validateDiscoveryInboxItem,
} from '../src/discoveryInbox.js'
import type { ChangeSetRecord } from '../src/changeSet.js'

const changeSet: ChangeSetRecord = {
  id: 'CS-MCP-INBOX',
  version: 1,
  source: 'mcp',
  status: 'pending',
  title: '岗位发现',
  createdAt: '2026-09-11T10:00:00.000Z',
  updatedAt: '2026-09-11T10:00:00.000Z',
  operations: [{
    id: 'discovery:add:job-1',
    kind: 'add_discovered_opportunity',
    summary: '新增发现岗位',
    opportunity: {
      id: 'job-1', company: '甲公司', role: 'AI 产品经理', currentStageLabel: '待投', processStage: 'not_applied', roleType: 'core', early: false,
      opportunityValue: 90, fitScore: 85, locallyManaged: true, importedAt: '2026-09-11T10:00:00.000Z',
      detail: { discovery: { sourceUrl: 'https://careers.example.com/job-1', sourceTitle: '甲公司 AI 产品经理', location: '北京', rationale: '匹配产品与 AI 方向。', discoveredAt: '2026-09-11T10:00:00.000Z', fitConfidence: 'high', opportunityValueConfidence: 'medium' } },
    },
  }],
}

describe('v1.4 discovery inbox', () => {
  it('creates valid durable inbox items from signed discovery operations', () => {
    const [item] = discoveryInboxItemsFromChangeSet(changeSet, new Date('2026-09-11T10:05:00.000Z'))
    expect(item.status).toBe('new')
    expect(item.sourceChangeSetId).toBe(changeSet.id)
    expect(validateDiscoveryInboxItem(item)).toEqual([])
  })

  it('preserves explicit lifecycle status when the same candidate is rediscovered', () => {
    const [first] = discoveryInboxItemsFromChangeSet(changeSet, new Date('2026-09-11T10:05:00.000Z'))
    const dismissed = { ...first, status: 'dismissed' as const, rejectionReason: 'location' as const }
    const [incoming] = discoveryInboxItemsFromChangeSet(changeSet, new Date('2026-09-11T11:05:00.000Z'))
    const merged = mergeDiscoveryInboxItems([dismissed], [incoming])
    expect(merged).toHaveLength(1)
    expect(merged[0].status).toBe('dismissed')
    expect(merged[0].rejectionReason).toBe('location')
  })

  it('creates a reviewable local ChangeSet instead of silently promoting a candidate', () => {
    const [item] = discoveryInboxItemsFromChangeSet(changeSet)
    const promotion = createInboxPromotionChangeSet(item, new Date('2026-09-11T12:00:00.000Z'))
    expect(promotion.status).toBe('pending')
    expect(promotion.source).toBe('user_action')
    expect(promotion.operations).toHaveLength(1)
    expect(promotion.operations[0].kind).toBe('add_discovered_opportunity')
  })
})
