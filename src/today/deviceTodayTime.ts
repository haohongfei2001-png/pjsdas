import { localDateKey } from '../todayBrief.js'
import { resolvePlanningTimezone, type TimePlanningPreferences } from '../timePlanningPreferences.js'

export function deviceTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/** A display/read context only: no stored dates, instants or preferences are migrated. */
export function surfaceTimezone(surface: string, preferences: TimePlanningPreferences | undefined, localZone: string) {
  return surface === 'today' ? localZone : resolvePlanningTimezone(preferences, localZone)
}

export function todayCapacityScope(account: string, now: Date, localZone: string) {
  return JSON.stringify([account, localZone, localDateKey(now, localZone)])
}
