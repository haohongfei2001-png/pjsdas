import { applyUserDomainCommand } from '../src/domainCommands.js'
import { applyOpportunityManagement, readOpportunityManagement } from '../src/opportunityManagement.js'
import { invokeReadTool } from '../gateway/readTools.js'
import { diffCommandObjects, diffCommandFields } from '../gateway/commandObjects.js'
import { invalidateProcessFact, invalidatedSourceFact } from '../src/processFactCorrection.js'
import { correctApplicationDeadline } from '../src/deadlineCorrection.js'
import { applicationDeadlineFingerprint } from '../src/applicationDeadline.js'
import type { SemanticIntakeObservation } from '../src/model.js'
import { applyGmailIngestion, applyMonitorIngestion } from '../src/autonomousIngestion.js'
import { applySemanticIntake } from '../src/semanticIntake.js'
import { describe, expect, it } from 'vitest'
import { applyOpportunityMerge, readOpportunityMerge, restoreOpportunityMerge } from '../src/opportunityMerge.js'
import { canonicalOpportunityId, resolveCanonicalOpportunityTarget, resolveCanonicalPostingIdentity } from '../src/opportunityCanonicalization.js'
import { upgradeSnapshotToLatest, validateSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'
import type { Opportunity } from '../src/model.js'
const at = '2026-10-05T10:00:00.000Z'
const now = new Date(at)
const source = 'https://careers.example/jobs/J123'
const sourceUrl = () => source
function fixture(): PJSDASSnapshot {
  const opportunity: Opportunity = { id: 'canonical', company: 'Synthetic Inc', role: 'Engineer', currentStageLabel: '待投递', processStage: 'not_applied', roleType: 'core', early: false, opportunityValue: 70, fitScore: 80, importedAt: at, detail: { discovery: { sourceUrl: source, sourceTitle: 'Synthetic posting', rationale: 'Synthetic evidence', discoveredAt: at, fitConfidence: 'high', opportunityValueConfidence: 'high' } } }
  return upgradeSnapshotToLatest({ schema: 'pjsdas-local-snapshot', version: 4, exportedAt: at, data: { opportunities: [opportunity, { ...structuredClone(opportunity), id: 'duplicate' }], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], scheduleNodes: [], decisionRequests: [], semanticReceipts: [], reminderIntents: [], reminderOutbox: [], timeline: [{ id: 'source-history', kind: 'opportunity_added', category: 'opportunity', source: 'user_action', occurredAt: at, recordedAt: at, title: 'Source history', opportunityId: 'duplicate' }] } })
}
async function command(snapshot: PJSDASSnapshot) {
  const read = await readOpportunityMerge(snapshot, 'canonical', 'duplicate')
  return { canonicalOpportunityId: 'canonical', duplicateOpportunityId: 'duplicate', expectedFingerprint: read.fingerprint, dependencies: read.dependencies, reason: 'Confirmed same exact posting', evidenceRefs: [source] }
}
async function merge(snapshot = fixture()) { return applyOpportunityMerge(snapshot, await command(snapshot), 'merge-command-123', now) }
describe('bounded audited opportunity merge', () => {
  it('preserves original source record and historical links with an explicit durable alias', async () => {
    const original = fixture(); const before = structuredClone(original)
    const result = await merge(original)
    expect(original).toEqual(before)
    expect(result.snapshot.data.opportunities.map(item => item.id)).toEqual(['canonical'])
    expect(result.snapshot.data.opportunityAliases?.[0]).toMatchObject({ id: 'duplicate', canonicalOpportunityId: 'canonical', originalOpportunity: before.data.opportunities[1] })
    expect(result.snapshot.data.timeline?.[0]).toEqual(before.data.timeline?.[0])
    expect(canonicalOpportunityId(result.snapshot, 'duplicate')).toBe('canonical')
    expect(resolveCanonicalOpportunityTarget(result.snapshot, { opportunityId: 'duplicate' })).toMatchObject({ status: 'unique', opportunity: { id: 'canonical' } })
    expect(resolveCanonicalPostingIdentity(result.snapshot, { company: 'Synthetic Inc', role: 'Engineer', sourceUrl: source })).toMatchObject({ kind: 'same_posting', opportunity: { id: 'canonical' } })
    validateSnapshot(result.snapshot)
    const restored = await restoreOpportunityMerge(result.snapshot, result.compensation!, now)
    expect(restored.data.opportunities).toEqual(before.data.opportunities)
    expect(restored.data.opportunityAliases).toBeUndefined()
    expect(restored.data.timeline).toHaveLength(3)
  })
  it('rewrites exact active event, process and action ownership without deleting their evidence', async () => {
    const snapshot = fixture()
    snapshot.data.processes.push({ id: 'process-1', opportunityId: 'duplicate', company: 'Synthetic Inc', role: 'Engineer', stage: 'not_applied', stageLabel: '待投递' })
    snapshot.data.processEvents.push({ id: 'event-1', opportunityId: 'duplicate', company: 'Synthetic Inc', role: 'Engineer', type: 'application_submitted', occurredAt: at, source: 'email', createdAt: at, updatedAt: at, notes: 'Original synthetic event' })
    const result = await merge(upgradeSnapshotToLatest(snapshot))
    expect(result.snapshot.data.processEvents[0]).toEqual({ ...snapshot.data.processEvents[0], opportunityId: 'canonical' })
    expect(result.snapshot.data.processes[0].opportunityId).toBe('canonical')
    expect((await restoreOpportunityMerge(result.snapshot, result.compensation!, now)).data.processEvents).toEqual(snapshot.data.processEvents)
  })
  it('requires exact dependency manifest, current workspace fingerprint and two active IDs', async () => {
    const snapshot = fixture(); const input = await command(snapshot)
    await expect(applyOpportunityMerge(snapshot, { ...input, dependencies: { ...input.dependencies, timelineIds: [] } }, 'merge-command-123', now)).rejects.toMatchObject({ code: 'STALE_TARGET' })
    snapshot.data.opportunities[0].fitScore++
    await expect(applyOpportunityMerge(snapshot, input, 'merge-command-123', now)).rejects.toMatchObject({ code: 'STALE_TARGET' })
    await expect(readOpportunityMerge(snapshot, 'canonical', 'unknown')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
  it('rejects conflicting facts, distinct external posting URLs and missing positive evidence', async () => {
    const conflict = fixture(); conflict.data.opportunities[1].fitScore = 25
    await expect(merge(conflict)).rejects.toMatchObject({ code: 'REFERENCE_IN_USE' })
    const distinct = fixture(); distinct.data.opportunities[1].detail!.discovery!.sourceUrl = 'https://careers.example/jobs/J999'
    await expect(merge(distinct)).rejects.toMatchObject({ code: 'REFERENCE_IN_USE' })
    const missing = fixture(); delete missing.data.opportunities[1].detail
    await expect(merge(missing)).rejects.toMatchObject({ code: 'REFERENCE_IN_USE' })
  })
  it('routes new events and replayed source records to the canonical opportunity', async () => {
    const result = await merge()
    const input = { runId: 'mail-run-1', sourceId: 'synthetic-mail', startedAt: at, completedAt: at, messages: [{ sourceRecordId: 'synthetic-message', receivedAt: at, classification: 'recruiting' as const, confidence: 'high' as const, company: 'Synthetic Inc', role: 'Engineer', eventType: 'application_submitted' as const }] }
    const incoming = applyGmailIngestion(result.snapshot, input)
    expect(incoming.snapshot.data.opportunities).toHaveLength(1)
    expect(incoming.snapshot.data.processEvents.every(event => event.opportunityId === 'canonical')).toBe(true)
    const replay = applyGmailIngestion(incoming.snapshot, { ...input, runId: 'mail-run-2' })
    expect(replay.snapshot.data.opportunities).toHaveLength(1)
    expect(replay.snapshot.data.processEvents).toEqual(incoming.snapshot.data.processEvents)
    const semantic = applySemanticIntake(result.snapshot, { contractVersion: 1, inputId: 'semantic-merged-input', source: { kind: 'mcp', sourceId: 'synthetic-mcp', sourceRecordId: 'source-one', sourceVersion: 'v1', observedAt: at, assertedAt: at, timezone: 'UTC' }, statementMode: 'assertion', originalText: 'Synthetic application submitted', candidates: [{ id: 'candidate-one', kind: 'application_submitted', occurredAt: at, target: { opportunityId: 'duplicate' }, objectConfidence: 'high', eventConfidence: 'high', temporalConfidence: 'high', evidenceRefs: [], sourceVersionRefs: [] }] }, { authorized: true, now })
    expect(semantic.snapshot.data.opportunities).toHaveLength(1)
    expect(semantic.snapshot.data.processEvents.every(event => event.opportunityId === 'canonical')).toBe(true)
  })
  it('refreshes the same posting source without recreating the duplicate', async () => {
    const result = await merge()
    const refreshed = applyMonitorIngestion(result.snapshot, { runId: 'monitor-new', sourceId: 'synthetic-monitor', startedAt: at, completedAt: at, observations: [{ sourceRecordId: 'posting-one', company: 'Synthetic Inc', role: 'Engineer', sourceUrl: source, sourceTitle: 'Synthetic posting', rationale: 'Synthetic evidence', fitScore: 80, opportunityValue: 70, fitConfidence: 'high', opportunityValueConfidence: 'high', discoveredAt: at }] })
    expect(refreshed.snapshot.data.opportunities).toHaveLength(1)
    expect(refreshed.createdOpportunityIds).toEqual([])
    expect(refreshed.snapshot.data.opportunityAliases).toEqual(result.snapshot.data.opportunityAliases)
  })
  it('replays identical command IDs without writing and rejects altered payloads', async () => {
    const before = fixture(); const input = await command(before)
    const first = await applyOpportunityMerge(before, input, 'merge-replay-command', now)
    const second = await applyOpportunityMerge(first.snapshot, input, 'merge-replay-command', now)
    expect(second.status).toBe('ALREADY_APPLIED'); expect(second.changed).toBe(false)
    expect(second.snapshot).toEqual(first.snapshot)
    await expect(applyOpportunityMerge(first.snapshot, { ...input, reason: 'Changed reason' }, 'merge-replay-command', now)).rejects.toMatchObject({ code: 'STALE_TARGET' })
    expect(diffCommandObjects(before, first.snapshot)).toContainEqual({ type: 'opportunity_alias', id: 'duplicate' })
    expect(diffCommandFields(before, first.snapshot)).toContainEqual({ type: 'opportunity_alias', id: 'duplicate', field: '*' })
  })
  it('reads aliased detail/assessment/prep and historical timeline without changing original evidence IDs', async () => {
    const result = await merge(); const source = { read: async () => ({ snapshot: result.snapshot, context: { now, timezone: 'UTC' } }) }
    for (const name of ['get_opportunity_detail', 'get_prep_graph'] as const) {
      const args = { opportunityId: 'duplicate' }
      const response = await invokeReadTool(source, name, args)
      expect(response.isError).not.toBe(true)
      expect(args.opportunityId).toBe('duplicate')
      if (name === 'get_opportunity_detail') expect(JSON.parse((response.content[0] as {text: string}).text).opportunityId).toBe('canonical')
    }
    const history = await invokeReadTool(source, 'get_recent_timeline', { opportunityId: 'duplicate' })
    const records = JSON.parse((history.content[0] as {text: string}).text).records
    expect(records).toContainEqual(expect.objectContaining({ timelineId: 'source-history', opportunityId: 'duplicate' }))
    const input = { kind: 'correct_application_deadline' as const, commandId: 'aliased-deadline-correction', opportunityId: 'duplicate', expectedDeadlineFingerprint: applicationDeadlineFingerprint(result.snapshot.data.opportunities[0], result.snapshot.data), correction: { state: 'unknown' as const, sourceUrl: sourceUrl(), sourceAuthority: 'official_role' as const, evidence: 'Synthetic role page has no deadline', checkedAt: at, postingStatus: 'open' as const } }
    const corrected = applyUserDomainCommand(result.snapshot, input, now)
    expect(corrected.status).toBe('APPLIED')
    const repeated = applyUserDomainCommand(corrected.snapshot, input, now)
    expect(repeated.status).toBe('ALREADY_APPLIED')
    expect(repeated.snapshot).toEqual(corrected.snapshot)
    correctApplicationDeadline(result.snapshot, input, at)
    expect(input.opportunityId).toBe('duplicate')
    expect(result.snapshot.data.opportunities[0].detail?.deadlineCorrections?.[0].sourceUrl).toBe(sourceUrl())
  })
  it('deduplicates historical alias fact keys across sources and retains original receipt evidence', async () => {
    const observation: SemanticIntakeObservation = { contractVersion: 1, inputId: 'historical-alias-source', source: { kind: 'gmail', sourceId: 'synthetic-mail', sourceRecordId: 'historic-message', sourceVersion: 'v1', observedAt: at, timezone: 'UTC' }, statementMode: 'assertion', candidates: [{ id: 'fact-one', kind: 'application_submitted', occurredAt: at, target: { opportunityId: 'duplicate' }, objectConfidence: 'high', eventConfidence: 'high', evidenceRefs: ['synthetic:original'], sourceVersionRefs: ['v1'] }] }
    const seeded = applySemanticIntake(fixture(), observation, { authorized: true, now }).snapshot
    seeded.data.opportunities[0] = { ...structuredClone(seeded.data.opportunities[1]), id: 'canonical' }
    const originalReceipt = structuredClone(seeded.data.semanticReceipts![0])
    const result = await merge(seeded)
    const incoming = { ...observation, inputId: 'different-source', source: { ...observation.source, sourceId: 'different-source-system', sourceRecordId: 'different-record' }, candidates: observation.candidates.map(item => ({ ...item, target: { opportunityId: 'canonical' } })) }
    const replay = applySemanticIntake(result.snapshot, incoming, { authorized: true, now })
    expect(replay.snapshot.data.processEvents).toEqual(result.snapshot.data.processEvents)
    expect(replay.snapshot.data.semanticReceipts![0]).toEqual(originalReceipt)
    expect(replay.snapshot.data.semanticReceipts!.at(-1)?.mutatedFactKeys).toEqual([])
  })
  it('invalidates aliased terminal evidence using exact receipt ownership and blocks canonical replay', async () => {
    const observation: SemanticIntakeObservation = { contractVersion: 1, inputId: 'historic-terminal', source: { kind: 'gmail', sourceId: 'synthetic-mail', sourceRecordId: 'historic-terminal-message', sourceVersion: 'v1', observedAt: at, timezone: 'UTC' }, statementMode: 'assertion', candidates: [{ id: 'terminal-one', kind: 'process_event', eventType: 'offer', occurredAt: at, target: { opportunityId: 'duplicate' }, objectConfidence: 'high', eventConfidence: 'high', evidenceRefs: ['synthetic:original-terminal'], sourceVersionRefs: ['v1'] }] }
    const seeded = applySemanticIntake(fixture(), observation, { authorized: true, now }).snapshot
    seeded.data.opportunities[0] = { ...structuredClone(seeded.data.opportunities[1]), id: 'canonical' }
    const result = await merge(seeded); const event = result.snapshot.data.processEvents[0]
    const input = { kind: 'invalidate_process_event' as const, commandId: 'correct-aliased-terminal', opportunityId: 'duplicate', eventId: event.id, receiptId: result.snapshot.data.semanticReceipts![0].id, expectedEventUpdatedAt: event.updatedAt, reason: 'Synthetic correction evidence', evidenceRefs: ['synthetic:verified-original'] }
    expect(() => invalidateProcessFact(structuredClone(result.snapshot), { ...input, receiptId: 'foreign-receipt' }, at)).toThrow(/receipt/)
    const corrected = applyUserDomainCommand(result.snapshot, input, now)
    expect(corrected.status).toBe('APPLIED')
    const repeated = applyUserDomainCommand(corrected.snapshot, input, now)
    expect(repeated.status).toBe('ALREADY_APPLIED')
    expect(repeated.snapshot).toEqual(corrected.snapshot)
    invalidateProcessFact(result.snapshot, input, at)
    expect(input.opportunityId).toBe('duplicate')
    expect(event.invalidation?.evidenceRefs).toEqual(input.evidenceRefs)
    const originalKey = result.snapshot.data.semanticReceipts![0].factKeys![0]
    expect(invalidatedSourceFact(result.snapshot, observation.source, originalKey.replace('|opp:duplicate|', '|opp:canonical|'))).toBe(true)
    const replay = applySemanticIntake(result.snapshot, { ...observation, inputId: 'canonical-replay', source: { ...observation.source, sourceVersion: 'v2' }, candidates: observation.candidates.map(item => ({ ...item, target: { opportunityId: 'canonical' } })) }, { authorized: true, now })
    expect(replay.snapshot.data.processEvents).toHaveLength(1)
    expect(replay.snapshot.data.opportunities[0].processStage).toBe('unknown')
    expect(replay.coverageDebtCount).toBeGreaterThan(0)
  })
  it('explicitly blocks archive of canonical source identity while merged aliases depend on it', async () => {
    const merged = await merge(); const read = await readOpportunityManagement(merged.snapshot, 'canonical')
    await expect(applyOpportunityManagement(merged.snapshot, { operations: [{ kind: 'archive_opportunity', id: 'canonical', expectedFingerprint: read.archive.fingerprint, dependencies: read.archive.dependencies, reason: 'Synthetic archive attempt' }] }, 'archive-canonical-command', now)).rejects.toMatchObject({ code: 'REFERENCE_IN_USE' })
    expect(merged.snapshot.data.opportunityAliases).toHaveLength(1)
    await expect(readOpportunityManagement(merged.snapshot, 'duplicate')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
  it('fails undo closed after any new data arrives', async () => {
    const result = await merge(); result.snapshot.data.opportunities[0].fitScore++
    await expect(restoreOpportunityMerge(result.snapshot, result.compensation!, now)).rejects.toMatchObject({ code: 'RESTORE_CONFLICT' })
  })
  it('does not put unrelated large workspace history in compensation or manifest', async () => {
    const snapshot = fixture()
    for (let i = 0; i < 2600; i++) snapshot.data.timeline!.push({ ...snapshot.data.timeline![0], id: `unrelated-history-${i}`, opportunityId: undefined })
    const result = await merge(snapshot)
    expect(result.compensation!.payload.changes).toHaveLength(1)
    expect(JSON.stringify(result.compensation).length).toBeLessThan(5000)
    expect((await command(snapshot)).dependencies.timelineIds).toEqual(['source-history'])
  })
})
