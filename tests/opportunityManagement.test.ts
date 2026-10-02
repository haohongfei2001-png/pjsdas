import { describe, expect, it } from 'vitest'
import { applyOpportunityManagement, opportunityManagementSchema, readOpportunityManagement, restoreOpportunityManagement } from '../src/opportunityManagement.js'
import { upgradeSnapshotToLatest, validateSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'
import { applySemanticIntake } from '../src/semanticIntake.js'
import type { Opportunity } from '../src/model.js'
const now = new Date('2026-10-02T12:00:00Z')
const at = now.toISOString()
export function opportunityFixture(): PJSDASSnapshot {
  const opportunity: Opportunity = { id: 'opp-a', company: 'Synthetic Company', role: 'Engineer', currentStageLabel: '面试', processStage: 'interview', roleType: 'core', early: false, opportunityValue: 72, fitScore: 81, importedAt: at, detail: { backgroundTag: 'Original', userFacts: { provenance: 'user_asserted', updatedAt: at, deadline: '2026-12-01', deadlinePrecision: 'date', location: 'Remote' } } }
  return upgradeSnapshotToLatest({ schema: 'pjsdas-local-snapshot', version: 4, exportedAt: at, data: {
    opportunities: [opportunity, { ...opportunity, id: 'opp-b', company: 'Unrelated' }],
    processes: [{ id: 'process-a', opportunityId: opportunity.id, company: opportunity.company, role: opportunity.role, stage: 'interview', stageLabel: 'Custom application label', notes: 'User application record', lastProgressAt: at }],
    processEvents: [{ id: 'event-a', opportunityId: opportunity.id, company: opportunity.company, role: opportunity.role, type: 'interview_invite', occurredAt: at, dueAt: '2026-11-01T10:00:00Z', timingMode: 'fixed', source: 'email', createdAt: at, updatedAt: at, notes: 'Immutable original invitation' }],
    actions: [{ id: 'event-action:event-a', opportunityId: opportunity.id, processEventId: 'event-a', kind: 'manual', title: 'Interview', dueAt: '2026-11-01T10:00:00Z', timingMode: 'fixed', estimatedMinutes: 60, leverage: 90, delayCost: 80, status: 'done', createdAt: at, updatedAt: at }],
    prep: [], applicationGroups: [], scheduleNodes: [], timeline: [{ id: 'history-a', kind: 'application_submitted', category: 'process', source: 'user_action', occurredAt: at, recordedAt: at, title: 'Application submitted', opportunityId: opportunity.id }], semanticReceipts: [], decisionRequests: [], reminderIntents: [], reminderOutbox: [],
  } })
}
async function update(patch: object, initial = opportunityFixture(), commandId = 'profile-command-a') {
  const read = await readOpportunityManagement(initial, 'opp-a')
  return applyOpportunityManagement(initial, { operations: [{ kind: 'update_opportunity_profile', id: 'opp-a', expectedFingerprint: read.profileFingerprint, patch }] }, commandId, now)
}
async function archive(initial = opportunityFixture(), commandId = 'archive-command-a') {
  const read = await readOpportunityManagement(initial, 'opp-a')
  return applyOpportunityManagement(initial, { operations: [{ kind: 'archive_opportunity', id: 'opp-a', expectedFingerprint: read.archive.fingerprint, dependencies: read.archive.dependencies, reason: 'Explicit synthetic archive request' }] }, commandId, now)
}

describe('bounded opportunity profile management', () => {
  it('patches explicit user fields and preserves application records, source events, dates and history', async () => {
    const original = opportunityFixture(); const before = structuredClone(original)
    const changed = await update({ detail: { backgroundTag: 'User correction', gap: 'Practice interviews' }, userFacts: { location: 'Shanghai' }, roleType: 'backup' }, original)
    expect(changed.snapshot.data.opportunities[0]).toMatchObject({ roleType: 'backup', processStage: 'interview', detail: { backgroundTag: 'User correction', userFacts: { location: 'Shanghai', deadline: '2026-12-01', deadlinePrecision: 'date' } } })
    for (const field of ['processes', 'processEvents', 'actions', 'scheduleNodes', 'semanticReceipts'] as const) expect(changed.snapshot.data[field]).toEqual(original.data[field])
    expect(changed.snapshot.data.opportunities[1]).toEqual(original.data.opportunities[1])
    expect(changed.snapshot.data.timeline![0]).toEqual(original.data.timeline![0]); expect(original).toEqual(before)
  })
  it('clears nullable user fields without replacing adjacent facts', async () => {
    const changed = await update({ detail: { backgroundTag: null }, userFacts: { location: null } })
    expect(changed.snapshot.data.opportunities[0].detail?.backgroundTag).toBeUndefined()
    expect(changed.snapshot.data.opportunities[0].detail?.userFacts).toMatchObject({ deadline: '2026-12-01' })
    expect(changed.snapshot.data.opportunities[0].detail?.userFacts?.location).toBeUndefined()
  })
  it.each([{ detail: { backgroundTag: 'Original' } }, { userFacts: { location: 'Remote' } }, { detail: { gap: null } }, { userFacts: { applicationUrl: null } }])('no-op patch emits no write %#', async patch => {
    const changed = await update(patch)
    expect(changed.changed).toBe(false); expect(changed.compensation).toBeUndefined()
  })
  it('does not fabricate user-fact metadata when clearing an absent fact', async () => {
    const initial = opportunityFixture(); delete initial.data.opportunities[0].detail?.userFacts
    expect((await update({ userFacts: { applicationUrl: null } }, initial)).changed).toBe(false)
  })
  it('recomputes assessment totals only from explicitly supplied components with unchanged rules', async () => {
    const original = opportunityFixture()
    const changed = await update({ assessment: { fit: { skills: { score: 83, confidence: 'high', rationale: 'User supplied' } }, opportunityValue: { roleGrowth: { score: 67, confidence: 'medium', rationale: 'User supplied' } } } }, original)
    expect(changed.snapshot.data.opportunities[0]).toMatchObject({ fitScore: 83, opportunityValue: 67, assessmentStatus: 'assessed' })
    expect(changed.snapshot.data.decisionRules).toEqual(original.data.decisionRules)
    expect(changed.snapshot.data.processes).toEqual(original.data.processes)
    expect(restoreOpportunityManagement(changed.snapshot, changed.compensation!, now).data.opportunities).toEqual(original.data.opportunities)
  })
  it('merges and clears individual assessment components without replacing neighboring values', async () => {
    const initial = (await update({ assessment: { fit: { skills: { score: 70, confidence: 'high', rationale: 'First' }, experience: { score: 40, confidence: 'low', rationale: 'Second' } }, opportunityValue: { roleGrowth: { score: 80, confidence: 'high', rationale: 'Third' } } } })).snapshot
    const changed = await update({ assessment: { fit: { skills: null } } }, initial, 'profile-command-b')
    expect(changed.snapshot.data.opportunities[0].detail?.assessment?.fit).toEqual({ experience: { score: 40, confidence: 'low', rationale: 'Second' } })
    await expect(update({ assessment: { fit: { experience: null } } }, changed.snapshot)).rejects.toThrow(/at least one/)
  })
  it.each([{ company: 'Renamed' }, { role: 'Renamed' }, { processStage: 'offer' }, { deadline: '2026-11-01' }, { fitScore: 100 }, { detail: { facts: {} } }, { detail: { discovery: {} } }, { userFacts: { deadline: '2026-11-01' } }, { userFacts: { provenance: 'verified' } }, { assessment: { weights: {} } }, { assessment: { fit: { invented: {} } } }, { userFacts: { applicationUrl: 'javascript:alert(1)' } }])('rejects source/derived/security/identity field injection %#', async patch => {
    const read = await readOpportunityManagement(opportunityFixture(), 'opp-a')
    expect(opportunityManagementSchema.safeParse({ operations: [{ kind: 'update_opportunity_profile', id: 'opp-a', expectedFingerprint: read.profileFingerprint, patch }] }).success).toBe(false)
  })
  it('rejects stale exact fingerprints and foreign/missing IDs without mutations', async () => {
    const original = opportunityFixture(); const read = await readOpportunityManagement(original, 'opp-a')
    original.data.opportunities[0].currentStageLabel = 'Newer user application record'
    await expect(applyOpportunityManagement(original, { operations: [{ kind: 'update_opportunity_profile', id: 'opp-a', expectedFingerprint: read.profileFingerprint, patch: { early: true } }] }, 'stale-command')).rejects.toThrow(/changed/)
    await expect(readOpportunityManagement(original, 'foreign-or-missing')).rejects.toThrow(/not found/)
    expect(original.data.opportunities[0].early).toBe(false)
  })
  it('validates whole batches before any input mutation', async () => {
    const original = opportunityFixture(); const before = structuredClone(original); const read = await readOpportunityManagement(original, 'opp-a')
    await expect(applyOpportunityManagement(original, { operations: [{ kind: 'update_opportunity_profile', id: 'opp-a', expectedFingerprint: read.profileFingerprint, patch: { early: true } }, { kind: 'update_opportunity_profile', id: 'missing', expectedFingerprint: read.profileFingerprint, patch: { early: true } }] }, 'atomic-command')).rejects.toThrow(/not found/)
    expect(original).toEqual(before)
  })
})

describe('recoverable exact-closure opportunity archive', () => {
  it('retains original source facts in ledger compensation and preserves audit history', async () => {
    const original = opportunityFixture(); const removed = await archive(original)
    expect(removed.snapshot.data.opportunities.map(item => item.id)).toEqual(['opp-b'])
    expect(removed.snapshot.data.processes).toEqual([]); expect(removed.snapshot.data.processEvents).toEqual([]); expect(removed.snapshot.data.actions).toEqual([]); expect(removed.snapshot.data.scheduleNodes).toEqual([])
    expect(removed.compensation?.payload.changes.find(item => item.type === 'process_event')?.before).toEqual(original.data.processEvents[0])
    expect(removed.snapshot.data.timeline?.slice(0, 1)).toEqual(original.data.timeline)
    const restored = restoreOpportunityManagement(removed.snapshot, removed.compensation!, now)
    for (const field of ['opportunities', 'processes', 'processEvents', 'actions', 'scheduleNodes'] as const) expect(restored.data[field]).toEqual(original.data[field])
    expect(restored.data.timeline).toHaveLength(2); validateSnapshot(restored)
  })
  it('restores completed/cancelled/superseded states exactly, never resurrecting old deadlines', async () => {
    const initial = opportunityFixture(); const first = initial.data.scheduleNodes![0]
    first.state = 'superseded'; first.supersededByNodeId = 'new-version'
    initial.data.scheduleNodes!.push({ ...first, id: 'new-version', version: first.version + 1, state: 'cancelled', supersedesNodeId: first.id, supersededByNodeId: undefined, cancelledAt: at })
    const normalized = upgradeSnapshotToLatest(initial)
    const removed = await archive(normalized)
    const restored = upgradeSnapshotToLatest(restoreOpportunityManagement(removed.snapshot, removed.compensation!, now))
    expect(restored.data.scheduleNodes).toEqual(normalized.data.scheduleNodes)
    expect(restored.data.actions[0].status).toBe('done')
  })
  it('archives and restores only local reminder intents preserving exact identity', async () => {
    const initial = opportunityFixture(); const node = initial.data.scheduleNodes![0]
    initial.data.reminderIntents!.push({ id: 'reminder-a', scheduleNodeId: node.id, scheduleNodeVersion: node.version, purpose: 'upcoming', triggerAt: '2026-10-31T10:00:00Z', deliveryOwner: 'pjsdas', channel: 'in_product', state: 'active', dedupeKey: 'synthetic-dedupe', createdAt: at, updatedAt: at })
    const removed = await archive(initial)
    expect(removed.snapshot.data.reminderIntents).toEqual([])
    expect(restoreOpportunityManagement(removed.snapshot, removed.compensation!, now).data.reminderIntents).toEqual(initial.data.reminderIntents)
    initial.data.reminderIntents![0].channel = 'task'; initial.data.reminderIntents![0].deliveryOwner = 'external_task'; initial.data.reminderIntents![0].capability = 'chatgpt_tasks'
    await expect(archive(initial)).rejects.toThrow(/External reminder/)
  })
  it('requires an exact manifest, including all occurrence versions', async () => {
    const initial = opportunityFixture(); const read = await readOpportunityManagement(initial, 'opp-a')
    await expect(applyOpportunityManagement(initial, { operations: [{ kind: 'archive_opportunity', id: 'opp-a', expectedFingerprint: read.archive.fingerprint, dependencies: { ...read.archive.dependencies, eventIds: [] }, reason: 'Explicit' }] }, 'archive-command')).rejects.toThrow(/exact reviewed/)
  })
  it.each(['unowned-process', 'foreign-process', 'foreign-opportunity', 'foreign-event'] as const)('rejects cross/unowned process projection links: %s', async mode => {
    const initial = opportunityFixture()
    if (mode === 'unowned-process' || mode === 'foreign-process') initial.data.processes.push({ ...initial.data.processes[0], id: 'legacy-process', opportunityId: mode === 'unowned-process' ? undefined : 'opp-b', effectiveProcessEventId: 'event-a' })
    if (mode === 'foreign-opportunity') initial.data.opportunities[1].effectiveProcessEventId = 'event-a'
    if (mode === 'foreign-event') initial.data.opportunities[0].effectiveProcessEventId = 'unowned-event'
    const before = structuredClone(initial)
    await expect(archive(initial)).rejects.toThrow(/unowned or cross-opportunity/)
    expect(initial).toEqual(before)
  })
  it.each(['scheduleNodeId', 'occurrenceId'] as const)('rejects real missing-timing semantic decisions selecting only %s', async selector => {
    const initial = opportunityFixture(); const node = initial.data.scheduleNodes![0]
    const applied = applySemanticIntake(initial, { contractVersion: 1, inputId: `missing-timing-${selector}`, source: { kind: 'web', sourceId: 'synthetic', sourceRecordId: selector, observedAt: at, timezone: 'UTC' }, statementMode: 'current_intent', candidates: [{ id: 'candidate', kind: 'reminder_intent', purpose: 'upcoming', objectConfidence: 'high', eventConfidence: 'high', evidenceRefs: ['synthetic'], sourceVersionRefs: [], target: { [selector]: selector === 'scheduleNodeId' ? node.id : node.occurrenceId } }] }, { authorized: true, workspaceRevision: 'txn:0', now })
    expect(applied.snapshot.data.decisionRequests?.some(item => item.state === 'open')).toBe(true)
    await expect(archive(applied.snapshot)).rejects.toThrow(/pending decision/)
    const removed = await archive(initial)
    removed.snapshot.data.decisionRequests = structuredClone(applied.snapshot.data.decisionRequests)
    expect(() => restoreOpportunityManagement(removed.snapshot, removed.compensation!, now)).toThrow(/pending decision/)
  })
  it.each(['reminderIntentId', 'choice-opportunity', 'choice-occurrence', 'choice-reminder'] as const)('checks pending decision selector %s', async selector => {
    const initial = opportunityFixture(); const node = initial.data.scheduleNodes![0]
    initial.data.reminderIntents!.push({ id: 'reminder-a', scheduleNodeId: node.id, scheduleNodeVersion: node.version, purpose: 'upcoming', triggerAt: '2026-10-31T10:00:00Z', deliveryOwner: 'pjsdas', channel: 'in_product', state: 'active', dedupeKey: 'synthetic-decision-reminder', createdAt: at, updatedAt: at })
    const applied = applySemanticIntake(initial, { contractVersion: 1, inputId: `missing-timing-${selector}`, source: { kind: 'web', sourceId: 'synthetic', sourceRecordId: selector, observedAt: at, timezone: 'UTC' }, statementMode: 'current_intent', candidates: [{ id: 'candidate', kind: 'reminder_intent', purpose: 'upcoming', objectConfidence: 'high', eventConfidence: 'high', evidenceRefs: ['synthetic'], sourceVersionRefs: [], target: { scheduleNodeId: node.id } }] }, { authorized: true, workspaceRevision: 'txn:0', now })
    const decision = applied.snapshot.data.decisionRequests!.find(item => item.state === 'open')!
    expect(decision).toBeDefined(); decision.affectedObjects = [{ type: 'source', id: 'synthetic' }]
    decision.payloadBinding.candidate.target = selector === 'reminderIntentId' ? { reminderIntentId: 'reminder-a' } : undefined
    if (selector === 'choice-opportunity') decision.choices[0].resolution = { opportunityId: 'opp-a' }
    if (selector === 'choice-occurrence') decision.choices[0].resolution = { occurrenceId: node.occurrenceId }
    if (selector === 'choice-reminder') decision.choices[0].resolution = { reminderIntentId: 'reminder-a' }
    await expect(archive(applied.snapshot)).rejects.toThrow(/pending decision/)
    const removed = await archive(initial); removed.snapshot.data.decisionRequests = [structuredClone(decision)]
    expect(() => restoreOpportunityManagement(removed.snapshot, removed.compensation!, now)).toThrow(/pending decision/)
  })
  it.each(['unique-name', 'ambiguous-name'] as const)('uses the existing semantic identity matcher for %s pending decisions', async mode => {
    const initial = opportunityFixture()
    const target = mode === 'unique-name' ? { company: 'Synthetic Company', role: 'Engineer' } : { role: 'Engineer' }
    const applied = applySemanticIntake(initial, { contractVersion: 1, inputId: `missing-timing-${mode}`, source: { kind: 'web', sourceId: 'synthetic', sourceRecordId: mode, observedAt: at, timezone: 'UTC' }, statementMode: 'current_intent', candidates: [{ id: 'candidate', kind: 'reminder_intent', purpose: 'upcoming', objectConfidence: 'high', eventConfidence: 'high', evidenceRefs: ['synthetic'], sourceVersionRefs: [], target }] }, { authorized: true, workspaceRevision: 'txn:0', now })
    const decision = applied.snapshot.data.decisionRequests!.find(item => item.state === 'open')!
    expect(decision).toBeDefined(); decision.affectedObjects = [{ type: 'source', id: 'synthetic' }]
    for (const choice of decision.choices) choice.resolution = undefined
    await expect(archive(applied.snapshot)).rejects.toThrow(/pending decision/)
    const removed = await archive(initial); removed.snapshot.data.decisionRequests = [structuredClone(decision)]
    expect(() => restoreOpportunityManagement(removed.snapshot, removed.compensation!, now)).toThrow(/pending decision/)
  })
  it('fails closed on shared prep/schedule associations', async () => {
    const initial = opportunityFixture(); initial.data.scheduleNodes![0].relatedPrepIds = ['shared-prep']
    await expect(archive(initial)).rejects.toThrow(/Shared/)
  })
  it('preserves unrelated later data and original collection positions on restore', async () => {
    const original = opportunityFixture(); original.data.opportunities.reverse()
    const removed = await archive(original); removed.snapshot.data.opportunities[0].detail!.gap = 'Unrelated later edit'
    const restored = restoreOpportunityManagement(removed.snapshot, removed.compensation!, now)
    expect(restored.data.opportunities.map(item => item.id)).toEqual(['opp-b', 'opp-a'])
    expect(restored.data.opportunities[0].detail?.gap).toBe('Unrelated later edit')
  })
  it.each(['id', 'new-event', 'new-occurrence', 'indirect-node'] as const)('rejects conflicting newer input: %s', async mode => {
    const original = opportunityFixture(); const removed = await archive(original)
    if (mode === 'id') removed.snapshot.data.opportunities.push({ ...original.data.opportunities[0], role: 'Newer identity' })
    if (mode === 'new-event') removed.snapshot.data.processEvents.push({ ...original.data.processEvents[0], id: 'new-event' })
    if (mode === 'new-occurrence') removed.snapshot.data.scheduleNodes!.push({ ...original.data.scheduleNodes![0], id: 'new-version', version: 20, opportunityId: undefined, processId: undefined, processEventId: undefined, relatedActionIds: [], state: 'cancelled' })
    if (mode === 'indirect-node') removed.snapshot.data.scheduleNodes!.push({ ...original.data.scheduleNodes![0], id: 'indirect-node', occurrenceId: 'new-occurrence', version: 1, opportunityId: undefined, processId: undefined, relatedActionIds: [], state: 'cancelled' })
    expect(() => restoreOpportunityManagement(removed.snapshot, removed.compensation!, now)).toThrow(/newer|New dependent/)
  })
  it('rejects newly arrived unowned projection pointers during restore', async () => {
    const original = opportunityFixture(); const removed = await archive(original)
    removed.snapshot.data.processes.push({ ...original.data.processes[0], id: 'new-legacy-process', opportunityId: undefined, effectiveProcessEventId: 'event-a' })
    expect(() => restoreOpportunityManagement(removed.snapshot, removed.compensation!, now)).toThrow(/unowned or cross-opportunity/)
  })
  it('rejects invalid compensation identities and duplicate rows', async () => {
    const removed = await archive(); const compensation = structuredClone(removed.compensation!)
    compensation.payload.changes[0].before.id = 'foreign'
    expect(() => restoreOpportunityManagement(removed.snapshot, compensation, now)).toThrow(/identity/)
    compensation.payload.changes[0] = removed.compensation!.payload.changes[0]; compensation.payload.changes.push(compensation.payload.changes[0])
    expect(() => restoreOpportunityManagement(removed.snapshot, compensation, now)).toThrow(/identity/)
  })
})
