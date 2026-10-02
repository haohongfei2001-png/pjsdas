import type { DatePrecision } from './model.js'

/** Date.parse normalizes impossible dates; source evidence must never do so. */
export function validSourceDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = Date.parse(value + 'T00:00:00Z')
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value
}

/** A precise source instant needs a valid local calendar/clock and explicit offset. */
export function validSourceInstant(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value)
  if (!match || !validSourceDate(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] ?? 0) > 59) return false
  if (match[5] !== 'Z' && (Number(match[6]) > 14 || Number(match[7]) > 59 || Number(match[6]) === 14 && Number(match[7]) !== 0)) return false
  return Number.isFinite(Date.parse(value))
}

export function validSourceDeadline(value: string, precision: DatePrecision): boolean {
  return precision === 'date' ? validSourceDate(value) : validSourceInstant(value)
}
