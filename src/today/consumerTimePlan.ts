import type { RankedAction, ScheduleNode } from '../model.js'
import type { TimePlanningPreferences } from '../timePlanningPreferences.js'
import { capacityForDate } from '../timePlanningPreferences.js'
import { latestByOccurrence, localDateKey, nodeForAction } from '../todayBrief.js'

export interface ConsumerTimeConflict {
  kind: 'fixed_overlap' | 'hard_deadline_capacity'
  relatedIds: string[]
  at?: string
  selectedIds?: string[]
}

export interface ConsumerTimePlan {
  capacityMinutes?: number
  fixedMinutes: number
  planned: RankedAction[]
  deferredCount: number
  deferredHard: RankedAction[]
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
  const deadlineFor = (item: RankedAction) => {
    const node = nodeForAction(item.action, activeNodes)
    const date = node?.temporal.precision === 'date' ? node.temporal.date
      : !node && item.action.duePrecision === 'date' ? item.action.dueAt?.slice(0, 10) : undefined
    if (date) return dayBounds(date, input.timezone).dayEnd
    const raw = node?.temporal.deadlineAt ?? node?.temporal.endAt ?? item.action.dueAt
    const at = raw ? Date.parse(raw) : NaN
    return Number.isFinite(at) ? at : bounds.dayEnd
  }
  const mandatory = startable.filter(item => {
    const node = nodeForAction(item.action, activeNodes)
    return isHard(item, node) && needsStartToday(item, node, today, input.timezone)
  }).sort((a, b) => deadlineFor(a) - deadlineFor(b) || b.score - a.score || a.action.id.localeCompare(b.action.id))
  // Exact instants can cross local midnight. Reserve fixed commitments through
  // those deadlines too; a local calendar boundary is not a fabricated cutoff.
  const deadlineHorizon = Math.max(bounds.dayEnd, ...mandatory.map(deadlineFor))
  const occupied = fixedIntervals(input.nodes, { ...bounds, dayEnd: deadlineHorizon })
  const horizonWindows: Interval[] = []
  let windowDay = bounds
  while (windowDay.dayStart < deadlineHorizon) {
    const date = localDateKey(new Date(windowDay.dayStart), input.timezone)
    const day = new Date(`${date}T12:00:00.000Z`).getUTCDay()
    horizonWindows.push(...(workIntervals(input.preferences, day, windowDay, input.timezone)
      ?? [{ start: windowDay.dayStart, end: windowDay.dayEnd }]))
    if (windowDay.dayEnd >= deadlineHorizon) break
    windowDay = dayBounds(localDateKey(new Date(windowDay.dayEnd), input.timezone), input.timezone)
  }
  const freeBefore = (end: number) => {
    const clipped = horizonWindows.map(interval => ({ start: Math.max(interval.start, input.now.getTime()),
      end: Math.min(interval.end, end) })).filter(interval => interval.end > interval.start)
    // Floor usable minutes and ceil occupied minutes: never promise a minute
    // that is only partially left before a real deadline.
    const physical = Math.floor(clipped.reduce((sum, interval) => sum + interval.end - interval.start, 0) / 60_000)
      - unionMinutes(intersectIntervals(clipped, occupied))
    return Math.max(0, Math.min(physical, capacityMinutes === undefined ? Infinity : capacityMinutes - fixedMinutes))
  }
  // Earliest-deadline knapsack: every retained prefix is feasible before its
  // own deadline. Maximize existing business priority across the whole subset,
  // rather than letting the first long task consume all remaining time.
  // Priority already incorporates opportunity value, fit, urgency, stage,
  // prep-graph leverage and cost efficiency. In-progress intent gets a bonus.
  type Choice = { utility: number; items: RankedAction[]; key: string }
  const states = new Map<number, Choice>([[0, { utility: 0, items: [], key: '' }]])
  const better = (left: Choice, right: Choice) => left.utility > right.utility
    || (left.utility === right.utility && left.key < right.key)
  for (const item of mandatory) {
    const cost = Math.max(1, Math.ceil(item.action.estimatedMinutes))
    const limit = freeBefore(deadlineFor(item))
    const utility = item.score * item.score + (item.action.status === 'doing' ? 2500 : 0)
    for (const [used, prior] of [...states]) {
      const total = used + cost
      if (total > limit) continue
      const choice = { utility: prior.utility + utility, items: [...prior.items, item],
        key: [...prior.items, item].map(entry => entry.action.id).sort().join('\0') }
      const existing = states.get(total)
      if (!existing || better(choice, existing)) states.set(total, choice)
    }
  }
  let best: Choice = states.get(0)!, bestMinutes = 0
  for (const [used, choice] of states) {
    if (better(choice, best) || (choice.utility === best.utility && used < bestMinutes)) { best = choice; bestMinutes = used }
  }
  const planned = [...best.items]
  const selected = new Set(planned.map(item => item.action.id))
  const deferredHard = mandatory.filter(item => !selected.has(item.action.id))
  if (deferredHard.length) conflicts.push({ kind: 'hard_deadline_capacity',
    relatedIds: deferredHard.map(item => item.action.id), selectedIds: planned.map(item => item.action.id) })
  let remaining = Math.max(0, freeBefore(bounds.dayEnd) - bestMinutes)
  const flexible = startable.filter(item => !selected.has(item.action.id) && !mandatory.includes(item))
    .sort((a, b) => (b.action.status === 'doing' ? 1 : 0) - (a.action.status === 'doing' ? 1 : 0)
      || b.score - a.score || a.action.id.localeCompare(b.action.id))
  for (const item of flexible) {
    if (planned.length >= 8) break
    if (capacityMinutes === undefined && planned.length >= Math.max(1, best.items.length)) break
    if (item.action.estimatedMinutes > remaining) continue
    planned.push(item)
    selected.add(item.action.id)
    remaining -= item.action.estimatedMinutes
  }
  return { capacityMinutes, fixedMinutes, planned, deferredHard,
    deferredCount: startable.length - planned.length, conflicts }
}
