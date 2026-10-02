import { describe, expect, it } from 'vitest'
import { applicationDeadlineFingerprint, classifyJob, resolveApplicationDeadline } from '../src/applicationDeadline.js'
import { applyDomainCompensation, applyUserDomainCommand } from '../src/domainCommands.js'
import { buildOpportunityDecisionList } from '../src/opportunityDecisionRead.js'
import { buildScheduleStream } from '../src/schedule/scheduleStream.js'
import { createSnapshot, upgradeSnapshotToLatest, validateSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'
import type { CorrectApplicationDeadlineCommand } from '../src/deadlineCorrection.js'
import { invokeApplyUserCommand } from '../gateway/userCommands.js'
import { enrichOpportunityListWithFacts } from '../src/ai/richOpportunityRead.js'
import type { WorkspaceWriteInput } from '../gateway/workspaceSource.js'
const now = new Date('2026-10-02T08:00:00Z')
function base(): PJSDASSnapshot { return createSnapshot({ opportunities: [{ id: 'synthetic-legacy', company: '河谷智能', role: '运营分析师', processStage: 'not_applied', currentStageLabel: '待投', participationStatus: 'active', deadline: '2026-09-30T15:59:59Z', deadlinePrecision: 'datetime', roleType: 'core', early: false, opportunityValue: 70, fitScore: 80, importedAt: now.toISOString() }], processes: [], processEvents: [], actions: [{ id: 'legacy-apply-owner', kind: 'apply', title: '申请河谷智能', opportunityId: 'synthetic-legacy', dueAt: '2026-09-30T15:59:59Z', timingMode: 'deadline', estimatedMinutes: 45, leverage: 70, delayCost: 70, status: 'todo', createdAt: now.toISOString(), updatedAt: now.toISOString() }], prep: [], applicationGroups: [] }) }
function command(snapshot = base(), deadline?: string): CorrectApplicationDeadlineCommand { return { commandId: 'synthetic-deadline-correction', kind: 'correct_application_deadline', opportunityId: 'synthetic-legacy', expectedDeadlineFingerprint: applicationDeadlineFingerprint(snapshot.data.opportunities[0], snapshot.data), correction: { state: deadline ? 'confirmed' : 'unknown', deadline, precision: deadline ? 'date' : undefined, sourceUrl: 'https://careers.example.test/roles/analyst', sourceAuthority: 'official_role', evidence: deadline ? 'Official role page publishes the application deadline.' : 'Official current role page is open and does not publish an application deadline.', checkedAt: now.toISOString(), postingStatus: 'open' } } }

describe('canonical application deadline corrections', () => {
  it('clears all current deadline owners and survives normalization without losing original evidence or fabricating a node', () => {
    const before = base(); const oldNodes = structuredClone(before.data.scheduleNodes)
    const result = applyUserDomainCommand(before, command(before), now)
    const next = upgradeSnapshotToLatest(JSON.parse(JSON.stringify(result.snapshot)))
    expect(next.data.opportunities[0].deadline).toBeUndefined()
    expect(next.data.actions[0].dueAt).toBeUndefined()
    expect(next.data.scheduleNodes).toHaveLength(2)
    expect(next.data.scheduleNodes![0].temporal).toEqual(oldNodes![0].temporal)
    expect(next.data.scheduleNodes![0].state).toBe('superseded')
    expect(next.data.scheduleNodes![1].state).toBe('cancelled')
    expect(resolveApplicationDeadline(next.data.opportunities[0], next.data)).toMatchObject({ state: 'unknown', source: 'correction', postingStatus: 'open' })
    expect(classifyJob(next.data.opportunities[0], next.data, now, 'Asia/Shanghai')).toBe('no_deadline')
    const jobs = buildOpportunityDecisionList(next, { now, timezone: 'Asia/Shanghai' })
    const schedule = buildScheduleStream(next, { accountKey: 'synthetic', workspaceRevision: '1', now, timezone: 'Asia/Shanghai' })
    expect(jobs.all[0].category).toBe('no_deadline')
    expect(schedule.sections.no_deadline.map(item => item.opportunityId)).toEqual(['synthetic-legacy'])
    expect(schedule.sections.no_deadline[0].node).toBeUndefined()
    expect(schedule.sections.upcoming).toHaveLength(0)
    expect(next.data.reminderIntents).toHaveLength(0)
    expect(applyUserDomainCommand(next, command(before), now).status).toBe('ALREADY_APPLIED')
    expect(before.data.scheduleNodes).toEqual(oldNodes)
    validateSnapshot(next)
  })
  it('sets a source-backed date-only deadline across legacy action and canonical node without an invented hour', () => {
    const next = applyUserDomainCommand(base(), command(base(), '2026-10-08'), now).snapshot
    expect(next.data.opportunities[0].deadline).toBe('2026-10-08')
    expect(next.data.actions[0].dueAt).toBe('2026-10-08')
    expect(next.data.scheduleNodes!.at(-1)?.temporal).toEqual({ shape: 'date_only', precision: 'date', timezone: 'floating-date', date: '2026-10-08', resolutionBasis: 'source_explicit' })
    expect(classifyJob(next.data.opportunities[0], next.data, new Date('2026-10-08T15:59:59Z'), 'Asia/Shanghai')).toBe('to_apply')
    expect(classifyJob(next.data.opportunities[0], next.data, new Date('2026-10-08T16:00:00Z'), 'Asia/Shanghai')).toBe('deadline_passed')
  })
  it('attributes the resolved date to its actual correction owner and permits documented fallback sources', () => {
    const input = command(base(), '2026-10-08')
    const fallback = applyUserDomainCommand(base(), { ...input, correction: { ...input.correction, sourceAuthority: 'aggregator', postingStatus: 'unknown' } }, now).snapshot
    expect(resolveApplicationDeadline(fallback.data.opportunities[0], fallback.data)).toMatchObject({ sourceUrl: input.correction.sourceUrl, sourceAuthority: 'aggregator' })
    const explicit = applyUserDomainCommand(fallback, { commandId: 'synthetic-real-user-provenance', kind: 'set_deadline', opportunityId: 'synthetic-legacy', deadline: '2026-10-11', precision: 'date' }, now).snapshot
    expect(resolveApplicationDeadline(explicit.data.opportunities[0], explicit.data)).toMatchObject({ source: 'user', sourceAuthority: 'user' })
    expect(resolveApplicationDeadline(explicit.data.opportunities[0], explicit.data).sourceUrl).toBeUndefined()
  })
  it('allows stronger evidence to replace a fallback correction without treating its node as official evidence', () => {
    const input = command(base(), '2026-10-08')
    const fallback = applyUserDomainCommand(base(), { ...input, correction: { ...input.correction, sourceAuthority: 'aggregator' } }, now).snapshot
    const edit = applyUserDomainCommand(fallback, { commandId: 'synthetic-fallback-manual', kind: 'set_deadline', opportunityId: 'synthetic-legacy', deadline: '2026-10-11', precision: 'date' }, now)
    if (edit.status !== 'APPLIED' || !edit.compensation) throw new Error('Missing compensation')
    const restored = applyDomainCompensation(edit.snapshot, edit.compensation, now)
    const stronger = command(restored, '2026-10-09')
    const upgraded = applyUserDomainCommand(restored, { ...stronger, commandId: 'synthetic-stronger-source', correction: { ...stronger.correction, sourceAuthority: 'university_repost' } }, now).snapshot
    expect(resolveApplicationDeadline(upgraded.data.opportunities[0], upgraded.data)).toMatchObject({ deadline: '2026-10-09', sourceAuthority: 'university_repost' })
  })
  it('refuses old deadline undo after an independent identical-date edit even at the same timestamp', () => {
    const input = { commandId: 'synthetic-first-date', kind: 'set_deadline' as const, opportunityId: 'synthetic-legacy', deadline: '2026-10-11', precision: 'date' as const }
    const first = applyUserDomainCommand(base(), input, now)
    if (first.status !== 'APPLIED' || !first.compensation) throw new Error('Missing compensation')
    const later = applyUserDomainCommand(first.snapshot, { ...input, commandId: 'synthetic-independent-date' }, now).snapshot
    const before = JSON.stringify(later)
    expect(() => applyDomainCompensation(later, first.compensation!, now)).toThrow(/changed/)
    expect(JSON.stringify(later)).toBe(before)
  })
  it('withdraws reminders on every superseded version of the corrected application occurrence', () => {
    const reminded = applyUserDomainCommand(base(), { commandId: 'synthetic-old-version-reminder', kind: 'upsert_reminder_intent', scheduleNodeId: base().data.scheduleNodes![0].id, purpose: 'deadline', triggerAt: '2026-09-29T10:00:00Z', deliveryOwner: 'external_calendar', channel: 'calendar', capabilityStates: { google_calendar: 'available' } }, now).snapshot
    const edited = applyUserDomainCommand(reminded, { commandId: 'synthetic-rescheduled-date', kind: 'set_deadline', opportunityId: 'synthetic-legacy', deadline: '2026-10-11', precision: 'date' }, now).snapshot
    const next = applyUserDomainCommand(edited, command(edited), now).snapshot
    expect(next.data.reminderIntents![0].state).toBe('cancelled')
    expect(next.data.reminderOutbox).toHaveLength(1)
    expect(next.data.reminderOutbox![0]).toMatchObject({ operation: 'cancel', state: 'pending' })
  })
  it('honors an explicit source calendar timezone rather than the workspace timezone', () => {
    const next = applyUserDomainCommand(base(), command(base(), '2026-10-08'), now).snapshot
    const latest = next.data.scheduleNodes!.at(-1)!
    latest.temporal.timezone = 'Asia/Tokyo'
    expect(classifyJob(next.data.opportunities[0], next.data, new Date('2026-10-08T15:30:00Z'), 'Asia/Shanghai')).toBe('deadline_passed')
  })
  it('an explicit later user deadline can replace an unknown correction', () => {
    const cleared = applyUserDomainCommand(base(), command(), now).snapshot
    const later = applyUserDomainCommand(cleared, { commandId: 'synthetic-new-user-date', kind: 'set_deadline', opportunityId: 'synthetic-legacy', deadline: '2026-10-11', precision: 'date' }, now).snapshot
    expect(resolveApplicationDeadline(later.data.opportunities[0], later.data).deadline).toBe('2026-10-11')
    expect(later.data.actions[0].dueAt).toBe('2026-10-11')
  })
  it('keeps a correction, later user edit, undo, and canonical reschedule on the same deadline authority', () => {
    const corrected = applyUserDomainCommand(base(), command(base(), '2026-10-08'), now).snapshot
    const edited = applyUserDomainCommand(corrected, { commandId: 'synthetic-later-deadline', kind: 'set_deadline', opportunityId: 'synthetic-legacy', deadline: '2026-10-11', precision: 'date' }, now)
    if (edited.status !== 'APPLIED' || !edited.compensation) throw new Error('Missing compensation')
    const undone = applyDomainCompensation(edited.snapshot, edited.compensation, now)
    expect(resolveApplicationDeadline(undone.data.opportunities[0], undone.data)).toMatchObject({ deadline: '2026-10-08', source: 'correction', sourceUrl: command().correction.sourceUrl, sourceAuthority: 'official_role', checkedAt: now.toISOString() })
    expect(resolveApplicationDeadline(undone.data.opportunities[0], undone.data).evidenceRefs).toEqual(resolveApplicationDeadline(corrected.data.opportunities[0], corrected.data).evidenceRefs)
    expect(undone.data.opportunities[0].deadline).toBe('2026-10-08')
    const moved = applyUserDomainCommand(corrected, { commandId: 'synthetic-reschedule', kind: 'reschedule_occurrence', occurrenceId: 'application-deadline:synthetic-legacy', temporal: { shape: 'date_only', precision: 'date', timezone: 'floating-date', date: '2026-10-12', resolutionBasis: 'user_explicit' } }, now).snapshot
    expect(resolveApplicationDeadline(moved.data.opportunities[0], moved.data).deadline).toBe('2026-10-12')
    expect(moved.data.opportunities[0].deadline).toBe('2026-10-12')
    expect(moved.data.actions[0].dueAt).toBe('2026-10-12')
  })
  it('does not let a weaker new correction erase pre-existing explicit ownership', () => {
    const explicit = applyUserDomainCommand(base(), { commandId: 'synthetic-old-user-deadline', kind: 'set_deadline', opportunityId: 'synthetic-legacy', deadline: '2026-10-11', precision: 'date' }, now).snapshot
    const input = command(explicit)
    expect(() => applyUserDomainCommand(explicit, { ...input, correction: { ...input.correction, sourceAuthority: 'university_repost' } }, now)).toThrow(/Weaker evidence/)
    expect(() => applyUserDomainCommand(explicit, { ...input, correction: { ...input.correction, sourceAuthority: 'aggregator', postingStatus: 'unknown' } }, now)).toThrow(/Weaker evidence/)
  })
  it('a source correction cannot be overwritten by undoing an older manual deadline', () => {
    const original = applyUserDomainCommand(base(), { commandId: 'synthetic-prior-manual', kind: 'set_deadline', opportunityId: 'synthetic-legacy', deadline: '2026-10-05', precision: 'date' }, now)
    if (original.status !== 'APPLIED' || !original.compensation) throw new Error('Missing compensation')
    const corrected = applyUserDomainCommand(original.snapshot, command(original.snapshot), now).snapshot
    expect(() => applyDomainCompensation(corrected, original.compensation!, now)).toThrow(/newer correction/)
  })
  it('deadline withdrawal retires a pending external reminder through the same canonical cancellation outbox', () => {
    const snapshot = applyUserDomainCommand(base(), { commandId: 'synthetic-existing-reminder', kind: 'upsert_reminder_intent', scheduleNodeId: base().data.scheduleNodes![0].id, purpose: 'deadline', triggerAt: '2026-09-29T10:00:00Z', deliveryOwner: 'external_calendar', channel: 'calendar', capabilityStates: { google_calendar: 'available' } }, now).snapshot
    const next = applyUserDomainCommand(snapshot, command(snapshot), now).snapshot
    expect(next.data.reminderIntents![0].state).toBe('cancelled')
    expect(next.data.reminderOutbox).toHaveLength(1)
    expect(next.data.reminderOutbox![0]).toMatchObject({ operation: 'cancel', state: 'pending' })
  })
  it('unknown source availability cannot silently reopen an earlier confirmed closed posting', () => {
    const input = command()
    const closed = applyUserDomainCommand(base(), { ...input, correction: { ...input.correction, postingStatus: 'closed' } }, now).snapshot
    const unknown = applyUserDomainCommand(closed, { ...command(closed), commandId: 'synthetic-later-unknown', correction: { ...command(closed).correction, postingStatus: 'unknown' } }, now).snapshot
    expect(classifyJob(unknown.data.opportunities[0], unknown.data, now, 'Asia/Shanghai')).toBe('deadline_passed')
    const reopened = applyUserDomainCommand(unknown, { ...command(unknown), commandId: 'synthetic-explicit-reopening' }, now).snapshot
    expect(classifyJob(reopened.data.opportunities[0], reopened.data, now, 'Asia/Shanghai')).toBe('no_deadline')
  })
  it('protects submissions and rejects changed owners with all-store equality', () => {
    const snapshot = base(); const input = command(snapshot)
    snapshot.data.actions[0].dueAt = '2026-10-09'
    expect(() => applyUserDomainCommand(snapshot, input, now)).toThrow(/changed/)
    const applied = base(); applied.data.actions[0].status = 'done'
    const serialized = JSON.stringify(applied)
    expect(() => applyUserDomainCommand(applied, command(applied), now)).toThrow(/unsubmitted/)
    expect(JSON.stringify(applied)).toBe(serialized)
  })
  it('exposes a stable owner token and commits through the exact workspace CAS boundary', async () => {
    let snapshot = base(); const writes: WorkspaceWriteInput[] = []
    const read = enrichOpportunityListWithFacts(snapshot, { opportunities: [{ opportunityId: 'synthetic-legacy' }] }, true)
    const input = { ...command(snapshot), expectedDeadlineFingerprint: read.opportunities[0].deadlineAudit!.fingerprint }
    const result = await invokeApplyUserCommand({ read: async () => ({ snapshot, context: { workspaceVersion: 'txn:5', now } }), write: async value => { writes.push(value); snapshot = value.snapshot; return { snapshot, context: { workspaceVersion: 'txn:6', now } } } }, input)
    expect(result.isError).not.toBe(true)
    expect(writes[0].expectedWorkspaceVersion).toBe('txn:5')
    expect(writes[0].command?.operation).toBe('correct_application_deadline')
    expect(snapshot.data.opportunities).toHaveLength(1)
  })
})

describe('exclusive user-defined job categories', () => {
  it.each([
    ['not_applied', '2026-10-08', 'to_apply'], ['not_applied', '2026-09-20', 'deadline_passed'], ['not_applied', undefined, 'no_deadline'],
    ['screening', '2026-09-20', 'applied'], ['assessment', '2026-09-20', 'applied'], ['written_test', '2026-09-20', 'written_test'],
    ['interview', '2026-09-20', 'interview'], ['offer', '2026-09-20', 'process_ended'], ['unknown', '2026-09-20', undefined],
  ] as const)('%s with %s maps only to %s', (stage, deadline, category) => {
    const snapshot = base(); const job = snapshot.data.opportunities[0]; job.processStage = stage; job.deadline = deadline; job.deadlinePrecision = 'date'; snapshot.data.scheduleNodes = []
    expect(classifyJob(job, snapshot.data, now, 'Asia/Shanghai')).toBe(category)
  })
  it('terminates a submitted process separately from closing an unsubmitted source, preserving abandoned uncertainty', () => {
    const snapshot = base(); const job = snapshot.data.opportunities[0]
    job.processStage = 'closed'; snapshot.data.actions[0].status = 'done'
    expect(classifyJob(job, snapshot.data, now, 'Asia/Shanghai')).toBe('process_ended')
    job.processStage = 'not_applied'; job.participationStatus = 'abandoned'; snapshot.data.actions[0].status = 'todo'
    expect(classifyJob(job, snapshot.data, now, 'Asia/Shanghai')).toBeUndefined()
    const closed = applyUserDomainCommand(base(), { ...command(), correction: { ...command().correction, postingStatus: 'closed' } }, now).snapshot
    expect(classifyJob(closed.data.opportunities[0], closed.data, now, 'Asia/Shanghai')).toBe('deadline_passed')
  })
})
