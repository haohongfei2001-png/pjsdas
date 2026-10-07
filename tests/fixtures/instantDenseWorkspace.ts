import { denseDecisionWorkspace } from './denseDecisionWorkspace.js'
import { upgradeSnapshotToLatest } from '../../src/snapshot.js'
export const INSTANT_NOW = new Date('2026-10-01T01:00:00Z')
export function instantDenseWorkspace(historyRows = 3940) {
  const snapshot = denseDecisionWorkspace()
  snapshot.data.actions.forEach((action, index) => {
    action.status = index < 6 ? 'todo' : 'done'
    action.plannedDate = index < 6 ? '2026-10-01' : undefined
    action.kind = index === 2 ? 'apply' : 'manual'
    if (index === 2) action.id = `apply:${action.opportunityId}`
    action.title = `Instant task ${index}`
    action.dueAt = index < 6 ? '2026-10-01T15:59:59Z' : undefined
    action.duePrecision = 'datetime'
    action.updatedAt = '2026-09-01T01:00:00Z'
  })
  snapshot.data.scheduleNodes!.forEach((node, index) => {
    node.relatedActionIds = [snapshot.data.actions[index].id]
    node.temporal = { shape: 'deadline', precision: 'datetime', timezone: 'UTC', deadlineAt: index < 6 ? '2026-10-01T15:59:59Z' : '2026-11-01T15:59:59Z', resolutionBasis: 'legacy_projection' }
  })
  // The interaction target is an actual explicit arrangement. Other rows remain
  // archived application facts for dense-history/correction coverage.
  snapshot.data.scheduleNodes![0].kind = 'interview'
  snapshot.data.scheduleNodes![0].temporal = { shape: 'fixed_range', precision: 'datetime', timezone: 'Asia/Shanghai',
    startAt: '2026-10-01T14:00:00+08:00', endAt: '2026-10-01T15:00:00+08:00', resolutionBasis: 'user_explicit' }
  snapshot.data.timeline = Array.from({ length: historyRows }, (_, index) => ({ id: `instant-history-${index}`, kind: 'opportunity_updated' as const,
    category: 'opportunity' as const, source: 'user_action' as const, title: 'Synthetic historical evidence', detail: 'synthetic audit '.repeat(40),
    occurredAt: '2026-09-01T01:00:00Z', recordedAt: '2026-09-01T01:00:00Z' }))
  snapshot.data.timePlanning = { version: 1, defaultDailyMinutes: 360, updatedAt: INSTANT_NOW.toISOString() }
  snapshot.data.applicationGroups = [{ id: 'instant-imported-group', company: 'Synthetic imported company' }]
  for (const action of snapshot.data.actions.slice(0, 6)) {
    action.applicationGroupId = 'instant-imported-group'
    snapshot.data.opportunities.find(item => item.id === action.opportunityId)!.applicationGroupId = 'instant-imported-group'
  }
  let normalized = upgradeSnapshotToLatest(snapshot)
  // Normalize to a stable migrated baseline, matching a warmed connected cache.
  for (let i = 0; i < 3; i++) normalized = upgradeSnapshotToLatest(normalized)
  return normalized
}
