import { describe, expect, it } from 'vitest'
import { action, opportunity } from '../e2e/fixtures/todayWorkspace.js'
import type { ScheduleNode } from '../src/model.js'
import { syncScheduleNodeForActionStatus } from '../src/scheduleNodes.js'
import { scheduleDisplayTimezone } from '../src/scheduleDisplayTime.js'
import { parseSnapshotText, upgradeSnapshotToLatest } from '../src/snapshot.js'
import { selectTodayWeb } from '../src/today/todayWebSelector.js'
import { buildScheduleStream } from '../src/schedule/scheduleStream.js'
import { buildOpportunityDecisionList } from '../src/opportunityDecisionRead.js'

const old = '2026-09-20T00:00:00.000Z'
const now = new Date('2026-09-28T12:00:00.000Z')
function node(id: string, state: ScheduleNode['state'], at: string): ScheduleNode {
  return { id, occurrenceId: id, version: 1, opportunityId: 'job', kind: 'follow_up', state,
    temporal: { shape: 'deadline', precision: 'datetime', timezone: 'source-offset', deadlineAt: at, resolutionBasis: 'legacy_projection' },
    relatedActionIds: ['task'], relatedPrepIds: [], evidenceRefs: ['source'], sourceVersionRefs: ['version'], constraintKind: 'user_soft',
    createdAt: old, updatedAt: old }
}

describe('history completion startup defense', () => {
  it.each(['source-offset', 'floating-date', 'obsolete-zone', '', undefined])('normalizes display timezone %s without changing stored instants', (timezone) => {
    const value = '2026-11-01T01:30:00-04:00'
    expect(() => new Intl.DateTimeFormat('en-GB', { timeZone: scheduleDisplayTimezone(timezone) }).format(new Date(value))).not.toThrow()
    expect(value).toBe('2026-11-01T01:30:00-04:00')
  })
  it('retains real IANA timezone and UTC', () => {
    expect(scheduleDisplayTimezone('Asia/Shanghai')).toBe('Asia/Shanghai')
    expect(scheduleDisplayTimezone('UTC')).toBe('UTC')
  })
  it('keeps historical occurrence facts and unknown completion times unchanged while completing a current related task', () => {
    const task = action('task', 'Task', 'job')
    const data = { opportunities: [opportunity('job', 'Company', 'Role')], actions: [task], processes: [], processEvents: [], prep: [], applicationGroups: [],
      scheduleNodes: [node('elapsed', 'elapsed_unresolved', old), node('completed', 'completed', old), node('superseded', 'superseded', old),
        node('legacy-past', 'scheduled', old), node('current', 'scheduled', '2026-09-29T10:00:00+08:00')] }
    const historical = structuredClone(data.scheduleNodes.slice(0, 4))
    task.status = 'done' as any
    syncScheduleNodeForActionStatus(data, task.id, 'done', now.toISOString())
    expect(data.scheduleNodes.slice(0, 4)).toEqual(historical)
    expect(data.scheduleNodes[4]).toMatchObject({ state: 'completed', completedAt: now.toISOString() })
    const snapshot = upgradeSnapshotToLatest({ schema: 'pjsdas-local-snapshot', version: 1, exportedAt: old, data })
    const restored = parseSnapshotText(JSON.stringify(snapshot))
    expect(restored.data.scheduleNodes!.slice(0, 4)).toEqual(historical)
    expect(restored.data.scheduleNodes!.find((item) => item.id === 'completed')?.completedAt).toBeUndefined()
    expect(() => selectTodayWeb(restored, { availableMinutes: 180 }, { now, timezone: 'UTC', workspaceVersion: 'test' })).not.toThrow()
    expect(() => buildScheduleStream(restored, { now, timezone: 'UTC', accountKey: 'test', workspaceRevision: 'test' })).not.toThrow()
    expect(() => buildOpportunityDecisionList(restored, { now, timezone: 'UTC', workspaceVersion: 'test' })).not.toThrow()
  })
})
