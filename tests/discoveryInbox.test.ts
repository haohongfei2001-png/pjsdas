import { describe, expect, it } from 'vitest'
import {
  createInboxPromotionChangeSet,
  discoveryInboxItemsFromChangeSet,
  mergeDiscoveryInboxItems,
  validateDiscoveryInboxItem,
} from '../src/discoveryInbox.js'
import type { ChangeSetRecord } from '../src/changeSet.js'

function changeSet(sourceUrl = 'https://careers.example.com/job-1', discoveredAt = '2026-09-11T10:00:00.000Z'): ChangeSetRecord {
  return {
    id: `CS-MCP-INBOX-${discoveredAt}`,
    version: 1,
    source: 'mcp',
    status: 'pending',
    title: '岗位发现',
    createdAt: discoveredAt,
    updatedAt: discoveredAt,
    operations: [{
      id: 'discovery:add:job-1',
      kind: 'add_discovered_opportunity',
      summary: '新增发现岗位',
      opportunity: {
        id: 'job-1', company: '甲公司', role: 'AI 产品经理', currentStageLabel: '待投', processStage: 'not_applied', roleType: 'core', early: false,
        opportunityValue: 90, fitScore: 85, locallyManaged: true, importedAt: discoveredAt,
        detail: { discovery: { sourceUrl, sourceTitle: '甲公司 AI 产品经理', location: '北京', rationale: '匹配产品与 AI 方向。', discoveredAt, fitConfidence: 'high', opportunityValueConfidence: 'medium' } },
      },
    }],
  }
}

describe('v1.4 discovery inbox', () => {
  it('creates valid durable inbox items with posting identity from signed discovery operations', () => {
    const cs = changeSet()
    const [item] = discoveryInboxItemsFromChangeSet(cs, new Date('2026-09-11T10:05:00.000Z'))
    expect(item.status).toBe('new')
    expect(item.sourceChangeSetId).toBe(cs.id)
    expect(item.posting?.canonicalSourceUrl).toBe('https://careers.example.com/job-1')
    expect(validateDiscoveryInboxItem(item)).toEqual([])
  })

  it('preserves explicit lifecycle status when the same candidate is rediscovered', () => {
    const [first] = discoveryInboxItemsFromChangeSet(changeSet(), new Date('2026-09-11T10:05:00.000Z'))
    const dismissed = { ...first, status: 'dismissed' as const, rejectionReason: 'location' as const }
    const [incoming] = discoveryInboxItemsFromChangeSet(changeSet(), new Date('2026-09-11T11:05:00.000Z'))
    const merged = mergeDiscoveryInboxItems([dismissed], [incoming])
    expect(merged).toHaveLength(1)
    expect(merged[0].status).toBe('dismissed')
    expect(merged[0].rejectionReason).toBe('location')
  })

  it('retains the previous source when a rediscovered candidate arrives through a new posting URL', () => {
    const [first] = discoveryInboxItemsFromChangeSet(changeSet('https://jobs.example.com/old', '2026-08-01T00:00:00.000Z'), new Date('2026-08-01T00:05:00.000Z'))
    const [incoming] = discoveryInboxItemsFromChangeSet(changeSet('https://careers.example.com/new', '2026-09-11T10:00:00.000Z'), new Date('2026-09-11T10:05:00.000Z'))
    const merged = mergeDiscoveryInboxItems([first], [incoming], new Date('2026-09-11T10:05:00.000Z'))
    expect(merged).toHaveLength(1)
    expect(merged[0].posting?.canonicalSourceUrl).toBe('https://careers.example.com/new')
    expect(merged[0].postingHistory).toHaveLength(1)
    expect(merged[0].postingHistory?.[0].canonicalSourceUrl).toBe('https://jobs.example.com/old')
  })

  it('creates a reviewable local ChangeSet instead of silently promoting a candidate', () => {
    const [item] = discoveryInboxItemsFromChangeSet(changeSet())
    const promotion = createInboxPromotionChangeSet(item, new Date('2026-09-11T12:00:00.000Z'))
    expect(promotion.status).toBe('pending')
    expect(promotion.source).toBe('user_action')
    expect(promotion.operations).toHaveLength(1)
    expect(promotion.operations[0].kind).toBe('add_discovered_opportunity')
    if (promotion.operations[0].kind === 'add_discovered_opportunity') {
      expect(promotion.operations[0].opportunity.detail?.discovery?.posting).toBeTruthy()
    }
  })
})
