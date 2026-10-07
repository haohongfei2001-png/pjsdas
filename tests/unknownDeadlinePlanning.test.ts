import { describe, expect, it } from 'vitest'
import { classifyJob, resolveApplicationDeadline } from '../src/applicationDeadline.js'
import { applyUserDomainCommand } from '../src/domainCommands.js'
import { buildScheduleStream } from '../src/schedule/scheduleStream.js'
import { buildTodayBrief, nodeForAction } from '../src/todayBrief.js'
import { selectTodayWeb } from '../src/today/todayWebSelector.js'
import { upgradeSnapshotToLatest } from '../src/snapshot.js'
import { UNKNOWN_DEADLINE_NOW as now, UNKNOWN_DEADLINE_OLD_DATE, unknownDeadlineWorkspace } from './fixtures/unknownDeadlineWorkspace.js'

const context = { now, timezone: 'Asia/Shanghai' }

describe('withdrawn application deadlines in Today planning', () => {
  it.each([0, 480])('does not turn unknown dates into hard-deadline warnings with %i minutes available', availableMinutes => {
    const snapshot = unknownDeadlineWorkspace()
    const before = JSON.stringify(snapshot)
    const web = selectTodayWeb(snapshot, { availableMinutes }, context)
    const brief = buildTodayBrief(snapshot, { availableMinutes }, context)
    expect(web.notSelectedHardActions).toEqual([])
    expect(web.businessConflicts).toEqual([])
    expect(web.protectedActionIds).toEqual([])
    expect(brief.internalDiagnostics.protectedActionIds).toEqual([])
    expect(brief.materialCoverageWarnings.filter(item => ['capacity_conflict', 'hard_deadline_unplanned'].includes(item.code))).toEqual([])
    for (const item of [...web.actions, ...[brief.nextAction, ...brief.nextActions].filter(item => !!item)]) {
      expect(item.timing).toBeUndefined()
      expect(item.protectedByLatestStart).toBe(false)
    }
    expect(JSON.stringify(snapshot)).toBe(before)
  })

  it('preserves real deadline protection in a mixed late-day workspace', () => {
    const snapshot = unknownDeadlineWorkspace(8, true)
    const web = selectTodayWeb(snapshot, { availableMinutes: 0 }, context)
    const brief = buildTodayBrief(snapshot, { availableMinutes: 0 }, context)
    expect(web.notSelectedHardActions.map(item => item.actionId)).toEqual(['apply:real-deadline'])
    expect(web.businessConflicts).toEqual([{ kind: 'hard_deadline_capacity', relatedIds: ['apply:real-deadline'], selectedIds: [] }])
    expect(web.protectedActionIds).toEqual(['apply:real-deadline'])
    expect(brief.internalDiagnostics.protectedActionIds).toEqual(['apply:real-deadline'])
    expect(brief.materialCoverageWarnings.filter(item => ['capacity_conflict', 'hard_deadline_unplanned'].includes(item.code))
      .every(item => item.relatedIds.every(id => id === 'apply:real-deadline'))).toBe(true)
  })

  it.each(['cancelled', 'superseded'] as const)('resolves latest occurrence before discarding %s history, without reviving an older version', state => {
    const snapshot = unknownDeadlineWorkspace(1)
    const [prior, withdrawn] = snapshot.data.scheduleNodes!
    // Cached historical versions may still retain their original state.
    prior.state = 'scheduled'
    withdrawn.state = state
    expect(nodeForAction(snapshot.data.actions[0]!, [prior, withdrawn])).toBeUndefined()
    expect(nodeForAction(snapshot.data.actions[0]!, [withdrawn, prior])).toBeUndefined()
  })

  it('does not revive an obsolete action link removed from the latest occurrence', () => {
    const snapshot = unknownDeadlineWorkspace(1)
    const [prior, latest] = snapshot.data.scheduleNodes!
    prior.state = 'scheduled'
    latest.state = 'scheduled'
    latest.relatedActionIds = []
    expect(nodeForAction(snapshot.data.actions[0]!, [prior, latest])).toBeUndefined()
  })

  it('retains completed shared deadlines for an unfinished related action', () => {
    const snapshot = unknownDeadlineWorkspace(1, true)
    const node = snapshot.data.scheduleNodes!.find(item => item.opportunityId === 'real-deadline')!
    node.state = 'completed'
    const action = snapshot.data.actions.find(item => item.opportunityId === 'real-deadline')!
    expect(nodeForAction(action, snapshot.data.scheduleNodes!)).toBe(node)
    expect(selectTodayWeb(snapshot, { availableMinutes: 0 }, context).protectedActionIds).toEqual([action.id])
  })

  it('keeps cancelled source evidence and no-deadline classification through repeated reload and both projections', () => {
    let snapshot = unknownDeadlineWorkspace(2)
    const history = structuredClone(snapshot.data.scheduleNodes)
    const corrections = structuredClone(snapshot.data.opportunities.map(item => item.detail?.deadlineCorrections))
    for (let reload = 0; reload < 3; reload++) {
      snapshot = upgradeSnapshotToLatest(JSON.parse(JSON.stringify(snapshot)))
      expect(selectTodayWeb(snapshot, { availableMinutes: 0 }, context).notSelectedHardActions).toEqual([])
      expect(buildTodayBrief(snapshot, { availableMinutes: 0 }, context).internalDiagnostics.protectedActionIds).toEqual([])
      expect(snapshot.data.scheduleNodes).toEqual(history)
      expect(snapshot.data.opportunities.map(item => item.detail?.deadlineCorrections)).toEqual(corrections)
      for (const opportunity of snapshot.data.opportunities) {
        expect(classifyJob(opportunity, snapshot.data, now, context.timezone)).toBe('no_deadline')
        expect(resolveApplicationDeadline(opportunity, snapshot.data)).toMatchObject({ state: 'unknown', source: 'correction' })
      }
      const schedule = buildScheduleStream(snapshot, { ...context, accountKey: 'synthetic', workspaceRevision: 'test-revision' })
      expect(schedule.sections.no_deadline).toHaveLength(0)
      expect(schedule.sections.upcoming).toEqual([])
      expect(snapshot.data.scheduleNodes!.every(item => item.temporal.deadlineAt === UNKNOWN_DEADLINE_OLD_DATE)).toBe(true)
    }
  })

  it('protects a newly confirmed deadline after an unknown correction without reusing the cancelled time', () => {
    const snapshot = unknownDeadlineWorkspace(1)
    const next = applyUserDomainCommand(snapshot, { commandId: 'new-user-deadline', kind: 'set_deadline',
      opportunityId: 'unknown-0', deadline: '2026-10-02T15:59:59Z', precision: 'datetime' }, now).snapshot
    const selected = selectTodayWeb(next, { availableMinutes: 0 }, context)
    expect(selected.protectedActionIds).toEqual(['apply:unknown-0'])
    expect(selected.notSelectedHardActions[0]?.timing?.deadlineAt).toBe('2026-10-02T15:59:59Z')
  })
})
