import { calendarNodeProjection, scheduleNodeEligible } from '../scheduleEligibility.js'
import { readModelSnapshot } from '../readModelSnapshot.js'
import { scheduleDisplayTimezone } from '../scheduleDisplayTime.js'
import type { ScheduleNode, ScheduleNodeState, TimelineRecord } from '../model.js'
import { effectiveScheduleNodeState } from '../scheduleNodes.js'
import { indexScheduleOccurrenceEvidence, recruitingOccurrenceNeedsConfirmation, recruitingScheduleNode as recruitingNode, syntheticActionBackfill } from '../scheduleOccurrenceEvidence.js'
import { type PJSDASSnapshot } from '../snapshot.js'
import { localDateKey } from '../todayBrief.js'

export type ScheduleSection = 'upcoming' | 'unresolved' | 'history' | 'undated' | 'no_deadline'
export type ScheduleEntryKind = 'node' | 'process_event' | 'business_fact' | 'action' | 'opportunity'

export interface ScheduleEntry {
  id: string
  kind: ScheduleEntryKind
  section: ScheduleSection
  date?: string
  occurredAt?: string
  recordedAt?: string
  opportunityId?: string
  actionId?: string
  processEventId?: string
  nodeId?: string
  occurrenceId?: string
  version?: number
  state?: ScheduleNodeState
  title: string
  invalidated?: boolean
  sourceRefs: string[]
  node?: ScheduleNode
  timeline?: TimelineRecord
}

export interface ScheduleStream {
  accountKey: string
  workspaceRevision: string
  timezone: string
  evaluatedAt: string
  key: string
  sections: Record<ScheduleSection, ScheduleEntry[]>
  counts: Record<ScheduleSection, number>
  positions: Record<ScheduleSection, Map<string, number>>
  /** Task status receipts for Today; never calendar events. */
  completedActions?: ScheduleEntry[]
}

export interface ScheduleCursor {
  projectionKey: string
  section: ScheduleSection
  afterId: string
}

export interface ScheduleWindow {
  entries: ScheduleEntry[]
  loadedCount: number
  totalCount: number
  nextCursor?: ScheduleCursor
}

function validInstant(value: string | undefined) {
  if (!value) return undefined
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : undefined
}

function eventCalendarDate(value: string, when: Date, timezone: string) {
  // A calendar date has no UTC offset or clock time. Do not shift it to the
  // previous day when the device is west of UTC.
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : localDateKey(when, timezone)
}

function temporalDate(node: ScheduleNode, timezone: string) {
  if (node.temporal.precision === 'date') return node.temporal.date
  const value = node.temporal.startAt ?? node.temporal.deadlineAt ?? node.temporal.endAt
  const parsed = validInstant(value)
  return parsed ? localDateKey(parsed, scheduleDisplayTimezone(node.temporal.timezone, node.temporal.resolutionBasis, timezone) ?? timezone) : undefined
}

function nodeEntry(node: ScheduleNode, state: ScheduleNodeState, section: ScheduleSection, date?: string): ScheduleEntry {
  const occurredAt = section === 'history'
    ? state === 'completed' ? node.completedAt : undefined
    : undefined
  return {
    id: `node:${node.id}`,
    kind: 'node',
    section,
    date,
    occurredAt,
    recordedAt: section === 'history' ? node.updatedAt : undefined,
    opportunityId: node.opportunityId,
    processEventId: node.processEventId,
    nodeId: node.id,
    occurrenceId: node.occurrenceId,
    version: node.version,
    state,
    title: node.kind,
    sourceRefs: [...node.evidenceRefs, ...node.sourceVersionRefs],
    node,
  }
}

function chronological(a: ScheduleEntry, b: ScheduleEntry) {
  return (a.date ?? '9999-12-31').localeCompare(b.date ?? '9999-12-31')
    || (a.occurredAt ?? a.node?.temporal.startAt ?? a.node?.temporal.deadlineAt ?? '').localeCompare(
      b.occurredAt ?? b.node?.temporal.startAt ?? b.node?.temporal.deadlineAt ?? '',
    )
    || a.id.localeCompare(b.id)
}

/** One immutable, account/revision-bound index feeds Today and Schedule. */
export function buildScheduleStream(
  rawSnapshot: PJSDASSnapshot,
  context: { accountKey: string; workspaceRevision: string; timezone: string; now?: Date },
): ScheduleStream {
  return buildScheduleStreamNormalized(readModelSnapshot(rawSnapshot), context)
}

/** Shared normalized input for a consumer render. */
export function buildScheduleStreamNormalized(
  snapshot: PJSDASSnapshot,
  context: { accountKey: string; workspaceRevision: string; timezone: string; now?: Date },
): ScheduleStream {
  if (!context.accountKey.trim() || !context.workspaceRevision.trim()) throw new Error('Schedule identity is required.')
  const now = context.now ?? new Date()
  if (!Number.isFinite(now.getTime())) throw new Error('Schedule clock is invalid.')
  try { new Intl.DateTimeFormat('en-US', { timeZone: context.timezone }) } catch { throw new Error('Schedule timezone is invalid.') }
  const today = localDateKey(now, context.timezone)
  const sections: ScheduleStream['sections'] = { upcoming: [], unresolved: [], history: [], undated: [], no_deadline: [] }
  const timeline = snapshot.data.timeline ?? []
  const completedActions: ScheduleEntry[] = []
  const evidence = indexScheduleOccurrenceEvidence(timeline)
  const latest = new Map<string, ScheduleNode>()
  for (const node of snapshot.data.scheduleNodes ?? []) {
    const prior = latest.get(node.occurrenceId)
    if (!prior || node.version > prior.version || (node.version === prior.version && node.id > prior.id)) latest.set(node.occurrenceId, node)
  }
  const nodeEntries = new Map<string, ScheduleEntry>()
  const completedActionEntries = new Map<string, ScheduleEntry>()
  const explicitNodeForAction = new Map<string, ScheduleNode>()
  for (const candidate of latest.values()) {
    if (!scheduleNodeEligible(candidate, snapshot.data) || candidate.temporal.resolutionBasis === 'legacy_projection') continue
    for (const actionId of candidate.relatedActionIds) explicitNodeForAction.set(actionId, candidate)
  }
  const legacyAliases: Array<{ legacy: ScheduleNode; primary: ScheduleNode }> = []
  for (const storedNode of latest.values()) {
    if (!scheduleNodeEligible(storedNode, snapshot.data)) continue
    let node = calendarNodeProjection(storedNode)
    const onlyActionId = node.relatedActionIds.length === 1 ? node.relatedActionIds[0] : undefined
    const explicit = onlyActionId && node.temporal.resolutionBasis === 'legacy_projection'
      && node.occurrenceId === `action:${onlyActionId}`
      ? explicitNodeForAction.get(onlyActionId)
      : undefined
    if (explicit && explicit.id !== node.id) {
      legacyAliases.push({ legacy: node, primary: explicit })
      continue
    }
    // A recruiting action checkbox is an operation, not proof that an
    // application/test/interview happened. Project conservatively without
    // changing the archived node or its operation/Undo evidence.
    const occurrenceEvidence = evidence.occurrenceFacts.get(node.id) ?? []
    if (recruitingOccurrenceNeedsConfirmation(node, evidence, now)) {
      // A later real submission remains its own dated fact. Do not resurrect
      // the earlier checkbox-derived deadline beside it or retime that node.
      const checkboxTime = validInstant(node.completedAt)?.getTime()
      if (node.kind === 'application_deadline' && node.opportunityId && checkboxTime !== undefined
        && evidence.submissions.get(node.opportunityId)?.some(fact => {
          const time = validInstant(fact.occurredAt)?.getTime()
          return time !== undefined && time > checkboxTime && time <= now.getTime()
        })) continue
      node = { ...node, state: 'scheduled', completedAt: undefined, cancelledAt: undefined }
    }
    const state = effectiveScheduleNodeState(node, now, context.timezone)
    if (state === 'completed' || state === 'cancelled') {
      const occurredAt = state === 'completed' ? node.completedAt : undefined
      // Cancellation records the operation elsewhere; this row is the original
      // arrangement and therefore retains its planned time.
      const date = state === 'cancelled' ? temporalDate(node, context.timezone)
        : validInstant(occurredAt) ? eventCalendarDate(occurredAt!, new Date(occurredAt!), context.timezone) : undefined
      const entry = nodeEntry(node, state, date ? 'history' : 'undated', date)
      sections[entry.section].push(entry)
      nodeEntries.set(node.id, entry)
      if (state === 'completed') node.relatedActionIds.forEach((id) => {
        completedActionEntries.set(id, entry)
      })
    } else if (state === 'elapsed_unresolved') {
      const entry = nodeEntry(node, state, 'unresolved', temporalDate(node, context.timezone))
      sections.unresolved.push(entry)
      nodeEntries.set(node.id, entry)
    } else if (state !== 'superseded') {
      const date = temporalDate(node, context.timezone)
      const activeWindow = node.temporal.shape === 'availability_window'
        && Boolean(validInstant(node.temporal.endAt) && new Date(node.temporal.endAt!) >= now)
      const entry = nodeEntry(
        node, state, date ? 'upcoming' : 'undated', activeWindow && date && date < today ? today : date,
      )
      sections[entry.section].push(entry)
      nodeEntries.set(node.id, entry)
    }
    const entry = nodeEntries.get(node.id)
    if (entry) {
      entry.sourceRefs.push(...occurrenceEvidence.map(fact => `timeline:${fact.id}`))
      if (node.constraintKind === 'user_plan') {
        const task = snapshot.data.actions.find(action => node.relatedActionIds.includes(action.id))
        if (task) { entry.title = task.title; entry.actionId = task.id }
      }
    }
  }
  for (const { legacy, primary } of legacyAliases) {
    const entry = nodeEntries.get(primary.id)
    if (!entry) continue
    entry.sourceRefs.push(...legacy.evidenceRefs, ...legacy.sourceVersionRefs)
    nodeEntries.set(legacy.id, entry)
  }
  // Invitation receipt, submission and process closure are retained in job and
  // operation history. Only the eligible occurrence owns calendar chronology.
  function linkCompletionFact(entry: ScheduleEntry | undefined, fact: TimelineRecord) {
    if (!entry) return false
    const when = validInstant(fact.occurredAt)
    if (!when || when > now) return false
    const existingTime = validInstant(entry.occurredAt)
    if (existingTime && existingTime.getTime() !== when.getTime()) return false
    if (entry.section === 'undated') {
      sections.undated = sections.undated.filter((candidate) => candidate !== entry)
      entry.section = 'history'
      entry.date = eventCalendarDate(fact.occurredAt, when, context.timezone)
      entry.occurredAt = fact.occurredAt
      entry.recordedAt = fact.recordedAt
      sections.history.push(entry)
    }
    entry.sourceRefs.push(`timeline:${fact.id}`)
    return true
  }
  for (const item of timeline) {
    if (syntheticActionBackfill(item)) continue
    if (item.kind === 'action_status_changed') {
      if (item.changes?.status?.after !== 'done' || !item.actionId) continue
      const entry = item.scheduleNodeId ? nodeEntries.get(item.scheduleNodeId) : completedActionEntries.get(item.actionId)
      if (entry?.node && (!recruitingNode(entry.node) || entry.state === 'completed' && Boolean(entry.occurredAt))
        && linkCompletionFact(entry, item)) continue
      // Keep Today task history independent of the calendar projection.
      const when = validInstant(item.occurredAt)
      if (when && when <= now) completedActions.push({ id: `task:${item.id}`, kind: 'action', section: 'history',
        date: eventCalendarDate(item.occurredAt, when, context.timezone), occurredAt: item.occurredAt, recordedAt: item.recordedAt,
        actionId: item.actionId, opportunityId: item.opportunityId, title: item.title, timeline: item,
        sourceRefs: [`timeline:${item.id}`] })
      continue
    }
    if (item.kind === 'semantic_intake_applied' && item.commandOperation === 'complete_occurrence' && item.scheduleNodeId) {
      const entry = nodeEntries.get(item.scheduleNodeId)
      if (entry?.state === 'completed') linkCompletionFact(entry, item)
      continue
    }
  }

  // Explicit occurrence evidence may be recorded after its task receipt in
  // the input array. Reconcile after all facts, so sync order never duplicates
  // the same completion in Today.
  for (let index = completedActions.length - 1; index >= 0; index -= 1) {
    const task = completedActions[index]
    const entry = task.actionId ? completedActionEntries.get(task.actionId) : undefined
    if (entry?.state === 'completed' && entry.occurredAt && task.timeline && linkCompletionFact(entry, task.timeline)) {
      completedActions.splice(index, 1)
    }
  }
  for (const section of Object.keys(sections) as ScheduleSection[]) {
    for (const entry of sections[section]) entry.sourceRefs = [...new Set(entry.sourceRefs)]
    sections[section].sort(chronological)
  }
  const counts = Object.fromEntries((Object.keys(sections) as ScheduleSection[]).map((section) => [section, sections[section].length])) as ScheduleStream['counts']
  const positions = Object.fromEntries((Object.keys(sections) as ScheduleSection[]).map((section) => [
    section,
    new Map(sections[section].map((item, index) => [item.id, index])),
  ])) as ScheduleStream['positions']
  return {
    accountKey: context.accountKey,
    workspaceRevision: context.workspaceRevision,
    timezone: context.timezone,
    evaluatedAt: now.toISOString(),
    key: JSON.stringify([context.accountKey, context.workspaceRevision, context.timezone, today]),
    sections,
    completedActions,
    counts,
    positions,
  }
}

export function readScheduleWindow(
  stream: ScheduleStream,
  section: ScheduleSection,
  limit = 30,
  cursor?: ScheduleCursor,
): ScheduleWindow {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Schedule window limit is invalid.')
  if (cursor && (cursor.projectionKey !== stream.key || cursor.section !== section)) {
    throw new Error('Schedule cursor belongs to a different account, revision, day, or section.')
  }
  const all = stream.sections[section]
  const anchor = cursor ? stream.positions[section].get(cursor.afterId) : undefined
  if (cursor && anchor === undefined) throw new Error('Schedule cursor anchor is absent from this projection.')
  const start = anchor === undefined ? 0 : anchor + 1
  const entries = all.slice(start, start + limit)
  const loadedCount = start + entries.length
  return {
    entries,
    loadedCount,
    totalCount: all.length,
    nextCursor: loadedCount < all.length
      ? { projectionKey: stream.key, section, afterId: entries[entries.length - 1].id }
      : undefined,
  }
}
