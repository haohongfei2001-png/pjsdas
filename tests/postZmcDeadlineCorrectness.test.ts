import { describe, expect, it } from 'vitest'
import { formatScheduleTemporal, scheduleDisplayTimezone } from '../src/scheduleDisplayTime.js'
import { buildConsumerTimePlan } from '../src/today/consumerTimePlan.js'
import { rankActions } from '../src/decisionV3.js'
import { selectTodayWeb } from '../src/today/todayWebSelector.js'
import { DEADLINE, LATE_NOW, deadlineWorkspace } from './fixtures/postZmcDeadlineWorkspace.js'

describe('post-ZMC deadline correctness', () => {
  it.each([
    ['Asia/Shanghai', '2026-09-30T15:59:59Z', '23:59'],
    ['UTC', '2026-09-30T15:59:59Z', '15:59'],
    ['America/New_York', '2026-03-08T07:30:00Z', '03:30'],
    ['America/New_York', '2026-11-01T06:30:00Z', '01:30'],
  ])('displays legacy UTC storage in %s without changing the instant', (display, instant, expected) => {
    const label = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      timeZone: scheduleDisplayTimezone('UTC', 'legacy_projection', display) }).format(new Date(instant))
    expect(label).toBe(expected)
  })
  it('retains a source-explicit timezone instead of converting it to the browser zone', () => {
    expect(scheduleDisplayTimezone('America/New_York', 'source_explicit', 'Asia/Shanghai')).toBe('America/New_York')
    expect(formatScheduleTemporal({ precision: 'datetime', deadlineAt: DEADLINE, timezone: 'America/New_York',
      resolutionBasis: 'source_explicit' }, false, 'Asia/Shanghai')).toContain('11:59 (GMT-4)')
  })
  it.each(['UTC', 'Asia/Shanghai', 'America/New_York'])('preserves a date-only calendar date in %s', display => {
    expect(formatScheduleTemporal({ precision: 'date', date: '2026-09-30', timezone: 'floating-date',
      resolutionBasis: 'legacy_projection' }, false, display)).toBe('2026-09-30')
  })
  it.each([
    ['unknown capacity', undefined, LATE_NOW, ['apply-0', 'apply-1']],
    ['capacity below wall clock', 60, LATE_NOW, ['apply-0']],
    ['capacity above wall clock', 500, LATE_NOW, ['apply-0', 'apply-1']],
    ['500 physical minutes', 500, new Date('2026-09-30T07:39:00Z'), ['apply-0','apply-1','apply-2','apply-3','apply-4','apply-5']],
  ] as const)('selects a feasible optimal subset with %s', (_, capacity, now, expected) => {
    const snapshot = deadlineWorkspace(capacity)
    const before = JSON.stringify(snapshot)
    const selected = selectTodayWeb(snapshot, {}, { now, timezone: 'Asia/Shanghai' })
    expect(selected.actions.map(item => item.actionId)).toEqual(expected)
    expect(selected.actions.reduce((sum, item) => sum + item.estimatedMinutes, 0)).toBeLessThanOrEqual(
      Math.min(capacity ?? Infinity, Math.floor((Date.parse(DEADLINE) - now.getTime()) / 60_000)))
    expect(selected.capacityMinutes).toBe(capacity)
    expect(JSON.stringify(snapshot)).toBe(before)
  })
  it('keeps the same feasible selection across local midnight and input ordering', () => {
    const deadline = '2026-09-30T16:30:00Z'
    const now = new Date('2026-09-30T14:50:00Z')
    const snapshot = deadlineWorkspace(undefined, deadline)
    const selected = selectTodayWeb(snapshot, {}, { now, timezone: 'Asia/Shanghai' })
    snapshot.data.actions.reverse(); snapshot.data.scheduleNodes!.reverse()
    expect(selected.actions.map(item => item.actionId)).toEqual(['apply-0','apply-1'])
    expect(selectTodayWeb(JSON.parse(JSON.stringify(snapshot)), {}, { now, timezone: 'Asia/Shanghai' }).actions).toEqual(selected.actions)
  })
  it('includes an explicitly configured next-day work window before a cross-midnight deadline', () => {
    const snapshot = deadlineWorkspace(500, '2026-09-30T16:30:00Z')
    snapshot.data.timePlanning!.weeklyWindows = [
      { weekday: 3, startMinute: 1320, endMinute: 1440 }, { weekday: 4, startMinute: 0, endMinute: 60 },
    ]
    expect(selectTodayWeb(snapshot, {}, { now: new Date('2026-09-30T14:50:00Z'), timezone: 'Asia/Shanghai' })
      .actions.map(item => item.actionId)).toEqual(['apply-0', 'apply-1'])
  })
  it.each([undefined, 0, 30] as const)('keeps next-day capacity separate from today with override %s', nextDayCapacity => {
    const snapshot = deadlineWorkspace(500, '2026-09-30T16:50:00Z')
    snapshot.data.actions = snapshot.data.actions.slice(0, 1)
    snapshot.data.actions[0].estimatedMinutes = 60
    snapshot.data.timePlanning!.weeklyWindows = [
      { weekday: 3, startMinute: 1430, endMinute: 1440 }, { weekday: 4, startMinute: 0, endMinute: 50 },
    ]
    if (nextDayCapacity !== undefined) snapshot.data.timePlanning!.dateOverrides = { '2026-10-01': nextDayCapacity }
    expect(selectTodayWeb(snapshot, {}, { now: new Date('2026-09-30T15:50:00Z'), timezone: 'Asia/Shanghai' })
      .actions.map(item => item.actionId)).toEqual(nextDayCapacity === undefined ? ['apply-0'] : [])
  })
  it('applies an explicit Today allowance only to today, retaining tomorrow’s configured capacity', () => {
    const snapshot = deadlineWorkspace(500, '2026-09-30T16:50:00Z')
    snapshot.data.actions = snapshot.data.actions.slice(0, 1)
    snapshot.data.actions[0].estimatedMinutes = 60
    snapshot.data.timePlanning!.weeklyWindows = [
      { weekday: 3, startMinute: 1430, endMinute: 1440 }, { weekday: 4, startMinute: 0, endMinute: 50 },
    ]
    expect(selectTodayWeb(snapshot, { availableMinutes: 10 }, { now: new Date('2026-09-30T15:50:00Z'), timezone: 'Asia/Shanghai' })
      .actions.map(item => item.actionId)).toEqual(['apply-0'])
  })
  it('retains flexible work today when a hard application can use tomorrow’s capacity', () => {
    const snapshot = deadlineWorkspace(120, '2026-09-30T17:00:00Z')
    snapshot.data.actions = snapshot.data.actions.slice(0, 2)
    snapshot.data.actions[0].estimatedMinutes = 70
    snapshot.data.actions[1] = { ...snapshot.data.actions[1], kind: 'manual', estimatedMinutes: 20, dueAt: undefined }
    snapshot.data.scheduleNodes = snapshot.data.scheduleNodes!.slice(0, 1)
    snapshot.data.timePlanning!.weeklyWindows = [
      { weekday: 3, startMinute: 1410, endMinute: 1440 }, { weekday: 4, startMinute: 0, endMinute: 60 },
    ]
    expect(selectTodayWeb(snapshot, {}, { now: new Date('2026-09-30T15:30:00Z'), timezone: 'Asia/Shanghai' })
      .actions.map(item => item.actionId)).toEqual(['apply-0', 'apply-1'])
  })
  it.each([60, 100, 180])('finds the global priority maximum with staggered deadlines and a fixed meeting under %i minutes', capacity => {
    const snapshot = deadlineWorkspace()
    const nodes = snapshot.data.scheduleNodes!
    const offsets = [30, 60, 90, 100, 120, 150]
    snapshot.data.actions.forEach((item, i) => {
      item.dueAt = new Date(LATE_NOW.getTime() + offsets[i] * 60_000).toISOString()
      nodes[i].temporal.deadlineAt = item.dueAt
    })
    const ranked = rankActions(snapshot.data.actions, snapshot.data.opportunities, LATE_NOW)
    const meeting = { ...nodes[0], id: 'meeting', occurrenceId: 'meeting', relatedActionIds: [],
      temporal: { shape: 'fixed_range' as const, precision: 'datetime' as const, timezone: 'Asia/Shanghai',
        resolutionBasis: 'source_explicit' as const, startAt: new Date(LATE_NOW.getTime() + 20 * 60_000).toISOString(),
        endAt: new Date(LATE_NOW.getTime() + 40 * 60_000).toISOString() } }
    const plan = buildConsumerTimePlan({ ranked, nodes: [...nodes, meeting], availableMinutes: capacity,
      now: LATE_NOW, timezone: 'Asia/Shanghai' })
    let maximum = 0
    for (let mask = 0; mask < 64; mask++) {
      const chosen = ranked.filter(item => mask & (1 << Number(item.action.id.slice(-1))))
        .sort((a,b) => Date.parse(a.action.dueAt!) - Date.parse(b.action.dueAt!))
      let used = 0, feasible = true
      for (const item of chosen) {
        used += item.action.estimatedMinutes
        const minutes = (Date.parse(item.action.dueAt!) - LATE_NOW.getTime()) / 60_000
        const todayPhysical = Math.min(100, minutes) - Math.max(0, Math.min(40, minutes) - 20)
        const nextDayPhysical = Math.max(0, minutes - 100)
        if (used > Math.min(capacity - 20, todayPhysical) + nextDayPhysical) feasible = false
      }
      if (feasible) maximum = Math.max(maximum, chosen.reduce((sum, item) => sum + item.score ** 2, 0))
    }
    expect(plan.planned.reduce((sum, item) => sum + item.score ** 2, 0)).toBe(maximum)
  })
  it('prioritizes work already in progress when business value and cost are otherwise equal', () => {
    const snapshot = deadlineWorkspace(40)
    snapshot.data.actions = snapshot.data.actions.slice(0,2).map(item => ({ ...item, estimatedMinutes: 40 }))
    snapshot.data.opportunities[1].opportunityValue = 100; snapshot.data.opportunities[1].fitScore = 100
    snapshot.data.actions[1].status = 'doing'
    expect(selectTodayWeb(snapshot, {}, { now: LATE_NOW, timezone: 'Asia/Shanghai' }).actions.map(item => item.actionId)).toEqual(['apply-1'])
  })
})
