import { canonicalOpportunityId } from '../src/opportunityCanonicalization.js'
import type { UserDomainCommand } from '../src/domainCommands.js'
import type { PJSDASSnapshot } from '../src/snapshot.js'
import type { SemanticIntakeObservation } from '../src/model.js'

export interface CommandObjectRef {
  type: string
  id: string
}

export interface CommandFieldRef extends CommandObjectRef {
  field: string
}

function stableJson(value: unknown) {
  return JSON.stringify(value)
}

function addChangedById(
  refs: Map<string, CommandObjectRef>,
  type: string,
  before: Array<{ id: string }>,
  after: Array<{ id: string }>,
) {
  const left = new Map(before.map((item) => [item.id, item]))
  const right = new Map(after.map((item) => [item.id, item]))
  for (const id of new Set([...left.keys(), ...right.keys()])) {
    if (stableJson(left.get(id)) !== stableJson(right.get(id))) refs.set(`${type}:${id}`, { type, id })
  }
}

function addChangedScheduleOccurrences(
  refs: Map<string, CommandObjectRef>,
  before: NonNullable<PJSDASSnapshot['data']['scheduleNodes']>,
  after: NonNullable<PJSDASSnapshot['data']['scheduleNodes']>,
) {
  const group = (items: NonNullable<PJSDASSnapshot['data']['scheduleNodes']>) => {
    const map = new Map<string, unknown[]>()
    for (const item of items) {
      const list = map.get(item.occurrenceId) ?? []
      list.push(item)
      map.set(item.occurrenceId, list)
    }
    return map
  }
  const left = group(before)
  const right = group(after)
  for (const id of new Set([...left.keys(), ...right.keys()])) {
    if (stableJson(left.get(id) ?? []) !== stableJson(right.get(id) ?? [])) {
      refs.set(`schedule_occurrence:${id}`, { type: 'schedule_occurrence', id })
    }
  }
}

export function diffCommandObjects(before: PJSDASSnapshot, after: PJSDASSnapshot): CommandObjectRef[] {
  const refs = new Map<string, CommandObjectRef>()
  addChangedById(refs, 'opportunity_alias', before.data.opportunityAliases ?? [], after.data.opportunityAliases ?? [])
  addChangedById(refs, 'opportunity', before.data.opportunities, after.data.opportunities)
  addChangedById(refs, 'process', before.data.processes, after.data.processes)
  addChangedById(refs, 'process_event', before.data.processEvents, after.data.processEvents)
  addChangedById(refs, 'action', before.data.actions, after.data.actions)
  addChangedById(refs, 'prep', before.data.prep, after.data.prep)
  addChangedById(refs, 'application_group', before.data.applicationGroups, after.data.applicationGroups)
  addChangedById(refs, 'decision_request', before.data.decisionRequests ?? [], after.data.decisionRequests ?? [])
  addChangedById(refs, 'semantic_receipt', before.data.semanticReceipts ?? [], after.data.semanticReceipts ?? [])
  addChangedById(refs, 'reminder_intent', before.data.reminderIntents ?? [], after.data.reminderIntents ?? [])
  addChangedById(refs, 'reminder_outbox', before.data.reminderOutbox ?? [], after.data.reminderOutbox ?? [])
  addChangedById(refs, 'discovery_inbox', before.data.discoveryInbox ?? [], after.data.discoveryInbox ?? [])
  addChangedById(refs, 'change_set', before.data.changeSets ?? [], after.data.changeSets ?? [])
  addChangedById(refs, 'timeline', before.data.timeline ?? [], after.data.timeline ?? [])
  addChangedScheduleOccurrences(refs, before.data.scheduleNodes ?? [], after.data.scheduleNodes ?? [])
  if (stableJson(before.data.decisionRules) !== stableJson(after.data.decisionRules)) {
    refs.set('decision_rules:current', { type: 'decision_rules', id: 'current' })
  }
  if (stableJson(before.data.discoveryProfile) !== stableJson(after.data.discoveryProfile)) {
    refs.set('discovery_profile:current', { type: 'discovery_profile', id: 'current' })
  }
  if (stableJson(before.data.meta) !== stableJson(after.data.meta)) {
    refs.set('import_meta:current', { type: 'import_meta', id: 'current' })
  }
  if (stableJson(before.data.timePlanning) !== stableJson(after.data.timePlanning)) refs.set('time_preferences:current', { type: 'time_preferences', id: 'current' })
  if (before.data.timePlanning?.defaultDailyMinutes !== after.data.timePlanning?.defaultDailyMinutes) {
    refs.set('time_planning:default', { type: 'time_planning', id: 'default' })
  }
  if (stableJson(before.data.timePlanning?.weeklyWindows) !== stableJson(after.data.timePlanning?.weeklyWindows)) {
    refs.set('time_planning:windows', { type: 'time_planning', id: 'windows' })
  }
  if (before.data.timePlanning?.timezone !== after.data.timePlanning?.timezone) refs.set('time_planning:timezone', { type: 'time_planning', id: 'timezone' })
  const oldDays = before.data.timePlanning?.dateOverrides ?? {}
  const newDays = after.data.timePlanning?.dateOverrides ?? {}
  for (const date of new Set([...Object.keys(oldDays), ...Object.keys(newDays)])) {
    if (oldDays[date] !== newDays[date]) refs.set(`time_planning:${date}`, { type: 'time_planning', id: date })
  }
  return [...refs.values()].sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`))
}

function objectValue(snapshot: PJSDASSnapshot, ref: CommandObjectRef): unknown {
  const data = snapshot.data
  switch (ref.type) {
    case 'opportunity_alias': return data.opportunityAliases?.find(item => item.id === ref.id)
    case 'opportunity': return data.opportunities.find(item => item.id === ref.id)
    case 'process': return data.processes.find(item => item.id === ref.id)
    case 'process_event': return data.processEvents.find(item => item.id === ref.id)
    case 'action': return data.actions.find(item => item.id === ref.id)
    case 'prep': return data.prep.find(item => item.id === ref.id)
    case 'application_group': return data.applicationGroups.find(item => item.id === ref.id)
    case 'decision_request': return data.decisionRequests?.find(item => item.id === ref.id)
    case 'semantic_receipt': return data.semanticReceipts?.find(item => item.id === ref.id)
    case 'reminder_intent': return data.reminderIntents?.find(item => item.id === ref.id)
    case 'reminder_outbox': return data.reminderOutbox?.find(item => item.id === ref.id)
    case 'discovery_inbox': return data.discoveryInbox?.find(item => item.id === ref.id)
    case 'change_set': return data.changeSets?.find(item => item.id === ref.id)
    case 'timeline': return data.timeline?.find(item => item.id === ref.id)
    case 'schedule_occurrence': return data.scheduleNodes?.filter(item => item.occurrenceId === ref.id)
    case 'decision_rules': return data.decisionRules
    case 'discovery_profile': return data.discoveryProfile
    case 'import_meta': return data.meta
    case 'time_preferences': return data.timePlanning
    case 'time_planning': return ref.id === 'timezone' ? data.timePlanning?.timezone : ref.id === 'default' ? data.timePlanning?.defaultDailyMinutes
      : ref.id === 'windows' ? data.timePlanning?.weeklyWindows : data.timePlanning?.dateOverrides?.[ref.id]
    default: return undefined
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function changedFields(before: unknown, after: unknown, prefix = ''): string[] {
  if (stableJson(before) === stableJson(after)) return []
  if (plainObject(before) || plainObject(after)) {
    const left = plainObject(before) ? before : {}
    const right = plainObject(after) ? after : {}
    return [...new Set([...Object.keys(left), ...Object.keys(right)])]
      .filter(key => key !== 'updatedAt' && key !== 'createdAt')
      .flatMap(key => changedFields(left[key], right[key], prefix ? `${prefix}.${key}` : key))
  }
  return [prefix || '*']
}

/** Field evidence is written with new receipts; a missing legacy field set stays opaque. */
export function diffCommandFields(before: PJSDASSnapshot, after: PJSDASSnapshot,
  affectedObjects = diffCommandObjects(before, after)): CommandFieldRef[] {
  return affectedObjects.flatMap(ref => {
    const left = objectValue(before, ref)
    const right = objectValue(after, ref)
    const fields = left === undefined || right === undefined ? ['*'] : changedFields(left, right)
    // Unknown object kinds and metadata-only diffs remain conservative.
    return (fields.length ? fields : ['*']).map(field => ({ ...ref, field }))
  }).sort((a, b) => `${a.type}:${a.id}:${a.field}`.localeCompare(`${b.type}:${b.id}:${b.field}`))
}

export function intentFieldScopes(command: UserDomainCommand, objects: CommandObjectRef[]): CommandFieldRef[] {
  if (command.kind === 'correct_opportunity_fact') return objects.map(ref => ({ ...ref,
    field: ref.type === 'opportunity' && ref.id === command.opportunityId
      ? `detail.userFacts.${command.field}` : '*' }))
  if (command.kind === 'set_opportunity_preference') return objects.map(ref => ({ ...ref,
    field: ref.type === 'opportunity' && ref.id === command.opportunityId ? 'roleType' : '*' }))
  return objects.map(ref => ({ ...ref, field: '*' }))
}

function readFieldRefs(raw: unknown): CommandFieldRef[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const fields: CommandFieldRef[] = []
  for (const value of raw) {
    if (!value || typeof value !== 'object') return undefined
    const { type, id, field } = value as Record<string, unknown>
    if (typeof type !== 'string' || typeof id !== 'string' || typeof field !== 'string' || !field) return undefined
    fields.push({ type, id, field })
  }
  return fields
}

export function receiptConflictScopes(receipt: Record<string, unknown>): CommandFieldRef[] | undefined {
  return readFieldRefs(receipt.conflictScopes)
}

export function commandConflictScopes(affectedObjects: CommandObjectRef[], intentFields: CommandFieldRef[]): CommandFieldRef[] {
  return affectedObjects.flatMap(ref => {
    const scopes = intentFields.filter(field => field.type === ref.type && field.id === ref.id)
    return scopes.length ? scopes : [{ ...ref, field: '*' }]
  })
}

function scheduleOccurrenceForNode(snapshot: PJSDASSnapshot, id: string) {
  return snapshot.data.scheduleNodes?.find((item) => item.id === id)?.occurrenceId
}

export function normalizeCommandObjectRef(ref: CommandObjectRef, snapshot: PJSDASSnapshot): CommandObjectRef {
  if (ref.type === 'opportunity') return { ...ref, id: canonicalOpportunityId(snapshot, ref.id) }
  if (ref.type === 'schedule_node') {
    const occurrenceId = scheduleOccurrenceForNode(snapshot, ref.id)
    if (occurrenceId) return { type: 'schedule_occurrence', id: occurrenceId }
  }
  return ref
}

function unique(refs: CommandObjectRef[]) {
  const map = new Map<string, CommandObjectRef>()
  for (const ref of refs) map.set(`${ref.type}:${ref.id}`, ref)
  return [...map.values()].sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`))
}

export function domainIntentObjects(command: UserDomainCommand, snapshot: PJSDASSnapshot): CommandObjectRef[] {
  const refs: CommandObjectRef[] = []
  if ('opportunityId' in command && command.opportunityId) refs.push({ type: 'opportunity', id: canonicalOpportunityId(snapshot, command.opportunityId) })
  if ('actionId' in command && command.actionId) refs.push({ type: 'action', id: command.actionId })
  if ('occurrenceId' in command && command.occurrenceId) refs.push({ type: 'schedule_occurrence', id: command.occurrenceId })
  if ('reminderIntentId' in command && command.reminderIntentId) refs.push({ type: 'reminder_intent', id: command.reminderIntentId })
  if ('scheduleNodeId' in command && command.scheduleNodeId) {
    const occurrenceId = scheduleOccurrenceForNode(snapshot, command.scheduleNodeId)
    refs.push(occurrenceId
      ? { type: 'schedule_occurrence', id: occurrenceId }
      : { type: 'schedule_node', id: command.scheduleNodeId })
  }
  if (command.kind === 'add_manual_action' || command.kind === 'add_user_opportunity') refs.push({ type: 'command_target', id: command.commandId })
  if (command.kind === 'set_daily_capacity') refs.push({ type: 'time_planning', id: 'default' })
  if (command.kind === 'set_date_capacity') refs.push({ type: 'time_planning', id: command.date })
  if (command.kind === 'set_work_windows') refs.push({ type: 'time_planning', id: 'windows' })
  return unique(refs)
}

export function semanticIntentObjects(observation: SemanticIntakeObservation, snapshot: PJSDASSnapshot): CommandObjectRef[] {
  const refs: CommandObjectRef[] = [{
    type: 'source_record',
    id: `${observation.source.kind}:${observation.source.sourceId}:${observation.source.sourceRecordId}`,
  }]
  for (const candidate of observation.candidates) {
    if (candidate.kind === 'user_opportunity') refs.push({ type: 'command_target', id: `new-job:${candidate.company.trim().toLowerCase()}|${candidate.role.trim().toLowerCase()}|${candidate.location ?? ''}` })
    const target = candidate.target
    if (target?.opportunityId) refs.push({ type: 'opportunity', id: canonicalOpportunityId(snapshot, target.opportunityId) })
    if (target?.occurrenceId) refs.push({ type: 'schedule_occurrence', id: target.occurrenceId })
    if (target?.scheduleNodeId) {
      const occurrenceId = scheduleOccurrenceForNode(snapshot, target.scheduleNodeId)
      refs.push(occurrenceId
        ? { type: 'schedule_occurrence', id: occurrenceId }
        : { type: 'schedule_node', id: target.scheduleNodeId })
    }
    if (target?.reminderIntentId) refs.push({ type: 'reminder_intent', id: target.reminderIntentId })
  }
  return unique(refs)
}

export function decisionIntentObjects(requestId: string, snapshot: PJSDASSnapshot): CommandObjectRef[] {
  const request = snapshot.data.decisionRequests?.find((item) => item.id === requestId)
  const refs: CommandObjectRef[] = [{ type: 'decision_request', id: requestId }]
  for (const ref of request?.affectedObjects ?? []) {
    refs.push(normalizeCommandObjectRef({ type: ref.type, id: ref.id }, snapshot))
  }
  return unique(refs)
}

export function receiptAffectedObjects(receipt: Record<string, unknown>, snapshot: PJSDASSnapshot): CommandObjectRef[] | undefined {
  const raw = receipt.affectedObjects
  if (!Array.isArray(raw)) return undefined
  const refs = raw.flatMap((value) => {
    if (!value || typeof value !== 'object') return []
    const type = (value as Record<string, unknown>).type
    const id = (value as Record<string, unknown>).id
    if (typeof type !== 'string' || typeof id !== 'string') return []
    return [normalizeCommandObjectRef({ type, id }, snapshot)]
  })
  return unique(refs)
}

export function overlappingCommandObjects(left: CommandObjectRef[], right: CommandObjectRef[]) {
  const rightKeys = new Set(right.map((item) => `${item.type}:${item.id}`))
  return left.filter((item) => rightKeys.has(`${item.type}:${item.id}`))
}

export function readModelInvalidation(refs: CommandObjectRef[]) {
  return [...new Set(refs.map((item) => item.type))].sort()
}
