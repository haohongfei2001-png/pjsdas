import { applySemanticCompensation, applySemanticIntake } from '../src/semanticIntake.js'
import { mergeActionsForReimport } from '../src/reimportState.js'
import { buildWebSemanticInterpretation } from '../src/webSemanticInterpretation.js'
import { describe, expect, it } from 'vitest'
import { action, opportunity, workspace } from '../e2e/fixtures/todayWorkspace.js'
import { applyDomainCompensation, applyUserDomainCommand } from '../src/domainCommands.js'
import { buildScheduleStream } from '../src/schedule/scheduleStream.js'
import { selectTodayWeb } from '../src/today/todayWebSelector.js'
import { upgradeSnapshotToLatest } from '../src/snapshot.js'
import { applicationDeadlineFingerprint, classifyJob, hasApplicationEvidence, indexJobClassificationData, resolveApplicationDeadline } from '../src/applicationDeadline.js'
import { interactionProjection, undoInteractionProjection } from '../src/cloud/interactionProjection.js'
import { applyWorkspaceDelta, diffWorkspaceDelta } from '../src/workspaceDelta.js'
import { formatScheduleTemporal } from '../src/scheduleDisplayTime.js'
import { actionDeadline, latestActionNode } from '../src/deadlineOrder.js'
import { buildTodayBrief } from '../src/todayBrief.js'
import { getTodayPlan } from '../src/ai/readLayer.js'
import { ensureScheduleContractInPlace } from '../src/scheduleNodes.js'
import type { ScheduleNode } from '../src/model.js'

const now = new Date('2026-10-07T02:00:00Z')
const context = { accountKey: 'b1', workspaceRevision: '1', timezone: 'Asia/Shanghai', now }
const empty = () => { const s = workspace(); s.data.opportunities = []; s.data.actions = []; s.data.processes = []; s.data.processEvents = []; s.data.scheduleNodes = []; s.data.timeline = []; return s }
const job = () => { const s = empty(); s.data.opportunities = [{ ...opportunity('job', 'Company', 'Product'), deadline: '2026-10-10', deadlinePrecision: 'date' }]; return s }
const entries = (s: ReturnType<typeof empty>) => Object.values(buildScheduleStream(s, context).sections).flat()
const arrangement = { shape: 'fixed_range' as const, precision: 'datetime' as const, timezone: 'Asia/Shanghai', startAt: '2026-10-08T15:00:00+08:00', resolutionBasis: 'user_explicit' as const }
function applied(s: ReturnType<typeof empty>, command: Parameters<typeof applyUserDomainCommand>[1]) { const r = applyUserDomainCommand(s, command, now); if (r.status !== 'APPLIED') throw new Error(r.status); return r }

describe('B1 job, task and calendar ownership', () => {
  it.each(['semantic', 'instant'] as const)('withdraws only active submission proof after %s Undo while retaining audit and reload classification', path => {
    const before = job()
    let submitted: ReturnType<typeof job>, undone: ReturnType<typeof job>
    if (path === 'semantic') {
      const result = applySemanticIntake(before, { contractVersion: 1, inputId: 'undo-submission',
        source: { kind: 'mcp', sourceId: 'source', sourceRecordId: 'record', observedAt: now.toISOString(), timezone: 'Asia/Shanghai' }, statementMode: 'assertion',
        candidates: [{ id: 'submit', kind: 'application_submitted', target: { opportunityId: 'job' }, occurredAt: '2026-10-02T08:00:00Z',
          objectConfidence: 'high', eventConfidence: 'high', evidenceRefs: [], sourceVersionRefs: [] }] }, { authorized: true, now })
      submitted = result.snapshot
      undone = applySemanticCompensation(submitted, result.compensation!, now)
    } else {
      const command = { commandId: 'instant-submission-proof', kind: 'record_application_submission' as const, opportunityId: 'job' }
      const projected = interactionProjection(before, command, 1, now)
      submitted = applyWorkspaceDelta(before, projected.delta)
      undone = applyWorkspaceDelta(submitted, undoInteractionProjection(submitted, command, projected.compensation, projected.delta, 2, now))
    }
    const original = submitted.data.timeline!.find(record => record.kind === 'application_submitted')!
    expect(original.commandId).toBeTruthy()
    for (const snapshot of [undone, upgradeSnapshotToLatest(JSON.parse(JSON.stringify(undone)))]) {
      const target = snapshot.data.opportunities[0]
      expect(snapshot.data.timeline!.find(record => record.id === original.id)).toEqual(original)
      expect(target.applicationSubmissionProofs?.[original.commandId!]).toBe('withdrawn')
      expect(hasApplicationEvidence(target, snapshot.data)).toBe(false)
      expect(classifyJob(target, snapshot.data, now, context.timezone)).toBe('to_apply')
      expect(classifyJob(target, indexJobClassificationData(snapshot.data)(target.id), now, context.timezone)).toBe('to_apply')
      expect(snapshot.data.actions).toEqual([])
      expect(entries(snapshot)).toEqual([])
    }
  })
  it('keeps legacy submission facts while full and instant Undo agree on a later command-owned proof', () => {
    const before = job()
    before.data.timeline = applied(job(), { commandId: 'legacy-domain-command', kind: 'record_application_submission',
      opportunityId: 'job', occurredAt: '2026-09-01T08:00:00Z' }).snapshot.data.timeline
    const command = { commandId: 'new-after-legacy', kind: 'record_application_submission' as const, opportunityId: 'job' }
    const full = applied(before, command)
    const fullUndo = applyDomainCompensation(full.snapshot, full.compensation!, now)
    const projection = interactionProjection(before, command, 1, now)
    const local = applyWorkspaceDelta(before, projection.delta)
    const localUndo = applyWorkspaceDelta(local, undoInteractionProjection(local, command, projection.compensation, projection.delta, 2, now))
    expect(localUndo.data).toEqual(fullUndo.data)
    for (const result of [fullUndo, localUndo]) {
      expect(result.data.timeline).toContainEqual(before.data.timeline![0])
      expect(result.data.opportunities[0].applicationSubmissionProofs).toEqual({ 'new-after-legacy': 'withdrawn' })
      expect(hasApplicationEvidence(result.data.opportunities[0], result.data)).toBe(true)
      expect(classifyJob(result.data.opportunities[0], result.data, now, context.timezone))
        .toBe(classifyJob(before.data.opportunities[0], before.data, now, context.timezone))
      expect(entries(result)).toEqual([])
    }
  })
  it('preserves another job and refuses to overwrite a later independent same-job submission or recruiting fact', () => {
    const before = job(); before.data.opportunities.push({ ...before.data.opportunities[0], id: 'job-b', company: 'Other' })
    const first = applied(before, { commandId: 'proof-first', kind: 'record_application_submission', opportunityId: 'job' })
    const other = applied(first.snapshot, { commandId: 'proof-other-job', kind: 'record_application_submission', opportunityId: 'job-b' })
    const undone = applyDomainCompensation(other.snapshot, first.compensation!, now)
    expect(hasApplicationEvidence(undone.data.opportunities[0], undone.data)).toBe(false)
    expect(hasApplicationEvidence(undone.data.opportunities[1], undone.data)).toBe(true)
    expect(undone.data.timeline).toEqual(other.snapshot.data.timeline)
    const second = applied(first.snapshot, { commandId: 'proof-second', kind: 'record_application_submission', opportunityId: 'job' })
    expect(() => applyDomainCompensation(second.snapshot, first.compensation!, now)).toThrow(/later independent/)
    const onlyFirst = applyDomainCompensation(second.snapshot, second.compensation!, now)
    expect(onlyFirst.data.opportunities[0].applicationSubmissionProofs).toEqual({ 'proof-first': 'active', 'proof-second': 'withdrawn' })
    expect(classifyJob(onlyFirst.data.opportunities[0], onlyFirst.data, now, context.timezone)).toBe('applied')
    const none = applyDomainCompensation(onlyFirst, first.compensation!, now)
    expect(classifyJob(none.data.opportunities[0], none.data, now, context.timezone)).toBe('to_apply')
    expect(applyDomainCompensation(none, first.compensation!, new Date('2026-11-01'))).toBe(none)
    const interview = applied(first.snapshot, { commandId: 'later-interview', kind: 'record_process_event', opportunityId: 'job', eventType: 'interview_invite', dueAt: arrangement.startAt, timingMode: 'fixed' })
    expect(() => applyDomainCompensation(interview.snapshot, first.compensation!, now)).toThrow(/later independent/)
    expect(entries(interview.snapshot)).toHaveLength(1)
  })
  it('binds legacy instant Undo to its exact original command proof and refuses an unowned legacy compensation', () => {
    const before = job(), command = { commandId: 'legacy-exact-proof', kind: 'record_application_submission' as const, opportunityId: 'job' }
    const result = applied(before, command)
    delete result.snapshot.data.opportunities[0].applicationSubmissionProofs
    delete result.compensation!.payload.submissionCommandId
    const delta = diffWorkspaceDelta(before, result.snapshot, 1)
    expect(() => applyDomainCompensation(result.snapshot, result.compensation!, now)).toThrow(/exact fact ownership/)
    const undone = applyWorkspaceDelta(result.snapshot, undoInteractionProjection(result.snapshot, command, result.compensation, delta, 2, now))
    expect(hasApplicationEvidence(undone.data.opportunities[0], undone.data)).toBe(false)
    expect(undone.data.timeline).toEqual(result.snapshot.data.timeline)
  })
  it('rejects malformed optional submission ownership instead of silently accepting forged states', () => {
    for (const proof of [[], { '': 'active' }, { forged: 'confirmed' }]) {
      const invalid = job(); invalid.data.opportunities[0].applicationSubmissionProofs = proof as never
      expect(() => upgradeSnapshotToLatest(invalid)).toThrow(/投递事实归属/)
    }
  })
  it.each([['legacy_projection', 'UTC', '23:59'], ['source_explicit', 'America/New_York', '11:59']] as const)('retains %s deadline display provenance without an eligible calendar row', (resolutionBasis, timezone, expected) => {
    const source = job()
    source.data.scheduleNodes = [{ id: 'deadline-zone', occurrenceId: 'deadline-zone', version: 1, opportunityId: 'job', kind: 'application_deadline', state: 'scheduled', constraintKind: 'employer_hard',
      temporal: { shape: 'deadline', precision: 'datetime', deadlineAt: '2026-09-30T15:59:59Z', timezone, resolutionBasis },
      evidenceRefs: [], sourceVersionRefs: [], relatedActionIds: [], relatedPrepIds: [], createdAt: now.toISOString(), updatedAt: now.toISOString() }]
    const fact = resolveApplicationDeadline(source.data.opportunities[0], source.data)
    expect(formatScheduleTemporal({ ...fact, deadlineAt: fact.deadline }, true, 'Asia/Shanghai')).toContain(expected)
    expect(entries(source)).toEqual([])
  })
  it('A02/A03 saves company/title without a URL as a user job only and preserves actual write time', () => {
    const command = { commandId: 'manual-job-1', kind: 'add_user_opportunity' as const, company: 'Example', role: 'Product 2027', deadline: '2026-10-10', deadlinePrecision: 'date' as const }
    const result = applied(empty(), command)
    expect(result.snapshot.data.opportunities).toHaveLength(1)
    expect(result.snapshot.data.opportunities[0]).toMatchObject({ importedAt: now.toISOString(), deadline: '2026-10-10', detail: { userFacts: { provenance: 'user_asserted' } } })
    expect(result.snapshot.data.opportunities[0].roleType).toBeUndefined()
    expect(result.snapshot.data.actions).toHaveLength(0)
    expect(result.snapshot.data.processes).toHaveLength(0)
    expect(result.snapshot.data.scheduleNodes).toHaveLength(0)
    expect(entries(result.snapshot)).toHaveLength(0)
    expect(applyUserDomainCommand(result.snapshot, command, new Date('2026-11-01')).snapshot).toEqual(result.snapshot)
    expect(() => applyUserDomainCommand(result.snapshot, { ...command, role: 'Changed' }, now)).toThrow(/different facts/)
    expect(applyDomainCompensation(result.snapshot, result.compensation!, now).data.opportunities).toHaveLength(0)
  })
  it('A04 repeated add today keeps one intended action and no calendar time', () => {
    const command = { commandId: 'plan-application-1', kind: 'plan_application_action' as const, opportunityId: 'job', plannedDate: '2026-10-07' }
    const result = applied(job(), command)
    expect(result.snapshot.data.actions).toHaveLength(1)
    expect(applyUserDomainCommand(result.snapshot, { ...command, commandId: 'plan-application-2' }, now).status).toBe('ALREADY_APPLIED')
    expect(selectTodayWeb(result.snapshot, {}, context).actions.map(item => item.actionId)).toEqual(['apply:job'])
    expect(result.snapshot.data.scheduleNodes).toHaveLength(0)
    expect(entries(result.snapshot)).toHaveLength(0)
  })
  it('unplanned application intent and ordinary deadlines do not select today', () => {
    const result = applied(job(), { commandId: 'intent-only', kind: 'plan_application_action', opportunityId: 'job' })
    result.snapshot.data.actions.push({ ...action('other', 'Ordinary task'), dueAt: '2026-10-07', duePrecision: 'date' })
    expect(selectTodayWeb(result.snapshot, {}, context).actions).toHaveLength(0)
    expect(entries(result.snapshot)).toHaveLength(0)
  })
  it('A05 one explicit start produces one task/occurrence, not an invented end', () => {
    const result = applied(empty(), { commandId: 'timed-task', kind: 'add_manual_action', title: '准备材料', scheduledTemporal: arrangement, plannedDate: '2026-10-08' })
    expect(result.snapshot.data.actions).toHaveLength(1)
    expect(result.snapshot.data.scheduleNodes).toHaveLength(1)
    expect(entries(result.snapshot)).toHaveLength(1)
    expect(result.snapshot.data.scheduleNodes![0].temporal.endAt).toBeUndefined()
    expect(selectTodayWeb(result.snapshot, {}, context).actions).toHaveLength(0)
    const nextDay = { ...context, now: new Date('2026-10-08T02:00:00Z') }
    expect(selectTodayWeb(result.snapshot, {}, nextDay).actions[0]?.actionId).toBe(result.snapshot.data.actions[0].id)
    expect(upgradeSnapshotToLatest(upgradeSnapshotToLatest(result.snapshot)).data.scheduleNodes).toHaveLength(1)
  })
  it('A06/A07/A08 appointments retain source precision; assessment deadlines are only task obligations', () => {
    const assessment = applied(job(), { commandId: 'assessment-deadline', kind: 'record_process_event', opportunityId: 'job', eventType: 'assessment_invite', dueAt: '2026-10-07', duePrecision: 'date', timingMode: 'deadline' })
    expect(assessment.snapshot.data.processEvents).toHaveLength(1)
    expect(assessment.snapshot.data.actions).toHaveLength(1)
    expect(assessment.snapshot.data.scheduleNodes).toHaveLength(0)
    expect(selectTodayWeb(assessment.snapshot, {}, context).actions).toHaveLength(1)
    const interview = applied(job(), { commandId: 'interview-date', kind: 'record_process_event', opportunityId: 'job', eventType: 'interview_invite', dueAt: '2026-10-08', duePrecision: 'date', timingMode: 'fixed' })
    expect(entries(interview.snapshot)).toHaveLength(1)
    expect(entries(interview.snapshot)[0].date).toBe('2026-10-08')
    expect(interview.snapshot.data.scheduleNodes![0].temporal).toMatchObject({ precision: 'date', date: '2026-10-08' })
    expect(interview.snapshot.data.scheduleNodes![0].temporal.startAt).toBeUndefined()
    const started = applied(job(), { commandId: 'interview-start', kind: 'record_process_event', opportunityId: 'job', eventType: 'interview_invite', dueAt: arrangement.startAt, timingMode: 'fixed' })
    expect(started.snapshot.data.scheduleNodes![0].temporal.endAt).toBeUndefined()
  })
  it('A09 generic completion is not submission; explicit submission remains out of calendar', () => {
    const s = job(); s.data.actions = [{ ...action('apply:job', 'Apply', 'job'), kind: 'apply' }]
    const checked = applied(s, { commandId: 'checkbox-only', kind: 'set_action_status', actionId: 'apply:job', status: 'done' })
    expect(hasApplicationEvidence(checked.snapshot.data.opportunities[0], checked.snapshot.data)).toBe(false)
    const submitted = applied(checked.snapshot, { commandId: 'explicit-applied', kind: 'record_application_submission', opportunityId: 'job', occurredAt: '2026-10-02T08:00:00Z' })
    expect(hasApplicationEvidence(submitted.snapshot.data.opportunities[0], submitted.snapshot.data)).toBe(true)
    expect(entries(submitted.snapshot)).toHaveLength(0)
    expect(submitted.snapshot.data.timeline!.find(item => item.kind === 'application_submitted')).toMatchObject({ occurredAt: '2026-10-02T08:00:00Z', recordedAt: now.toISOString() })
  })
  it('fact-only correction owns deadlines while archival nodes remain unchanged, including unexpected owner conflict', () => {
    const s = job(); s.data.actions = [{ ...action('apply:job', 'Apply', 'job'), kind: 'apply', dueAt: '2026-10-10', duePrecision: 'date', plannedDate: '2026-10-07' }]
    const old: ScheduleNode = { id: 'old-deadline', occurrenceId: 'application-deadline:job', version: 1, opportunityId: 'job', kind: 'application_deadline', state: 'scheduled', temporal: { shape: 'date_only', precision: 'date', timezone: 'floating-date', date: '2026-10-10', resolutionBasis: 'legacy_projection' }, constraintKind: 'employer_hard', evidenceRefs: [], sourceVersionRefs: [], relatedActionIds: ['apply:job'], relatedPrepIds: [], createdAt: now.toISOString(), updatedAt: now.toISOString() }
    s.data.scheduleNodes = [old]
    const result = applied(s, { commandId: 'correct-fact', kind: 'correct_application_deadline', opportunityId: 'job', expectedDeadlineFingerprint: applicationDeadlineFingerprint(s.data.opportunities[0], s.data), correction: { state: 'confirmed', deadline: '2026-10-12', precision: 'date', sourceUrl: 'https://example.com/job', sourceAuthority: 'official_role', evidence: 'Exact source deadline', checkedAt: now.toISOString(), postingStatus: 'open' } })
    expect(result.snapshot.data.scheduleNodes).toEqual([old])
    const checked = applied(result.snapshot, { commandId: 'task-doing-after-correction', kind: 'set_action_status', actionId: 'apply:job', status: 'doing' })
    expect(checked.snapshot.data.opportunities[0].deadline).toBe('2026-10-12')
    expect(checked.snapshot.data.scheduleNodes).toEqual([old])
    const reordered = structuredClone(result.snapshot)
    reordered.data.scheduleNodes![0].temporal = Object.fromEntries(Object.entries(old.temporal).reverse()) as ScheduleNode['temporal']
    expect(resolveApplicationDeadline(reordered.data.opportunities[0], reordered.data).deadline).toBe('2026-10-12')
    const target = result.snapshot.data.opportunities[0]
    expect(resolveApplicationDeadline(target, result.snapshot.data)).toMatchObject({ state: 'confirmed', deadline: '2026-10-12', source: 'correction', precision: 'date' })
    const task = result.snapshot.data.actions[0]
    expect(actionDeadline(task, latestActionNode(task, result.snapshot.data.scheduleNodes!, [target])).deadline).toBe('2026-10-12')
    expect(entries(result.snapshot)).toHaveLength(0)
    const changed = structuredClone(result.snapshot); changed.data.scheduleNodes![0].temporal.date = '2026-10-14'
    expect(resolveApplicationDeadline(changed.data.opportunities[0], changed.data).state).toBe('unknown')
    expect(upgradeSnapshotToLatest(changed).data.opportunities[0].deadline).toBeUndefined()
  })
  it('binds direct task-plan commands, supersedes actual arrangements once, and undoes exact owners', () => {
    const first = applied(job(), { commandId: 'plan-timed-1', kind: 'plan_application_action', opportunityId: 'job', scheduledTemporal: arrangement })
    const nextTime = { ...arrangement, startAt: '2026-10-09T16:00:00+08:00' }
    expect(() => applyUserDomainCommand(first.snapshot, { commandId: 'plan-timed-1', kind: 'plan_application_action', opportunityId: 'job', scheduledTemporal: nextTime }, now)).toThrow(/reused/)
    const second = applied(first.snapshot, { commandId: 'plan-timed-2', kind: 'plan_application_action', opportunityId: 'job', scheduledTemporal: nextTime })
    expect(second.snapshot.data.actions).toHaveLength(1)
    expect(second.snapshot.data.actions[0].plannedDate).toBe('2026-10-09')
    expect(second.snapshot.data.actions[0].scheduledTemporal).toEqual(nextTime)
    expect(entries(second.snapshot)).toHaveLength(1)
    expect(entries(second.snapshot)[0].node?.temporal.startAt).toBe(nextTime.startAt)
    expect(second.snapshot.data.opportunities[0].deadline).toBe('2026-10-10')
    const undone = applyDomainCompensation(second.snapshot, second.compensation!, now)
    expect(undone.data.actions).toEqual(first.snapshot.data.actions)
    expect(undone.data.scheduleNodes).toEqual(first.snapshot.data.scheduleNodes)
    const later = structuredClone(second.snapshot); later.data.actions[0].plannedDate = '2026-10-10'
    expect(() => applyDomainCompensation(later, second.compensation!, now)).toThrow(/changed/)
  })
  it('new source-free input and task plans cannot be forged by an authorized email envelope', () => {
    const source = { kind: 'gmail' as const, sourceId: 'gmail:primary', sourceRecordId: 'forged-user-plan', observedAt: now.toISOString(), timezone: 'Asia/Shanghai' }
    for (const candidate of [
      { kind: 'user_opportunity' as const, company: 'Forged', role: 'Job' },
      { kind: 'application_action' as const, target: { opportunityId: 'job' }, plannedDate: '2026-10-07' },
      { kind: 'manual_action' as const, title: 'Apply from source instruction', scheduledTemporal: arrangement },
    ]) {
      const before = job()
      expect(() => applySemanticIntake(before, { contractVersion: 1, inputId: 'forged-envelope', source, statementMode: 'assertion',
        candidates: [{ ...candidate, id: 'forged', objectConfidence: 'high', eventConfidence: 'high', evidenceRefs: [], sourceVersionRefs: [] }] }, { authorized: true, now })).toThrow(/first-party/)
      expect(before.data.actions).toEqual([])
    }
  })
  it('retains explicit unplanned application intent through reimport without adopting imported job intent', () => {
    const first = applied(job(), { commandId: 'user-application-intent', kind: 'plan_application_action', opportunityId: 'job' })
    expect(mergeActionsForReimport([], first.snapshot.data.actions)).toEqual(first.snapshot.data.actions)
    expect(first.snapshot.data.scheduleNodes).toEqual([])
  })
  it.each(['2026-10-12', undefined])('refreshes a retained application task when an imported job deadline becomes %s, without a legacy node', deadline => {
    const first = applied(job(), { commandId: 'imported-job-plan', kind: 'plan_application_action', opportunityId: 'job', plannedDate: '2026-10-07' })
    first.snapshot.data.actions[0].status = 'doing'
    expect(first.snapshot.data.scheduleNodes).toEqual([])
    const after = structuredClone(first.snapshot)
    after.data.opportunities[0].deadline = deadline
    after.data.opportunities[0].deadlinePrecision = deadline ? 'date' : undefined
    after.data.actions = mergeActionsForReimport([], first.snapshot.data.actions)
    ensureScheduleContractInPlace(after.data)
    expect(after.data.actions).toHaveLength(1)
    expect(after.data.actions[0]).toMatchObject({ status: 'doing', plannedDate: '2026-10-07', dueAt: deadline })
    expect(actionDeadline(after.data.actions[0]).deadline).toBe(deadline)
    expect(after.data.scheduleNodes).toEqual([])
    expect(entries(after)).toHaveLength(0)
  })
  it('rejects floating or impossible new deadline facts, including old direct clients', () => {
    for (const deadline of ['2026-10-10T15:00:00', '2026-02-30T15:00:00Z']) {
      expect(() => applyUserDomainCommand(job(), { commandId: 'bad-time', kind: 'set_deadline', opportunityId: 'job', deadline, precision: 'datetime' }, now)).toThrow(/timezone|precision/)
    }
  })
  it('A05 first-party interpretation retains exact chosen local time instead of a due-by timestamp', () => {
    const parsed = buildWebSemanticInterpretation('明天 15:00 准备材料', [], empty(), [], now, 'Asia/Shanghai')
    expect(parsed.candidates).toHaveLength(1)
    expect(parsed.candidates[0]).toMatchObject({ kind: 'manual_action', plannedDate: '2026-10-08', scheduledTemporal: arrangement })
    expect(parsed.candidates[0]).not.toHaveProperty('dueAt')
  })

  it('rescheduling an explicit task moves its chosen day and exact time together, and rejects day-only replacement', () => {
    const first = applied(empty(), { commandId: 'reschedule-task', kind: 'add_manual_action', title: 'Prepare', scheduledTemporal: arrangement })
    const occurrenceId = first.snapshot.data.scheduleNodes![0].occurrenceId
    const before = structuredClone(first.snapshot)
    expect(() => applyUserDomainCommand(first.snapshot, { commandId: 'erase-time', kind: 'reschedule_occurrence', occurrenceId,
      temporal: { shape: 'date_only', precision: 'date', timezone: 'floating-date', date: '2026-10-09', resolutionBasis: 'user_explicit' } }, now)).toThrow(/explicit start/)
    expect(first.snapshot).toEqual(before)
    const temporal = { ...arrangement, startAt: '2026-10-09T16:00:00+08:00' }
    const moved = applied(first.snapshot, { commandId: 'move-time', kind: 'reschedule_occurrence', occurrenceId, temporal })
    expect(moved.snapshot.data.actions[0]).toMatchObject({ plannedDate: '2026-10-09', scheduledTemporal: temporal })
    expect(selectTodayWeb(moved.snapshot, {}, { ...context, now: new Date('2026-10-08T02:00:00Z') }).actions).toHaveLength(0)
    expect(selectTodayWeb(moved.snapshot, {}, { ...context, now: new Date('2026-10-09T02:00:00Z') }).actions).toHaveLength(1)
    expect(entries(moved.snapshot)).toHaveLength(1)
    const undone = applyDomainCompensation(moved.snapshot, moved.compensation!, now)
    expect(undone.data.actions).toEqual(first.snapshot.data.actions)
    expect(undone.data.scheduleNodes).toEqual(first.snapshot.data.scheduleNodes)
  })

  it('a timed task counts once in Today capacity, Web and external plans without a negative deferred count', () => {
    const result = applied(empty(), { commandId: 'one-hour', kind: 'add_manual_action', title: 'Prepare', estimatedMinutes: 60,
      scheduledTemporal: { ...arrangement, startAt: '2026-10-07T15:00:00+08:00', endAt: '2026-10-07T16:00:00+08:00' } })
    expect(result.snapshot.data.actions).toHaveLength(1)
    expect(entries(result.snapshot)).toHaveLength(1)
    const web = selectTodayWeb(result.snapshot, { availableMinutes: 120 }, context)
    expect(web.actions).toHaveLength(1)
    expect(web.deferredActionCount).toBe(0)
    expect(buildTodayBrief(result.snapshot, { availableMinutes: 120 }, context).plannedMinutes).toBe(60)
    expect(getTodayPlan(result.snapshot, { availableMinutes: 120 }, context).plannedMinutes).toBe(60)
  })

  it.each([60, 30])('reserves a start-only estimate before flexible work within %i minutes without fabricating an end', availableMinutes => {
    const first = applied(empty(), { commandId: 'start-only-reservation', kind: 'add_manual_action', title: 'Arranged', estimatedMinutes: 60,
      scheduledTemporal: { ...arrangement, startAt: '2026-10-07T15:00:00+08:00' } }).snapshot
    const second = applied(first, { commandId: 'flex-after-arrangement', kind: 'add_manual_action', title: 'Flexible', estimatedMinutes: 60, plannedDate: '2026-10-07' }).snapshot
    const before = structuredClone(second)
    const web = selectTodayWeb(second, { availableMinutes }, context)
    const brief = buildTodayBrief(second, { availableMinutes }, context)
    const external = getTodayPlan(second, { availableMinutes }, context)
    expect(web.actions.map(item => item.title)).toEqual(['Arranged'])
    expect(web.deferredActionCount).toBe(1)
    expect(web.overBudgetMinutes).toBe(60 - availableMinutes)
    expect(brief.plannedMinutes).toBe(60)
    expect(external.plannedMinutes).toBe(60)
    expect(external.capacityConflict).toBe(availableMinutes < 60)
    expect(external.fixedEvents).toMatchObject([{ occursAt: '2026-10-07T15:00:00+08:00', precision: 'datetime' }])
    expect(external.startableActions[0].dueAt).toBeUndefined()
    expect(second).toEqual(before)
    expect(second.data.scheduleNodes![0].temporal.endAt).toBeUndefined()
  })

  it('keeps explicitly arranged work when estimates exceed capacity and reports the same overage', () => {
    let snapshot = empty()
    for (const [id, hour] of [['first-arranged', '14'], ['second-arranged', '17']]) snapshot = applied(snapshot,
      { commandId: id, kind: 'add_manual_action', title: id, estimatedMinutes: 60,
        scheduledTemporal: { ...arrangement, startAt: `2026-10-07T${hour}:00:00+08:00` } }).snapshot
    expect(selectTodayWeb(snapshot, { availableMinutes: 60 }, context).overBudgetMinutes).toBe(60)
    expect(buildTodayBrief(snapshot, { availableMinutes: 60 }, context).plannedMinutes).toBe(120)
    expect(getTodayPlan(snapshot, { availableMinutes: 60 }, context)).toMatchObject({ plannedMinutes: 120, capacityConflict: true })
    expect(snapshot.data.scheduleNodes!.every(node => node.temporal.endAt === undefined)).toBe(true)
  })

  it('reserves start-only estimates before admitting a genuine recruiting deadline obligation', () => {
    const arranged = applied(job(), { commandId: 'before-assessment', kind: 'add_manual_action', title: 'Arranged', estimatedMinutes: 60,
      scheduledTemporal: { ...arrangement, startAt: '2026-10-07T15:00:00+08:00' } }).snapshot
    const snapshot = applied(arranged, { commandId: 'real-assessment-obligation', kind: 'record_process_event', opportunityId: 'job',
      eventType: 'assessment_invite', dueAt: '2026-10-07T18:00:00+08:00', timingMode: 'deadline', estimatedMinutes: 60 }).snapshot
    const web = selectTodayWeb(snapshot, { availableMinutes: 60 }, context)
    expect(web.actions.map(item => item.title)).toEqual(['Arranged'])
    expect(web.notSelectedHardActions).toHaveLength(1)
    expect(web.businessConflicts).toMatchObject([{ kind: 'hard_deadline_capacity' }])
    expect(snapshot.data.processEvents[0].dueAt).toBe('2026-10-07T18:00:00+08:00')
    expect(entries(snapshot)).toHaveLength(1)
  })

  it.each(['tomorrow', 'done', 'cancelled', 'known_end'] as const)('handles %s arrangements without charging the start-only estimate twice', scenario => {
    let snapshot = applied(empty(), { commandId: `reservation-${scenario}`, kind: 'add_manual_action', title: 'Arranged', estimatedMinutes: 60,
      scheduledTemporal: { ...arrangement, startAt: scenario === 'tomorrow' ? arrangement.startAt : '2026-10-07T15:00:00+08:00',
        endAt: scenario === 'known_end' ? '2026-10-07T16:00:00+08:00' : undefined } }).snapshot
    if (scenario === 'done') snapshot.data.actions[0].status = 'done'
    if (scenario === 'cancelled') snapshot = applied(snapshot, { commandId: 'cancel-estimated-arrangement', kind: 'cancel_occurrence', occurrenceId: snapshot.data.scheduleNodes![0].occurrenceId }).snapshot
    snapshot = applied(snapshot, { commandId: `flex-${scenario}`, kind: 'add_manual_action', title: 'Flexible', estimatedMinutes: 60, plannedDate: '2026-10-07' }).snapshot
    const budget = scenario === 'known_end' ? 120 : 60
    const web = selectTodayWeb(snapshot, { availableMinutes: budget }, context)
    expect(web.actions.some(item => item.title === 'Flexible')).toBe(true)
    expect(web.overBudgetMinutes).toBe(0)
    expect(buildTodayBrief(snapshot, { availableMinutes: budget }, context).plannedMinutes).toBe(budget)
    expect(getTodayPlan(snapshot, { availableMinutes: budget }, context).plannedMinutes).toBe(budget)
  })

  it('reopens an explicitly planned task without reopening its completed calendar history', () => {
    const first = applied(empty(), { commandId: 'reopened-plan', kind: 'add_manual_action', title: 'Repeat planned work', estimatedMinutes: 60,
      scheduledTemporal: { ...arrangement, startAt: '2026-10-07T15:00:00+08:00', endAt: '2026-10-07T16:00:00+08:00' } }).snapshot
    const actionId = first.data.actions[0].id
    const completed = applied(first, { commandId: 'completed-plan', kind: 'set_action_status', actionId, status: 'done' }).snapshot
    const reopened = applied(completed, { commandId: 'repeat-plan', kind: 'set_action_status', actionId, status: 'todo' }).snapshot
    expect(reopened.data.scheduleNodes).toEqual(completed.data.scheduleNodes)
    expect(reopened.data.scheduleNodes![0].state).toBe('completed')
    expect(selectTodayWeb(reopened, { availableMinutes: 60 }, context).actions.map(item => item.actionId)).toEqual([actionId])
    expect(buildTodayBrief(reopened, { availableMinutes: 60 }, context).plannedMinutes).toBe(60)
    const external = getTodayPlan(reopened, { availableMinutes: 60 }, context)
    expect(external.startableActions.map(item => item.actionId)).toEqual([actionId])
    expect(external.fixedEvents).toEqual([])
    expect(entries(reopened)).toHaveLength(1)
    expect(entries(reopened).every(item => item.section === 'history')).toBe(true)
  })

  it.each(['Asia/Tokyo', 'source-offset'])('keeps the confirmed %s arrangement day across display timezones', timezone => {
    const snapshot = applied(empty(), { commandId: 'tokyo-arrangement', kind: 'add_manual_action', title: 'Tokyo plan',
      scheduledTemporal: { ...arrangement, timezone, startAt: '2026-10-08T00:30:00+09:00' } }).snapshot
    expect(snapshot.data.actions[0].plannedDate).toBe('2026-10-08')
    const west = { ...context, timezone: 'America/Los_Angeles', now: new Date('2026-10-07T12:00:00Z') }
    expect(selectTodayWeb(snapshot, {}, west).actions).toEqual([])
    expect(buildTodayBrief(snapshot, {}, west).nextActions).toEqual([])
    expect(getTodayPlan(snapshot, {}, west).startableActions).toEqual([])
    expect(selectTodayWeb(snapshot, {}, { ...west, now: new Date('2026-10-08T12:00:00Z') }).actions).toHaveLength(1)
  })

  it('exposes the actual arranged start separately from a later completion deadline', () => {
    const snapshot = applied(job(), { commandId: 'arranged-application', kind: 'plan_application_action', opportunityId: 'job',
      scheduledTemporal: { ...arrangement, startAt: '2026-10-07T15:00:00+08:00' } }).snapshot
    const result = getTodayPlan(snapshot, {}, context)
    expect(result.startableActions[0]).toMatchObject({ dueAt: '2026-10-10', duePrecision: 'date', timingMode: 'deadline' })
    expect(result.fixedEvents).toMatchObject([{ occursAt: '2026-10-07T15:00:00+08:00', precision: 'datetime', timezone: 'Asia/Shanghai' }])
    expect(getTodayPlan(snapshot, {}, { ...context, now: new Date('2026-10-08T02:00:00Z') }).fixedEvents).toEqual([])
  })

  it('source occurrence dedup preserves deadline versus appointment meaning at the same instant', () => {
    const observation = (id: string, timingMode: 'deadline' | 'fixed') => ({ contractVersion: 1 as const, inputId: id,
      source: { kind: 'mcp' as const, sourceId: 'b1-source', sourceRecordId: id, observedAt: now.toISOString(), timezone: 'Asia/Shanghai' },
      statementMode: 'assertion' as const, candidates: [{ id: 'assessment', kind: 'process_event' as const, eventType: 'assessment_invite' as const,
        target: { opportunityId: 'job', occurrenceId: 'source:assessment-1' }, dueAt: arrangement.startAt, duePrecision: 'datetime' as const, timingMode,
        objectConfidence: 'high' as const, eventConfidence: 'high' as const, evidenceRefs: [], sourceVersionRefs: [] }] })
    const first = applySemanticIntake(job(), observation('deadline-source', 'deadline'), { authorized: true, now })
    expect(first.status).toBe('APPLIED')
    expect(first.snapshot.data.processEvents).toHaveLength(1)
    expect(entries(first.snapshot)).toHaveLength(0)
    const repeated = applySemanticIntake(first.snapshot, observation('second-source', 'deadline'), { authorized: true, now })
    expect(repeated.snapshot.data.processEvents).toEqual(first.snapshot.data.processEvents)
    expect(repeated.snapshot.data.decisionRequests).toHaveLength(0)
    const changed = applySemanticIntake(first.snapshot, observation('changed-meaning', 'fixed'), { authorized: true, now })
    expect(changed.status).toBe('DECISION_REQUIRED')
    expect(changed.snapshot.data.processEvents).toEqual(first.snapshot.data.processEvents)
    expect(changed.snapshot.data.actions).toEqual(first.snapshot.data.actions)
    expect(entries(changed.snapshot)).toHaveLength(0)
    expect(changed.snapshot.data.decisionRequests?.[0].reason).toBe('material_conflict')
  })

  it('a batch receipt cannot use another job or occurrence to prove a changed source fact', () => {
    const before = job(); before.data.opportunities.push({ ...before.data.opportunities[0], id: 'job-b', company: 'Other Company' })
    const candidate = (opportunityId: string, timingMode: 'deadline' | 'fixed') => ({ id: opportunityId, kind: 'process_event' as const,
      eventType: 'assessment_invite' as const, target: { opportunityId, occurrenceId: `source:${opportunityId}` },
      dueAt: arrangement.startAt, duePrecision: 'datetime' as const, timingMode,
      objectConfidence: 'high' as const, eventConfidence: 'high' as const, evidenceRefs: [], sourceVersionRefs: [] })
    const source = { kind: 'mcp' as const, sourceId: 'batch-source', sourceRecordId: 'batch', observedAt: now.toISOString(), timezone: 'Asia/Shanghai' }
    const first = applySemanticIntake(before, { contractVersion: 1, inputId: 'batch', source, statementMode: 'assertion',
      candidates: [candidate('job', 'deadline'), candidate('job-b', 'fixed')] }, { authorized: true, now })
    expect(first.snapshot.data.processEvents).toHaveLength(2)
    for (const legacy of [false, true]) {
      const stored = structuredClone(first.snapshot)
      if (legacy) for (const receipt of stored.data.semanticReceipts ?? []) delete receipt.factMutationObjects
      const changed = applySemanticIntake(stored, { contractVersion: 1, inputId: 'other-source', source: { ...source, sourceId: 'other-source', sourceRecordId: 'changed' },
        statementMode: 'assertion', candidates: [candidate('job', 'fixed')] }, { authorized: true, now })
      expect(changed.status).toBe('DECISION_REQUIRED')
      expect(changed.snapshot.data.processEvents).toEqual(first.snapshot.data.processEvents)
      expect(changed.snapshot.data.decisionRequests?.[0].reason).toBe('material_conflict')
    }
  })
  it('a batch with one real submission and another job task never turns task completion or Undo into submission', () => {
    const before = job(); before.data.opportunities.push({ ...before.data.opportunities[0], id: 'job-b', company: 'Other Company' })
    const evidence = { objectConfidence: 'high' as const, eventConfidence: 'high' as const, evidenceRefs: [], sourceVersionRefs: [] }
    const observation = { contractVersion: 1 as const, inputId: 'submission-and-task',
      source: { kind: 'mcp' as const, sourceId: 'batch-source', sourceRecordId: 'submission-and-task', observedAt: now.toISOString(), timezone: 'Asia/Shanghai' },
      statementMode: 'assertion' as const, candidates: [
        { ...evidence, id: 'applied-a', kind: 'application_submitted' as const, target: { opportunityId: 'job' }, occurredAt: '2026-10-06T02:00:00Z' },
        { ...evidence, id: 'task-b', kind: 'application_action' as const, target: { opportunityId: 'job-b' }, plannedDate: '2026-10-07' },
      ] }
    const first = applySemanticIntake(before, observation, { authorized: true, now })
    expect(first.status).toBe('APPLIED')
    const task = first.snapshot.data.actions.find(item => item.opportunityId === 'job-b')!
    expect(task).toBeDefined()
    const completed = applied(first.snapshot, { commandId: 'complete-b-task', kind: 'set_action_status', actionId: task.id, status: 'done' })
    const replay = applySemanticIntake(completed.snapshot, observation, { authorized: true, now: new Date('2026-10-08T02:00:00Z') })
    expect(replay.status).toBe('ALREADY_APPLIED')
    expect(replay.snapshot).toEqual(completed.snapshot)
    const undone = applyDomainCompensation(replay.snapshot, completed.compensation!, now)
    expect(undone.data.actions.find(item => item.id === task.id)?.status).toBe('todo')
    for (const snapshot of [first.snapshot, completed.snapshot, replay.snapshot, undone]) {
      expect(hasApplicationEvidence(snapshot.data.opportunities.find(item => item.id === 'job')!, snapshot.data)).toBe(true)
      expect(hasApplicationEvidence(snapshot.data.opportunities.find(item => item.id === 'job-b')!, snapshot.data)).toBe(false)
      expect(snapshot.data.timeline?.filter(item => item.kind === 'application_submitted')).toHaveLength(1)
      expect(entries(snapshot)).toHaveLength(0)
    }
  })

})
