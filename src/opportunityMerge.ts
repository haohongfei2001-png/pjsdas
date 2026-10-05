import * as z from 'zod/v4'
import { opportunityManagementFingerprint } from './opportunityManagement.js'
import { validateSnapshot, type PJSDASSnapshot, type SnapshotData } from './snapshot.js'
import type { Opportunity } from './model.js'
import { canonicalizeJobSourceUrl } from './jobPosting.js'
import { resolveOpportunityTarget } from './semanticTargetMatching.js'

const id = z.string().min(1).max(240).refine(value => value.trim().length > 0)
const ids = z.array(id).max(2500).refine(values => new Set(values).size === values.length)
export const opportunityMergeDependenciesSchema = z.object({
  opportunityIds: ids, processIds: ids, eventIds: ids, actionIds: ids, scheduleNodeIds: ids,
  reminderIntentIds: ids, reminderOutboxIds: ids, discoveryInboxIds: ids, applicationGroupIds: ids,
  decisionRequestIds: ids, semanticReceiptIds: ids, timelineIds: ids, changeSetIds: ids, prepIds: ids, aliasIds: ids,
}).strict()
export const opportunityMergeSchema = z.object({ canonicalOpportunityId: id, duplicateOpportunityId: id,
  expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/), dependencies: opportunityMergeDependenciesSchema,
  reason: z.string().trim().min(1).max(800), evidenceRefs: z.array(z.string().trim().min(1).max(2000)).min(1).max(20),
}).strict().refine(value => value.canonicalOpportunityId !== value.duplicateOpportunityId, 'Two distinct opportunity IDs are required.').refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 262144, 'Merge review exceeds the request limit.')
export type OpportunityMergeInput = z.infer<typeof opportunityMergeSchema>
export interface OpportunityMergeCompensation {
  operation: 'opportunity_merge_restore'
  payload: { changes: Array<{ collection: keyof SnapshotData; id: string; before: unknown; beforeIndex: number }>; aliasesBefore: SnapshotData['opportunityAliases']; afterFingerprint: string; commandId: string; canonicalOpportunityId: string; duplicateOpportunityId: string }
}
export class OpportunityMergeError extends Error {
  constructor(public readonly code: 'NOT_FOUND' | 'STALE_TARGET' | 'REFERENCE_IN_USE' | 'RESTORE_CONFLICT' | 'INVALID_COMPENSATION' | 'INVALID_CONFIGURATION', message: string) { super(message); this.name = 'OpportunityMergeError' }
}
const collections = {
  opportunityIds: 'opportunities', processIds: 'processes', eventIds: 'processEvents', actionIds: 'actions', scheduleNodeIds: 'scheduleNodes', reminderIntentIds: 'reminderIntents', reminderOutboxIds: 'reminderOutbox', discoveryInboxIds: 'discoveryInbox', applicationGroupIds: 'applicationGroups', decisionRequestIds: 'decisionRequests', semanticReceiptIds: 'semanticReceipts', timelineIds: 'timeline', changeSetIds: 'changeSets', prepIds: 'prep', aliasIds: 'opportunityAliases',
} as const
function checked(snapshot: PJSDASSnapshot) {
  const next = structuredClone(snapshot)
  for (const key of ['scheduleNodes', 'decisionRequests', 'semanticReceipts', 'reminderIntents', 'reminderOutbox'] as const) if (!Array.isArray(next.data[key])) throw new OpportunityMergeError('INVALID_CONFIGURATION', 'Migrate the workspace snapshot before merging opportunities.')
  validateSnapshot(next)
  return next
}
function manifest(snapshot: PJSDASSnapshot, canonicalId: string, duplicateId: string) {
  const related = new Set([canonicalId, duplicateId])
  for (const item of snapshot.data.opportunities) if (related.has(item.id) && item.applicationGroupId) related.add(item.applicationGroupId)
  const references = (value: unknown): boolean => typeof value === 'string' ? related.has(value) : Array.isArray(value) ? value.some(references) : Boolean(value && typeof value === 'object' && Object.values(value).some(references))
  let changed = true
  while (changed) {
    changed = false
    for (const collection of Object.values(collections)) for (const item of snapshot.data[collection] ?? []) if (!related.has(item.id) && references(item)) { related.add(item.id); changed = true }
    if (related.size > 2500) throw new OpportunityMergeError('REFERENCE_IN_USE', 'This merge aggregate exceeds the evidence limit.')
  }
  return Object.fromEntries(Object.entries(collections).map(([key, collection]) => [key, (snapshot.data[collection] ?? []).filter(item => related.has(item.id)).map(item => item.id).sort()])) as z.infer<typeof opportunityMergeDependenciesSchema>
}
function pair(snapshot: PJSDASSnapshot, canonicalId: string, duplicateId: string) {
  if (canonicalId === duplicateId) throw new OpportunityMergeError('REFERENCE_IN_USE', 'Two distinct opportunity IDs are required.')
  const canonical = snapshot.data.opportunities.find(item => item.id === canonicalId)
  const duplicate = snapshot.data.opportunities.find(item => item.id === duplicateId)
  if (!canonical || !duplicate) throw new OpportunityMergeError('NOT_FOUND', 'Both exact active opportunity IDs must exist.')
  if ((snapshot.data.opportunityAliases ?? []).some(item => item.id === canonicalId || item.id === duplicateId || item.canonicalOpportunityId === duplicateId)) throw new OpportunityMergeError('REFERENCE_IN_USE', 'Chained or conflicting aliases require separate reconciliation.')
  return { canonical, duplicate }
}
/** Full workspace manifest is intentional: unknown cross-aggregate writes invalidate the reviewed merge. */
export async function readOpportunityMerge(snapshot: PJSDASSnapshot, canonicalId: string, duplicateId: string) {
  const next = checked(snapshot); const selected = pair(next, canonicalId, duplicateId)
  return { ...selected, dependencies: manifest(next, canonicalId, duplicateId), fingerprint: await opportunityManagementFingerprint({ canonicalId, duplicateId, data: next.data }) }
}
function mergeProfile(canonical: Opportunity, duplicate: Opportunity): Opportunity {
  const merge = (a: unknown, b: unknown, path: string): unknown => {
    if (b === undefined) return a
    if (a === undefined) return structuredClone(b)
    if (JSON.stringify(a) === JSON.stringify(b)) return a
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      const result = { ...a } as Record<string, unknown>
      for (const [key, value] of Object.entries(b)) {
        // Each source remains in the originalOpportunity alias, not overwritten or conflated.
        if (path === 'detail' && ['discovery', 'facts', 'postingHistory', 'deadlineCorrections'].includes(key)) continue
        result[key] = merge(result[key], value, path ? `${path}.${key}` : key)
      }
      return result
    }
    throw new OpportunityMergeError('REFERENCE_IN_USE', `Conflicting opportunity field ${path}; reconcile it explicitly before merge.`)
  }
  const { id: _id, importedAt: _imported, order: _order, ...rest } = duplicate
  return merge(canonical, rest, '') as Opportunity
}
export async function applyOpportunityMerge(snapshot: PJSDASSnapshot, raw: unknown, commandId: string, now = new Date()) {
  const input = opportunityMergeSchema.parse(raw)
  if (commandId.length < 8 || commandId.length > 160) throw new Error('Invalid merge command identity.')
  const next = checked(snapshot)
  const payloadFingerprint = await opportunityManagementFingerprint(input)
  const prior = (next.data.opportunityAliases ?? []).find(alias => alias.commandId === commandId)
  if (prior) {
    if (prior.payloadFingerprint !== payloadFingerprint || prior.id !== input.duplicateOpportunityId || prior.canonicalOpportunityId !== input.canonicalOpportunityId) throw new OpportunityMergeError('STALE_TARGET', 'Merge command identity was already used for a different payload.')
    return { status: 'ALREADY_APPLIED' as const, changed: false, snapshot: next, summary: 'This exact merge command is already applied.', objects: [], compensation: undefined, compensationFingerprint: undefined }
  }
  const reviewed = await readOpportunityMerge(next, input.canonicalOpportunityId, input.duplicateOpportunityId)
  const normalized = Object.fromEntries(Object.entries(input.dependencies).map(([key, values]) => [key, [...values].sort()]))
  if (reviewed.fingerprint !== input.expectedFingerprint || await opportunityManagementFingerprint(normalized) !== await opportunityManagementFingerprint(reviewed.dependencies)) throw new OpportunityMergeError('STALE_TARGET', 'The exact reviewed merge manifest or fingerprint changed.')
  const { canonical, duplicate } = pair(next, input.canonicalOpportunityId, input.duplicateOpportunityId)
  const postingA = canonical.detail?.discovery?.posting
  const postingB = duplicate.detail?.discovery?.posting
  const sourceA = postingA?.canonicalSourceUrl ?? canonical.detail?.discovery?.sourceUrl
  const sourceB = postingB?.canonicalSourceUrl ?? duplicate.detail?.discovery?.sourceUrl
  if (!sourceA || !sourceB || canonicalizeJobSourceUrl(sourceA) !== canonicalizeJobSourceUrl(sourceB)
    || (postingA && postingB && (postingA.id !== postingB.id || postingA.identityKey !== postingB.identityKey))
    || !input.evidenceRefs.some(ref => { try { return canonicalizeJobSourceUrl(ref) === canonicalizeJobSourceUrl(sourceA) } catch { return false } })) throw new OpportunityMergeError('REFERENCE_IN_USE', 'Explicit shared exact posting evidence is required; distinct posting identities cannot be merged.')
  const applicationA = canonical.detail?.facts?.application.applicationUrl ?? canonical.detail?.userFacts?.applicationUrl
  const applicationB = duplicate.detail?.facts?.application.applicationUrl ?? duplicate.detail?.userFacts?.applicationUrl
  if (applicationA && applicationB && canonicalizeJobSourceUrl(applicationA) !== canonicalizeJobSourceUrl(applicationB)) throw new OpportunityMergeError('REFERENCE_IN_USE', 'Distinct external application job identifiers cannot be merged.')
  const identityA = canonical.detail?.facts?.identity
  const identityB = duplicate.detail?.facts?.identity
  if (identityA && identityB && await opportunityManagementFingerprint(identityA) !== await opportunityManagementFingerprint(identityB)) throw new OpportunityMergeError('REFERENCE_IN_USE', 'Conflicting business-line, batch, department or location identity cannot be merged.')
  const targetIds = new Set([canonical.id, duplicate.id])
  if (next.data.processes.filter(item => item.opportunityId && targetIds.has(item.opportunityId)).length > 1) throw new OpportunityMergeError('REFERENCE_IN_USE', 'Multiple process projections require explicit reconciliation before merge.')
  const targetMatches = (target: Parameters<typeof resolveOpportunityTarget>[1]) => {
    const result = resolveOpportunityTarget(next.data.opportunities, target)
    return result.status === 'unique' ? targetIds.has(result.opportunity.id) : result.opportunities.some(item => targetIds.has(item.id))
  }
  if ((next.data.decisionRequests ?? []).some(item => ['open', 'expired'].includes(item.state) && (item.affectedObjects.some(ref => ref.type === 'opportunity' && targetIds.has(ref.id)) || targetMatches(item.payloadBinding.candidate.target) || item.choices.some(choice => targetMatches(choice.resolution))))) throw new OpportunityMergeError('REFERENCE_IN_USE', 'Resolve semantic decisions for these opportunities before merging.')
  if (canonical.applicationGroupId || duplicate.applicationGroupId) throw new OpportunityMergeError('REFERENCE_IN_USE', 'Application-group quota effects require explicit reconciliation before merge.')
  const events = new Set(next.data.processEvents.filter(item => targetIds.has(item.opportunityId)).map(item => item.id))
  const processes = new Set(next.data.processes.filter(item => item.opportunityId && targetIds.has(item.opportunityId)).map(item => item.id))
  const nodes = (next.data.scheduleNodes ?? []).filter(item => item.opportunityId && targetIds.has(item.opportunityId))
  const nodeIds = new Set(nodes.map(item => item.id))
  if (nodes.some(item => (item.processId && !processes.has(item.processId)) || (item.processEventId && !events.has(item.processEventId)))
    || next.data.actions.some(item => item.opportunityId && targetIds.has(item.opportunityId) && item.processEventId && !events.has(item.processEventId))
    || (next.data.reminderIntents ?? []).some(item => nodeIds.has(item.scheduleNodeId) && (item.deliveryOwner !== 'pjsdas' || item.channel !== 'in_product' || item.externalLink || item.capability))) throw new OpportunityMergeError('REFERENCE_IN_USE', 'Shared ownership or external reminder delivery requires separate reconciliation before merge.')
  if ((next.data.changeSets ?? []).some(item => item.status === 'pending' && reviewed.dependencies.changeSetIds.includes(item.id))) throw new OpportunityMergeError('REFERENCE_IN_USE', 'Resolve pending aggregate changes before merge.')
  const before = structuredClone(next.data)
  const combined = mergeProfile(canonical, duplicate)
  next.data.opportunities = next.data.opportunities.filter(item => item.id !== duplicate.id).map(item => item.id === canonical.id ? combined : item)
  const replace = (value: string | undefined) => value === duplicate.id ? canonical.id : value
  for (const collection of ['processes', 'processEvents', 'actions', 'scheduleNodes'] as const) for (const item of next.data[collection] ?? []) if (item.opportunityId === duplicate.id) item.opportunityId = canonical.id
  for (const item of next.data.discoveryInbox ?? []) {
    item.candidateOpportunityId = replace(item.candidateOpportunityId)!
    if (item.promotedOpportunityId) item.promotedOpportunityId = replace(item.promotedOpportunityId)
  }
  next.data.opportunityAliases = [...(next.data.opportunityAliases ?? []), { id: duplicate.id, canonicalOpportunityId: canonical.id, commandId, payloadFingerprint, mergedAt: now.toISOString(), originalOpportunity: structuredClone(duplicate) }]
  next.data.timeline = [...(next.data.timeline ?? []), { id: `opportunity-merge:${commandId}`, kind: 'change_set_applied', category: 'data', source: 'user_action', occurredAt: now.toISOString(), recordedAt: now.toISOString(), title: 'Merged duplicate opportunity', detail: `${input.reason} Evidence: ${input.evidenceRefs.join('; ')}`, opportunityId: canonical.id, commandId, commandOperation: 'opportunity_merge' }]
  next.exportedAt = now.toISOString()
  validateSnapshot(next)
  const changes: OpportunityMergeCompensation['payload']['changes'] = []
  for (const collection of ['opportunities', 'processes', 'processEvents', 'actions', 'scheduleNodes', 'discoveryInbox'] as const) {
    for (const [beforeIndex, item] of (before[collection] ?? []).entries()) {
      const after = (next.data[collection] ?? []).find(row => row.id === item.id)
      if (JSON.stringify(item) !== JSON.stringify(after)) changes.push({ collection, id: item.id, before: item, beforeIndex })
    }
  }
  const compensation: OpportunityMergeCompensation = { operation: 'opportunity_merge_restore', payload: { changes, aliasesBefore: before.opportunityAliases, afterFingerprint: await opportunityManagementFingerprint(next.data), commandId, canonicalOpportunityId: canonical.id, duplicateOpportunityId: duplicate.id } }
  if (new TextEncoder().encode(JSON.stringify(compensation)).byteLength > 1048576) throw new OpportunityMergeError('REFERENCE_IN_USE', 'Merge evidence exceeds the compensation size limit.')
  return { status: 'APPLIED' as const, changed: true, snapshot: next, summary: 'Merged duplicate opportunity while preserving its source provenance and history.', objects: [{ type: 'opportunity' as const, id: canonical.id }, { type: 'opportunity' as const, id: duplicate.id }], compensation, compensationFingerprint: await opportunityManagementFingerprint(compensation) }
}
/** Trusted ledger evidence only; fail closed on any subsequent workspace mutation. */
export async function restoreOpportunityMerge(snapshot: PJSDASSnapshot, compensation: OpportunityMergeCompensation, now = new Date()) {
  const next = checked(snapshot); const payload = compensation?.payload
  if (compensation?.operation !== 'opportunity_merge_restore' || !Array.isArray(payload?.changes) || !payload.changes.length || payload.changes.length > 2500 || !/^[a-f0-9]{64}$/.test(payload.afterFingerprint)) throw new OpportunityMergeError('INVALID_COMPENSATION', 'Invalid merge compensation.')
  if (await opportunityManagementFingerprint(next.data) !== payload.afterFingerprint) throw new OpportunityMergeError('RESTORE_CONFLICT', 'Workspace input changed after merge; undo requires reconciliation and cannot overwrite newer data.')
  const restored = structuredClone(next)
  const allowed = new Set(['opportunities', 'processes', 'processEvents', 'actions', 'scheduleNodes', 'discoveryInbox'])
  const seen = new Set<string>()
  for (const change of payload.changes) {
    const key = `${change.collection}:${change.id}`
    if (!allowed.has(change.collection) || seen.has(key) || !change.before || typeof change.before !== 'object' || !('id' in change.before) || change.before.id !== change.id || !Number.isInteger(change.beforeIndex) || change.beforeIndex < 0) throw new OpportunityMergeError('INVALID_COMPENSATION', 'Invalid merge compensation object.')
    seen.add(key)
    const rows = (restored.data[change.collection] ?? []) as Array<{id: string}>
    const currentIndex = rows.findIndex(item => item.id === change.id)
    if (currentIndex >= 0) rows[currentIndex] = structuredClone(change.before) as {id: string}
    else rows.splice(Math.min(change.beforeIndex, rows.length), 0, structuredClone(change.before) as {id: string})
  }
  if (payload.aliasesBefore === undefined) delete restored.data.opportunityAliases
  else restored.data.opportunityAliases = structuredClone(payload.aliasesBefore)
  pair(restored, payload.canonicalOpportunityId, payload.duplicateOpportunityId)
  restored.data.timeline = [...(next.data.timeline ?? []), { id: `opportunity-merge-restore:${payload.commandId}`, kind: 'change_set_applied', category: 'data', source: 'user_action', occurredAt: now.toISOString(), recordedAt: now.toISOString(), title: 'Restored duplicate opportunity merge', commandId: payload.commandId, commandOperation: 'opportunity_merge_restore' }]
  restored.exportedAt = now.toISOString(); validateSnapshot(restored)
  return restored
}
