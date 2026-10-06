import { assertNoScoringInput, withoutRetiredScoring } from './scoringRetirement.js'
import * as z from 'zod/v4'
import { resolveOpportunityTarget } from './semanticTargetMatching.js'
import type { SemanticTargetRef } from './model.js'
import { SNAPSHOT_VERSION, validateSnapshot, type PJSDASSnapshot } from './snapshot.js'

const id = z.string().min(1).max(240).refine(value => value.trim().length > 0, 'An exact nonblank identifier is required.')
const text = z.string().trim().min(1).max(2000)
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/)
const nonempty = (value: object) => Object.keys(value).length > 0
// Source provenance, identity, application state, dates and derived scores are deliberately absent.
const profilePatch = z.object({
  roleType: z.enum(['core', 'backup', 'reach', 'lottery', 'practice']).optional(),
  early: z.boolean().optional(),
  prepEstimateMinutes: z.number().int().min(5).max(720).nullable().optional(),
  detail: z.object({ backgroundTag: text.nullable().optional(), coreOutput: text.nullable().optional(), workMode: text.nullable().optional(), candidateProfile: text.nullable().optional(), jdSummary: text.nullable().optional(), gap: text.nullable().optional(), intensity: text.nullable().optional(), earlyReason: text.nullable().optional(), rules: text.nullable().optional() }).strict().refine(nonempty).optional(),
  userFacts: z.object({ location: text.nullable().optional(), compensationText: text.nullable().optional(), applicationUrl: z.url().max(2000).refine(value => /^https?:\/\//.test(value)).nullable().optional() }).strict().refine(nonempty).optional(),
}).strict().refine(nonempty)
const ids = z.array(id).max(2500).refine(value => new Set(value).size === value.length)
export const opportunityArchiveDependenciesSchema = z.object({ processIds: ids, eventIds: ids, actionIds: ids, scheduleNodeIds: ids, reminderIntentIds: ids }).strict()
export const opportunityManagementSchema = z.object({ operations: z.array(z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('update_opportunity_profile'), id, expectedFingerprint: fingerprint, patch: profilePatch }).strict(),
  z.object({ kind: z.literal('archive_opportunity'), id, expectedFingerprint: fingerprint, dependencies: opportunityArchiveDependenciesSchema, reason: z.string().trim().min(1).max(800) }).strict(),
])).min(1).max(20) }).strict().refine(value => new Set(value.operations.map(item => item.id)).size === value.operations.length, 'Each opportunity may be targeted only once per batch.').refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 262144)
export type OpportunityManagementInput = z.infer<typeof opportunityManagementSchema>
type Dependencies = z.infer<typeof opportunityArchiveDependenciesSchema>
const collections = { opportunity: 'opportunities', process: 'processes', process_event: 'processEvents', action: 'actions', schedule_node: 'scheduleNodes', reminder_intent: 'reminderIntents' } as const
type ObjectType = keyof typeof collections
type Entity = { id: string; [key: string]: unknown }
export interface OpportunityManagementChange { type: ObjectType; id: string; before: Entity; after: Entity | null; beforeIndex: number }
export interface OpportunityManagementCompensation {
  operation: 'opportunity_management_restore'
  payload: { changes: OpportunityManagementChange[]; archives: string[]; guards: Array<{ type: 'application_group' | 'decision_rules'; id: string; value: unknown }> }
}
export class OpportunityManagementError extends Error {
  constructor(public readonly code: 'NOT_FOUND' | 'STALE_TARGET' | 'REFERENCE_IN_USE' | 'RESTORE_CONFLICT' | 'INVALID_COMPENSATION' | 'INVALID_CONFIGURATION', message: string) { super(message); this.name = 'OpportunityManagementError' }
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)]))
  return value
}
const equal = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
export async function opportunityManagementFingerprint(value: unknown) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical(value))))
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
}
function rawSnapshot(snapshot: PJSDASSnapshot) {
  for (const key of ['scheduleNodes', 'decisionRequests', 'semanticReceipts', 'reminderIntents', 'reminderOutbox'] as const) {
    if (!snapshot.data || !Object.hasOwn(snapshot.data, key) || snapshot.data[key] === undefined) throw new OpportunityManagementError('INVALID_CONFIGURATION', 'The workspace needs a separate snapshot migration before opportunity management.')
  }
  validateSnapshot(snapshot)
  const next = structuredClone(snapshot)
  next.version = SNAPSHOT_VERSION
  validateSnapshot(next)
  return next
}
function rows(snapshot: PJSDASSnapshot, type: ObjectType): Entity[] { return (snapshot.data[collections[type]] ?? []) as unknown as Entity[] }
function setRows(snapshot: PJSDASSnapshot, type: ObjectType, value: Entity[]) { (snapshot.data as unknown as Record<string, unknown>)[collections[type]] = value }
function patch<T extends object>(value: T, changes: object): T {
  const next = { ...value } as Record<string, unknown>
  for (const [key, item] of Object.entries(changes)) { if (item === null) delete next[key]; else if (item !== undefined) next[key] = item }
  return next as T
}
function closure(snapshot: PJSDASSnapshot, opportunityId: string) {
  const processIds = new Set(snapshot.data.processes.filter(item => item.opportunityId === opportunityId).map(item => item.id))
  const eventIds = new Set(snapshot.data.processEvents.filter(item => item.opportunityId === opportunityId).map(item => item.id))
  const actionIds = new Set(snapshot.data.actions.filter(item => item.opportunityId === opportunityId || (item.processEventId && eventIds.has(item.processEventId))).map(item => item.id))
  const seeds = (snapshot.data.scheduleNodes ?? []).filter(item => item.opportunityId === opportunityId || (item.processId && processIds.has(item.processId)) || (item.processEventId && eventIds.has(item.processEventId)) || item.relatedActionIds.some(id => actionIds.has(id)))
  const occurrences = new Set(seeds.map(item => item.occurrenceId))
  const nodes = (snapshot.data.scheduleNodes ?? []).filter(item => occurrences.has(item.occurrenceId))
  const nodeIds = new Set(nodes.map(item => item.id))
  const reminders = (snapshot.data.reminderIntents ?? []).filter(item => nodeIds.has(item.scheduleNodeId))
  const dependencies: Dependencies = { processIds: [...processIds].sort(), eventIds: [...eventIds].sort(), actionIds: [...actionIds].sort(), scheduleNodeIds: [...nodeIds].sort(), reminderIntentIds: reminders.map(item => item.id).sort() }
  const refs = [{ type: 'opportunity' as ObjectType, id: opportunityId }, ...Object.entries({ process: dependencies.processIds, process_event: dependencies.eventIds, action: dependencies.actionIds, schedule_node: dependencies.scheduleNodeIds, reminder_intent: dependencies.reminderIntentIds }).flatMap(([type, ids]) => ids.map(id => ({ type: type as ObjectType, id })))]
  return { dependencies, refs, nodes, reminders, processIds, eventIds, actionIds }
}
function assertArchiveClosure(snapshot: PJSDASSnapshot, opportunityId: string, selected: ReturnType<typeof closure>) {
  if ((snapshot.data.opportunityAliases ?? []).some(alias => alias.canonicalOpportunityId === opportunityId)) throw new OpportunityManagementError('REFERENCE_IN_USE', 'Merged source aliases still depend on this canonical opportunity; reconcile or undo the merge before archive.')
  if (selected.refs.length > 2500) throw new OpportunityManagementError('REFERENCE_IN_USE', 'This aggregate exceeds the bounded archive limit.')
  const opportunity = snapshot.data.opportunities.find(item => item.id === opportunityId)
  const crossesEventOwnership = (eventId: string | undefined, belongs: boolean) => Boolean(eventId) && selected.eventIds.has(eventId!) !== belongs
  if (snapshot.data.opportunities.some(item => item.id !== opportunityId && item.effectiveProcessEventId && selected.eventIds.has(item.effectiveProcessEventId))
    || crossesEventOwnership(opportunity?.effectiveProcessEventId, true)
    || snapshot.data.processes.some(item => crossesEventOwnership(item.effectiveProcessEventId, selected.processIds.has(item.id)))) throw new OpportunityManagementError('REFERENCE_IN_USE', 'A process projection has unowned or cross-opportunity event links; reconcile those records before archive or restore.')
  if (selected.nodes.some(node => (node.opportunityId && node.opportunityId !== opportunityId) || (node.processId && !selected.processIds.has(node.processId)) || (node.processEventId && !selected.eventIds.has(node.processEventId)) || node.relatedActionIds.some(id => !selected.actionIds.has(id)) || node.relatedPrepIds.length)
    || snapshot.data.actions.some(action => selected.actionIds.has(action.id) && ((action.opportunityId && action.opportunityId !== opportunityId) || action.prepId || action.applicationGroupId))) {
    throw new OpportunityManagementError('REFERENCE_IN_USE', 'Shared preparations, actions or schedule occurrences require an explicit reassignment workflow before archive.')
  }
  const reminderIds = new Set(selected.dependencies.reminderIntentIds)
  if (selected.reminders.some(item => item.deliveryOwner !== 'pjsdas' || item.channel !== 'in_product' || item.capability !== undefined || item.externalLink !== undefined)
    || (snapshot.data.reminderOutbox ?? []).some(item => reminderIds.has(item.reminderIntentId))) throw new OpportunityManagementError('REFERENCE_IN_USE', 'External reminder delivery must be reconciled separately before archive.')
  if ((snapshot.data.discoveryInbox ?? []).some(item => item.promotedOpportunityId === opportunityId || (item.status === 'promoted' && item.candidateOpportunityId === opportunityId))) throw new OpportunityManagementError('REFERENCE_IN_USE', 'A promoted discovery record requires an explicit linked-inbox archive workflow.')
  const targets = new Set(selected.refs.map(ref => `${ref.type}:${ref.id}`))
  const occurrenceIds = new Set(selected.nodes.map(node => node.occurrenceId))
  const nodeIds = new Set(selected.dependencies.scheduleNodeIds)
  const reminderIdsForDecision = new Set(selected.dependencies.reminderIntentIds)
  const referencesAggregate = (target: SemanticTargetRef | undefined) => {
    if (!target) return false
    const resolved = resolveOpportunityTarget(snapshot.data.opportunities, target)
    return target.opportunityId === opportunityId || Boolean((target.scheduleNodeId && nodeIds.has(target.scheduleNodeId)) || (target.occurrenceId && occurrenceIds.has(target.occurrenceId)) || (target.reminderIntentId && reminderIdsForDecision.has(target.reminderIntentId)))
      || (resolved.status === 'unique' ? resolved.opportunity.id === opportunityId : resolved.status === 'ambiguous' && resolved.opportunities.some(item => item.id === opportunityId))
  }
  if ((snapshot.data.decisionRequests ?? []).some(item => item.state === 'open' && (item.affectedObjects.some(ref => targets.has(`${ref.type}:${ref.id}`)) || referencesAggregate(item.payloadBinding.candidate.target) || item.choices.some(choice => referencesAggregate(choice.resolution))))) throw new OpportunityManagementError('REFERENCE_IN_USE', 'Resolve the pending decision for this aggregate before archive or restore.')
}
function groupGuard(snapshot: PJSDASSnapshot, opportunityId: string) {
  const groupId = snapshot.data.opportunities.find(item => item.id === opportunityId)?.applicationGroupId
  return groupId ? [{ type: 'application_group' as const, id: groupId, value: structuredClone(snapshot.data.applicationGroups.find(item => item.id === groupId)) }] : []
}
export function opportunityManagementObjectRefs(snapshot: PJSDASSnapshot, input: OpportunityManagementInput) {
  return input.operations.flatMap(operation => operation.kind === 'archive_opportunity' ? closure(snapshot, operation.id).refs.map(ref => ref.type === 'schedule_node' ? { type: 'schedule_occurrence', id: snapshot.data.scheduleNodes!.find(node => node.id === ref.id)!.occurrenceId } : ref) : [{ type: 'opportunity', id: operation.id }])
}
export async function readOpportunityManagement(snapshot: PJSDASSnapshot, opportunityId: string) {
  const original = rawSnapshot(snapshot)
  const opportunity = original.data.opportunities.find(item => item.id === opportunityId)
  if (!opportunity) throw new OpportunityManagementError('NOT_FOUND', 'The opportunity was not found in this workspace.')
  const selected = closure(original, opportunityId)
  const aggregate = selected.refs.map(ref => ({ ...ref, value: rows(original, ref.type).find(item => item.id === ref.id) }))
  return { opportunity: withoutRetiredScoring(opportunity), profileFingerprint: await opportunityManagementFingerprint(opportunity), archive: { dependencies: selected.dependencies, fingerprint: await opportunityManagementFingerprint({ aggregate, guards: groupGuard(original, opportunityId) }) } }
}

/** Pure bounded reducer; authorization and authoritative CAS belong to the existing gateway kernel. */
export async function applyOpportunityManagement(snapshot: PJSDASSnapshot, raw: unknown, commandId: string, now = new Date()) {
  assertNoScoringInput(raw)
  const input = opportunityManagementSchema.parse(raw)
  if (commandId.length < 8 || commandId.length > 160) throw new Error('Invalid opportunity management command identity.')
  const original = rawSnapshot(snapshot)
  const next = structuredClone(original)
  const changes: OpportunityManagementChange[] = []
  const archives: string[] = []
  const guards: OpportunityManagementCompensation['payload']['guards'] = []
  const timestamp = now.toISOString()
  for (const operation of input.operations) {
    const current = next.data.opportunities.find(item => item.id === operation.id)
    if (!current) throw new OpportunityManagementError('NOT_FOUND', 'The opportunity was not found in this workspace.')
    const reviewed = await readOpportunityManagement(next, operation.id)
    if (operation.expectedFingerprint !== (operation.kind === 'archive_opportunity' ? reviewed.archive.fingerprint : reviewed.profileFingerprint)) throw new OpportunityManagementError('STALE_TARGET', 'The opportunity or an archive dependency changed. Read it again before applying this command.')
    if (operation.kind === 'archive_opportunity') {
      if (!equal(Object.fromEntries(Object.entries(operation.dependencies).map(([key, ids]) => [key, [...ids].sort()])), reviewed.archive.dependencies)) throw new OpportunityManagementError('STALE_TARGET', 'Archive requires the exact reviewed dependent-object manifest.')
      const selected = closure(next, operation.id)
      assertArchiveClosure(next, operation.id, selected)
      for (const ref of selected.refs) {
        const items = rows(next, ref.type)
        changes.push({ ...ref, before: structuredClone(items.find(item => item.id === ref.id)!), after: null, beforeIndex: rows(original, ref.type).findIndex(item => item.id === ref.id) })
        setRows(next, ref.type, items.filter(item => item.id !== ref.id))
      }
      archives.push(operation.id)
      guards.push(...groupGuard(original, operation.id))
    } else {
      const { detail, userFacts, ...top } = operation.patch
      let updated = patch(current, top)
      if (detail) {
        const changed = patch(updated.detail ?? {}, detail)
        if (!equal(changed, updated.detail ?? {})) updated.detail = changed
      }
      if (userFacts) {
        const previous = updated.detail?.userFacts
        const facts = patch(previous ?? { provenance: 'user_asserted' as const, updatedAt: timestamp }, userFacts)
        const withoutMetadata = (value: unknown) => Object.fromEntries(Object.entries((value ?? {}) as object).filter(([key]) => key !== 'provenance' && key !== 'updatedAt'))
        if (!equal(withoutMetadata(previous), withoutMetadata(facts))) {
          facts.updatedAt = timestamp
          updated.detail = { ...updated.detail, userFacts: facts }
        }
      }
      if (!equal(current, updated)) {
        next.data.opportunities[next.data.opportunities.findIndex(item => item.id === operation.id)] = updated
        changes.push({ type: 'opportunity', id: operation.id, before: structuredClone(current) as unknown as Entity, after: structuredClone(updated) as unknown as Entity, beforeIndex: original.data.opportunities.findIndex(item => item.id === operation.id) })
      }
    }
  }
  if (!changes.length) return { status: 'ALREADY_APPLIED' as const, changed: false, snapshot, summary: 'The requested opportunity data is already current.', objects: [] }
  const compensation: OpportunityManagementCompensation = { operation: 'opportunity_management_restore', payload: { changes, archives, guards } }
  if (changes.length > 2500 || new TextEncoder().encode(JSON.stringify(compensation)).byteLength > 1048576) throw new OpportunityManagementError('REFERENCE_IN_USE', 'This aggregate exceeds the bounded archive evidence limit.')
  next.data.timeline = [...(next.data.timeline ?? []), { id: `opportunity-management:${commandId}`, kind: 'change_set_applied', category: 'data', source: 'user_action', occurredAt: timestamp, recordedAt: timestamp, title: `Updated ${input.operations.length} opportunity profile/archive request(s)`, detail: input.operations.filter(item => item.kind === 'archive_opportunity').map(item => item.reason).join('; ') || undefined, commandId, commandOperation: 'opportunity_management' }]
  next.exportedAt = timestamp
  validateSnapshot(next)
  return { status: 'APPLIED' as const, changed: true, snapshot: next, summary: `Updated ${changes.length} opportunity aggregate object(s).`, objects: opportunityManagementObjectRefs(original, input), compensation, compensationFingerprint: await opportunityManagementFingerprint(compensation), archivedOpportunityIds: archives }
}

/** Compensation is loaded only from the owner-scoped authoritative ledger, never from client input. */
export function restoreOpportunityManagement(snapshot: PJSDASSnapshot, compensation: OpportunityManagementCompensation, now = new Date()) {
  const payload = compensation?.payload
  if (compensation?.operation !== 'opportunity_management_restore' || !payload || !Array.isArray(payload.changes) || !payload.changes.length || payload.changes.length > 2500 || !Array.isArray(payload.archives) || !Array.isArray(payload.guards)) throw new OpportunityManagementError('INVALID_COMPENSATION', 'Opportunity compensation is invalid.')
  const next = rawSnapshot(snapshot)
  const seen = new Set<string>()
  for (const change of payload.changes) {
    if (!Object.hasOwn(collections, change.type) || !change.id || seen.has(`${change.type}:${change.id}`) || change.before?.id !== change.id || (change.after && change.after.id !== change.id) || !Number.isInteger(change.beforeIndex) || change.beforeIndex < 0) throw new OpportunityManagementError('INVALID_COMPENSATION', 'Opportunity compensation identity is invalid.')
    seen.add(`${change.type}:${change.id}`)
    if (!equal(rows(next, change.type).find(item => item.id === change.id) ?? null, change.after)) throw new OpportunityManagementError('RESTORE_CONFLICT', 'An archived or edited object has newer data; restore cannot overwrite it.')
  }
  for (const guard of payload.guards) {
    const current = guard.type === 'application_group' ? next.data.applicationGroups.find(item => item.id === guard.id) : guard.type === 'decision_rules' && guard.id === 'current' ? next.data.decisionRules ?? null : undefined
    if (!equal(current, guard.value) || current === undefined) throw new OpportunityManagementError('RESTORE_CONFLICT', 'An aggregate parent or assessment rule changed after this command.')
  }
  for (const opportunityId of payload.archives) {
    const archivedOccurrences = new Set(payload.changes.filter(change => change.type === 'schedule_node').map(change => change.before.occurrenceId))
    if ((next.data.scheduleNodes ?? []).some(node => archivedOccurrences.has(node.occurrenceId)) || closure(next, opportunityId).refs.length !== 1) throw new OpportunityManagementError('RESTORE_CONFLICT', 'New dependent input arrived after archive; restore requires reconciliation.')
  }
  for (const change of [...payload.changes].sort((a, b) => a.beforeIndex - b.beforeIndex)) {
    const items = rows(next, change.type)
    const index = items.findIndex(item => item.id === change.id)
    if (index >= 0) items[index] = structuredClone(change.before)
    else items.splice(Math.min(change.beforeIndex, items.length), 0, structuredClone(change.before))
    setRows(next, change.type, items)
  }
  for (const opportunityId of payload.archives) {
    const selected = closure(next, opportunityId)
    if (selected.refs.some(ref => !payload.changes.some(change => change.type === ref.type && change.id === ref.id && change.after === null))) throw new OpportunityManagementError('RESTORE_CONFLICT', 'New dependent input arrived after archive; restore requires reconciliation.')
    assertArchiveClosure(next, opportunityId, selected)
  }
  next.exportedAt = now.toISOString()
  validateSnapshot(next)
  return next
}
