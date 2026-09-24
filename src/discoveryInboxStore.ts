import {
  applyChangeSet,
  dbPromise,
  getAllOpportunities,
  savePendingChangeSet,
} from './db.js'
import {
  createInboxPromotionChangeSet,
  discoveryInboxDecisionTimeline,
  discoveryInboxItemsFromChangeSet,
  mergeDiscoveryInboxItems,
} from './discoveryInbox.js'
import { resolveOpportunityPostingIdentity } from './jobPosting.js'
import { deriveDiscoveryInboxStatusChange } from './discoveryStatus.js'
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
  if (status === 'promoted') throw new Error('加入机会池需要明确的确认操作。')
  const now = new Date()
  const change = deriveDiscoveryInboxStatusChange(item, status, rejectionReason, now)
  const next = change.item
  const stores = status === 'dismissed' ? ['discoveryInbox', 'timeline'] as const : ['discoveryInbox'] as const
  const tx = db.transaction(stores, 'readwrite')
  await tx.objectStore('discoveryInbox').put(next)
  if (change.timeline) await tx.objectStore('timeline').put(change.timeline)
  await tx.done
  return next
}

export async function bulkUpdateDiscoveryInboxStatus(
  ids: string[],
  status: 'later' | 'dismissed',
  rejectionReason?: DiscoveryRejectionReason,
) {
  const uniqueIds = Array.from(new Set(ids))
  const updated: DiscoveryInboxItem[] = []
  for (const id of uniqueIds) {
    updated.push(await updateDiscoveryInboxStatus(id, status, rejectionReason))
  }
  return updated
}

export async function promoteDiscoveryInboxItem(id: string) {
  const db = await dbPromise
  const item = await db.get('discoveryInbox', id)
  if (!item) throw new Error(`找不到发现箱条目 ${id}。`)
  if (item.status === 'promoted') return item

  const opportunities = await getAllOpportunities()
  const exactId = opportunities.find((opportunity) => opportunity.id === item.candidateOpportunityId)
  const identity = exactId
    ? { kind: 'same_posting' as const, opportunity: exactId }
    : resolveOpportunityPostingIdentity({
        company: item.company,
        role: item.role,
        location: item.location,
        sourceUrl: item.sourceUrl,
      }, opportunities)
  if (identity.kind === 'ambiguous') {
    throw new Error('发现箱岗位与历史 Opportunity 的 posting identity 不明确；已停止自动归并，请先完成身份核对。')
  }
  const existing = identity.kind === 'same_posting' ? identity.opportunity : undefined
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
