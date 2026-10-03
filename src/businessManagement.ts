import * as z from 'zod/v4'
import type { Action, ApplicationGroup, Prep } from './model.js'
import { validateSnapshot, type PJSDASSnapshot } from './snapshot.js'

const id = z.string().trim().min(1).max(240)
const short = z.string().trim().min(1).max(300)
const note = z.string().trim().max(2000)
const minutes = z.number().int().min(5).max(720)
const prepFields = z.object({ title: short, estimatedMinutes: minutes, triggeredBy: note.nullable().optional(), priorityLabel: short.nullable().optional(), minimumOutput: note.nullable().optional(), triggerRule: note.nullable().optional(), sourceStatus: short.nullable().optional() }).strict()
// Timeline/status/time edits continue through the existing domain/schedule commands.
// These new operations cannot silently edit or remove a derived scheduled action.
const actionFields = z.object({ title: short, estimatedMinutes: minutes, leverage: z.number().min(0).max(100).optional(), delayCost: z.number().min(0).max(100).optional() }).strict()
const groupFields = z.object({ company: short, coveredRoles: note.nullable().optional(), rule: note.nullable().optional(), total: z.number().int().min(0).max(1000).optional(), currentOrder: note.nullable().optional(), locked: z.boolean().optional(), nextAction: note.nullable().optional(), notes: note.nullable().optional() }).strict()
const nonempty = (v: object) => Object.keys(v).length > 0
export const businessManagementOperationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create_prep'), value: prepFields }).strict(),
  z.object({ kind: z.literal('update_prep'), id, patch: prepFields.partial().refine(nonempty, 'A nonempty patch is required.') }).strict(),
  z.object({ kind: z.literal('archive_prep'), id }).strict(),
  z.object({ kind: z.literal('create_manual_action'), value: actionFields }).strict(),
  z.object({ kind: z.literal('update_manual_action'), id, patch: actionFields.partial().refine(nonempty, 'A nonempty patch is required.') }).strict(),
  z.object({ kind: z.literal('archive_manual_action'), id }).strict(),
  z.object({ kind: z.literal('create_application_group'), value: groupFields }).strict(),
  z.object({ kind: z.literal('update_application_group'), id, patch: groupFields.partial().refine(nonempty, 'A nonempty patch is required.') }).strict(),
  z.object({ kind: z.literal('archive_application_group'), id }).strict(),
])
export const businessManagementSchema = z.object({ operations: z.array(businessManagementOperationSchema).min(1).max(50) }).strict().refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 262144, 'Management batches must not exceed 256 KiB.')
export type BusinessManagementOperation = z.infer<typeof businessManagementOperationSchema>
export type BusinessManagementInput = z.infer<typeof businessManagementSchema>
export type ManagementEntityType = 'prep' | 'action' | 'application_group'
type ManagementEntity = Prep | Action | ApplicationGroup
export interface ManagementObjectChange { type: ManagementEntityType; id: string; before: ManagementEntity | null; after: ManagementEntity | null; beforeIndex: number }
export interface BusinessManagementCompensation { operation: 'business_management_restore'; payload: { changes: ManagementObjectChange[] } }

export class BusinessManagementError extends Error {
  constructor(public readonly code: 'NOT_FOUND' | 'REFERENCE_IN_USE' | 'DERIVED_OBJECT' | 'RESTORE_CONFLICT' | 'INVALID_COMPENSATION', message: string) { super(message); this.name = 'BusinessManagementError' }
}
function entityType(operation: BusinessManagementOperation): ManagementEntityType {
  return operation.kind.endsWith('_prep') ? 'prep' : operation.kind.endsWith('_manual_action') ? 'action' : 'application_group'
}
export function businessManagementObjectRefs(input: BusinessManagementInput, commandId: string) {
  return input.operations.map((operation, index) => ({ type: entityType(operation), id: 'id' in operation ? operation.id : `managed:${entityType(operation)}:${commandId}:${index}` }))
}
function records(snapshot: PJSDASSnapshot, type: ManagementEntityType): ManagementEntity[] {
  return type === 'prep' ? snapshot.data.prep : type === 'action' ? snapshot.data.actions : snapshot.data.applicationGroups
}
function assign(snapshot: PJSDASSnapshot, type: ManagementEntityType, items: ManagementEntity[]) {
  if (type === 'prep') snapshot.data.prep = items as Prep[]
  else if (type === 'action') snapshot.data.actions = items as Action[]
  else snapshot.data.applicationGroups = items as ApplicationGroup[]
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
  return value
}
const equal = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
function patchObject<T extends object>(current: T, patch: object): T {
  const value = { ...current } as Record<string, unknown>
  for (const [key, item] of Object.entries(patch)) { if (item === null) delete value[key]; else if (item !== undefined) value[key] = item }
  return value as T
}
function assertFinalReferences(snapshot: PJSDASSnapshot) {
  const prepIds = new Set(snapshot.data.prep.map(item => item.id))
  const groupIds = new Set(snapshot.data.applicationGroups.map(item => item.id))
  const actionIds = new Set(snapshot.data.actions.map(item => item.id))
  if (snapshot.data.actions.some(item => (item.prepId && !prepIds.has(item.prepId)) || (item.applicationGroupId && !groupIds.has(item.applicationGroupId))) || snapshot.data.opportunities.some(item => item.applicationGroupId && !groupIds.has(item.applicationGroupId)) || (snapshot.data.scheduleNodes ?? []).some(item => item.relatedPrepIds.some(ref => !prepIds.has(ref)) || item.relatedActionIds.some(ref => !actionIds.has(ref)))) {
    throw new BusinessManagementError('REFERENCE_IN_USE', 'A referenced business object cannot be archived. Reassign or remove its dependent objects explicitly first.')
  }
}
function assertEditableAction(snapshot: PJSDASSnapshot, action: Action) {
  if (action.kind !== 'manual' || action.processEventId || action.prepId || action.applicationGroupId || action.dueAt || (snapshot.data.scheduleNodes ?? []).some(node => node.relatedActionIds.includes(action.id))) {
    throw new BusinessManagementError('DERIVED_OBJECT', 'This action is governed by another business object or schedule. Use its existing domain command instead.')
  }
}

/** Business edits preserve the validated envelope and unrelated raw facts. */
function rawBusinessSnapshot(snapshot: PJSDASSnapshot) {
  validateSnapshot(snapshot)
  const next = structuredClone(snapshot)
  return next
}

/** Pure atomic reducer. The gateway must authorize, persist its compensation and perform CAS. */
export function applyBusinessManagement(snapshot: PJSDASSnapshot, raw: unknown, commandId: string, now = new Date()) {
  const input = businessManagementSchema.parse(raw)
  if (commandId.length < 8 || commandId.length > 160) throw new Error('Invalid business command identity.')
  const original = rawBusinessSnapshot(snapshot)
  const next = structuredClone(original)
  const timestamp = now.toISOString()
  const refs = businessManagementObjectRefs(input, commandId)
  for (const [index, operation] of input.operations.entries()) {
    const ref = refs[index]
    const items = records(next, ref.type)
    const current = items.find(item => item.id === ref.id)
    if ('value' in operation) {
      if (current) throw new BusinessManagementError('RESTORE_CONFLICT', 'The deterministic new object ID already exists.')
      let created: ManagementEntity
      if (operation.kind === 'create_prep') created = patchObject({ id: ref.id, title: operation.value.title, estimatedMinutes: operation.value.estimatedMinutes, createdAt: timestamp, updatedAt: timestamp }, operation.value)
      else if (operation.kind === 'create_manual_action') created = { ...operation.value, id: ref.id, kind: 'manual', status: 'todo', leverage: operation.value.leverage ?? 50, delayCost: operation.value.delayCost ?? 50, createdAt: timestamp, updatedAt: timestamp }
      else created = patchObject({ id: ref.id, company: operation.value.company }, operation.value)
      items.push(created)
      continue
    }
    if (!current) throw new BusinessManagementError('NOT_FOUND', 'The requested business object was not found in this workspace.')
    if (ref.type === 'action') assertEditableAction(next, current as Action)
    if ('patch' in operation) {
      // Imported Prep actions and schedule estimates are materialized by older
      // paths. Do not leave them stale until a shared recompute adapter exists.
      if (ref.type === 'prep' && (next.data.actions.some(action => action.prepId === ref.id) || (next.data.scheduleNodes ?? []).some(node => node.relatedPrepIds.includes(ref.id)))) {
        throw new BusinessManagementError('DERIVED_OBJECT', 'This preparation has dependent actions or schedule nodes. Update it through a reconciled preparation workflow.')
      }
      const updated = patchObject(current, operation.patch)
      if (equal(current, updated)) continue
      if (ref.type !== 'application_group') (updated as Prep | Action).updatedAt = timestamp
      if (ref.type === 'application_group') {
        const group = updated as ApplicationGroup
        if (group.total !== undefined && group.used !== undefined && group.total < group.used) throw new BusinessManagementError('REFERENCE_IN_USE', 'Group capacity cannot be lower than its recorded usage.')
        if (group.total !== undefined && group.used !== undefined) group.remaining = group.total - group.used
      }
      items[items.findIndex(item => item.id === ref.id)] = updated
    } else assign(next, ref.type, items.filter(item => item.id !== ref.id))
  }
  assertFinalReferences(next)
  const unique = [...new Map(refs.map(ref => [`${ref.type}:${ref.id}`, ref])).values()]
  const changes: ManagementObjectChange[] = unique.map(ref => ({ ...ref, beforeIndex: records(original, ref.type).findIndex(item => item.id === ref.id), before: structuredClone(records(original, ref.type).find(item => item.id === ref.id) ?? null), after: structuredClone(records(next, ref.type).find(item => item.id === ref.id) ?? null) })).filter(change => !equal(change.before, change.after))
  if (!changes.length) return { status: 'ALREADY_APPLIED' as const, changed: false, snapshot, summary: 'The requested business data is already current.', objects: refs }
  next.data.timeline = [...(next.data.timeline ?? []), { id: `management:${commandId}`, kind: 'change_set_applied', category: 'data', source: 'user_action', occurredAt: timestamp, recordedAt: timestamp, title: `Updated ${changes.length} business object(s)`, commandId, commandOperation: 'business_management' }]
  next.exportedAt = timestamp
  validateSnapshot(next)
  const compensation: BusinessManagementCompensation = { operation: 'business_management_restore', payload: { changes } }
  return { status: 'APPLIED' as const, changed: true, snapshot: next, summary: `Updated ${changes.length} business object(s).`, objects: refs, compensation }
}

/** Only pass owner-scoped compensation read from the command ledger, never a tool payload. */
export function restoreBusinessManagement(snapshot: PJSDASSnapshot, compensation: BusinessManagementCompensation, now = new Date()) {
  const changes = compensation?.payload?.changes
  if (compensation?.operation !== 'business_management_restore' || !Array.isArray(changes) || !changes.length || changes.length > 50) throw new BusinessManagementError('INVALID_COMPENSATION', 'Management compensation is invalid.')
  const next = rawBusinessSnapshot(snapshot)
  const seen = new Set<string>()
  for (const change of changes) {
    if (!['prep', 'action', 'application_group'].includes(change.type) || !change.id || seen.has(`${change.type}:${change.id}`) || (change.before && change.before.id !== change.id) || (change.after && change.after.id !== change.id) || (!change.before && !change.after) || !Number.isInteger(change.beforeIndex) || (change.before ? change.beforeIndex < 0 : change.beforeIndex !== -1)) throw new BusinessManagementError('INVALID_COMPENSATION', 'Management compensation object is invalid.')
    seen.add(`${change.type}:${change.id}`)
    if (!equal(records(next, change.type).find(item => item.id === change.id) ?? null, change.after)) throw new BusinessManagementError('RESTORE_CONFLICT', 'A business object changed after this command. Restore would overwrite newer data.')
  }
  // Replace existing objects in place; restore removed objects in their prior
  // order rather than moving every edited object to the end of the collection.
  for (const change of [...changes].sort((a, b) => a.beforeIndex - b.beforeIndex)) {
    const items = records(next, change.type)
    const index = items.findIndex(item => item.id === change.id)
    if (!change.before) assign(next, change.type, items.filter(item => item.id !== change.id))
    else if (index >= 0) items[index] = structuredClone(change.before)
    else items.splice(Math.min(change.beforeIndex, items.length), 0, structuredClone(change.before))
  }
  assertFinalReferences(next)
  next.exportedAt = now.toISOString()
  validateSnapshot(next)
  return next
}

export const businessManagementReadSchema = z.object({
  type: z.enum(['prep', 'action', 'application_group']),
  ids: z.array(id).min(1).max(100).optional(),
  afterId: id.optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict().refine(value => !(value.ids && value.afterId), 'Choose exact IDs or pagination, not both.')
/** Read only from the already owner-scoped workspace supplied by the gateway. */
export function readBusinessManagement(snapshot: PJSDASSnapshot, raw: unknown) {
  const input = businessManagementReadSchema.parse(raw)
  const requested = input.ids ? new Set(input.ids) : undefined
  const selected = records(snapshot, input.type)
    .filter(item => (!requested || requested.has(item.id)) && (!input.afterId || item.id > input.afterId))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const page = selected.slice(0, input.limit)
  return { type: input.type, items: structuredClone(page), nextAfterId: selected.length > input.limit ? page.at(-1)!.id : null }
}
