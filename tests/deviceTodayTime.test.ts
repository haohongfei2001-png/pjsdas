import { describe, expect, it } from 'vitest'
import { surfaceTimezone, todayCapacityScope } from '../src/today/deviceTodayTime.js'
import { todayCapacity } from '../src/today/localDayCapacity.js'
import type { TimePlanningPreferences } from '../src/timePlanningPreferences.js'

describe('device-local Today context', () => {
  const preferences: TimePlanningPreferences = { version: 1, timezone: 'Europe/London', defaultDailyMinutes: 60,
    dateOverrides: { '2026-10-06': 360, '2026-10-07': 180 }, updatedAt: '2026-10-01T00:00:00Z' }
  it('uses the same device-local date for Today capacity and its save scope without rewriting preferences', () => {
    const now = new Date('2026-10-06T16:15:00Z'), before = JSON.stringify(preferences)
    for (const [timezone, date, minutes] of [['Asia/Shanghai', '2026-10-07', 180], ['America/Los_Angeles', '2026-10-06', 360]] as const) {
      const todayZone = surfaceTimezone('today', preferences, timezone)
      expect(todayZone).toBe(timezone)
      expect(JSON.parse(todayCapacityScope('owner', now, todayZone))).toEqual(['owner', timezone, date])
      expect(todayCapacity(preferences, now, todayZone)).toEqual({ source: 'manual', minutes })
    }
    expect(JSON.stringify(preferences)).toBe(before)
  })
  it('retains account planning context for Schedule, jobs and history', () => {
    for (const surface of ['schedule', 'opportunities', 'history', 'settings']) {
      expect(surfaceTimezone(surface, preferences, 'America/Los_Angeles')).toBe('Europe/London')
    }
  })
  it('changes the edit scope at midnight, on timezone changes even within one date, and on account switches', () => {
    const now = new Date('2026-10-06T15:59:59Z')
    const scope = todayCapacityScope('owner', now, 'Asia/Shanghai')
    expect(todayCapacityScope('owner', new Date('2026-10-06T16:00:00Z'), 'Asia/Shanghai')).not.toBe(scope)
    expect(todayCapacityScope('owner', now, 'Asia/Tokyo')).not.toBe(scope)
    expect(todayCapacityScope('other', now, 'Asia/Shanghai')).not.toBe(scope)
  })
})
