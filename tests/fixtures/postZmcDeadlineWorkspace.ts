import { createSnapshot } from '../../src/snapshot.js'
import { action, opportunity } from '../../e2e/fixtures/todayWorkspace.js'
import type { ScheduleNode } from '../../src/model.js'

export const DEADLINE = '2026-09-30T15:59:59Z'
export const LATE_NOW = new Date('2026-09-30T14:20:00Z')
export function deadlineWorkspace(capacity?: number, deadline = DEADLINE) {
  const costs = [40, 50, 80, 90, 92, 100]
  const opportunities = costs.map((_, i) => ({ ...opportunity(`job-${i}`, String.fromCharCode(65 + i), 'Engineer'),
    opportunityValue: [100, 95, 65, 55, 40, 25][i], fitScore: [100, 95, 65, 55, 40, 25][i],
    deadline, deadlinePrecision: 'datetime' as const }))
  const actions = costs.map((cost, i) => ({ ...action(`apply-${i}`, `申请 ${String.fromCharCode(65 + i)}`, `job-${i}`),
    kind: 'apply' as const, timingMode: 'deadline' as const, dueAt: deadline, duePrecision: 'datetime' as const,
    estimatedMinutes: cost }))
  const scheduleNodes: ScheduleNode[] = actions.map(item => ({ id: `schedule:application-deadline:${item.opportunityId}:v1`, occurrenceId: `application-deadline:${item.opportunityId}`,
    version: 1, opportunityId: item.opportunityId, kind: 'application_deadline', state: 'scheduled', constraintKind: 'employer_hard',
    temporal: { shape: 'deadline', precision: 'datetime', timezone: 'UTC', deadlineAt: deadline, resolutionBasis: 'legacy_projection' },
    evidenceRefs: ['retained-source'], sourceVersionRefs: ['retained-version'], relatedActionIds: [item.id], relatedPrepIds: [],
    createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z' }))
  return createSnapshot({ opportunities, actions, scheduleNodes, processes: [], processEvents: [], prep: [], applicationGroups: [],
    ...(capacity === undefined ? {} : { timePlanning: { version: 1 as const, defaultDailyMinutes: capacity, updatedAt: LATE_NOW.toISOString() } }) }, LATE_NOW.toISOString())
}

export function explicitStartDenseWorkspace() {
  const snapshot = deadlineWorkspace(100, new Date(LATE_NOW.getTime() + 400 * 60_000).toISOString())
  const opportunity = snapshot.data.opportunities[0], action = snapshot.data.actions[0], node = snapshot.data.scheduleNodes![0]
  snapshot.data.opportunities = Array.from({ length: 18 }, (_, index) => ({ ...opportunity,
    id: `job-${index}`, company: `Dense ${index}`, opportunityValue: 100 - index, fitScore: 100 - index }))
  snapshot.data.actions = Array.from({ length: 18 }, (_, index) => ({ ...action,
    id: `apply-${index}`, opportunityId: `job-${index}`, title: `密集申请 ${index}`, estimatedMinutes: 30 }))
  snapshot.data.scheduleNodes = snapshot.data.actions.map((item, index) => ({ ...node,
    id: `schedule:application-deadline:${item.opportunityId}:v1`, occurrenceId: `application-deadline:${item.opportunityId}`,
    opportunityId: item.opportunityId, relatedActionIds: [item.id], temporal: { ...node.temporal,
      latestStartAt: new Date(LATE_NOW.getTime() + (index + 1) * 5 * 60_000).toISOString() } }))
  return snapshot
}
