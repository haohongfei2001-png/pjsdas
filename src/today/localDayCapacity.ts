import { localDateKey } from '../todayBrief.js'
import type { TimePlanningPreferences } from '../timePlanningPreferences.js'

export function localDayBounds(today: string, timezone: string) {
  const noon = new Date(`${today}T12:00:00.000Z`).getTime()
  const firstTimeForDate = (date: string) => {
    let lower = noon - 48 * 3_600_000, upper = noon + 48 * 3_600_000
    while (upper - lower > 1) {
      const middle = Math.floor((lower + upper) / 2)
      if (localDateKey(new Date(middle), timezone) < date) lower = middle
      else upper = middle
    }
    return upper
  }
  const dayStart = firstTimeForDate(today)
  const following = new Date(`${today}T12:00:00.000Z`)
  following.setUTCDate(following.getUTCDate() + 1)
  const dayEnd = firstTimeForDate(following.toISOString().slice(0, 10))
  return { dayStart, dayEnd }
}


/** Full usable minutes until the next local date, including 23/25-hour DST days. */
export function remainingLocalDayMinutes(now: Date, timezone: string) {
  return Math.max(0, Math.floor((localDayBounds(localDateKey(now, timezone), timezone).dayEnd - now.getTime()) / 60_000))
}

/** Today ignores legacy recurring defaults without rewriting account-owned preferences. */
export function todayCapacity(preferences: TimePlanningPreferences | undefined, now: Date, timezone: string, explicit?: number) {
  const manual = explicit ?? preferences?.dateOverrides?.[localDateKey(now, timezone)]
  return { minutes: manual ?? remainingLocalDayMinutes(now, timezone), source: manual === undefined ? 'remaining_day' as const : 'manual' as const }
}
