import { applyOpportunityMerge, readOpportunityMerge } from '../src/opportunityMerge.js'
import { describe, expect, it } from 'vitest'
import { applyDecisionDismissalCompensation, decisionRequestFingerprint, dismissSemanticDecision, dismissedSemanticCandidate } from '../src/decisionDismissal.js'
import { applySemanticIntake } from '../src/semanticIntake.js'
import { createSnapshot, validateSnapshot } from '../src/snapshot.js'
import type { DecisionRequest, SemanticIntakeObservation } from '../src/model.js'
import { opportunity } from '../e2e/fixtures/todayWorkspace.js'

const now = new Date('2026-10-01T00:00:00Z')
function observation(): SemanticIntakeObservation {
  return { contractVersion: 1, inputId: 'synthetic-input', originalTextFingerprint: 'synthetic-content-v1', statementMode: 'assertion',
    source: { kind: 'gmail', sourceId: 'gmail:primary', sourceRecordId: 'synthetic-source', sourceVersion: 'v1', timezone: 'Asia/Shanghai', observedAt: now.toISOString() },
    candidates: [{ id: 'synthetic-candidate', kind: 'process_event', eventType: 'interview_invite', occurredAt: now.toISOString(),
      dueAt: '2026-10-03T14:00:00+08:00', timingMode: 'fixed', target: { company: '甲星公司' }, objectConfidence: 'high', eventConfidence: 'high', temporalConfidence: 'high',
      evidenceRefs: ['synthetic:evidence'], sourceVersionRefs: ['synthetic:v1'] }] }
}
function seeded() {
  return applySemanticIntake(createSnapshot({ opportunities: [opportunity('synthetic-a', '甲星公司', '产品经理'), opportunity('synthetic-b', '甲星公司', '客户经理')],
    processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [] }), observation(), { authorized: true, now }).snapshot
}
async function command(request: DecisionRequest) {
  return { kind: 'dismiss_semantic_decision' as const, commandId: 'synthetic-dismissal', requestId: request.id,
    expectedRequestUpdatedAt: request.updatedAt, expectedFingerprint: await decisionRequestFingerprint(request),
    reason: 'Synthetic source was not a personal invitation.', evidenceRefs: ['synthetic:reviewed-source'] }
}

describe('universal audited semantic decision dismissal', () => {
  it.each(['open', 'expired'] as const)('dismisses a %s request without any business mutation', async state => {
    const base = seeded(); const request = base.data.decisionRequests![0]; request.state = state
    const old = structuredClone(base); const input = await command(request)
    const result = await dismissSemanticDecision(base, input, new Date('2026-10-02T00:00:00Z'))
    const dismissed = result.snapshot.data.decisionRequests![0]
    expect(dismissed.state).toBe('dismissed')
    expect(dismissed.payloadBinding).toEqual(request.payloadBinding)
    expect(dismissed.choices).toEqual(request.choices)
    expect(dismissed.dismissal).toMatchObject({ commandId: input.commandId, reason: input.reason, evidenceRefs: input.evidenceRefs })
    for (const key of ['opportunities', 'processes', 'processEvents', 'actions', 'scheduleNodes', 'semanticReceipts'] as const) expect(result.snapshot.data[key]).toEqual(base.data[key])
    expect(base).toEqual(old)
    expect(result.snapshot.data.timeline?.at(-1)).toMatchObject({ commandId: input.commandId, commandOperation: input.kind, decisionRequestId: request.id })
    expect((await dismissSemanticDecision(result.snapshot, input, now)).status).toBe('ALREADY_APPLIED')
    validateSnapshot(result.snapshot)
  })
  it.each(['missing_required_field', 'material_conflict', 'external_consequence', 'shared_governance'] as const)('dismisses %s without requiring a dismiss choice', async reason => {
    const base = seeded(); const request = base.data.decisionRequests![0]; request.reason = reason
    expect(request.choices.every(choice => !choice.resolution?.dismiss)).toBe(true)
    const result = await dismissSemanticDecision(base, await command(request), now)
    expect(result.snapshot.data.decisionRequests![0].state).toBe('dismissed')
    expect(result.snapshot.data.processEvents).toHaveLength(0)
  })
  it('rejects stale timestamps, full-content changes and truncated fingerprints atomically', async () => {
    const base = seeded(); const input = await command(base.data.decisionRequests![0]); const old = structuredClone(base)
    await expect(dismissSemanticDecision(base, { ...input, expectedRequestUpdatedAt: '2020-01-01T00:00:00Z' })).rejects.toThrow(/changed/)
    await expect(dismissSemanticDecision(base, { ...input, expectedFingerprint: input.expectedFingerprint.slice(0, 16) })).rejects.toThrow(/fingerprint/)
    const changed = structuredClone(base); changed.data.decisionRequests![0].question += ' Updated.'
    await expect(dismissSemanticDecision(changed, input)).rejects.toThrow(/changed/)
    expect(base).toEqual(old)
  })
  it.each(['answered', 'auto_resolved', 'superseded'] as const)('refuses %s requests', async state => {
    const base = seeded(); const request = base.data.decisionRequests![0]; request.state = state
    await expect(dismissSemanticDecision(base, await command(request))).rejects.toThrow(/Only open or expired/)
  })
  it('rejects command reuse with changed reason, target or evidence', async () => {
    const base = seeded(); const input = await command(base.data.decisionRequests![0]); const result = await dismissSemanticDecision(base, input, now)
    await expect(dismissSemanticDecision(result.snapshot, { ...input, reason: 'Different' })).rejects.toThrow(/reused/)
    await expect(dismissSemanticDecision(result.snapshot, { ...input, evidenceRefs: ['synthetic:other'] })).rejects.toThrow(/reused/)
  })
  it('restores the original request and retains audit, but refuses a later edit', async () => {
    const base = seeded(); const result = await dismissSemanticDecision(base, await command(base.data.decisionRequests![0]), now)
    const restored = await applyDecisionDismissalCompensation(result.snapshot, result.compensation!, now)
    expect(restored.data.decisionRequests).toEqual(base.data.decisionRequests)
    expect(restored.data.timeline?.length).toBe((base.data.timeline?.length ?? 0) + 2)
    const changed = structuredClone(result.snapshot); changed.data.decisionRequests![0].question += ' Changed later.'
    await expect(applyDecisionDismissalCompensation(changed, result.compensation!, now)).rejects.toThrow(/changed/)
    await expect(applyDecisionDismissalCompensation(restored, result.compensation!, now)).rejects.toThrow(/changed/)
  })
  it('suppresses exact replay despite changed input and candidate IDs without blanket source suppression', async () => {
    const base = seeded(); const result = await dismissSemanticDecision(base, await command(base.data.decisionRequests![0]), now)
    const replay = observation(); replay.inputId = 'synthetic-replayed-input'; replay.candidates[0].id = 'synthetic-renumbered-candidate'
    expect(dismissedSemanticCandidate(result.snapshot, replay, replay.candidates[0])).toBe(true)
    const same = applySemanticIntake(result.snapshot, replay, { authorized: true, now })
    expect(same.snapshot.data.decisionRequests?.filter(request => request.state === 'open')).toHaveLength(0)
    expect(same.snapshot.data.processEvents).toHaveLength(0)
    for (const change of ['source-version', 'candidate-content', 'source-content'] as const) {
      const updated = observation()
      if (change === 'source-version') updated.source.sourceVersion = 'v2'
      if (change === 'source-content') updated.originalTextFingerprint = 'synthetic-content-v2'
      if (change === 'candidate-content' && updated.candidates[0].kind === 'process_event') updated.candidates[0].dueAt = '2026-10-04T14:00:00+08:00'
      expect(dismissedSemanticCandidate(result.snapshot, updated, updated.candidates[0])).toBe(false)
      const next = applySemanticIntake(result.snapshot, updated, { authorized: true, now })
      expect(next.snapshot.data.decisionRequests?.some(request => request.state === 'open')).toBe(true)
      expect(next.snapshot.data.decisionRequests?.find(request => request.id === base.data.decisionRequests![0].id)?.state).toBe('dismissed')
    }
  })
  it('keeps a dismissed duplicate-target fact suppressed after merge without rewriting its evidence', async () => {
    const base = seeded()
    const canonical = base.data.opportunities[0]
    const duplicate = base.data.opportunities[1]
    duplicate.role = canonical.role
    for (const job of base.data.opportunities) job.detail = { discovery: {
      sourceUrl: 'https://careers.example/jobs/synthetic-merge-dismissal', sourceTitle: 'Synthetic posting', rationale: 'Synthetic evidence',
      discoveredAt: now.toISOString(), fitConfidence: 'high', opportunityValueConfidence: 'high',
    } }
    const request = base.data.decisionRequests![0]
    request.payloadBinding.candidate.target = { opportunityId: duplicate.id }
    request.payloadBinding.source.sourceVersion = undefined
    const dismissed = await dismissSemanticDecision(base, await command(request), now)
    const retained = structuredClone(dismissed.snapshot.data.decisionRequests![0])
    const reviewed = await readOpportunityMerge(dismissed.snapshot, canonical.id, duplicate.id)
    const merged = await applyOpportunityMerge(dismissed.snapshot, {
      canonicalOpportunityId: canonical.id, duplicateOpportunityId: duplicate.id,
      expectedFingerprint: reviewed.fingerprint, dependencies: reviewed.dependencies,
      reason: 'Synthetic records describe the same posting.', evidenceRefs: ['https://careers.example/jobs/synthetic-merge-dismissal'],
    }, 'synthetic-merge-dismissed', now)
    const replay = observation()
    replay.inputId = 'synthetic-replay-after-merge'
    replay.source.sourceVersion = undefined
    replay.candidates[0].target = { opportunityId: canonical.id }
    expect(dismissedSemanticCandidate(merged.snapshot, replay, replay.candidates[0])).toBe(true)
    const result = applySemanticIntake(merged.snapshot, replay, { authorized: true, now })
    expect(result.snapshot.data.decisionRequests).toEqual([retained])
    expect(result.snapshot.data.processEvents).toHaveLength(0)
    expect(result.snapshot.data.actions).toHaveLength(0)
    // References are meaningful version evidence even when sourceVersion is absent.
    replay.candidates[0].sourceVersionRefs = ['synthetic:v2']
    expect(dismissedSemanticCandidate(merged.snapshot, replay, replay.candidates[0])).toBe(false)
    const fresh = applySemanticIntake(merged.snapshot, replay, { authorized: true, now })
    expect(fresh.snapshot.data.processEvents).toHaveLength(1)
    expect(fresh.snapshot.data.processEvents[0].opportunityId).toBe(canonical.id)
    expect(fresh.snapshot.data.decisionRequests?.find(item => item.id === retained.id)).toEqual(retained)
  })

})
