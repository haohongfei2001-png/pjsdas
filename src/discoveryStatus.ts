import { discoveryInboxDecisionTimeline } from './discoveryInbox.js'
import type { DiscoveryInboxItem, DiscoveryInboxStatus, DiscoveryRejectionReason } from './model.js'

export function deriveDiscoveryInboxStatusChange(
  item: DiscoveryInboxItem,
  status: Exclude<DiscoveryInboxStatus, 'promoted'>,
  rejectionReason: DiscoveryRejectionReason | undefined,
  now: Date,
) {
  if (item.status === 'promoted') throw new Error('已加入机会池的发现箱条目不能退回候选状态。')
  const timestamp = now.toISOString()
  const next: DiscoveryInboxItem = {
    ...item,
    status,
    rejectionReason: status === 'dismissed' ? (rejectionReason ?? 'not_interested') : undefined,
    seenAt: status === 'seen' ? timestamp : item.seenAt,
    updatedAt: timestamp,
  }
  return {
    item: next,
    timeline: status === 'dismissed'
      ? discoveryInboxDecisionTimeline(next, 'rejected', now, next.rejectionReason)
      : undefined,
  }
}
