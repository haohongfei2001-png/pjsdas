import { confirmedApplicationNode, resolveApplicationDeadline } from './applicationDeadline.js'
import type { Action, DatePrecision, Opportunity, ProcessEvent, ScheduleNode } from './model.js'

/** Ordering is only chronological. Historic assessments never participate. */
export interface DeadlineOrderValue { id: string; deadline?: string; precision?: DatePrecision; timezone?: string }
const formatters = new Map<string, Intl.DateTimeFormat>()
function dateKey(instant: number, timezone: string) {
  let formatter = formatters.get(timezone)
  if (!formatter) { formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }); formatters.set(timezone, formatter) }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}
const calendarEnds = new Map<string, number>()
export function deadlineTimezone(value: DeadlineOrderValue, fallback = 'UTC') {
  return value.timezone && !['floating-date', 'source-offset'].includes(value.timezone) ? value.timezone : fallback
}
/** Internal calendar boundary for comparison/feasibility only. Never an asserted timestamp. */
export function deadlineBoundaryMs(value: DeadlineOrderValue, timezone = 'UTC'): number | undefined {
  if (!value.deadline) return undefined
  if (value.precision !== 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value.deadline)) {
    const instant = Date.parse(value.deadline)
    return Number.isFinite(instant) ? instant : undefined
  }
  const date = value.deadline.slice(0, 10), parsed = Date.parse(date)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== date) return undefined
  const zone = deadlineTimezone(value, timezone), cacheKey = `${zone}|${date}`
  const cached = calendarEnds.get(cacheKey)
  if (cached !== undefined) return cached
  const next = new Date(`${date}T12:00:00.000Z`)
  const noon = next.getTime()
  next.setUTCDate(next.getUTCDate() + 1)
  const following = next.toISOString().slice(0, 10)
  let lower = noon - 48 * 3_600_000, upper = noon + 48 * 3_600_000
  try {
    while (upper - lower > 1) {
      const middle = Math.floor((lower + upper) / 2)
      if (dateKey(middle, zone) < following) lower = middle
      else upper = middle
    }
  } catch { return undefined }
  if (calendarEnds.size >= 1000) calendarEnds.delete(calendarEnds.keys().next().value!)
  calendarEnds.set(cacheKey, upper)
  return upper
}
export function deadlineHasPassed(value: DeadlineOrderValue, now: Date, timezone = 'UTC') {
  const boundary = deadlineBoundaryMs(value, timezone)
  if (boundary === undefined) return false
  return value.precision === 'date' || /^\d{4}-\d{2}-\d{2}$/.test(value.deadline ?? '') ? boundary <= now.getTime() : boundary < now.getTime()
}
export function compareDeadlines(a: DeadlineOrderValue, b: DeadlineOrderValue, timezone = 'UTC') {
  const left = deadlineBoundaryMs(a, timezone) ?? Infinity, right = deadlineBoundaryMs(b, timezone) ?? Infinity
  return (left < right ? -1 : left > right ? 1 : 0) || a.id.localeCompare(b.id)
}
export type ActionTimingOwner = ScheduleNode & { readonly timingUnknown?: true; readonly projectionOnly?: true; readonly completionDeadline?: DeadlineOrderValue }
export function hasKnownActionTiming(node: ActionTimingOwner) {
  return !node.timingUnknown && node.state !== 'cancelled' && node.state !== 'superseded'
    && node.temporal.shape !== 'estimated_date' && node.temporal.resolutionBasis !== 'system_estimate'
}
export function actionDeadline(action: Action, node?: ActionTimingOwner): DeadlineOrderValue {
  if (node?.completionDeadline) return node.completionDeadline
  if (action.timingContractVersion === 2) return { id: action.id, deadline: action.dueAt, precision: action.duePrecision }
  if (node) {
    const temporal = node.temporal
    if (!hasKnownActionTiming(node)) return { id: action.id }
    return { id: action.id, precision: temporal.precision, timezone: temporal.timezone,
      deadline: temporal.precision === 'date' ? temporal.date
        : temporal.shape === 'fixed_range' ? temporal.startAt : temporal.deadlineAt ?? temporal.endAt }
  }
  return { id: action.id, deadline: action.dueAt, precision: action.duePrecision }
}
export function actionNodesById(nodes: ScheduleNode[], actions: Action[] = [], opportunities: Opportunity[] = [], processEvents: ProcessEvent[] = []) {
  const actionsById = new Map(actions.map(action => [action.id, action]))
  const eventActions = new Map<string, Action[]>()
  const applicationActions = new Map<string, Action[]>()
  for (const action of actions) {
    if (action.processEventId) eventActions.set(action.processEventId, [...(eventActions.get(action.processEventId) ?? []), action])
    if (action.kind === 'apply' && action.opportunityId) applicationActions.set(action.opportunityId, [...(applicationActions.get(action.opportunityId) ?? []), action])
  }
  const latest = new Map<string, ScheduleNode>()
  for (const node of nodes) {
    const previous = latest.get(node.occurrenceId)
    if (!previous || node.version > previous.version) latest.set(node.occurrenceId, node)
  }
  const byAction = new Map<string, ActionTimingOwner>()
  const ownersByAction = new Map<string, ScheduleNode[]>()
  for (const node of latest.values()) {
    // Canonical ownership may precede a generated action, so explicit entity
    // identity also establishes the relationship without fabricating stored links.
    const byEvent = node.processEventId ? (eventActions.get(node.processEventId) ?? [])
      .filter(action => !node.opportunityId || !action.opportunityId || node.opportunityId === action.opportunityId) : []
    const byApplication = node.kind === 'application_deadline' && node.opportunityId
      ? applicationActions.get(node.opportunityId) ?? [] : []
    const ids = new Set([...node.relatedActionIds, ...byEvent.map(action => action.id), ...byApplication.map(action => action.id)])
    for (const id of ids) {
      ownersByAction.set(id, [...(ownersByAction.get(id) ?? []), node])
      const previous = byAction.get(id)
      // Retain a terminal owner so consumers cannot mistake withdrawal for no
      // canonical history and revive a retained raw action date. An independent
      // live occurrence still owns the action even if a tombstone has a higher version.
      const active = node.state !== 'cancelled' && node.state !== 'superseded'
      const previousActive = previous && previous.state !== 'cancelled' && previous.state !== 'superseded'
      if (!previous || active && !previousActive || active === previousActive
        && (node.version > previous.version || node.version === previous.version && node.id.localeCompare(previous.id) < 0)) byAction.set(id, node)
    }
  }
  for (const [id, owners] of ownersByAction) {
    const action = actionsById.get(id)
    if (action?.processEventId) {
      const processOwners = owners.filter(node => node.processEventId === action.processEventId && hasKnownActionTiming(node))
      const facts = new Set(processOwners.map(node => {
        const value = actionDeadline(action, node)
        return JSON.stringify([node.temporal.shape, value.precision,
          value.precision === 'date' ? [value.deadline, value.timezone] : value.deadline ? Date.parse(value.deadline) : null])
      }))
      if (facts.size > 1) {
        byAction.set(id, { ...byAction.get(id)!, timingUnknown: true })
        continue
      }
    }
    const applications = owners.filter(node => node.kind === 'application_deadline' && (!action?.opportunityId || node.opportunityId === action.opportunityId))
    if ((action && action.kind !== 'apply') || !applications.length) continue
    const confirmed = confirmedApplicationNode(applications)
    // This is a derived unknown result, never a stored node, state transition or
    // guessed source choice. Every reader must honor canonical source conflict.
    byAction.set(id, confirmed?.node ?? { ...byAction.get(id)!, timingUnknown: true })
  }
  for (const action of actions) {
    const event = processEvents.find(item => item.id === action.processEventId && !item.invalidation)
    if (!byAction.has(action.id) && event?.temporal && ['deadline', 'date_only', 'availability_window'].includes(event.temporal.shape) && event.timingMode !== 'fixed') {
      byAction.set(action.id, { projectionOnly: true, id: `process-obligation:${event.id}`, occurrenceId: `process-obligation:${event.id}`, version: 1,
        opportunityId: event.opportunityId, processEventId: event.id, kind: event.type === 'written_test_invite' ? 'written_test' : 'assessment',
        state: 'scheduled', temporal: structuredClone(event.temporal), constraintKind: 'employer_hard',
        relatedActionIds: [action.id], relatedPrepIds: [], evidenceRefs: [`process-event:${event.id}`], sourceVersionRefs: [], createdAt: event.createdAt, updatedAt: event.updatedAt })
    }
  }
  for (const action of actions) {
    if (action.timingContractVersion === 2 && byAction.has(action.id) && !action.processEventId) {
      const original = byAction.get(action.id)!
      byAction.set(action.id, { ...original, id: `action-deadline-fact:${action.id}`, occurrenceId: `action-deadline-fact:${action.id}`, projectionOnly: true,
        state: action.dueAt ? 'scheduled' : 'cancelled',
        temporal: { shape: action.duePrecision === 'date' ? 'date_only' : 'deadline', precision: action.duePrecision ?? 'datetime',
          timezone: action.duePrecision === 'date' ? 'floating-date' : 'source-offset', resolutionBasis: 'user_explicit',
          date: action.duePrecision === 'date' ? action.dueAt?.slice(0, 10) : undefined,
          deadlineAt: action.duePrecision === 'date' ? undefined : action.dueAt },
        completionDeadline: { id: action.id, deadline: action.dueAt, precision: action.duePrecision } })
    }
    const opportunity = opportunities.find(item => item.id === action.opportunityId)
    let deadline: DeadlineOrderValue | undefined
    if (action.kind === 'apply' && opportunity?.detail?.deadlineCorrections?.at(-1)?.acknowledgedNodeFacts !== undefined) {
      const fact = resolveApplicationDeadline(opportunity, { scheduleNodes: nodes })
      deadline = { id: action.id, deadline: fact.deadline, precision: fact.precision, timezone: fact.timezone }
      byAction.set(action.id, {
        projectionOnly: true, id: `deadline-fact:${action.id}`, occurrenceId: `deadline-fact:${action.id}`, version: 1,
        opportunityId: opportunity.id, kind: 'application_deadline', state: fact.state === 'confirmed' ? 'scheduled' : 'cancelled',
        temporal: { shape: fact.precision === 'date' ? 'date_only' : 'deadline', precision: fact.precision ?? 'datetime',
          timezone: fact.timezone ?? 'source-offset', date: fact.precision === 'date' ? fact.deadline : undefined,
          deadlineAt: fact.precision === 'date' ? undefined : fact.deadline, resolutionBasis: 'source_explicit' },
        constraintKind: 'employer_hard', relatedActionIds: [action.id], relatedPrepIds: [],
        evidenceRefs: fact.evidenceRefs ?? [], sourceVersionRefs: [], createdAt: action.createdAt, updatedAt: action.updatedAt,
        completionDeadline: deadline,
      })
    }
    const arrangement = [...latest.values()].filter(node => node.constraintKind === 'user_plan'
      && node.kind !== 'application_deadline' && node.relatedActionIds.includes(action.id)
      && node.temporal.resolutionBasis === 'user_explicit' && node.temporal.shape === 'fixed_range')
      .sort((a, b) => b.version - a.version)[0]
    if (arrangement) byAction.set(action.id, { ...arrangement,
      completionDeadline: deadline ?? { id: action.id, deadline: action.dueAt, precision: action.duePrecision } })
  }
  return byAction
}
export function latestActionNode(action: Action, nodes: ScheduleNode[], opportunities: Opportunity[] = [], processEvents: ProcessEvent[] = []) { return actionNodesById(nodes, [action], opportunities, processEvents).get(action.id) }
export function compareActionDeadlines(a: Action, b: Action, timezone = 'UTC', nodeA?: ScheduleNode, nodeB?: ScheduleNode) {
  return compareDeadlines(actionDeadline(a, nodeA), actionDeadline(b, nodeB), timezone)
}
