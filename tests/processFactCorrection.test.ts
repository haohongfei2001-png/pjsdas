import { describe, expect, it } from 'vitest'
import { applyDomainCompensation, applyUserDomainCommand } from '../src/domainCommands.js'
import { applySemanticCompensation, applySemanticIntake } from '../src/semanticIntake.js'
import { applyProcessEventDeleteCommand } from '../src/processEventDeleteCommand.js'
import { createSnapshot, upgradeSnapshotToLatest, validateSnapshot } from '../src/snapshot.js'
import { overlayProcessEventsOnOpportunities, overlayProcessEventsOnProcesses } from '../src/processEvents.js'
import type { SemanticIntakeObservation } from '../src/model.js'
const now = new Date('2026-10-02T00:00:00Z')
function base() { return createSnapshot({ opportunities: [{ id: 'synthetic-job', company: '星河研究', role: '产品分析师', currentStageLabel: '待投', processStage: 'not_applied', roleType: 'core', early: false, opportunityValue: 70, fitScore: 80, importedAt: now.toISOString() }], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [] }) }
function observation(inputId = 'synthetic-original'): SemanticIntakeObservation { return { contractVersion: 1, inputId, source: { kind: 'gmail', sourceId: 'gmail:primary', sourceRecordId: inputId, observedAt: now.toISOString(), timezone: 'Asia/Shanghai' }, statementMode: 'assertion', candidates: [{ id: 'terminal', kind: 'process_event', eventType: 'offer', occurredAt: now.toISOString(), target: { opportunityId: 'synthetic-job' }, objectConfidence: 'high', eventConfidence: 'high', evidenceRefs: ['synthetic:source'], sourceVersionRefs: ['synthetic:v1'] }] } }
function seeded() { return applySemanticIntake(base(), observation(), { authorized: true, now }).snapshot }
function command(snapshot = seeded()) { const event = snapshot.data.processEvents[0]; return { kind: 'invalidate_process_event' as const, commandId: 'synthetic-correction-1', opportunityId: 'synthetic-job', eventId: event.id, receiptId: snapshot.data.semanticReceipts![0].id, expectedEventUpdatedAt: event.updatedAt, reason: 'Source described a recruiting process, not a personal outcome.', evidenceRefs: ['synthetic:verified-original'] } }

describe('audit-preserving terminal fact correction', () => {
  it('retains the original evidence, clears both terminal mirrors, and persists unknown rather than inventing a stage', () => {
    const before = seeded(); const originalEvent = structuredClone(before.data.processEvents[0]); const input = command(before)
    const result = applyUserDomainCommand(before, input, new Date('2026-10-02T01:00:00Z'))
    expect(result.status).toBe('APPLIED')
    const next = upgradeSnapshotToLatest(JSON.parse(JSON.stringify(result.snapshot)))
    expect(next.data.processEvents[0]).toMatchObject(JSON.parse(JSON.stringify(originalEvent)))
    expect(next.data.processEvents[0].invalidation?.commandId).toBe(input.commandId)
    expect(next.data.opportunities[0]).toMatchObject({ processStage: 'unknown', currentStageLabel: '阶段待核实' })
    expect(next.data.processes[0]).toMatchObject({ stage: 'unknown', result: 'pending' })
    expect(next.data.opportunities[0].effectiveProcessEventId).toBeUndefined()
    expect(next.data.semanticReceipts![0].factInvalidations).toHaveLength(1)
    expect(next.data.semanticReceipts).toHaveLength(2)
    expect(overlayProcessEventsOnOpportunities(next.data.opportunities, next.data.processEvents, next.data.processes)[0].processStage).toBe('unknown')
    expect(overlayProcessEventsOnProcesses(next.data.processes, next.data.opportunities, next.data.processEvents)[0].stage).toBe('unknown')
    expect(applyUserDomainCommand(next, input, now).status).toBe('ALREADY_APPLIED')
    const replay = applySemanticIntake(next, observation(), { authorized: true, now })
    expect(replay.snapshot.data.processEvents).toHaveLength(1)
    expect(replay.coverageDebtCount).toBeGreaterThan(0)
    expect(before.data.processEvents[0].invalidation).toBeUndefined()
    validateSnapshot(next)
  })
  it('reprojects surviving valid evidence without replacing a later manual or independently owned event', () => {
    const earlier = applyUserDomainCommand(base(), { commandId: 'synthetic-interview', kind: 'record_process_event', opportunityId: 'synthetic-job', eventType: 'interview_invite', occurredAt: '2026-10-01T00:00:00Z' }, now).snapshot
    const withOffer = applySemanticIntake(earlier, observation(), { authorized: true, now }).snapshot
    const offer = withOffer.data.processEvents.find(e => e.type === 'offer')!
    const input = { ...command(seeded()), eventId: offer.id, expectedEventUpdatedAt: offer.updatedAt }
    const corrected = applyUserDomainCommand(withOffer, input, now).snapshot
    expect(corrected.data.opportunities[0].processStage).toBe('interview')
    const later = applyUserDomainCommand(seeded(), { commandId: 'synthetic-legitimate-offer', kind: 'record_process_event', opportunityId: 'synthetic-job', eventType: 'offer', occurredAt: '2026-10-03T00:00:00Z' }, now).snapshot
    const before = structuredClone(later.data.opportunities[0])
    const preserved = applyUserDomainCommand(later, command(seeded()), now).snapshot
    expect(preserved.data.opportunities[0]).toEqual(before)
    expect(preserved.data.processes[0].result).toBe('offer')
  })
  it('retains corrected original evidence against both source undo and ordinary event deletion', () => {
    const original = applySemanticIntake(base(), observation(), { authorized: true, now })
    const next = applyUserDomainCommand(original.snapshot, command(original.snapshot), now).snapshot
    const before = JSON.stringify(next)
    expect(() => applySemanticCompensation(next, original.compensation!, now)).toThrow(/retained/)
    expect(applyProcessEventDeleteCommand(next, next.data.processEvents[0].id, now).status).toBe('NEEDS_CONFIRMATION')
    expect(JSON.stringify(next)).toBe(before)
  })
  it('refuses stale event or wrong source ownership without changing any stores', () => {
    const snapshot = seeded(); const serialized = JSON.stringify(snapshot)
    expect(() => applyUserDomainCommand(snapshot, { ...command(snapshot), expectedEventUpdatedAt: '2020-01-01T00:00:00Z' }, now)).toThrow(/changed/)
    expect(() => applyUserDomainCommand(snapshot, { ...command(snapshot), receiptId: 'unrelated-receipt' }, now)).toThrow(/receipt/)
    expect(JSON.stringify(snapshot)).toBe(serialized)
  })
  it('new event undo restores its exact stage projection and refuses later edits', () => {
    const result = applyUserDomainCommand(base(), { commandId: 'synthetic-offer-command', kind: 'record_process_event', opportunityId: 'synthetic-job', eventType: 'offer' }, now)
    if (result.status !== 'APPLIED' || !result.compensation) throw new Error('Missing compensation')
    const undone = applyDomainCompensation(result.snapshot, result.compensation, now)
    expect(undone.data.opportunities[0].processStage).toBe('not_applied')
    expect(undone.data.processes).toHaveLength(0)
    const changed = structuredClone(result.snapshot); changed.data.opportunities[0].currentStageLabel = 'Independent manual update'
    expect(() => applyDomainCompensation(changed, result.compensation!, now)).toThrow(/changed/)
  })
})
