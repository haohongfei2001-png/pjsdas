import type { TimelineRecord } from '../model.js'
import type { PJSDASSnapshot } from '../snapshot.js'
import { localDateKey } from '../todayBrief.js'
import { applyWorkspaceDelta, patchDeltaRow, type WorkspaceDelta, type DeltaRow } from '../workspaceDelta.js'

// Today consumes today's completion evidence, never the full historical stream.
// Cold reads build this view once. Hot deltas maintain it by changed record ID.
const views = new WeakMap<TimelineRecord[], Map<string, TimelineRecord[]>>()
function belongs(row: TimelineRecord, key: string) {
  const [timezone, date] = key.split('|')
  const instant = new Date(row.occurredAt)
  return Number.isFinite(instant.getTime()) && localDateKey(instant, timezone) === date
}
export function todayScheduleSnapshot(snapshot: PJSDASSnapshot, now: Date, timezone: string): PJSDASSnapshot {
  const timeline = snapshot.data.timeline
  if (!timeline) return snapshot
  const key = `${timezone}|${localDateKey(now, timezone)}`
  let cached = views.get(timeline)
  if (!cached) { cached = new Map(); views.set(timeline, cached) }
  let rows = cached.get(key)
  if (!rows) {
    rows = timeline.filter(row => belongs(row, key))
    cached.set(key, rows)
    // Day/zone changes must not accumulate an unbounded collection of views.
    if (cached.size > 4) cached.delete(cached.keys().next().value!)
  }
  return { ...snapshot, data: { ...snapshot.data, timeline: rows } }
}
export function patchConsumerSnapshot(snapshot: PJSDASSnapshot, delta: WorkspaceDelta): PJSDASSnapshot {
  const next = applyWorkspaceDelta(snapshot, delta, false)
  const cached = snapshot.data.timeline && views.get(snapshot.data.timeline)
  if (cached && next.data.timeline && next.data.timeline !== snapshot.data.timeline) {
    const updated = new Map<string, TimelineRecord[]>()
    for (const [key, prior] of cached) {
      const rows = new Map(prior.map(row => [row.id, row]))
      for (const change of delta.changes) if (change.collection === 'timeline') {
        // Updates may move a formerly historical row into today's view. The
        // full source row remains in the authoritative in-memory projection.
        const current = rows.get(change.id) ?? (change.before && snapshot.data.timeline?.find(row => row.id === change.id))
        const row = patchDeltaRow(current as unknown as DeltaRow ?? null, change, false) as unknown as TimelineRecord | null
        if (row && belongs(row, key)) rows.set(change.id, row)
        else rows.delete(change.id)
      }
      updated.set(key, [...rows.values()])
    }
    views.set(next.data.timeline, updated)
  }
  return next
}
