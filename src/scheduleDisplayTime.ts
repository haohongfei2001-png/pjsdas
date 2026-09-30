import type { ScheduleNodeTemporal } from './model.js'

function validTimezone(value?: string): string | undefined {
  if (!value || value === 'source-offset' || value === 'floating-date') return undefined
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0))
    return value
  } catch {
    return undefined
  }
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
  const formatted = new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    timeZone: timezone }).format(new Date(at))
  if (temporal.resolutionBasis !== 'source_explicit') return formatted
  const displayZone = new Intl.DateTimeFormat('en-US', { timeZone: validTimezone(displayTimezone) }).resolvedOptions().timeZone
  const sourceZone = new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone
  if (sourceZone === displayZone) return formatted
  const zoneLabel = new Intl.DateTimeFormat(locale, { timeZone: timezone, timeZoneName: 'shortOffset' })
    .formatToParts(new Date(at)).find(part => part.type === 'timeZoneName')?.value
  return `${formatted} (${zoneLabel})`
}
