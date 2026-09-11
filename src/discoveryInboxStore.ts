import {
  applyChangeSet,
  dbPromise,
  getAllOpportunities,
  savePendingChangeSet,
} from './db.js'
import {
  createInboxPromotionChangeSet,
  discoveryInboxDecisionTimeline,
  discoveryInboxIdentity,
  discoveryInboxItemsFromChangeSet,
  mergeDiscoveryInboxItems,
} from './discoveryInbox.js'
import type { ChangeSetRecord } from './changeSet.js'
import type {
  DiscoveryInboxItem,
  DiscoveryInboxStatus,
  DiscoveryRejectionReason,
} from './model.js'

export async function getAllDiscoveryInboxItems() {
  const items = await (await dbPromise).getAll('discoveryInbox')
  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.company.localeCompare(b.company))
}

export async function saveDiscoveryInboxFromChangeSet(changeSet: ChangeSetRecord) {
  const db = await dbPromise
  const existing = await db.getAll('discoveryInbox')
  const incoming = discoveryInboxItemsFromChangeSet(changeSet)
  const merged = mergeDiscoveryInboxItems(existing, incoming)
  const tx = db.transaction('discoveryInbox', 'readwrite')
  for (const item of merged) await tx.store.put(item)
  await tx.done
  return incoming.length
}

export async function updateDiscoveryInboxStatus(
  id: string,
  status: DiscoveryInboxStatus,
  rejectionReason?: DiscoveryRejectionReason,
) {
  const db = await dbPromise
  const item = await db.get('discoveryInbox', id)
  if (!item) throw new Error(`找不到发现箱条目 ${id}。`)
  if (item.status === 'promoted' && status !== 'promoted') throw new Error('已加入机会池的发现箱条目不能退回候选状态。')
  const now = new Date()
  const next: DiscoveryInboxItem = {
    ...item,
    status,
    rejectionReason: status === 'dismissed' ? (rejectionReason ?? 'not_interested') : undefined,
    seenAt: status === 'seen' ? now.toISOString() : item.seenAt,
    updatedAt: now.toISOString(),
  }
  const stores = status === 'dismissed' ? ['discoveryInbox', 'timeline'] as const : ['discoveryInbox'] as const
  const tx = db.transaction(stores, 'readwrite')
  await tx.objectStore('discoveryInbox').put(next)
  if (status === 'dismissed') {
    await tx.objectStore('timeline').put(discoveryInboxDecisionTimeline(next, 'rejected', now, next.rejectionReason))
  }
  await tx.done
  return next
}

export async function promoteDiscoveryInboxItem(id: string) {
  const db = await dbPromise
  const item = await db.get('discoveryInbox', id)
  if (!item) throw new Error(`找不到发现箱条目 ${id}。`)
  if (item.status === 'promoted') return item

  const opportunities = await getAllOpportunities()
  const existing = opportunities.find((opportunity) =>
    opportunity.id === item.candidateOpportunityId ||
    discoveryInboxIdentity(opportunity.company, opportunity.role) === discoveryInboxIdentity(item.company, item.role)
  )
  let promotedOpportunityId = existing?.id
  if (!existing) {
    const changeSet = createInboxPromotionChangeSet(item)
    await savePendingChangeSet(changeSet)
    await applyChangeSet(changeSet.id)
    promotedOpportunityId = item.candidateOpportunityId
  }

  const now = new Date()
  const promoted: DiscoveryInboxItem = {
    ...item,
    status: 'promoted',
    rejectionReason: undefined,
    promotedOpportunityId,
    updatedAt: now.toISOString(),
  }
  const tx = db.transaction(['discoveryInbox', 'timeline'], 'readwrite')
  await tx.objectStore('discoveryInbox').put(promoted)
  await tx.objectStore('timeline').put(discoveryInboxDecisionTimeline(promoted, 'accepted', now))
  await tx.done
  return promoted
}
