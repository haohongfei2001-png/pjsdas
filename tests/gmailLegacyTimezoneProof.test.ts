import { describe, expect, it } from 'vitest'
import { gmailSemanticRecordFromMessage, reconciliationRecordVersion } from '../gateway/gmailAutomation.js'
import { reprocessVersion } from '../gateway/gmailFragmentReprocessDryRunHandler.js'
import { applyGmailSemanticBatch, type GmailSemanticRecord } from '../src/gmailSemanticIntake.js'
import { applySemanticCompensation, resolveSemanticDecision } from '../src/semanticIntake.js'
import { createSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'
import { applyUserDomainCommand } from '../src/domainCommands.js'
import { opportunity } from '../e2e/fixtures/todayWorkspace.js'

const now = new Date('2026-09-21T00:00:00Z')
function run(snapshot: PJSDASSnapshot, record: GmailSemanticRecord, runId: string, reconcileExisting = true) {
  return applyGmailSemanticBatch(snapshot, { records: [record], runId, sourceId: 'gmail:primary', checkedAt: now.toISOString(), authorized: true, reconcileExisting })
}
function fixture() {
  const snapshot = createSnapshot({ opportunities: [opportunity('jd', '京东', 'AI产品经理'), opportunity('designer', '京东', '设计师')],
    processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [] })
  const record = gmailSemanticRecordFromMessage({ id: 'legacy-zone', threadId: 'synthetic-thread', internalDate: String(now.getTime()),
    payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: '京东 招聘进展' }],
      body: { data: Buffer.from('京东 面试通知：2026年9月25日14:30').toString('base64url') } } }, snapshot.data.opportunities, now, 'Asia/Shanghai')!
  record.observation.candidates = [{ id: 'legacy-event', kind: 'process_event', eventType: 'interview_invite', target: { company: '京东' },
    dueAt: '2026-09-25T14:30:00+08:00', duePrecision: 'datetime', objectConfidence: 'low', eventConfidence: 'high', temporalConfidence: 'high', evidenceRefs: [], sourceVersionRefs: [] }]
  const first = run(snapshot, record, 'original', false)
  const request = first.snapshot.data.decisionRequests![0]!
  const answered = resolveSemanticDecision(first.snapshot, request.id, 'opportunity:designer', now)
  expect(answered.status).toBe('APPLIED')
  const receiptId = answered.receipt!.id
  return { record, answered, snapshot: answered.snapshot, receiptId }
}
function receipt(f: ReturnType<typeof fixture>) { return f.snapshot.data.semanticReceipts!.find(item => item.id === f.receiptId)! }
function latestIssue(result: ReturnType<typeof run>) {
  return result.snapshot.data.timeline.filter(item => item.ingestion?.sourceRecordId === 'legacy-zone').at(-1)!.ingestion!.issueKinds ?? []
}
function unchanged(result: ReturnType<typeof run>, before: PJSDASSnapshot) {
  expect(result.snapshot.data.processEvents).toEqual(before.data.processEvents)
  expect(result.snapshot.data.scheduleNodes).toEqual(before.data.scheduleNodes)
}

describe('legacy decision timing uses exact historical source proof, not offset guesses', () => {
  it.each([['same-version', (r: GmailSemanticRecord) => r], ['reconciliation', reconciliationRecordVersion], ['fragment', reprocessVersion]] as const)('%s preserves the original source zone', (_name, version) => {
    const f = fixture(), result = run(f.snapshot, version(f.record), 'same-zone')
    unchanged(result, f.snapshot)
    expect(latestIssue(result)).not.toContain('interpretation_failure')
  })
  it.each([reconciliationRecordVersion, reprocessVersion])('rejects a changed workspace zone across a parser version', version => {
    const f = fixture(), record = version(structuredClone(f.record))
    record.observation.source.timezone = 'UTC'
    const candidate = record.observation.candidates[0]!
    if (candidate.kind !== 'process_event') throw new Error('fixture')
    candidate.dueAt = '2026-09-25T14:30:00+00:00'
    const result = run(f.snapshot, record, 'changed-zone')
    unchanged(result, f.snapshot)
    expect(latestIssue(result)).toContain('interpretation_failure')
    expect(result.run.outcomes.unresolved).toBe(1)
  })
  it.each(['missing request', 'source id', 'source version', 'choice', 'due time', 'fingerprint', 'empty refs', 'wrong command', 'wrong input', 'missing original refs'] as const)('does not borrow proof after %s changes', mutation => {
    const f = fixture(), r = receipt(f), request = f.snapshot.data.decisionRequests![0]!
    if (mutation === 'missing request') f.snapshot.data.decisionRequests = []
    if (mutation === 'source id') request.payloadBinding.source.sourceRecordId = 'other-message'
    if (mutation === 'source version') request.payloadBinding.source.sourceVersion = 'other-version'
    if (mutation === 'choice') request.answerChoiceId = 'opportunity:jd'
    if (mutation === 'due time' && request.payloadBinding.candidate.kind === 'process_event') request.payloadBinding.candidate.dueAt = '2026-09-25T15:30:00+08:00'
    if (mutation === 'fingerprint') request.payloadBinding.originalTextFingerprint = 'different-text'
    if (mutation === 'empty refs') r.factMutationObjects = { [r.factKeys![0]!]: [] }
    if (mutation === 'wrong command') r.commandId = 'unrelated-command'
    if (mutation === 'wrong input') r.inputId = 'unrelated-input'
    if (mutation === 'missing original refs') r.factMutationObjects = { [r.factKeys![0]!]: r.factMutationObjects![r.factKeys![0]!]!.map(ref => ({ ...ref, id: 'missing-original-object' })) }
    const result = run(f.snapshot, reconciliationRecordVersion(f.record), `negative:${mutation}`)
    unchanged(result, f.snapshot)
    expect(latestIssue(result)).toContain('interpretation_failure')
  })
  it.each([false, true])('uses the old node, never a newer reschedule, when historical proof missing=%s', missing => {
    const f = fixture(), original = f.snapshot.data.scheduleNodes![0]!
    const changed = applyUserDomainCommand(f.snapshot, { commandId: 'later-arrangement', kind: 'reschedule_occurrence', occurrenceId: original.occurrenceId,
      temporal: { shape: 'fixed_range', precision: 'datetime', startAt: '2026-09-26T14:30:00+00:00', timezone: 'UTC', resolutionBasis: 'user_explicit' } }, now).snapshot
    if (missing) changed.data.scheduleNodes = changed.data.scheduleNodes!.filter(item => item.id !== original.id)
    const result = run(changed, reconciliationRecordVersion(f.record), 'historical-proof')
    unchanged(result, changed)
    if (missing) expect(latestIssue(result)).toContain('interpretation_failure')
    else expect(latestIssue(result)).not.toContain('interpretation_failure')
  })
  it.each(['Asia/Shanghai', 'UTC'])('Undo keeps historical proof without claiming the restored open decision is answered: %s', zone => {
    const f = fixture()
    const undone = applySemanticCompensation(f.snapshot, f.answered.compensation!, now)
    expect(undone.data.decisionRequests![0]!.state).toBe('open')
    const record = reconciliationRecordVersion(structuredClone(f.record)); record.observation.source.timezone = zone
    const result = run(undone, record, 'after-undo')
    unchanged(result, undone)
    if (zone === 'Asia/Shanghai') {
      expect(latestIssue(result)).not.toContain('interpretation_failure')
      const repeated = run(result.snapshot, reprocessVersion(record), 'after-undo-again')
      unchanged(repeated, result.snapshot)
      expect(latestIssue(repeated)).not.toContain('interpretation_failure')
    } else expect(latestIssue(result)).toContain('interpretation_failure')
  })
})
