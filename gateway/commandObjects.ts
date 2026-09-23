import type { UserDomainCommand } from '../src/domainCommands.js'
import type { PJSDASSnapshot } from '../src/snapshot.js'
import type { SemanticIntakeObservation } from '../src/model.js'

export interface CommandObjectRef {
  type: string
  id: string
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
  addChangedScheduleOccurrences(refs, before.data.scheduleNodes ?? [], after.data.scheduleNodes ?? [])
  if (stableJson(before.data.decisionRules) !== stableJson(after.data.decisionRules)) {
    refs.set('decision_rules:current', { type: 'decision_rules', id: 'current' })
  }
  return [...refs.values()].sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`))
}

function scheduleOccurrenceForNode(snapshot: PJSDASSnapshot, id: string) {
  return snapshot.data.scheduleNodes?.find((item) => item.id === id)?.occurrenceId
}

export function normalizeCommandObjectRef(ref: CommandObjectRef, snapshot: PJSDASSnapshot): CommandObjectRef {
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
  if ('opportunityId' in command && command.opportunityId) refs.push({ type: 'opportunity', id: command.opportunityId })
  if ('actionId' in command && command.actionId) refs.push({ type: 'action', id: command.actionId })
  if ('occurrenceId' in command && command.occurrenceId) refs.push({ type: 'schedule_occurrence', id: command.occurrenceId })
  if ('reminderIntentId' in command && command.reminderIntentId) refs.push({ type: 'reminder_intent', id: command.reminderIntentId })
  if ('scheduleNodeId' in command && command.scheduleNodeId) {
    const occurrenceId = scheduleOccurrenceForNode(snapshot, command.scheduleNodeId)
    refs.push(occurrenceId
      ? { type: 'schedule_occurrence', id: occurrenceId }
      : { type: 'schedule_node', id: command.scheduleNodeId })
  }
  if (command.kind === 'add_manual_action') refs.push({ type: 'command_target', id: command.commandId })
  return unique(refs)
}

export function semanticIntentObjects(observation: SemanticIntakeObservation, snapshot: PJSDASSnapshot): CommandObjectRef[] {
  const refs: CommandObjectRef[] = [{
    type: 'source_record',
    id: `${observation.source.kind}:${observation.source.sourceId}:${observation.source.sourceRecordId}`,
  }]
  for (const candidate of observation.candidates) {
    const target = candidate.target
    if (target?.opportunityId) refs.push({ type: 'opportunity', id: target.opportunityId })
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
