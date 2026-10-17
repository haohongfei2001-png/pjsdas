import type { Opportunity } from './model.js'
import { upgradeSnapshotToLatest, type PJSDASSnapshot } from './snapshot.js'

/** No timestamp inference: historical imports, refreshes and explicit saves stay read. */
export function isUnreadJob(job: Opportunity | undefined): boolean {
  return job?.discoveryRead?.version === 1 && !job.discoveryRead.viewedAt
}

/** The authenticated workspace owns the metadata, never a shared browser key. */
export function applyJobViewedCommand(snapshot: PJSDASSnapshot, opportunityId: string, now = new Date()) {
  const target = snapshot.data.opportunities.find(job => job.id === opportunityId)
  if (!target) throw new Error('This job is unavailable in the current workspace.')
  if (!isUnreadJob(target)) return { status: 'ALREADY_APPLIED' as const, changed: false, snapshot, summary: 'Job already viewed.' }
  const next = upgradeSnapshotToLatest(snapshot)
  const job = next.data.opportunities.find(job => job.id === opportunityId)!
  job.discoveryRead = { ...job.discoveryRead!, viewedAt: now.toISOString() }
  next.exportedAt = now.toISOString()
  return { status: 'APPLIED' as const, changed: true, snapshot: next, summary: 'Job viewed.' }
}
