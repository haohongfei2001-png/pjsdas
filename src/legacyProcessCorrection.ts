import type { ProcessEvent, SemanticIntakeReceipt } from './model.js'
import { opportunityManagementFingerprint } from './opportunityManagement.js'
import { processEventStageLabel, stageForProcessEvent } from './processEvents.js'
import { upgradeSnapshotToLatest, validateSnapshot, type PJSDASSnapshot } from './snapshot.js'

export interface InvalidateLegacyProcessEventCommand {
  kind: 'invalidate_legacy_process_event'
  commandId: string
  eventId: string
  expectedEventFingerprint: string
  sourceRefs: string[]
  reason: string
  evidenceRefs: string[]
}
function sourceRefs(snapshot: PJSDASSnapshot, event: ProcessEvent) {
  const refs = new Set<string>([`process-event:${event.id}`])
  for (const record of snapshot.data.timeline ?? []) if (record.processEventId === event.id) {
    refs.add(`timeline:${record.id}`)
    if (record.changeSetId) refs.add(`changeset:${record.changeSetId}`)
    if (record.sourceRef) refs.add(record.sourceRef)
  }
  for (const set of snapshot.data.changeSets ?? []) if (set.operations.some(operation => operation.kind === 'add_process_event' && operation.event.id === event.id)) refs.add(`changeset:${set.id}`)
  return [...refs].sort()
}
function receiptReferences(snapshot: PJSDASSnapshot, eventId: string) {
  return (snapshot.data.semanticReceipts ?? []).filter(receipt => receipt.affectedObjects.some(ref => ref.type === 'process_event' && ref.id === eventId)
    || Object.values(receipt.factMutationObjects ?? {}).some(refs => refs.some(ref => ref.type === 'process_event' && ref.id === eventId)))
}
/** Review bytes include all exact provenance and projections that may be touched. */
export async function readLegacyProcessCorrection(snapshot: PJSDASSnapshot, eventId: string) {
  const originalEvent = snapshot.data.processEvents.find(item => item.id === eventId)
  if (!originalEvent) throw new Error('The exact ProcessEvent was not found.')
  if (!['offer', 'rejection'].includes(originalEvent.type)) {
    const refs = sourceRefs(snapshot, originalEvent)
    const receiptIds = receiptReferences(snapshot, eventId).map(item => item.id)
    return { event: originalEvent, sourceRefs: refs, receiptIds, eligible: false,
      blocked: 'NONTERMINAL_EVENT_REQUIRES_LIFECYCLE_RECONCILIATION',
      expectedEventFingerprint: await opportunityManagementFingerprint({ event: originalEvent, refs, receiptIds }) }
  }
  // Review the same deterministic legacy projection used by apply. Otherwise
  // migration could materialize a live schedule after an empty dependency review.
  snapshot = upgradeSnapshotToLatest(snapshot)
  const event = snapshot.data.processEvents.find(item => item.id === eventId)
  if (!event) throw new Error('The exact ProcessEvent was not found.')
  const refs = sourceRefs(snapshot, event)
  const ownedReceipts = receiptReferences(snapshot, eventId)
  const dependencies = {
    actions: snapshot.data.actions.filter(item => item.processEventId === eventId),
    nodes: (snapshot.data.scheduleNodes ?? []).filter(item => item.processEventId === eventId),
    opportunity: snapshot.data.opportunities.find(item => item.id === event.opportunityId),
    processes: snapshot.data.processes.filter(item => item.opportunityId === event.opportunityId || item.effectiveProcessEventId === eventId),
    competingEvents: snapshot.data.processEvents.filter(item => item.opportunityId === event.opportunityId),
  }
  const eventStage = stageForProcessEvent(event.type)
  const provesProjection = (owner: { effectiveProcessEventId?: string; effectiveProcessEventAt?: string }, stage: string) => {
    const proof = snapshot.data.processEvents.find(item => item.id === owner.effectiveProcessEventId && item.opportunityId === event.opportunityId && !item.invalidation)
    return proof && proof.occurredAt === owner.effectiveProcessEventAt && stageForProcessEvent(proof.type) === stage
  }
  const unprovenTerminal = ['offer', 'rejection'].includes(event.type) && (
    dependencies.opportunity && dependencies.opportunity.processStage === eventStage && !provesProjection(dependencies.opportunity, eventStage!)
    || dependencies.processes.some(item => item.stage === eventStage && (!provesProjection(item, eventStage!) || item.effectiveProcessEventId === event.id && item.lastProgressAt !== event.occurredAt)))
  const blocked = event.invalidation ? 'ALREADY_INVALIDATED' : ownedReceipts.length ? 'SOURCE_RECEIPT_PRESENT'
    : unprovenTerminal ? 'UNPROVEN_TERMINAL_PROJECTION'
    : dependencies.actions.length || dependencies.nodes.length ? 'DEPENDENT_SCHEDULE_REQUIRES_RECONCILIATION'
      : undefined
  return { event, sourceRefs: refs, receiptIds: ownedReceipts.map(item => item.id), eligible: !blocked, blocked,
    expectedEventFingerprint: await opportunityManagementFingerprint({ event, refs, ownedReceipts, dependencies }) }
}
/** Separate explicit reviewed legacy path: it never fabricates or weakens source receipt ownership. */
export async function invalidateLegacyProcessEvent(snapshot: PJSDASSnapshot, command: InvalidateLegacyProcessEventCommand, now = new Date()) {
  if (!command.commandId.trim() || !command.reason.trim() || command.reason.length > 800 || !command.evidenceRefs.length || command.evidenceRefs.length > 20
    || command.evidenceRefs.some(ref => !ref.trim() || ref.length > 1000) || !/^[a-f0-9]{64}$/.test(command.expectedEventFingerprint)) throw new Error('Legacy correction requires a reviewed fingerprint, reason and evidence.')
  const existing = snapshot.data.processEvents.find(item => item.id === command.eventId)?.invalidation
  const prior = (snapshot.data.timeline ?? []).find(item => item.commandId === command.commandId)
  if (prior) {
    if (prior.commandOperation !== command.kind || existing?.commandId !== command.commandId || existing.reason !== command.reason
      || existing.legacyReview?.expectedEventFingerprint !== command.expectedEventFingerprint
      || JSON.stringify(existing.legacyReview.sourceRefs) !== JSON.stringify(command.sourceRefs)
      || JSON.stringify(existing.evidenceRefs) !== JSON.stringify(command.evidenceRefs)) throw new Error('Legacy correction command ID was reused with a different payload.')
    return { status: 'ALREADY_APPLIED' as const, snapshot, summary: 'The reviewed legacy event is already invalidated.' }
  }
  const reviewed = await readLegacyProcessCorrection(snapshot, command.eventId)
  if (!reviewed.eligible) throw new Error(`Legacy correction is blocked: ${reviewed.blocked}.`)
  if (reviewed.expectedEventFingerprint !== command.expectedEventFingerprint || JSON.stringify(reviewed.sourceRefs) !== JSON.stringify(command.sourceRefs)) throw new Error('Legacy event or its provenance changed since review.')
  const next = upgradeSnapshotToLatest(snapshot)
  const event = next.data.processEvents.find(item => item.id === command.eventId)!
  const timestamp = now.toISOString(), receiptId = `legacy-process-correction:${command.commandId}`
  const affected: SemanticIntakeReceipt['affectedObjects'] = [{ type: 'process_event', id: event.id }]
  const survivors = next.data.processEvents.filter(item => item.opportunityId === event.opportunityId && item.id !== event.id && !item.invalidation && stageForProcessEvent(item.type))
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.createdAt.localeCompare(a.createdAt))
  const latest = survivors[0] && (!survivors[1] || survivors[0].occurredAt !== survivors[1].occurredAt || survivors[0].type === survivors[1].type) ? survivors[0] : undefined
  const stage = latest ? stageForProcessEvent(latest.type)! : 'unknown'
  const label = latest ? processEventStageLabel(latest) : '阶段待核实'
  const target = next.data.opportunities.find(item => item.id === event.opportunityId)
  if (target?.effectiveProcessEventId === event.id && target.effectiveProcessEventAt === event.occurredAt && target.processStage === stageForProcessEvent(event.type)) {
    Object.assign(target, { processStage: stage, currentStageLabel: label, effectiveProcessEventId: latest?.id, effectiveProcessEventAt: latest?.occurredAt })
    affected.push({ type: 'opportunity', id: target.id })
  }
  for (const process of next.data.processes) if (process.opportunityId === event.opportunityId && process.effectiveProcessEventId === event.id
    && process.effectiveProcessEventAt === event.occurredAt && process.lastProgressAt === event.occurredAt && process.stage === stageForProcessEvent(event.type)) {
    Object.assign(process, { stage, stageLabel: label, effectiveProcessEventId: latest?.id, effectiveProcessEventAt: latest?.occurredAt, lastProgressAt: latest?.occurredAt,
      currentAction: undefined, nextCheckAt: undefined, silenceRisk: undefined, result: 'pending' })
    affected.push({ type: 'process', id: process.id })
  }
  event.invalidation = { commandId: command.commandId, receiptId, invalidatedAt: timestamp, reason: command.reason, evidenceRefs: [...command.evidenceRefs],
    legacyReview: { expectedEventFingerprint: command.expectedEventFingerprint, sourceRefs: [...command.sourceRefs] } }
  next.data.semanticReceipts!.push({ id: receiptId, inputId: receiptId, commandId: command.commandId, sourceKind: 'mcp', sourceId: 'explicit-legacy-review', sourceRecordId: command.commandId,
    status: 'committed', summary: command.reason, affectedObjects: affected, decisionRequestIds: [], creationSequence: Math.max(0, ...next.data.semanticReceipts!.map(item => item.creationSequence ?? 0)) + 1,
    undoAvailable: false, createdAt: timestamp, updatedAt: timestamp })
  next.data.timeline = [...(next.data.timeline ?? []), { id: receiptId, kind: 'opportunity_updated', category: 'process', source: 'user_action', occurredAt: timestamp, recordedAt: timestamp,
    title: 'Reviewed legacy process evidence invalidated', detail: command.reason, processEventId: event.id, commandId: command.commandId, commandOperation: command.kind }]
  next.exportedAt = timestamp
  validateSnapshot(next)
  return { status: 'APPLIED' as const, snapshot: next, summary: 'Legacy evidence retained as an audited tombstone; no receipt ownership was inferred and independent progress was preserved.' }
}
