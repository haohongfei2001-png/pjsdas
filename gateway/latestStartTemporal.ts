import { validSourceInstant } from '../src/sourceCalendar.js'

/** Admission for the newly exposed field only; legacy temporal DTOs are unchanged. */
export function validLatestStartWindow(value: {
  shape: string
  precision: string
  timezone: string
  startAt?: string
  endAt?: string
  latestStartAt?: string
}) {
  if (value.latestStartAt === undefined) return true
  if (value.shape !== 'availability_window' || value.precision !== 'datetime'
    || !value.startAt || !value.endAt || value.timezone === 'floating-date'
    || ![value.startAt, value.endAt, value.latestStartAt].every(validSourceInstant)) return false
  if (value.timezone !== 'source-offset') {
    try { new Intl.DateTimeFormat('en-US', { timeZone: value.timezone }).format(new Date(0)) }
    catch { return false }
  }
  const start = Date.parse(value.startAt), end = Date.parse(value.endAt), latest = Date.parse(value.latestStartAt)
  return start < end && start <= latest && latest <= end
}
