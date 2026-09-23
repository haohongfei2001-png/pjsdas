import { cancelScheduleNodeForProcessEvent } from './scheduleNodes.js'
import { upgradeSnapshotToLatest, validateSnapshot, type PJSDASSnapshot } from './snapshot.js'
import { timelineFromDeletedProcessEvent } from './timeline.js'

// Only the first-party connected Web client may invoke this scoped command.
// The gateway owns identity, revision checks, receipts and the atomic commit.
export function applyProcessEventDeleteCommand(snapshot: PJSDASSnapshot, eventId: string, now = new Date()) {
  const next = upgradeSnapshotToLatest(snapshot)
  const event = next.data.processEvents.find((item) => item.id === eventId)
  if (!event) throw new Error(`Process event ${eventId} no longer exists.`)
  const timestamp = now.toISOString()
  const action = next.data.actions.find((item) => item.processEventId === eventId)
  const scheduleNodes = (next.data.scheduleNodes ?? [])
    .filter((item) => item.processEventId === eventId)
    .map((item) => structuredClone(item))

  cancelScheduleNodeForProcessEvent(next.data, eventId, timestamp)
  next.data.processEvents = next.data.processEvents.filter((item) => item.id !== eventId)
  next.data.actions = next.data.actions.filter((item) => item.processEventId !== eventId)
  next.data.timeline = [...(next.data.timeline ?? []), timelineFromDeletedProcessEvent(event, timestamp)]
  next.exportedAt = timestamp
  validateSnapshot(next)
  return {
    status: 'APPLIED' as const, changed: true, snapshot: next,
    summary: `Deleted process event ${eventId}.`,
    compensation: {
      operation: 'restore_deleted_process_event',
      payload: { event, action, scheduleNodes },
    },
  }
}
