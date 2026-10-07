import { actionArrangementDate, calendarNodeProjection, isExplicitActionArrangement, scheduleNodeEligible } from '../scheduleEligibility.js'
import { actionDeadline, actionNodesById, compareActionDeadlines, deadlineBoundaryMs } from '../deadlineOrder.js'
import type { Opportunity, ProcessEvent, RankedAction, ScheduleNode } from '../model.js'
import type { TimePlanningPreferences } from '../timePlanningPreferences.js'
import { localDayBounds as dayBounds, todayCapacity } from './localDayCapacity.js'
import { capacityForDate } from '../timePlanningPreferences.js'
import { latestByOccurrence, localDateKey } from '../todayBrief.js'

export interface ConsumerTimeConflict {
  kind: 'fixed_overlap' | 'hard_deadline_capacity'
  relatedIds: string[]
  at?: string
  selectedIds?: string[]
}

export interface ConsumerTimePlan {
  capacityMinutes?: number
  fixedMinutes: number
  plannedMinutes: number
  overBudgetMinutes: number
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


function isHard(item: RankedAction, node: ScheduleNode | undefined) {
  if (!actionDeadline(item.action, node).deadline) return false
  if (node?.constraintKind === 'employer_hard' && node.temporal.shape !== 'fixed_range') return true
  return Boolean(item.action.dueAt && (item.action.processEventId || item.action.kind === 'apply' || item.action.kind === 'group_decision'))
}

function needsStartToday(item: RankedAction, node: ScheduleNode | undefined, today: string, timezone: string) {
  const deadline = actionDeadline(item.action, node)
  const boundary = deadlineBoundaryMs(deadline, timezone)
  if (boundary === undefined) return false
  // A date-only value owns its source calendar day, not the viewer's calendar.
  if (localDateKey(new Date(boundary - (deadline.precision === 'date' ? 1 : 0)), timezone) === today) return true
  const explicit = node?.temporal.latestStartAt
  const latestStart = explicit ? Date.parse(explicit) : boundary - item.action.estimatedMinutes * 60_000
  return Number.isFinite(latestStart) && localDateKey(new Date(latestStart), timezone) <= today
}

export function buildConsumerTimePlan(input: {
  ranked: RankedAction[]
  nodes: ScheduleNode[]
  opportunities?: Opportunity[]
  processEvents?: ProcessEvent[]
  preferences?: TimePlanningPreferences
  availableMinutes?: number
  /** Current Web and external plans share the live remaining-day/manual capacity. */
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
  const available = input.useRemainingDayDefault ? undefined : workIntervals(input.preferences, weekday, bounds, input.timezone)
  const calendarNodes = input.nodes.filter(node => scheduleNodeEligible(node, {
    actions: input.ranked.map(item => item.action), processEvents: input.processEvents ?? [],
  })).map(calendarNodeProjection)
  const fixed = fixedIntervals(calendarNodes, { ...bounds, dayStart: todayChoice ? Math.max(bounds.dayStart, input.now.getTime()) : bounds.dayStart })
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
  const nodeMap = actionNodesById(input.nodes, input.ranked.map(item => item.action), input.opportunities, input.processEvents)
  const compare = (a: RankedAction, b: RankedAction) => compareActionDeadlines(a.action, b.action, input.timezone,
    nodeMap.get(a.action.id), nodeMap.get(b.action.id))
  const arrangements = input.ranked.filter(item => {
    if (!isExplicitActionArrangement(item.action.scheduledTemporal)) return false
    const owner = nodeMap.get(item.action.id)
    return !owner || ['scheduled', 'in_progress'].includes(owner.state)
  })
  const arrangedToday = arrangements.filter(item => actionArrangementDate(item.action.scheduledTemporal!) === today)
  // Unknown ends remain unknown. These are workload reservations, never
  // fabricated fixed intervals or evidence of an overlap.
  const estimatedByDay = new Map<string, Array<{ start: number; minutes: number }>>()
  for (const item of arrangements.filter(item => !item.action.scheduledTemporal!.endAt)) {
    const temporal = item.action.scheduledTemporal!, date = actionArrangementDate(temporal)!
    const reservations = estimatedByDay.get(date) ?? []
    reservations.push({ start: Date.parse(temporal.startAt!), minutes: item.action.estimatedMinutes })
    estimatedByDay.set(date, reservations)
  }
  const startable = input.ranked.filter(item => {
    const action = item.action
    const owner = nodeMap.get(action.id)
    // Explicitly reopening work does not reopen its historical calendar fact.
    // Its retained chosen day can still own ordinary, capacity-limited work.
    const historicalArrangement = action.scheduledTemporal && owner?.constraintKind === 'user_plan'
      && isExplicitActionArrangement(owner.temporal) && !['scheduled', 'in_progress'].includes(owner.state)
    if ((action.scheduledTemporal || action.timingMode === 'fixed') && !historicalArrangement) return false
    if (action.plannedDate) return action.plannedDate === today
    // A real recruiting obligation may be due/overdue without a chosen plan.
    // Ordinary task deadlines and old automatic apply tasks do not choose today.
    const event = input.processEvents?.find(event => event.id === action.processEventId && !event.invalidation)
    return Boolean(event && event.dueAt && event.timingMode !== 'fixed'
      && needsStartToday(item, nodeMap.get(action.id), today, input.timezone))
  }).sort(compare)
  const deadlineFor = (item: RankedAction) => {
    const node = nodeMap.get(item.action.id)
    const deadline = actionDeadline(item.action, node)
    return deadlineBoundaryMs(deadline, input.timezone) ?? bounds.dayEnd
  }
  const mandatory = startable.filter(item => {
    const node = nodeMap.get(item.action.id)
    return isHard(item, node) && needsStartToday(item, node, today, input.timezone)
  }).sort(compare)
  // Exact instants can cross local midnight. Reserve fixed commitments through
  // those deadlines too; a local calendar boundary is not a fabricated cutoff.
  const deadlineHorizon = Math.max(bounds.dayEnd, ...mandatory.map(deadlineFor))
  const occupied = fixedIntervals(calendarNodes, { ...bounds, dayEnd: deadlineHorizon })
  const horizonDays: { windows: Interval[]; capacity?: number; reserved: number; estimates: Array<{ start: number; minutes: number }> }[] = []
  let windowDay = bounds
  while (windowDay.dayStart < deadlineHorizon) {
    const date = localDateKey(new Date(windowDay.dayStart), input.timezone)
    const day = new Date(`${date}T12:00:00.000Z`).getUTCDay()
    // Today has only its remaining-time/manual budget. Keep legacy work-window
    // policies for later dates and external planning contracts without rewriting them.
    const windows = (input.useRemainingDayDefault && date === today ? undefined
      : workIntervals(input.preferences, day, windowDay, input.timezone))
      ?? [{ start: windowDay.dayStart, end: windowDay.dayEnd }]
    const estimates = estimatedByDay.get(date) ?? []
    horizonDays.push({ windows, estimates, capacity: date === today ? capacityMinutes : capacityForDate(input.preferences, date, day),
      reserved: unionMinutes(intersectIntervals(windows, fixedIntervals(calendarNodes, { ...windowDay,
        // A live remaining-time budget must not subtract commitments already in the past.
        dayStart: todayChoice && date === today ? Math.max(windowDay.dayStart, input.now.getTime()) : windowDay.dayStart })))
        + estimates.reduce((sum, item) => sum + item.minutes, 0) })
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
        - day.estimates.filter(item => item.start < end).reduce((sum, item) => sum + item.minutes, 0)
      return total + Math.max(0, Math.min(physical, day.capacity === undefined ? Infinity : day.capacity - day.reserved))
    }, 0)
  }
  // Keep the earliest feasible deadlines in order. Capacity and real latest-start
  // obligations are feasibility checks, never a proxy score or a recommendation.
  const obligationsFor = (item: RankedAction) => {
    const cost = Math.max(1, Math.ceil(item.action.estimatedMinutes))
    const deadline = deadlineFor(item)
    const rawStart = nodeMap.get(item.action.id)?.temporal.latestStartAt
    const latestStart = rawStart ? Date.parse(rawStart) : NaN
    // Starting by S requires the first work minute by S + one minute. The
    // remaining work may continue in later windows until the real deadline.
    if (item.action.status !== 'doing' && Number.isFinite(latestStart) && latestStart + 60_000 < deadline) {
      return [{ at: latestStart + 60_000, minutes: 1 }, { at: deadline, minutes: cost - 1 }]
    }
    return [{ at: deadline, minutes: cost }]
  }
  const obligations = new Map(mandatory.map(item => [item.action.id, obligationsFor(item)]))
  const chosen: RankedAction[] = []
  for (const item of mandatory) {
    const requirements = [...chosen, item].flatMap(entry => obligations.get(entry.action.id)!)
      .sort((a, b) => a.at - b.at)
    let used = 0
    const feasible = requirements.every(requirement => { used += requirement.minutes; return used <= freeBefore(requirement.at) })
    if (feasible) chosen.push(item)
  }
  const planned = [...chosen]
  const selected = new Set(planned.map(item => item.action.id))
  const deferredHard = mandatory.filter(item => !selected.has(item.action.id))
  if (deferredHard.length) conflicts.push({ kind: 'hard_deadline_capacity',
    relatedIds: deferredHard.map(item => item.action.id), selectedIds: planned.map(item => item.action.id) })
  const todayFree = freeBefore(bounds.dayEnd)
  let prefixMinutes = 0, requiredToday = 0
  const selectedObligations = chosen.flatMap(item => obligations.get(item.action.id)!).sort((a, b) => a.at - b.at)
  for (const obligation of selectedObligations) {
    prefixMinutes += obligation.minutes
    const laterCapacity = Math.max(0, freeBefore(obligation.at) - todayFree)
    requiredToday = Math.max(requiredToday, prefixMinutes - laterCapacity)
  }
  // Allocate hard work as late as its deadlines permit, so minutes reserved
  // tomorrow do not consume today's otherwise usable flexible-work budget.
  let remaining = Math.max(0, todayFree - requiredToday)
  const flexible = startable.filter(item => !selected.has(item.action.id) && !mandatory.includes(item)).sort(compare)
  for (const item of flexible) {
    if (item.action.estimatedMinutes > remaining) continue
    planned.push(item)
    selected.add(item.action.id)
    remaining -= item.action.estimatedMinutes
  }
  const deferredCount = startable.length - planned.length
  const plannedMinutes = fixedMinutes + planned.reduce((sum, item) => sum + item.action.estimatedMinutes, 0)
    + arrangedToday.filter(item => !item.action.scheduledTemporal?.endAt).reduce((sum, item) => sum + item.action.estimatedMinutes, 0)
  planned.push(...arrangedToday)
  planned.sort(compare)
  const overBudgetMinutes = capacityMinutes === undefined ? 0 : Math.max(0, plannedMinutes - capacityMinutes)
  return { capacityMinutes, fixedMinutes, plannedMinutes, overBudgetMinutes, planned, deferredHard,
    deferredCount, conflicts }
}
