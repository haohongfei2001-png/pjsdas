import { applyOpportunityMerge, readOpportunityMerge } from '../src/opportunityMerge.js'
import { describe, expect, it, vi } from 'vitest'
import { gmailReconciliationStateForRecord, gmailSemanticRecordFromMessage, runGmailReconciliationForBinding } from '../gateway/gmailAutomation.js'
import { dismissSemanticDecision, decisionRequestFingerprint } from '../src/decisionDismissal.js'
import { applyGmailSemanticBatch, type GmailSemanticRecord } from '../src/gmailSemanticIntake.js'
import { reconcileIngestionDebt } from '../src/ingestionResolution.js'
import { summarizeCoverage } from '../src/ingestion.js'
import { createSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'
import { opportunity } from '../e2e/fixtures/todayWorkspace.js'
const source = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }))
vi.mock('../gateway/driveWorkspaceSource.js', () => ({ createDriveWorkspaceSource: () => source }))
vi.mock('../gateway/transactionalWorkspaceSource.js', () => ({ createTransactionalWorkspaceSource: () => source }))
vi.mock('../gateway/tokenCrypto.js', () => ({ decryptSecret: async () => 'synthetic-refresh' }))
vi.mock('../gateway/googleOAuthTokens.js', () => ({ refreshGoogleAccessToken: async () => 'synthetic-access' }))
const now = new Date('2026-10-05T00:00:00Z')
const later = new Date('2026-10-05T01:00:00Z')
function message(two = false) {
  const body = '甲星公司 请于2026年10月8日14:00参加面试' + (two ? '；甲星公司 请于2026年10月9日14:00参加笔试' : '')
  return { id: 'synthetic-dismissal-source', threadId: 'synthetic-thread', internalDate: String(now.getTime()),
    payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: '招聘进展' }], body: { data: Buffer.from(body).toString('base64url') } } }
}
function record(two = false) { return gmailSemanticRecordFromMessage(message(two), base().data.opportunities, now)! }
function base() { return createSnapshot({ opportunities: [opportunity('synthetic-a', '甲星公司', '产品经理'), opportunity('synthetic-b', '甲星公司', '客户经理')], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [] }) }
function apply(snapshot: PJSDASSnapshot, item: GmailSemanticRecord, runId = 'synthetic-first', reconcileExisting = false) {
  return applyGmailSemanticBatch(snapshot, { runId, sourceId: 'gmail:primary', checkedAt: (reconcileExisting ? later : now).toISOString(), authorized: true, records: [item], reconcileExisting })
}
async function dismiss(snapshot: PJSDASSnapshot, index = 0) {
  const request = snapshot.data.decisionRequests![index]
  return (await dismissSemanticDecision(snapshot, { kind: 'dismiss_semantic_decision', commandId: `synthetic-dismiss-${index}`, requestId: request.id,
    expectedRequestUpdatedAt: request.updatedAt, expectedFingerprint: await decisionRequestFingerprint(request), reason: 'Synthetic source does not assert this fact.', evidenceRefs: ['synthetic:review'] }, later)).snapshot
}
function reconciliation(item: GmailSemanticRecord) {
  const next = structuredClone(item)
  next.observation.inputId = 'synthetic-reconciliation'
  next.observation.source.sourceVersion = 'reconciliation-v1'
  next.observation.candidates.forEach(candidate => { candidate.sourceVersionRefs = [`${next.observation.source.sourceRecordId}:reconciliation-v1`] })
  return next
}

describe('dismissed Gmail ambiguity consumption', () => {
  it('settles coverage after explicit dismissal and same-version Gmail replay', async () => {
    const item = record(); const first = apply(base(), item)
    expect(first.run.outcomes).toEqual({ unresolved: 1 })
    const dismissed = await dismiss(first.snapshot)
    const resolved = reconcileIngestionDebt(dismissed, later)
    expect(resolved.appended.at(-1)?.ingestionResolution).toMatchObject({ outcome: 'ignored', reason: 'semantic_decision_settled' })
    expect(summarizeCoverage(resolved.snapshot.data.timeline, { now: later }).activeUnresolvedCount).toBe(0)
    const replay = apply(dismissed, item, 'synthetic-replay', true)
    expect(replay.run.outcomes.unresolved ?? 0).toBe(0)
    expect(summarizeCoverage(replay.snapshot.data.timeline, { now: later }).activeUnresolvedCount).toBe(0)
    expect(gmailReconciliationStateForRecord(item, replay.snapshot)).toBe('NO_ACTION')
  })
  it('recognizes unchanged bytes across ordinary intake and reconciliation parser tags', async () => {
    const item = record(); const first = apply(base(), item)
    const dismissed = await dismiss(first.snapshot)
    const replay = apply(dismissed, reconciliation(item), 'synthetic-parser-replay', true)
    expect(replay.run.outcomes.unresolved ?? 0).toBe(0)
    expect(replay.snapshot.data.decisionRequests?.filter(request => request.state === 'open')).toHaveLength(0)
    expect(replay.snapshot.data.processEvents).toHaveLength(0)
    expect(summarizeCoverage(replay.snapshot.data.timeline, { now: later }).activeUnresolvedCount).toBe(0)
    expect(gmailReconciliationStateForRecord(reconciliation(item), replay.snapshot)).toBe('NO_ACTION')
  })
  it('keeps a mixed source with an independent open choice unresolved', async () => {
    const item = record(true); const first = apply(base(), item)
    expect(first.snapshot.data.decisionRequests).toHaveLength(2)
    const dismissed = await dismiss(first.snapshot)
    expect(reconcileIngestionDebt(dismissed, later).appended.at(-1)?.ingestionResolution?.outcome).toBe('active_unresolved')
    const replay = apply(dismissed, reconciliation(item), 'synthetic-mixed-replay', true)
    expect(replay.run.outcomes.unresolved).toBe(1)
    expect(gmailReconciliationStateForRecord(reconciliation(item), replay.snapshot)).toBe('UNRESOLVED')
  })
  it.each(['business_ambiguity', 'interpretation_failure', 'transport_gap'] as const)('does not erase an independent %s gap', async issue => {
    const item = record(); item.gaps = ['Synthetic independent source gap.']; item.issueKinds = [issue]
    // Interpretation failures block initial candidates, so seed the question from a complete read first.
    const first = await dismiss(apply(base(), record()).snapshot)
    const dismissed = apply(first, item, 'synthetic-gap', true).snapshot
    expect(reconcileIngestionDebt(dismissed, later).appended.at(-1)?.ingestionResolution?.outcome).toBe('active_unresolved')
    const replay = apply(dismissed, reconciliation(item), 'synthetic-gap-replay', true)
    expect(replay.run.outcomes.unresolved).toBe(1)
    expect(gmailReconciliationStateForRecord(reconciliation(item), replay.snapshot)).toBe('UNRESOLVED')
  })
  it('preserves independently committed facts while settling the dismissed question', async () => {
    const item = record(true)
    item.observation.candidates[1].target = { opportunityId: 'synthetic-a' }
    item.observation.candidates[1].objectConfidence = 'high'
    const first = apply(base(), item)
    expect(first.snapshot.data.processEvents).toHaveLength(1)
    const dismissed = await dismiss(first.snapshot)
    expect(reconcileIngestionDebt(dismissed, later).appended.at(-1)?.ingestionResolution).toMatchObject({ outcome: 'resolved', reason: 'semantic_receipt_committed' })
    const replay = apply(dismissed, item, 'synthetic-independent-fact', true)
    expect(replay.run.outcomes.unresolved ?? 0).toBe(0)
    expect(replay.snapshot.data.processEvents).toEqual(first.snapshot.data.processEvents)
    expect(gmailReconciliationStateForRecord(item, replay.snapshot)).toBe('ACTION_REQUIRED')
  })
  it('settles a mixed dismissed question and committed fact whose receipt retains a merged alias', async () => {
    const initial = base()
    const posting = 'https://careers.example/jobs/synthetic-mixed-alias'
    for (const job of initial.data.opportunities) job.detail = { discovery: {
      sourceUrl: posting, sourceTitle: 'Synthetic posting', rationale: 'Synthetic evidence', discoveredAt: now.toISOString(),
      fitConfidence: 'high', opportunityValueConfidence: 'high',
    } }
    const item = record(true)
    item.observation.candidates[1].target = { opportunityId: 'synthetic-b' }
    item.observation.candidates[1].objectConfidence = 'high'
    const first = apply(initial, item)
    expect(first.snapshot.data.processEvents).toHaveLength(1)
    const dismissed = await dismiss(first.snapshot)
    // Model an explicitly reconciled duplicate profile before the bounded merge.
    dismissed.data.opportunities[0] = { ...structuredClone(dismissed.data.opportunities[1]), id: 'synthetic-a' }
    const reviewed = await readOpportunityMerge(dismissed, 'synthetic-a', 'synthetic-b')
    const merged = await applyOpportunityMerge(dismissed, { canonicalOpportunityId: 'synthetic-a', duplicateOpportunityId: 'synthetic-b',
      expectedFingerprint: reviewed.fingerprint, dependencies: reviewed.dependencies, reason: 'Synthetic exact duplicate.', evidenceRefs: [posting] }, 'synthetic-settlement-merge', later)
    const receipts = structuredClone(merged.snapshot.data.semanticReceipts)
    expect(receipts?.some(receipt => receipt.factKeys?.some(key => key.includes('opp:synthetic-b|')))).toBe(true)
    const current = structuredClone(item)
    current.observation.candidates[1].target = { opportunityId: 'synthetic-a' }
    const replay = apply(merged.snapshot, current, 'synthetic-merged-settlement', true)
    expect(replay.run.outcomes.unresolved ?? 0).toBe(0)
    expect(replay.snapshot.data.processEvents).toEqual(merged.snapshot.data.processEvents)
    expect(replay.snapshot.data.semanticReceipts).toEqual(receipts)
    expect(summarizeCoverage(replay.snapshot.data.timeline, { now: later }).activeUnresolvedCount).toBe(0)
    expect(gmailReconciliationStateForRecord(current, replay.snapshot)).toBe('ACTION_REQUIRED')
  })
  it('settles a legacy request using only its original matching ledger fingerprint', async () => {
    const item = record(); const first = apply(base(), item)
    delete first.snapshot.data.decisionRequests![0].payloadBinding.originalTextFingerprint
    const dismissed = await dismiss(first.snapshot)
    expect(reconcileIngestionDebt(dismissed, later).appended.at(-1)?.ingestionResolution?.outcome).toBe('ignored')
    const replay = apply(dismissed, reconciliation(item), 'synthetic-legacy-replay', true)
    expect(replay.run.outcomes.unresolved ?? 0).toBe(0)
    expect(replay.snapshot.data.decisionRequests?.filter(request => request.state === 'open')).toHaveLength(0)
    const changed = reconciliation(item); changed.observation.originalTextFingerprint = 'synthetic-changed-bytes'
    expect(apply(dismissed, changed, 'synthetic-legacy-changed', true).run.outcomes.unresolved).toBe(1)
  })
  it.each(['missing', 'conflicting'] as const)('does not settle legacy content with %s creation-ledger proof', async kind => {
    const item = record(); const first = apply(base(), item)
    delete first.snapshot.data.decisionRequests![0].payloadBinding.originalTextFingerprint
    const dismissed = await dismiss(first.snapshot)
    const entry = dismissed.data.timeline!.find(row => row.ingestion)!
    if (kind === 'missing') entry.ingestion!.accountedAt = '2026-10-04T00:00:00Z'
    else dismissed.data.timeline!.push({ ...structuredClone(entry), id: 'synthetic-conflicting-proof', ingestion: { ...entry.ingestion!, fingerprint: 'synthetic-conflicting-bytes' } })
    const changed = structuredClone(item); changed.observation.originalTextFingerprint = 'synthetic-changed-bytes'
    const replay = apply(dismissed, changed, 'synthetic-no-legacy-proof', true)
    expect(replay.run.outcomes.unresolved).toBe(1)
    expect(gmailReconciliationStateForRecord(changed, replay.snapshot)).toBe('UNRESOLVED')
    expect(reconcileIngestionDebt(dismissed, later).appended.at(-1)?.ingestionResolution?.outcome).toBe('active_unresolved')
  })
  it.each(['interpretation_failure', 'transport_gap'] as const)('preserves an issueKinds-only %s with an empty gaps list', async issue => {
    const item = record(); const dismissed = await dismiss(apply(base(), item).snapshot)
    const changed = reconciliation(item); changed.issueKinds = [issue]; changed.gaps = []
    const replay = apply(dismissed, changed, 'synthetic-empty-gaps', true)
    expect(replay.run.outcomes.unresolved).toBe(1)
    expect(gmailReconciliationStateForRecord(changed, replay.snapshot)).toBe('UNRESOLVED')
  })
  it('keeps a source active when an older open candidate was omitted by the current parse', async () => {
    const item = record(true); const dismissed = await dismiss(apply(base(), item).snapshot)
    const incomplete = structuredClone(item); incomplete.observation.candidates = incomplete.observation.candidates.slice(0, 1)
    expect(gmailReconciliationStateForRecord(incomplete, dismissed)).toBe('UNRESOLVED')
    const replay = apply(dismissed, incomplete, 'synthetic-omitted-open-candidate', true)
    expect(replay.run.outcomes.unresolved).toBe(1)
    expect(gmailReconciliationStateForRecord(incomplete, replay.snapshot)).toBe('UNRESOLVED')
  })
  it.each(['source-bytes', 'candidate-fact', 'actual-version', 'other-ref'] as const)('keeps changed %s eligible', async change => {
    const item = record(); const dismissed = await dismiss(apply(base(), item).snapshot)
    const changed = reconciliation(item)
    if (change === 'source-bytes') changed.observation.originalTextFingerprint = 'synthetic-new-content'
    if (change === 'actual-version') changed.observation.source.sourceVersion = 'actual-source-v2'
    if (change === 'other-ref') changed.observation.candidates[0].sourceVersionRefs.push('synthetic:independent-v2')
    if (change === 'candidate-fact' && changed.observation.candidates[0].kind === 'process_event') changed.observation.candidates[0].dueAt = '2026-10-10T14:00:00+08:00'
    const replay = apply(dismissed, changed, `synthetic-${change}`, true)
    expect(replay.run.outcomes.unresolved).toBe(1)
    expect(replay.snapshot.data.decisionRequests?.some(request => request.state === 'open')).toBe(true)
  })
  it.each(['missing', 'foreign'] as const)('does not settle a receipt with %s decision links', async kind => {
    const item = record(); const dismissed = await dismiss(apply(base(), item).snapshot)
    const request = dismissed.data.decisionRequests![0]
    if (kind === 'missing') dismissed.data.semanticReceipts![0].decisionRequestIds.push('synthetic-missing-request')
    else request.payloadBinding.source.sourceRecordId = 'synthetic-foreign-source'
    expect(reconcileIngestionDebt(dismissed, later).appended.at(-1)?.ingestionResolution?.outcome).toBe('active_unresolved')
    expect(apply(dismissed, item, 'synthetic-invalid-links', true).run.outcomes.unresolved).toBe(1)
  })
  it.each([false, true])('publishes matching final reconciliation proof and coverage for mixed=%s', async mixed => {
    const dismissed = await dismiss(apply(base(), record(mixed)).snapshot)
    source.read.mockResolvedValue({ snapshot: dismissed, context: { workspaceVersion: 'synthetic-v1', timezone: 'Asia/Shanghai' } })
    let persisted: PJSDASSnapshot | undefined
    source.write.mockImplementation(async input => { persisted = input.snapshot; return { snapshot: input.snapshot, context: { workspaceVersion: 'synthetic-v2' } } })
    const fetchImpl: typeof fetch = async input => {
      const url = new URL(String(input))
      const payload = url.pathname.endsWith('/messages') ? { messages: [{ id: 'synthetic-dismissal-source' }] }
        : url.pathname.endsWith('/messages/synthetic-dismissal-source') ? message(mixed) : undefined
      if (!payload) throw new Error(`Unexpected synthetic fetch: ${url.pathname}`)
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const result = await runGmailReconciliationForBinding({
      binding: { userId: 'synthetic-user', googleSubject: 'synthetic-subject', refreshTokenCiphertext: 'synthetic-cipher',
        grantedScopes: ['https://www.googleapis.com/auth/gmail.readonly'], gmailPendingMessageIds: [], gmailIntakeConsentVersion: 'uu06-v1' },
      tokenEncryptionKey: 'synthetic-key', googleClientId: 'synthetic-client', googleClientSecret: 'synthetic-client-value',
      forceStart: true, now: () => later, fetchImpl,
    })
    expect(result.cycleComplete).toBe(true)
    expect(result.summary.unresolvedCount).toBe(mixed ? 1 : 0)
    expect(result.summary.stateCounts.NO_ACTION).toBe(mixed ? 0 : 1)
    expect(result.summary.actionableCount).toBe(0)
    expect(result.summary.fixedOrHardWithin7DaysCount).toBe(mixed ? 1 : 0)
    expect(persisted).toBeDefined()
    expect(summarizeCoverage(persisted!.data.timeline, { now: later }).activeUnresolvedCount).toBe(mixed ? 1 : 0)
    expect(persisted!.data.timeline?.find(item => item.gmailReconciliation)?.gmailReconciliation?.stateCounts.UNRESOLVED).toBe(mixed ? 1 : 0)
  })

})
