import type { RankedAction, ScheduleNode } from '../model.js'
import type { TimePlanningPreferences } from '../timePlanningPreferences.js'
import { capacityForDate } from '../timePlanningPreferences.js'
import { dueSortValue, latestByOccurrence, localDateKey, nodeForAction } from '../todayBrief.js'

export interface ConsumerTimeConflict {
  kind: 'fixed_overlap' | 'hard_deadline_capacity'
  relatedIds: string[]
  at?: string
}

export interface ConsumerTimePlan {
  capacityMinutes?: number
  fixedMinutes: number
  planned: RankedAction[]
  deferredCount: number
  conflicts: ConsumerTimeConflict[]
}

interface Interval { start: number; end: number }
const workIntervalCache = new Map<string, Interval[]>()

function dayBounds(today: string, timezone: string) {
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

function workIntervals(preferences: TimePlanningPreferences | undefined, weekday: number, bounds: ReturnType<typeof dayBounds>, timezone: string): Interval[] | undefined {
  const windows = preferences?.weeklyWindows?.filter(window => window.weekday === weekday) ?? []
  if (!windows.length) return undefined
  const cacheKey = JSON.stringify([bounds.dayStart, bounds.dayEnd, timezone, windows])
  const cached = workIntervalCache.get(cacheKey)
  if (cached) return cached
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const within = (millis: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(millis)).map(part => [part.type, part.value]))
    const minute = Number(parts.hour) * 60 + Number(parts.minute)
    return windows.some(window => minute >= window.startMinute && minute < window.endMinute)
  }
  const intervals: Interval[] = []
  for (let minute = bounds.dayStart; minute < bounds.dayEnd; minute += 60_000) {
    if (within(minute)) {
      const last = intervals.at(-1)
      if (last?.end === minute) last.end = Math.min(bounds.dayEnd, minute + 60_000)
      else intervals.push({ start: minute, end: Math.min(bounds.dayEnd, minute + 60_000) })
    }
  }
  if (workIntervalCache.size >= 20) workIntervalCache.delete(workIntervalCache.keys().next().value!)
  workIntervalCache.set(cacheKey, intervals)
  return intervals
}

function intersectIntervals(left: Interval[], right: Interval[]): Interval[] {
  return left.flatMap(a => right.flatMap(b => {
    const start = Math.max(a.start, b.start), end = Math.min(a.end, b.end)
    return end > start ? [{ start, end }] : []
  })).sort((a, b) => a.start - b.start)
}

function fixedIntervals(nodes: ScheduleNode[], bounds: ReturnType<typeof dayBounds>) {
  return latestByOccurrence(nodes).filter(node => (node.state === 'scheduled' || node.state === 'in_progress')
    && node.temporal.shape === 'fixed_range' && node.temporal.startAt && node.temporal.endAt)
    .map(node => ({ node, start: Math.max(bounds.dayStart, new Date(node.temporal.startAt!).getTime()),
      end: Math.min(bounds.dayEnd, new Date(node.temporal.endAt!).getTime()) }))
    .filter(entry => Number.isFinite(entry.start) && Number.isFinite(entry.end) && entry.end > entry.start)
    .sort((a, b) => a.start - b.start || a.node.id.localeCompare(b.node.id))
}

function unionMinutes(intervals: Interval[]) {
  let total = 0, lastEnd = -Infinity
  for (const interval of intervals) {
    total += Math.max(0, interval.end - Math.max(interval.start, lastEnd))
    lastEnd = Math.max(lastEnd, interval.end)
  }
  return Math.ceil(total / 60_000)
}

function dateForAction(item: RankedAction, node: ScheduleNode | undefined, timezone: string) {
  if (node?.temporal.precision === 'date') return node.temporal.date
  const raw = node?.temporal.deadlineAt ?? node?.temporal.endAt ?? item.action.dueAt
  if (!raw) return undefined
  if (item.action.duePrecision === 'date' && !node) return raw.slice(0, 10)
  const parsed = new Date(raw)
  return Number.isFinite(parsed.getTime()) ? localDateKey(parsed, timezone) : undefined
}

function isHard(item: RankedAction, node: ScheduleNode | undefined) {
  if (node?.constraintKind === 'employer_hard' && node.temporal.shape !== 'fixed_range') return true
  return (item.action.kind === 'apply' || item.action.kind === 'group_decision') && Boolean(item.action.dueAt)
}

function needsStartToday(item: RankedAction, node: ScheduleNode | undefined, today: string, timezone: string) {
  if (dateForAction(item, node, timezone) === today) return true
  const explicit = node?.temporal.latestStartAt
  const dueAt = node?.temporal.deadlineAt ?? (item.action.duePrecision === 'datetime' ? item.action.dueAt : undefined)
  const latestStart = explicit ? new Date(explicit).getTime()
    : dueAt ? new Date(dueAt).getTime() - item.action.estimatedMinutes * 60_000 : NaN
  return Number.isFinite(latestStart) && localDateKey(new Date(latestStart), timezone) <= today
}

export function buildConsumerTimePlan(input: {
  ranked: RankedAction[]
  nodes: ScheduleNode[]
  preferences?: TimePlanningPreferences
  availableMinutes?: number
  now: Date
  timezone: string
}): ConsumerTimePlan {
  const today = localDateKey(input.now, input.timezone)
  const weekday = new Date(`${today}T12:00:00.000Z`).getUTCDay()
  const capacityMinutes = input.availableMinutes ?? capacityForDate(input.preferences, today, weekday)
  if (capacityMinutes !== undefined && (!Number.isInteger(capacityMinutes) || capacityMinutes < 0 || capacityMinutes > 1440)) {
    throw new Error('Today available time must be between 0 and 1440 minutes.')
  }
  const bounds = dayBounds(today, input.timezone)
  const available = workIntervals(input.preferences, weekday, bounds, input.timezone)
  const fixed = fixedIntervals(input.nodes, bounds)
  const fixedMinutes = unionMinutes(available ? intersectIntervals(fixed, available) : fixed)
  const conflicts: ConsumerTimeConflict[] = []
  for (let index = 0; index < fixed.length; index += 1) {
    const current = fixed[index]!
    for (const later of fixed.slice(index + 1)) {
      if (later.start >= current.end) break
      if (later.node.occurrenceId === current.node.occurrenceId) continue
      conflicts.push({ kind: 'fixed_overlap', relatedIds: [current.node.id, later.node.id], at: new Date(later.start).toISOString() })
    }
  }
  const activeNodes = latestByOccurrence(input.nodes)
  const startable = input.ranked.filter(item => item.action.timingMode !== 'fixed')
  const mandatory = startable.filter(item => {
    const node = nodeForAction(item.action, activeNodes)
    return isHard(item, node) && needsStartToday(item, node, today, input.timezone)
  }).sort((a, b) => dueSortValue(a.action, nodeForAction(a.action, activeNodes))
    - dueSortValue(b.action, nodeForAction(b.action, activeNodes)) || b.score - a.score)
  const planned: RankedAction[] = []
  const selected = new Set<string>()
  const workRemaining = available === undefined ? Infinity : unionMinutes(available.map(interval => ({
    start: Math.max(interval.start, input.now.getTime()), end: interval.end,
  })).filter(interval => interval.end > interval.start))
    - unionMinutes(intersectIntervals(available, fixed).map(interval => ({
      start: Math.max(interval.start, input.now.getTime()), end: interval.end,
    })).filter(interval => interval.end > interval.start))
  let remaining = capacityMinutes === undefined ? 0 : Math.max(0, Math.min(capacityMinutes - fixedMinutes, workRemaining))
  const impossible: string[] = []
  let requiredMinutes = 0
  for (const item of mandatory) {
    const node = nodeForAction(item.action, activeNodes)
    const deadlineRaw = node?.temporal.deadlineAt ?? (item.action.duePrecision === 'datetime' ? item.action.dueAt : undefined)
    const deadline = deadlineRaw ? new Date(deadlineRaw).getTime() : undefined
    const minutesToDeadline = deadline !== undefined && Number.isFinite(deadline)
      ? (available === undefined ? Math.max(0, Math.floor((deadline - input.now.getTime()) / 60_000))
        : unionMinutes(available.map(interval => ({ start: Math.max(interval.start, input.now.getTime()),
          end: Math.min(interval.end, deadline) })).filter(interval => interval.end > interval.start))) : Infinity
    const fixedBeforeDeadline = deadline !== undefined && Number.isFinite(deadline)
      ? unionMinutes((available ? intersectIntervals(fixed, available) : fixed).map(interval => ({
        start: Math.max(interval.start, input.now.getTime()), end: Math.min(interval.end, deadline),
      })).filter(interval => interval.end > interval.start)) : 0
    requiredMinutes += item.action.estimatedMinutes
    const dueToday = dateForAction(item, node, input.timezone) === today
    if ((dueToday && capacityMinutes !== undefined && item.action.estimatedMinutes > remaining)
      || requiredMinutes > Math.max(0, minutesToDeadline - fixedBeforeDeadline)) {
      impossible.push(item.action.id)
      remaining = 0
    } else if (capacityMinutes !== undefined) remaining = Math.max(0, remaining - item.action.estimatedMinutes)
    planned.push(item)
    selected.add(item.action.id)
  }
  if (impossible.length) conflicts.push({ kind: 'hard_deadline_capacity', relatedIds: impossible })
  const flexible = startable.filter(item => !selected.has(item.action.id) && !mandatory.includes(item))
    .sort((a, b) => (b.action.status === 'doing' ? 1 : 0) - (a.action.status === 'doing' ? 1 : 0)
      || b.score - a.score || a.action.id.localeCompare(b.action.id))
  for (const item of flexible) {
    if (planned.length >= 8) break
    if (capacityMinutes === undefined && planned.length >= Math.max(1, mandatory.length)) break
    if (capacityMinutes !== undefined && item.action.estimatedMinutes > remaining) continue
    planned.push(item)
    selected.add(item.action.id)
    if (capacityMinutes !== undefined) remaining -= item.action.estimatedMinutes
  }
  return { capacityMinutes, fixedMinutes, planned,
    deferredCount: startable.length - planned.length, conflicts }
}
