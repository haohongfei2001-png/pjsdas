import { describe, expect, it } from 'vitest'
import { todayCapacity, remainingLocalDayMinutes } from '../src/today/localDayCapacity.js'
import { selectTodayWeb } from '../src/today/todayWebSelector.js'
import { createSnapshot } from '../src/snapshot.js'
import type { TimePlanningPreferences } from '../src/timePlanningPreferences.js'

const preferences: TimePlanningPreferences = { version: 1, updatedAt: '2026-10-01T00:00:00Z', defaultDailyMinutes: 180,
  dateOverrides: { '2026-10-06': 360 } }

describe('Today live local-midnight default', () => {
  it.each([
    ['2026-10-06T14:00:00Z', 'Asia/Shanghai', 120],
    ['2026-10-06T23:00:00Z', 'America/Los_Angeles', 480],
    ['2026-10-06T12:15:00Z', 'Asia/Kathmandu', 360],
    ['2026-10-06T10:00:00Z', 'Pacific/Kiritimati', 1440],
    ['2026-03-08T05:00:00Z', 'America/New_York', 1380],
    ['2026-11-01T04:00:00Z', 'America/New_York', 1500],
    ['2026-10-03T13:30:00Z', 'Australia/Lord_Howe', 1410],
    ['2026-10-06T15:59:59.999Z', 'Asia/Shanghai', 0],
    ['2026-10-06T16:00:00Z', 'Asia/Shanghai', 1440],
  ])('calculates complete minutes at %s in %s', (instant, timezone, expected) => {
    const now = new Date(instant)
    expect(remainingLocalDayMinutes(now, timezone)).toBe(expected)
    const source = createSnapshot({ opportunities: [], actions: [], processes: [], processEvents: [], prep: [], applicationGroups: [] }, instant)
    expect(selectTodayWeb(source, {}, { now, timezone }).capacityMinutes).toBe(expected)
  })

  it('keeps date-specific manual choices unchanged until the local day changes', () => {
    const before = JSON.stringify(preferences)
    expect(todayCapacity(preferences, new Date('2026-10-06T14:00:00Z'), 'Asia/Shanghai')).toEqual({ minutes: 360, source: 'manual' })
    expect(todayCapacity(preferences, new Date('2026-10-06T15:59:59Z'), 'Asia/Shanghai')).toEqual({ minutes: 360, source: 'manual' })
    expect(todayCapacity(preferences, new Date('2026-10-06T16:00:00Z'), 'Asia/Shanghai')).toEqual({ minutes: 1440, source: 'remaining_day' })
    expect(JSON.stringify(preferences)).toBe(before)
  })

  it('honors zero and 3h/6h choices even when they exceed time remaining', () => {
    for (const minutes of [0, 180, 360]) {
      expect(todayCapacity(preferences, new Date('2026-10-06T15:50:00Z'), 'Asia/Shanghai', minutes))
        .toEqual({ minutes, source: 'manual' })
    }
  })

  it('migrates legacy fixed defaults without writing or clamping the displayed choice to work windows', () => {
    const source = createSnapshot({ opportunities: [], actions: [], processes: [], processEvents: [], prep: [], applicationGroups: [],
      timePlanning: { ...preferences, dateOverrides: undefined,
        weeklyWindows: [{ weekday: 2, startMinute: 540, endMinute: 600 }] } }, '2026-10-06T14:00:00Z')
    const before = JSON.stringify(source)
    const now = new Date('2026-10-06T14:00:00Z')
    expect(selectTodayWeb(source, {}, { now, timezone: 'Asia/Shanghai' })).toMatchObject({ capacityMinutes: 120, capacitySource: 'remaining_day' })
    expect(selectTodayWeb(source, { availableMinutes: 360 }, { now, timezone: 'Asia/Shanghai' })).toMatchObject({ capacityMinutes: 360, capacitySource: 'manual' })
    expect(JSON.stringify(source)).toBe(before)
  })

  it('does not subtract past commitments from an already remaining-time budget', () => {
    const now = new Date('2026-10-06T22:00:00Z')
    const source = createSnapshot({ opportunities: [], processes: [], processEvents: [], prep: [], applicationGroups: [],
      actions: [{ id: 'one', kind: 'manual', title: 'One hour', status: 'todo', estimatedMinutes: 60, leverage: 80, delayCost: 50,
        createdAt: now.toISOString(), updatedAt: now.toISOString() }],
      scheduleNodes: [{ id: 'past', occurrenceId: 'past', version: 1, kind: 'interview', state: 'scheduled', constraintKind: 'employer_hard',
        temporal: { shape: 'fixed_range', precision: 'datetime', timezone: 'UTC', startAt: '2026-10-06T08:00:00Z', endAt: '2026-10-06T12:00:00Z', resolutionBasis: 'source_explicit' },
        evidenceRefs: [], sourceVersionRefs: [], relatedActionIds: [], relatedPrepIds: [], createdAt: now.toISOString(), updatedAt: now.toISOString() }],
    }, now.toISOString())
    expect(selectTodayWeb(source, {}, { now, timezone: 'UTC' }).actions.map(item => item.actionId)).toEqual(['one'])
  })
})
