import type { ScheduleNodeTemporal } from './model.js'

const zoneValidity = new Map<string, string | undefined>()
const formatters = new Map<string, Intl.DateTimeFormat>()
function formatter(locale: string, options: Intl.DateTimeFormatOptions) {
  const key = JSON.stringify([locale, options])
  let found = formatters.get(key)
  if (!found) {
    found = new Intl.DateTimeFormat(locale, options)
    if (formatters.size >= 64) formatters.delete(formatters.keys().next().value!)
    formatters.set(key, found)
  }
  return found
}
function validTimezone(value?: string): string | undefined {
  if (!value || value === 'source-offset' || value === 'floating-date') return undefined
  if (zoneValidity.has(value)) return zoneValidity.get(value)
  let valid: string | undefined
  try { formatter('en-US', { timeZone: value }).format(new Date(0)); valid = value } catch { /* invalid source zone */ }
  if (zoneValidity.size >= 64) zoneValidity.delete(zoneValidity.keys().next().value!)
  zoneValidity.set(value, valid)
  return valid
}

/** A normalized legacy zone describes storage provenance, not the user's clock. */
export function scheduleDisplayTimezone(value?: string, basis?: ScheduleNodeTemporal['resolutionBasis'], displayTimezone?: string): string | undefined {
  return (basis === 'source_explicit' ? validTimezone(value) : undefined)
    ?? validTimezone(displayTimezone)
}

export function formatScheduleTemporal(temporal: Partial<ScheduleNodeTemporal>, zh: boolean, displayTimezone?: string): string | undefined {
  if (temporal.precision === 'date') return temporal.date
  const at = temporal.startAt ?? temporal.deadlineAt ?? temporal.endAt
  if (!at || !Number.isFinite(Date.parse(at))) return undefined
  const timezone = scheduleDisplayTimezone(temporal.timezone, temporal.resolutionBasis, displayTimezone)
  const locale = zh ? 'zh-CN' : 'en-GB'
  const formatted = formatter(locale, { month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    timeZone: timezone }).format(new Date(at))
  if (temporal.resolutionBasis !== 'source_explicit') return formatted
  const displayZone = formatter('en-US', { timeZone: validTimezone(displayTimezone) }).resolvedOptions().timeZone
  const sourceZone = formatter('en-US', { timeZone: timezone }).resolvedOptions().timeZone
  if (sourceZone === displayZone) return formatted
  const zoneLabel = formatter(locale, { timeZone: timezone, timeZoneName: 'shortOffset' })
    .formatToParts(new Date(at)).find(part => part.type === 'timeZoneName')?.value
  return `${formatted} (${zoneLabel})`
}
