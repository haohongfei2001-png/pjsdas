/** Account-owned planning choices. Missing preferences mean capacity is unknown. */
export interface WorkWindow {
  weekday: number
  startMinute: number
  endMinute: number
}

export interface TimePlanningPreferences {
  version: 1
  defaultDailyMinutes?: number
  weeklyWindows?: WorkWindow[]
  dateOverrides?: Record<string, number>
  updatedAt: string
}

export function validPlanningDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export function validateTimePlanningPreferences(value: TimePlanningPreferences): string[] {
  const errors: string[] = []
  if (!value || typeof value !== 'object') return ['Invalid planning preferences.']
  const minutes = value.defaultDailyMinutes
  if (value.version !== 1 || typeof value.updatedAt !== 'string' || !Number.isFinite(new Date(value.updatedAt).getTime())) errors.push('Invalid planning preference version or update time.')
  if (minutes !== undefined && (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440)) errors.push('Default available time must be 0–1440 minutes.')
  const overrides = value.dateOverrides
  if (overrides !== undefined && (!overrides || typeof overrides !== 'object' || Array.isArray(overrides))) errors.push('Invalid daily overrides.')
  for (const [date, amount] of Object.entries(overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : {})) {
    if (!validPlanningDate(date) || !Number.isInteger(amount) || amount < 0 || amount > 1440) errors.push(`Invalid available time for ${date}.`)
  }
  if (value.weeklyWindows !== undefined && !Array.isArray(value.weeklyWindows)) errors.push('Invalid work windows.')
  const windows = Array.isArray(value.weeklyWindows) ? value.weeklyWindows : []
  for (const window of windows) {
    if (!window || typeof window !== 'object') { errors.push('Invalid work window.'); continue }
    if (!Number.isInteger(window.weekday) || window.weekday < 0 || window.weekday > 6
      || !Number.isInteger(window.startMinute) || !Number.isInteger(window.endMinute)
      || window.startMinute < 0 || window.endMinute > 1440 || window.endMinute <= window.startMinute) errors.push('Invalid work window.')
  }
  if (windows.length > 21) errors.push('Too many work windows.')
  for (const [index, window] of windows.entries()) {
    if (!window || typeof window !== 'object') continue
    if (windows.some((other, at) => at !== index && other && typeof other === 'object' && other.weekday === window.weekday
      && other.startMinute < window.endMinute && window.startMinute < other.endMinute)) errors.push('Work windows may not overlap.')
  }
  return errors
}

export function capacityForDate(preferences: TimePlanningPreferences | undefined, date: string, weekday: number) {
  const selected = preferences?.dateOverrides?.[date] ?? preferences?.defaultDailyMinutes
  if (selected === undefined) return undefined
  const windows = preferences?.weeklyWindows?.filter(window => window.weekday === weekday) ?? []
  if (!windows.length) return selected
  const available = windows.reduce((sum, window) => sum + window.endMinute - window.startMinute, 0)
  return Math.min(selected, available)
}
