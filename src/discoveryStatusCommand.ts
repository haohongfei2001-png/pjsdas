import { deriveDiscoveryInboxStatusChange } from './discoveryStatus.js'
import { upgradeSnapshotToLatest, validateSnapshot, type PJSDASSnapshot } from './snapshot.js'
import type { DiscoveryInboxStatus, DiscoveryRejectionReason } from './model.js'

export interface DiscoveryStatusCommand {
  inboxItemId: string
  status: Exclude<DiscoveryInboxStatus, 'promoted'>
  rejectionReason?: DiscoveryRejectionReason
}

export function applyDiscoveryStatusCommand(snapshot: PJSDASSnapshot, command: DiscoveryStatusCommand, now = new Date()) {
  const next = upgradeSnapshotToLatest(snapshot)
  const index = (next.data.discoveryInbox ?? []).findIndex((item) => item.id === command.inboxItemId)
  if (index < 0) throw new Error(`Discovery Inbox item ${command.inboxItemId} was not found.`)
  const previous = next.data.discoveryInbox![index]
  const change = deriveDiscoveryInboxStatusChange(previous, command.status, command.rejectionReason, now)
  next.data.discoveryInbox![index] = change.item
  if (change.timeline) next.data.timeline = [...(next.data.timeline ?? []), change.timeline]
  next.exportedAt = now.toISOString()
  validateSnapshot(next)
  return {
    status: 'APPLIED' as const,
    changed: true,
    snapshot: next,
    summary: `Updated Discovery Inbox item ${command.inboxItemId} to ${command.status}.`,
    compensation: {
      operation: 'restore_discovery_status',
      payload: {
        inboxItemId: command.inboxItemId,
        status: previous.status,
        rejectionReason: previous.rejectionReason,
        seenAt: previous.seenAt,
        timelineId: change.timeline?.id,
      },
    },
  }
}
