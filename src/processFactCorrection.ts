import type { Opportunity, ProcessEvent, ProcessRecord, SemanticIntakeReceipt } from './model.js'
import { processEventStageLabel, stageForProcessEvent } from './processEvents.js'
import type { PJSDASSnapshot } from './snapshot.js'

export interface InvalidateProcessEventCommand {
  commandId: string
  kind: 'invalidate_process_event'
  opportunityId: string
  eventId: string
  receiptId: string
  expectedEventUpdatedAt: string
  reason: string
  evidenceRefs: string[]
}

function correctionStage(event: ProcessEvent | undefined) {
  return event ? stageForProcessEvent(event.type) ?? 'unknown' : 'unknown'
}

/** Exact terminal evidence correction, never deletion or a guess of the prior stage. */
export function invalidateProcessFact(next: PJSDASSnapshot, command: InvalidateProcessEventCommand, timestamp: string) {
  const event = next.data.processEvents.find(item => item.id === command.eventId && item.opportunityId === command.opportunityId)
  if (!event || !['offer', 'rejection'].includes(event.type)) throw new Error('Correction requires an exact terminal ProcessEvent.')
  if (event.invalidation) throw new Error('This evidence was already invalidated by another command.')
  if (event.updatedAt !== command.expectedEventUpdatedAt) throw new Error('ProcessEvent changed since review; read it again before correcting.')
  const owner = (next.data.semanticReceipts ?? []).find(item => item.id === command.receiptId)
  if (!owner || owner.status !== 'committed' || !owner.affectedObjects.some(item => item.type === 'process_event' && item.id === event.id)) {
    throw new Error('The exact source receipt does not own this ProcessEvent.')
  }
  const keys = (owner.mutatedFactKeys ?? []).filter(key => owner.factMutationObjects?.[key]?.some(item => item.type === 'process_event' && item.id === event.id))
  if (!keys.length) throw new Error('Legacy evidence has no provable per-fact mutation ownership; correction needs review.')
  if (!command.reason.trim() || command.reason.length > 800 || !command.evidenceRefs.length || command.evidenceRefs.length > 20 || command.evidenceRefs.some(ref => !ref.trim() || ref.length > 1000)) throw new Error('Correction requires a reason and source evidence.')
  const receiptId = `process-fact-correction:${command.commandId}`
  const afterSequence = Math.max(0, ...(next.data.semanticReceipts ?? []).map(item => item.creationSequence ?? 0))
  const affected: SemanticIntakeReceipt['affectedObjects'] = [{ type: 'process_event', id: event.id }]
  const surviving = next.data.processEvents.filter(item => item.opportunityId === event.opportunityId && item.id !== event.id && !item.invalidation && stageForProcessEvent(item.type))
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.createdAt.localeCompare(a.createdAt))
  // Equal-time competing outcomes have no provable ordering. Keep the stage unknown.
  const latest = surviving[0] && (!surviving[1] || surviving[0].occurredAt !== surviving[1].occurredAt || surviving[0].type === surviving[1].type) ? surviving[0] : undefined
  const stage = correctionStage(latest)
  const label = latest ? processEventStageLabel(latest) : '阶段待核实'
  const ownsProjection = (item: Opportunity | ProcessRecord) => item.effectiveProcessEventId === event.id
    && item.effectiveProcessEventAt === event.occurredAt
    && ('processStage' in item ? item.processStage : item.stage) === stageForProcessEvent(event.type)
  const opportunity = next.data.opportunities.find(item => item.id === event.opportunityId)
  if (opportunity && ownsProjection(opportunity)) {
    opportunity.processStage = stage
    opportunity.currentStageLabel = label
    opportunity.effectiveProcessEventId = latest?.id
    opportunity.effectiveProcessEventAt = latest?.occurredAt
    affected.push({ type: 'opportunity', id: opportunity.id })
  }
  for (const process of next.data.processes) {
    if (process.opportunityId !== event.opportunityId || !ownsProjection(process) || process.lastProgressAt !== event.occurredAt) continue
    process.stage = stage
    process.stageLabel = label
    process.effectiveProcessEventId = latest?.id
    process.effectiveProcessEventAt = latest?.occurredAt
    process.lastProgressAt = latest?.occurredAt
    process.currentAction = undefined
    process.nextCheckAt = undefined
    process.silenceRisk = undefined
    process.result = 'pending'
    affected.push({ type: 'process', id: process.id })
  }
  event.invalidation = { commandId: command.commandId, receiptId, sourceReceiptId: owner.id, invalidatedAt: timestamp, reason: command.reason, evidenceRefs: [...command.evidenceRefs] }
  // Only invalidate same-source dependants lacking an independently owned event.
  for (const receipt of next.data.semanticReceipts ?? []) {
    if (receipt.sourceKind !== owner.sourceKind || receipt.sourceId !== owner.sourceId || receipt.sourceRecordId !== owner.sourceRecordId) continue
    const overlaps = (receipt.factKeys ?? []).filter(key => keys.includes(key) && !receipt.factInvalidations?.some(item => item.factKey === key)
      && (receipt.id === owner.id || !receipt.factMutationObjects?.[key]?.some(item => item.type === 'process_event' && item.id !== event.id)))
    if (!overlaps.length) continue
    receipt.factInvalidations = [...(receipt.factInvalidations ?? []), ...overlaps.map(factKey => ({ factKey, invalidatedByReceiptId: receiptId, invalidatedAt: timestamp, invalidatedAfterSequence: afterSequence }))]
    receipt.undoAvailable = false
    receipt.updatedAt = timestamp
  }
  next.data.semanticReceipts!.push({ id: receiptId, inputId: receiptId, commandId: command.commandId, sourceKind: 'mcp', sourceId: 'explicit-fact-correction', sourceRecordId: command.commandId, status: 'committed', summary: command.reason, affectedObjects: affected, decisionRequestIds: [], creationSequence: afterSequence + 1, undoAvailable: false, createdAt: timestamp, updatedAt: timestamp })
  return { affected, stage }
}

/** A corrected original source cannot autonomously recreate its revoked fact. */
export function invalidatedSourceFact(snapshot: PJSDASSnapshot, source: { kind: string; sourceId: string; sourceRecordId: string }, factKey: string | undefined) {
  if (!factKey) return false
  return (snapshot.data.semanticReceipts ?? []).some(receipt => receipt.sourceKind === source.kind && receipt.sourceId === source.sourceId && receipt.sourceRecordId === source.sourceRecordId
    && receipt.factInvalidations?.some(item => item.factKey === factKey && item.invalidatedByReceiptId.startsWith('process-fact-correction:')))
}

const opportunityProjectionKeys = ['processStage', 'currentStageLabel', 'effectiveProcessEventId', 'effectiveProcessEventAt', 'locallyManaged'] as const
const processProjectionKeys = ['stage', 'stageLabel', 'effectiveProcessEventId', 'effectiveProcessEventAt', 'lastProgressAt', 'company', 'role', 'locallyManaged', 'progress', 'result', 'participationState'] as const
function projection(value: object, keys: readonly string[]) {
  return Object.fromEntries(keys.map(key => [key, (value as Record<string, unknown>)[key] ?? null]))
}
export interface ProcessProjectionUndo {
  opportunityId: string
  opportunityBefore: Record<string, unknown>
  opportunityAfter: Record<string, unknown>
  processes: Array<{ id: string; before?: ProcessRecord; after: ProcessRecord }>
}
export function captureProcessProjectionUndo(before: PJSDASSnapshot, after: PJSDASSnapshot, opportunityId: string): ProcessProjectionUndo {
  return {
    opportunityId,
    opportunityBefore: projection(before.data.opportunities.find(item => item.id === opportunityId)!, opportunityProjectionKeys),
    opportunityAfter: projection(after.data.opportunities.find(item => item.id === opportunityId)!, opportunityProjectionKeys),
    processes: after.data.processes.filter(item => item.opportunityId === opportunityId).map(item => ({ id: item.id, before: structuredClone(before.data.processes.find(old => old.id === item.id)), after: structuredClone(item) })),
  }
}
export function restoreProcessProjection(next: PJSDASSnapshot, undo: ProcessProjectionUndo | undefined, eventId: string) {
  if (!undo) {
    if (next.data.opportunities.some(item => item.effectiveProcessEventId === eventId) || next.data.processes.some(item => item.effectiveProcessEventId === eventId)) throw new Error('Legacy event undo lacks stage ownership; use evidence correction instead.')
    return
  }
  const target = next.data.opportunities.find(item => item.id === undo.opportunityId)
  if (!target || target.effectiveProcessEventId === eventId && JSON.stringify(projection(target, opportunityProjectionKeys)) !== JSON.stringify(undo.opportunityAfter)) throw new Error('Process stage changed after the event; undo cannot overwrite later progress.')
  for (const change of undo.processes) {
    const current = next.data.processes.find(item => item.id === change.id)
    if (!current || current.effectiveProcessEventId === eventId && JSON.stringify(change.before ? projection(current, processProjectionKeys) : current) !== JSON.stringify(change.before ? projection(change.after, processProjectionKeys) : change.after)) throw new Error('Process changed after the event; undo cannot overwrite later progress.')
  }
  if (target.effectiveProcessEventId === eventId) for (const key of opportunityProjectionKeys) (target as unknown as Record<string, unknown>)[key] = undo.opportunityBefore[key] ?? undefined
  for (const change of undo.processes) {
    if (next.data.processes.find(item => item.id === change.id)?.effectiveProcessEventId !== eventId) continue
    if (!change.before) next.data.processes = next.data.processes.filter(item => item.id !== change.id)
    else {
      const current = next.data.processes.find(item => item.id === change.id)!
      for (const key of processProjectionKeys) (current as unknown as Record<string, unknown>)[key] = change.before[key]
    }
  }
}
