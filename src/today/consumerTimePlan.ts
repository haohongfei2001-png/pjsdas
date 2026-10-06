import type { RankedAction, ScheduleNode } from '../model.js'
import type { TimePlanningPreferences } from '../timePlanningPreferences.js'
import { localDayBounds as dayBounds, todayCapacity } from './localDayCapacity.js'
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
  selectionSearch?: { complete: boolean; explored: number; limit: number }
}

interface Interval { start: number; end: number }
const workIntervalCache = new Map<string, Interval[]>()

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
  /** Web Today uses a live remaining-day default; external brief contracts stay unchanged. */
  useRemainingDayDefault?: boolean
  now: Date
  timezone: string
}): ConsumerTimePlan {
  const today = localDateKey(input.now, input.timezone)
  const weekday = new Date(`${today}T12:00:00.000Z`).getUTCDay()
  const todayChoice = input.useRemainingDayDefault ? todayCapacity(input.preferences, input.now, input.timezone, input.availableMinutes) : undefined
  const capacityMinutes = todayChoice?.minutes ?? input.availableMinutes ?? capacityForDate(input.preferences, today, weekday)
  if (capacityMinutes !== undefined && (!Number.isInteger(capacityMinutes) || capacityMinutes < 0
    || (todayChoice?.source !== 'remaining_day' && capacityMinutes > 1440))) {
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
  const horizonDays: { windows: Interval[]; capacity?: number; reserved: number }[] = []
  let windowDay = bounds
  while (windowDay.dayStart < deadlineHorizon) {
    const date = localDateKey(new Date(windowDay.dayStart), input.timezone)
    const day = new Date(`${date}T12:00:00.000Z`).getUTCDay()
    const windows = workIntervals(input.preferences, day, windowDay, input.timezone)
      ?? [{ start: windowDay.dayStart, end: windowDay.dayEnd }]
    horizonDays.push({ windows, capacity: date === today ? capacityMinutes : capacityForDate(input.preferences, date, day),
      reserved: unionMinutes(intersectIntervals(windows, fixedIntervals(input.nodes, { ...windowDay,
        // A live remaining-time budget must not subtract commitments already in the past.
        dayStart: todayChoice && date === today ? Math.max(windowDay.dayStart, input.now.getTime()) : windowDay.dayStart }))) })
    if (windowDay.dayEnd >= deadlineHorizon) break
    windowDay = dayBounds(localDateKey(new Date(windowDay.dayEnd), input.timezone), input.timezone)
  }
  const freeBefore = (end: number) => {
    // Daily preferences/overrides constrain their own calendar day. Today's
    // window-derived capacity must not erase tomorrow's usable work window.
    return horizonDays.reduce((total, day) => {
      const clipped = day.windows.map(interval => ({ start: Math.max(interval.start, input.now.getTime()),
        end: Math.min(interval.end, end) })).filter(interval => interval.end > interval.start)
      // Floor usable minutes and ceil occupied minutes: never promise a minute
      // that is only partially left before a real deadline.
      const physical = Math.floor(clipped.reduce((sum, interval) => sum + interval.end - interval.start, 0) / 60_000)
        - unionMinutes(intersectIntervals(clipped, occupied))
      return total + Math.max(0, Math.min(physical, day.capacity === undefined ? Infinity : day.capacity - day.reserved))
    }, 0)
  }
  // Earliest-deadline knapsack: every retained prefix is feasible before its
  // own deadline. Maximize existing business priority across the whole subset,
  // rather than letting the first long task consume all remaining time.
  // Priority already incorporates opportunity value, fit, urgency, stage,
  // prep-graph leverage and cost efficiency. In-progress intent gets a bonus.
  const obligationsFor = (item: RankedAction) => {
    const cost = Math.max(1, Math.ceil(item.action.estimatedMinutes))
    const deadline = deadlineFor(item)
    const rawStart = nodeForAction(item.action, activeNodes)?.temporal.latestStartAt
    const latestStart = rawStart ? Date.parse(rawStart) : NaN
    // Starting by S requires the first work minute by S + one minute. The
    // remaining work may continue in later windows until the real deadline.
    if (item.action.status !== 'doing' && Number.isFinite(latestStart) && latestStart + 60_000 < deadline) {
      return [{ at: latestStart + 60_000, minutes: 1 }, { at: deadline, minutes: cost - 1 }]
    }
    return [{ at: deadline, minutes: cost }]
  }
  const obligations = new Map(mandatory.map(item => [item.action.id, obligationsFor(item)]))
  const hasStartConstraint = [...obligations.values()].some(entries => entries.length > 1)
  const eventTimes = hasStartConstraint ? [...new Set([...obligations.values()].flatMap(entries => entries.map(entry => entry.at)))].sort((a, b) => a - b) : []
  const eventCapacity = eventTimes.map(freeBefore)
  type Choice = { utility: number; items: RankedAction[]; key: string; demand: number[] }
  const empty: Choice = { utility: 0, items: [], key: '', demand: eventTimes.map(() => 0) }
  const better = (left: Choice, right: Choice) => left.utility > right.utility
    || (left.utility === right.utility && left.key < right.key)
  const utilityFor = (item: RankedAction) => item.score * item.score + (item.action.status === 'doing' ? 2500 : 0)
  const costFor = (item: RankedAction) => Math.max(1, Math.ceil(item.action.estimatedMinutes))
  const extend = (prior: Choice, item: RankedAction, demand: number[]) => ({
    utility: prior.utility + utilityFor(item), items: [...prior.items, item], demand,
    key: [...prior.items, item].map(entry => entry.action.id).sort().join('\0'),
  })
  let best = empty
  let selectionSearch: ConsumerTimePlan['selectionSearch']
  if (!hasStartConstraint) {
    // Ordinary deadlines retain exact, polynomial cost dynamic programming.
    const states = new Map<number, Choice>([[0, empty]])
    for (const item of mandatory) {
      const cost = costFor(item), limit = freeBefore(deadlineFor(item))
      for (const [used, prior] of [...states]) {
        const total = used + cost
        if (total > limit) continue
        const choice = extend(prior, item, [])
        const existing = states.get(total)
        if (!existing || better(choice, existing)) states.set(total, choice)
      }
    }
    for (const choice of states.values()) if (better(choice, best)) best = choice
  } else {
    const candidates = mandatory.map(item => ({ item, cost: costFor(item), utility: utilityFor(item),
      demand: eventTimes.map(at => obligations.get(item.action.id)!
        .reduce((sum, entry) => sum + (entry.at <= at ? entry.minutes : 0), 0)) }))
      .filter(candidate => candidate.demand.every((amount, index) => amount <= eventCapacity[index]!))
      .sort((a, b) => b.utility / b.cost - a.utility / a.cost || b.utility - a.utility
        || deadlineFor(a.item) - deadlineFor(b.item) || a.item.action.id.localeCompare(b.item.action.id))
    const add = (prior: Choice, candidate: typeof candidates[number]) => {
      const demand = prior.demand.map((amount, index) => amount + candidate.demand[index]!)
      return demand.some((amount, index) => amount > eventCapacity[index]!) ? undefined : extend(prior, candidate.item, demand)
    }
    // Seed a feasible full-workspace choice before searching. Every retained
    // choice satisfies both start and completion obligations, even at the limit.
    for (const order of [candidates, [...candidates].sort((a, b) => b.utility - a.utility || a.item.action.id.localeCompare(b.item.action.id))]) {
      let seed = empty
      for (const candidate of order) seed = add(seed, candidate) ?? seed
      if (better(seed, best)) best = seed
    }
    const maxMinutes = Math.min(eventCapacity.at(-1) ?? 0, candidates.reduce((sum, item) => sum + item.cost, 0))
    // A suffix knapsack ignores early constraints and therefore supplies a safe
    // upper bound. Coarsening only relaxes costs; it never rejects a feasible plan.
    const stride = Math.max(1, Math.ceil(maxMinutes / 1440))
    const columns = Math.ceil(maxMinutes / stride) + 1
    const upper = Array.from({ length: candidates.length + 1 }, () => new Float64Array(columns))
    for (let index = candidates.length - 1; index >= 0; index--) {
      const candidate = candidates[index]!, units = Math.floor(candidate.cost / stride)
      for (let remaining = 0; remaining < columns; remaining++) {
        upper[index]![remaining] = Math.max(upper[index + 1]![remaining]!, remaining >= units
          ? candidate.utility + upper[index + 1]![remaining - units]! : 0)
      }
    }
    const limit = Math.min(100_000, Math.max(1, Math.floor(2_000_000 / Math.max(1, eventTimes.length))))
    let explored = 0, complete = true
    const search = (index: number, used: number, choice: Choice, improveIdentity: boolean) => {
      if (better(choice, best)) best = choice
      if (index >= candidates.length) return
      const residual = Math.max(0, Math.ceil((maxMinutes - used) / stride))
      const bound = choice.utility + upper[index]![Math.min(columns - 1, residual)]!
      if (improveIdentity ? bound < best.utility : bound <= best.utility) return
      if (explored >= limit) { complete = false; return }
      explored++
      const candidate = candidates[index]!
      const next = add(choice, candidate)
      if (next) search(index + 1, used + candidate.cost, next, improveIdentity)
      search(index + 1, used, choice, improveIdentity)
    }
    // Utility improvement gets the budget first. Equality-only branches must
    // not exhaust it before reaching a higher-value subset.
    search(0, 0, empty, false)
    search(0, 0, empty, true)
    selectionSearch = { complete, explored, limit }
  }
  const planned = [...best.items].sort((a, b) => deadlineFor(a) - deadlineFor(b) || b.score - a.score || a.action.id.localeCompare(b.action.id))
  const selected = new Set(planned.map(item => item.action.id))
  const deferredHard = mandatory.filter(item => !selected.has(item.action.id))
  if (deferredHard.length) conflicts.push({ kind: 'hard_deadline_capacity',
    relatedIds: deferredHard.map(item => item.action.id), selectedIds: planned.map(item => item.action.id) })
  const todayFree = freeBefore(bounds.dayEnd)
  let prefixMinutes = 0, requiredToday = 0
  const selectedObligations = best.items.flatMap(item => obligations.get(item.action.id)!).sort((a, b) => a.at - b.at)
  for (const obligation of selectedObligations) {
    prefixMinutes += obligation.minutes
    const laterCapacity = Math.max(0, freeBefore(obligation.at) - todayFree)
    requiredToday = Math.max(requiredToday, prefixMinutes - laterCapacity)
  }
  // Allocate hard work as late as its deadlines permit, so minutes reserved
  // tomorrow do not consume today's otherwise usable flexible-work budget.
  let remaining = Math.max(0, todayFree - requiredToday)
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
  return { capacityMinutes, fixedMinutes, planned, deferredHard, selectionSearch,
    deferredCount: startable.length - planned.length, conflicts }
}
