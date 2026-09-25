import type { ScheduleNode, ScheduleNodeState, TimelineRecord } from '../model.js'
import { effectiveScheduleNodeState } from '../scheduleNodes.js'
import { upgradeSnapshotToLatest, type PJSDASSnapshot } from '../snapshot.js'
import { localDateKey } from '../todayBrief.js'

export type ScheduleSection = 'upcoming' | 'unresolved' | 'history' | 'undated'
export type ScheduleEntryKind = 'node' | 'process_event' | 'business_fact' | 'action'

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

const BUSINESS_KINDS = new Set<TimelineRecord['kind']>([
  'application_submitted',
  'process_event_recorded',
  'process_event_deleted',
  'process_closed',
  'action_status_changed',
  'decision_resolved',
  'opportunity_added',
  'opportunity_updated',
  'opportunity_renamed',
  'semantic_undo_applied',
])

function validInstant(value: string | undefined) {
  if (!value) return undefined
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : undefined
}

function temporalDate(node: ScheduleNode, timezone: string) {
  if (node.temporal.precision === 'date') return node.temporal.date
  const value = node.temporal.startAt ?? node.temporal.deadlineAt ?? node.temporal.endAt
  const parsed = validInstant(value)
  return parsed ? localDateKey(parsed, timezone) : undefined
}

function nodeEntry(node: ScheduleNode, state: ScheduleNodeState, section: ScheduleSection, date?: string): ScheduleEntry {
  const occurredAt = section === 'history'
    ? node.completedAt ?? node.cancelledAt ?? (node.supersededByNodeId ? node.updatedAt : undefined)
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
  if (!context.accountKey.trim() || !context.workspaceRevision.trim()) throw new Error('Schedule identity is required.')
  const now = context.now ?? new Date()
  if (!Number.isFinite(now.getTime())) throw new Error('Schedule clock is invalid.')
  try { new Intl.DateTimeFormat('en-US', { timeZone: context.timezone }) } catch { throw new Error('Schedule timezone is invalid.') }
  const snapshot = upgradeSnapshotToLatest(rawSnapshot)
  const today = localDateKey(now, context.timezone)
  const sections: ScheduleStream['sections'] = { upcoming: [], unresolved: [], history: [], undated: [] }
  const latest = new Map<string, ScheduleNode>()
  for (const node of snapshot.data.scheduleNodes ?? []) {
    const prior = latest.get(node.occurrenceId)
    if (!prior || node.version > prior.version || (node.version === prior.version && node.id > prior.id)) latest.set(node.occurrenceId, node)
  }
  const representedNodeIds = new Set<string>()
  const representedProcessEventIds = new Set<string>()
  const representedCompletedActionIds = new Set<string>()
  const nodeEntries = new Map<string, ScheduleEntry>()
  const completedActionEntries = new Map<string, ScheduleEntry>()
  const processEventEntries = new Map<string, ScheduleEntry>()
  const explicitNodeForAction = new Map<string, ScheduleNode>()
  for (const candidate of latest.values()) {
    if (candidate.temporal.resolutionBasis === 'legacy_projection') continue
    for (const actionId of candidate.relatedActionIds) explicitNodeForAction.set(actionId, candidate)
  }
  const legacyAliases: Array<{ legacy: ScheduleNode; primary: ScheduleNode }> = []
  for (const node of latest.values()) {
    const onlyActionId = node.relatedActionIds.length === 1 ? node.relatedActionIds[0] : undefined
    const explicit = onlyActionId && node.temporal.resolutionBasis === 'legacy_projection'
      && node.occurrenceId === `action:${onlyActionId}`
      ? explicitNodeForAction.get(onlyActionId)
      : undefined
    if (explicit && explicit.id !== node.id) {
      legacyAliases.push({ legacy: node, primary: explicit })
      continue
    }
    const state = effectiveScheduleNodeState(node, now)
    if (state === 'completed' || state === 'cancelled') {
      const occurredAt = node.completedAt ?? node.cancelledAt
      const date = validInstant(occurredAt) ? localDateKey(new Date(occurredAt!), context.timezone) : undefined
      const entry = nodeEntry(node, state, date ? 'history' : 'undated', date)
      sections[entry.section].push(entry)
      nodeEntries.set(node.id, entry)
      if (state === 'completed') node.relatedActionIds.forEach((id) => {
        representedCompletedActionIds.add(id)
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
    representedNodeIds.add(node.id)
  }
  for (const { legacy, primary } of legacyAliases) {
    const entry = nodeEntries.get(primary.id)
    if (!entry) continue
    entry.sourceRefs.push(...legacy.evidenceRefs, ...legacy.sourceVersionRefs)
    nodeEntries.set(legacy.id, entry)
    representedNodeIds.add(legacy.id)
  }
  // Superseded versions are historical changes, never extra future appointments.
  for (const node of snapshot.data.scheduleNodes ?? []) {
    if (representedNodeIds.has(node.id) || !node.supersededByNodeId) continue
    const when = validInstant(node.updatedAt)
    if (!when || when > now) continue
    const entry = nodeEntry(node, 'superseded', 'history', localDateKey(when, context.timezone))
    sections.history.push(entry)
    nodeEntries.set(node.id, entry)
    representedNodeIds.add(node.id)
  }
  for (const event of snapshot.data.processEvents) {
    const when = validInstant(event.occurredAt)
    if (!when || when > now) continue
    const entry: ScheduleEntry = {
      id: `process:${event.id}`,
      kind: 'process_event',
      section: 'history',
      date: localDateKey(when, context.timezone),
      occurredAt: event.occurredAt,
      recordedAt: event.createdAt,
      opportunityId: event.opportunityId,
      processEventId: event.id,
      title: event.type,
      sourceRefs: [`process_event:${event.id}`],
    }
    sections.history.push(entry)
    representedProcessEventIds.add(event.id)
    processEventEntries.set(event.id, entry)
  }
  function linkCompletionFact(entry: ScheduleEntry | undefined, fact: TimelineRecord) {
    if (!entry) return false
    const when = validInstant(fact.occurredAt)
    if (!when || when > now) return false
    if (entry.section === 'undated') {
      sections.undated = sections.undated.filter((candidate) => candidate !== entry)
      entry.section = 'history'
      entry.date = localDateKey(when, context.timezone)
      entry.occurredAt = fact.occurredAt
      entry.recordedAt = fact.recordedAt
      sections.history.push(entry)
    }
    entry.sourceRefs.push(`timeline:${fact.id}`)
    return true
  }
  const timelineByCommand = new Map<string, ScheduleEntry>()
  for (const item of snapshot.data.timeline ?? []) {
    if (!BUSINESS_KINDS.has(item.kind)) continue
    if (item.processEventId && representedProcessEventIds.has(item.processEventId) && item.kind === 'process_event_recorded') {
      processEventEntries.get(item.processEventId)?.sourceRefs.push(`timeline:${item.id}`)
      continue
    }
    if (item.scheduleNodeId && representedNodeIds.has(item.scheduleNodeId) && item.kind === 'action_status_changed' && item.changes?.status?.after === 'done') {
      if (linkCompletionFact(nodeEntries.get(item.scheduleNodeId), item)) continue
    }
    if (item.kind === 'action_status_changed'
      && item.actionId
      && item.changes?.status?.after === 'done'
      && representedCompletedActionIds.has(item.actionId)) {
      if (linkCompletionFact(completedActionEntries.get(item.actionId), item)) continue
    }
    if (item.kind === 'application_submitted' && item.opportunityId
      && linkCompletionFact(completedActionEntries.get(`apply:${item.opportunityId}`), item)) continue
    const when = validInstant(item.occurredAt)
    if (!when || when > now) continue
    // Only exact command/type/object references may collapse log duplicates.
    const commandKey = item.commandId
      ? `${item.commandId}:${item.kind}:${item.opportunityId ?? ''}:${item.actionId ?? ''}:${item.processEventId ?? ''}`
      : undefined
    if (commandKey && timelineByCommand.has(commandKey)) {
      timelineByCommand.get(commandKey)?.sourceRefs.push(`timeline:${item.id}`)
      continue
    }
    const entry: ScheduleEntry = {
      id: `fact:${item.id}`,
      kind: 'business_fact',
      section: 'history',
      date: localDateKey(when, context.timezone),
      occurredAt: item.occurredAt,
      recordedAt: item.recordedAt,
      opportunityId: item.opportunityId,
      actionId: item.actionId,
      processEventId: item.processEventId,
      nodeId: item.scheduleNodeId,
      title: item.title,
      sourceRefs: [item.sourceRef, item.commandId].filter((value): value is string => Boolean(value)),
      timeline: item,
    }
    if (commandKey) timelineByCommand.set(commandKey, entry)
    sections.history.push(entry)
  }
  const completedActionIds = new Set((snapshot.data.timeline ?? [])
    .filter((item) => item.kind === 'action_status_changed' && item.actionId && item.changes?.status?.after === 'done')
    .map((item) => item.actionId!))
  representedCompletedActionIds.forEach((id) => completedActionIds.add(id))
  for (const fact of snapshot.data.timeline ?? []) {
    if (fact.kind === 'application_submitted' && fact.opportunityId) completedActionIds.add(`apply:${fact.opportunityId}`)
  }
  for (const action of snapshot.data.actions) {
    if (action.status !== 'done' || completedActionIds.has(action.id)) continue
    // Existing status is real, but an old action without a completion fact has no known completion time.
    sections.undated.push({
      id: `action:${action.id}`,
      kind: 'action',
      section: 'undated',
      actionId: action.id,
      opportunityId: action.opportunityId,
      title: action.title,
      sourceRefs: [],
    })
  }
  for (const section of Object.keys(sections) as ScheduleSection[]) sections[section].sort(chronological)
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
