/** Storage timezone markers describe provenance; Intl only accepts actual timezones. */
export function scheduleDisplayTimezone(value?: string): string | undefined {
  if (!value || value === 'source-offset' || value === 'floating-date') return undefined
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0))
    return value
  } catch {
    return undefined
  }
}
