import type { ScheduleNode } from '../../src/model.js'
import { upgradeSnapshotToLatest } from '../../src/snapshot.js'
import { action, opportunity } from '../../e2e/fixtures/todayWorkspace.js'

export const HISTORY_NOW = new Date('2026-09-28T12:00:00.000Z')
export const HISTORY_OLD = '2026-09-20T00:00:00.000Z'
export function historyActionWorkspace() {
  const job = opportunity('history-job', 'History company', 'Engineer')
  const task = { ...action('history-task', 'History task', job.id), plannedDate: '2026-09-28' }
  const states: ScheduleNode['state'][] = ['completed', 'elapsed_unresolved', 'superseded', 'cancelled', 'scheduled', 'in_progress', 'scheduled', 'in_progress']
  const nodes: ScheduleNode[] = states.map((state, index) => ({
    id: `history-node-${index}`, occurrenceId: `history-occurrence-${index}`, version: 1,
    opportunityId: job.id, kind: 'follow_up', state,
    temporal: { shape: 'fixed_range', precision: 'datetime', timezone: 'source-offset',
      startAt: index >= 6 ? '2026-09-29T10:00:00+08:00' : HISTORY_OLD, resolutionBasis: 'user_explicit' },
    // A same-timestamp prior completion cannot be inferred to belong to this command.
    completedAt: index === 0 ? HISTORY_NOW.toISOString() : undefined,
    evidenceRefs: ['retained:source'], sourceVersionRefs: ['retained:version'],
    relatedActionIds: [task.id], relatedPrepIds: [], constraintKind: 'user_plan',
    createdAt: HISTORY_OLD, updatedAt: HISTORY_OLD,
  }))
  nodes.push({ ...nodes[0], id: 'unknown-completion', occurrenceId: 'unknown-completion', completedAt: undefined })
  return upgradeSnapshotToLatest({ schema: 'pjsdas-local-snapshot', version: 1, exportedAt: HISTORY_OLD,
    data: { opportunities: [job], actions: [task], processes: [], processEvents: [], prep: [], applicationGroups: [], scheduleNodes: nodes,
      timeline: [{ id: 'retained-history', kind: 'opportunity_added', category: 'data', source: 'user_action',
        opportunityId: job.id, title: 'Historical job', occurredAt: HISTORY_OLD, recordedAt: HISTORY_OLD }] } })
}
