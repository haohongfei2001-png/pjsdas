import type { ScheduleNodeTemporal } from './model.js'

/** Resolve source expressions against their original timestamp, never ingestion/replay time. */
export function resolveSourceTemporal(text: string, options: {
  receivedAt: string
  timezone: string
  mode?: 'fixed' | 'deadline'
}): ScheduleNodeTemporal | undefined {
  const received = new Date(options.receivedAt)
  if (Number.isNaN(received.getTime())) return undefined
  // An unparsed source timezone or offset must not silently become the configured zone.
  if (/(?:UTC|GMT|[+-]\d{2}:?\d{2}|\d{2}:\d{2}(?::\d{2})?Z\b|\b[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?\b|美国|欧洲|伦敦|\b(?:PST|PDT|EST|EDT|CST|BST|CET|CEST|JST|KST|IST)\b)/i.test(text)) return undefined
  if (/\d{1,2}:\d{2}(?::\d{2})?\s+[A-Z]{3,5}\b/.test(text)) return undefined
  let parts: Record<string, string>
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: options.timezone,
      year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(received).map((part) => [part.type, part.value]))
  } catch { return undefined }
  const explicitRange = /(20\d{2})[年\/-](\d{1,2})[月\/-](\d{1,2})日?[^\d]{0,12}(\d{1,2})[:：](\d{2})\s*(?:-|—|–|~|～|至|到)\s*(\d{1,2})[:：](\d{2})/.exec(text)
  if (explicitRange) {
    const day = `${explicitRange[1]}-${explicitRange[2]!.padStart(2, '0')}-${explicitRange[3]!.padStart(2, '0')}`
    const checked = new Date(`${day}T00:00:00Z`)
    const startHour = Number(explicitRange[4]); const startMinute = Number(explicitRange[5])
    const endHour = Number(explicitRange[6]); const endMinute = Number(explicitRange[7])
    if (Number.isNaN(checked.getTime()) || checked.toISOString().slice(0, 10) !== day
      || startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) return undefined
    const startAt = uniqueInstantForLocal(
      `${day}T${String(startHour).padStart(2, '0')}:${String(startMinute).padStart(2, '0')}:00`,
      options.timezone,
    )
    const endAt = uniqueInstantForLocal(
      `${day}T${String(endHour).padStart(2, '0')}:${String(endMinute).padStart(2, '0')}:00`,
      options.timezone,
    )
    if (!startAt || !endAt || Date.parse(endAt) <= Date.parse(startAt)) return undefined
    const latestMatch = /(?:最晚|最迟)\s*(?:开始|开考|入场|进入|启动)?\s*[:：]?\s*(\d{1,2})[:：](\d{2})|latest\s+start(?:\s+time)?\s*[:：]?\s*(\d{1,2})[:：](\d{2})/i.exec(text)
    let latestStartAt: string | undefined
    if (latestMatch) {
      const hour = Number(latestMatch[1] ?? latestMatch[3])
      const minute = Number(latestMatch[2] ?? latestMatch[4])
      if (hour > 23 || minute > 59) return undefined
      latestStartAt = uniqueInstantForLocal(
        `${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`,
        options.timezone,
      )
      if (!latestStartAt || Date.parse(latestStartAt) < Date.parse(startAt) || Date.parse(latestStartAt) > Date.parse(endAt)) {
        return undefined
      }
    }
    return {
      shape: 'availability_window',
      precision: 'datetime',
      timezone: options.timezone,
      startAt,
      endAt,
      ...(latestStartAt ? { latestStartAt } : {}),
      resolutionBasis: 'source_explicit',
      rawExpression: explicitRange[0].slice(0, 180),
    }
  }

  if (/(?:开放|可参加|可完成|有效时间|时间窗|availability|available|window)/i.test(text)) {
    const bounds = text.split(/至|到|[~～]|\s+to\s+/i)
    if (bounds.length === 2) {
      const start = resolveSourceTemporal(bounds[0]!, { ...options, mode: 'fixed' })
      const rightHasDay = /20\d{2}[年\/-]|今天|明天|后天|周|today|tomorrow|this |next /i.test(bounds[1]!)
      const right = rightHasDay ? bounds[1]! : `${start?.startAt?.slice(0, 10) ?? ''} ${bounds[1]}`
      const end = resolveSourceTemporal(right, { ...options, mode: 'fixed' })
      if (start?.startAt && end?.startAt && Date.parse(end.startAt) > Date.parse(start.startAt)) {
        return { shape: 'availability_window', startAt: start.startAt, endAt: end.startAt,
          precision: 'datetime', timezone: options.timezone, resolutionBasis: 'source_explicit',
          rawExpression: `${start.rawExpression} – ${end.rawExpression}`.slice(0, 220) }
      }
      return undefined
    }
    if (bounds.length > 2) return undefined
  }
  const fullDates = [...text.matchAll(/(20\d{2})[年\/-](\d{1,2})[月\/-](\d{1,2})日?/g)]
  const relative = [...text.matchAll(/大后天|后天|明天|今天|day after tomorrow|tomorrow|today|(?:本|下)周[一二三四五六日天]|(?:this|next)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)/gi)]
  if (fullDates.length + relative.length !== 1) return undefined
  let day: string
  let expression: string
  if (fullDates.length) {
    const match = fullDates[0]!
    day = `${match[1]}-${match[2]!.padStart(2, '0')}-${match[3]!.padStart(2, '0')}`
    expression = match[0]
    const checked = new Date(`${day}T00:00:00Z`)
    if (Number.isNaN(checked.getTime()) || checked.toISOString().slice(0, 10) !== day) return undefined
  } else {
    expression = relative[0]![0].toLowerCase()
    const originalDay = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`)
    let offset = /大后天/.test(expression) ? 3 : /后天|day after tomorrow/.test(expression) ? 2 : /明天|tomorrow/.test(expression) ? 1 : 0
    if (/周|^(?:this|next) /.test(expression)) {
      const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
      const weekday = expression.includes('周') ? Math.min('一二三四五六日天'.indexOf(expression.slice(-1)), 6)
        : weekdays.findIndex((name) => expression.endsWith(name))
      const mondayOffset = (originalDay.getUTCDay() + 6) % 7
      offset = weekday - mondayOffset + (/下周|^next /.test(expression) ? 7 : 0)
    }
    originalDay.setUTCDate(originalDay.getUTCDate() + offset)
    day = originalDay.toISOString().slice(0, 10)
  }
  const clocks = [...text.matchAll(/(?:^|[^\d])(\d{1,2})[:：](\d{2})(?:\s*(am|pm))?/gi)]
  if (!clocks.length && options.mode === 'deadline') return { shape: 'date_only', date: day,
    precision: 'date', timezone: options.timezone, resolutionBasis: 'source_explicit', rawExpression: expression }
  if (clocks.length !== 1) return undefined
  const clock = clocks[0]!
  let hour = Number(clock[1]); const minute = Number(clock[2])
  const meridiem = clock[3]?.toLowerCase() ?? (/下午|晚上|中午/.test(text) ? 'pm' : /上午|早上/.test(text) ? 'am' : undefined)
  if (meridiem) { if (hour < 1 || hour > 12) return undefined; hour = hour % 12 + (meridiem === 'pm' ? 12 : 0) }
  if (hour > 23 || minute > 59) return undefined
  const local = `${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`
  const instant = uniqueInstantForLocal(local, options.timezone)
  if (!instant) return undefined // DST nonexistent or duplicated wall-clock time is a decision.
  return { shape: options.mode === 'deadline' ? 'deadline' : 'fixed_range',
    ...(options.mode === 'deadline' ? { deadlineAt: instant } : { startAt: instant }),
    precision: 'datetime', timezone: options.timezone, resolutionBasis: 'source_explicit',
    rawExpression: `${expression} ${clock[0]!.trim()}`.slice(0, 100) }
}

function uniqueInstantForLocal(local: string, timezone: string): string | undefined {
  const wall = Date.parse(`${local}Z`)
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
  const formatted = (instant: number) => {
    const p = Object.fromEntries(formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]))
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`
  }
  const offsets = new Set<number>()
  // Sample either side of any ordinary timezone transition to detect both folds.
  for (const hours of [-36, -12, 0, 12, 36]) {
    const sample = wall + hours * 3_600_000
    offsets.add(Date.parse(`${formatted(sample)}Z`) - sample)
  }
  const matches = [...offsets].map((offset) => wall - offset).filter((instant) => formatted(instant) === local)
  if (matches.length !== 1) return undefined
  // Retain a stable explicit offset so the instant remains meaningful without locale state.
  const offset = (wall - matches[0]!) / 60_000
  const sign = offset < 0 ? '-' : '+'
  return `${local}${sign}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:${String(Math.abs(offset) % 60).padStart(2, '0')}`
}
