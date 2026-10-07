import { describe, expect, it } from 'vitest'
import { action, opportunity, workspace } from '../e2e/fixtures/todayWorkspace.js'
import type { ScheduleNode, TimelineRecord, ProcessEvent } from '../src/model.js'
import { applyDomainCompensation, applyUserDomainCommand, type UserDomainCommand } from '../src/domainCommands.js'
import { upgradeSnapshotToLatest } from '../src/snapshot.js'
import { buildScheduleStream, buildScheduleStreamNormalized } from '../src/schedule/scheduleStream.js'
import { invokeAddOpportunities } from '../gateway/addOpportunities.js'

const now = new Date('2026-10-06T12:00:00.000Z')
const eventTime = '2026-10-02T08:00:00.000Z'
const context = { accountKey: 'synthetic', workspaceRevision: '1', timezone: 'Asia/Shanghai', now }
const log = (id: string, kind: TimelineRecord['kind'], extra: Partial<TimelineRecord> = {}): TimelineRecord => ({
  id, kind, category: 'opportunity', source: 'user_action', occurredAt: now.toISOString(),
  recordedAt: now.toISOString(), title: id, opportunityId: 'job', ...extra,
})

describe('explicit correction of checkbox-only occurrence state', () => {
  function checkboxSnapshot(status: 'done' | 'skipped', knownTime: boolean, past = false) {
    const snapshot = empty()
    snapshot.data.actions = [{ ...action('task', '招聘任务', 'job'), status }]
    snapshot.data.scheduleNodes = [node('meeting', {
      opportunityId: 'job', kind: 'written_test', state: status === 'done' ? 'completed' : 'cancelled', relatedActionIds: ['task'],
      completedAt: status === 'done' && knownTime ? now.toISOString() : undefined,
      cancelledAt: status === 'skipped' && knownTime ? now.toISOString() : undefined,
      ...(past ? { temporal: { shape: 'date_only', precision: 'date', timezone: 'floating-date', date: '2026-10-01', resolutionBasis: 'legacy_projection' } } : {}),
    }), node('independent', { state: 'completed', completedAt: eventTime })]
    snapshot.data.timeline = [log('checkbox', 'action_status_changed', { actionId: 'task', changes: { status: { before: 'todo', after: status } } })]
    return upgradeSnapshotToLatest(snapshot)
  }
  const cases = (['done', 'skipped'] as const).flatMap(status =>
    (['complete_occurrence', 'cancel_occurrence', 'reschedule_occurrence'] as const).flatMap(kind =>
      [true, false].map(knownTime => ({ status, kind, knownTime }))))

  it.each(cases)('$status checkbox → $kind works with knownTime=$knownTime, preserving replay and Undo', ({ status, kind, knownTime }) => {
    const snapshot = checkboxSnapshot(status, knownTime)
    const original = structuredClone(snapshot)
    expect(buildScheduleStream(snapshot, context).sections.upcoming.find(item => item.nodeId === 'meeting')?.state).toBe('scheduled')
    const command: UserDomainCommand = kind === 'reschedule_occurrence'
      ? { commandId: `explicit:${status}:${kind}:${knownTime}`, kind, occurrenceId: 'meeting', temporal: {
        shape: 'fixed_range', precision: 'datetime', timezone: 'UTC', startAt: '2026-10-09T08:00:00.000Z', resolutionBasis: 'user_explicit',
      } }
      : { commandId: `explicit:${status}:${kind}:${knownTime}`, kind, occurrenceId: 'meeting', occurredAt: now.toISOString() }
    const result = applyUserDomainCommand(snapshot, command, now)
    if (result.status !== 'APPLIED') throw new Error(result.status)
    expect(snapshot).toEqual(original)
    const replacement = result.snapshot.data.scheduleNodes!.find(item => item.occurrenceId === 'meeting' && item.version === 2)!
    expect(replacement.id).not.toBe('meeting')
    expect(replacement.state).toBe(kind === 'complete_occurrence' ? 'completed' : kind === 'cancel_occurrence' ? 'cancelled' : 'scheduled')
    expect(result.snapshot.data.timeline).toContainEqual(original.data.timeline![0])
    expect(result.snapshot.data.timeline!.find(item => item.commandId === command.commandId)?.scheduleNodeId).toBe(replacement.id)
    expect(result.snapshot.data.scheduleNodes!.find(item => item.id === 'independent')).toEqual(original.data.scheduleNodes!.find(item => item.id === 'independent'))
    const replay = applyUserDomainCommand(result.snapshot, command, new Date('2026-10-08T12:00:00.000Z'))
    expect(replay.status).toBe('ALREADY_APPLIED')
    expect(replay.snapshot).toEqual(result.snapshot)
    const restored = applyDomainCompensation(result.snapshot, result.compensation, now)
    for (const collection of ['scheduleNodes', 'actions', 'opportunities', 'processEvents', 'processes'] as const) expect(restored.data[collection]).toEqual(original.data[collection])
    expect(restored.data.timeline).toEqual(result.snapshot.data.timeline)
    expect(buildScheduleStream(restored, context).sections.upcoming.find(item => item.nodeId === 'meeting')?.state).toBe('scheduled')
    // A fresh explicit correction after Undo cannot reuse the old fact's node ID.
    const repeated = applyUserDomainCommand(restored, { ...command, commandId: `${command.commandId}:again` }, now)
    if (repeated.status !== 'APPLIED') throw new Error(repeated.status)
    expect(repeated.snapshot.data.scheduleNodes!.find(item => item.occurrenceId === 'meeting' && item.version === 2)?.id).not.toBe(replacement.id)
  })

  it('allows an explicitly confirmed completion of an elapsed ambiguous legacy occurrence', () => {
    const snapshot = checkboxSnapshot('done', false, true)
    expect(buildScheduleStream(snapshot, context).sections.unresolved.some(item => item.nodeId === 'meeting')).toBe(false)
    expect(snapshot.data.scheduleNodes!.some(item => item.id === 'meeting')).toBe(true)
    const result = applyUserDomainCommand(snapshot, { commandId: 'confirm-elapsed', kind: 'complete_occurrence', occurrenceId: 'meeting', occurredAt: eventTime }, now)
    if (result.status !== 'APPLIED') throw new Error(result.status)
    expect(buildScheduleStream(result.snapshot, context).sections.history.some(item => item.occurrenceId === 'meeting' && item.occurredAt === eventTime)).toBe(true)
  })

  function processBackedCorrection(deterministicIdentity = false) {
    const snapshot = checkboxSnapshot('done', true)
    snapshot.data.processEvents = [{ ...event('invitation', 'written_test_invite'), dueAt: '2026-10-07T08:00:00.000Z', notes: 'Original event note' }]
    snapshot.data.actions[0].processEventId = 'invitation'
    snapshot.data.scheduleNodes![0].processEventId = 'invitation'
    snapshot.data.scheduleNodes![0].processId = 'process'
    if (deterministicIdentity) {
      snapshot.data.scheduleNodes![0].occurrenceId = 'process-event:invitation'
      snapshot.data.scheduleNodes![0].id = 'schedule:process-event:invitation:v1'
    }
    snapshot.data.processes = [{ id: 'process', opportunityId: 'job', company: '真实公司', role: '产品经理', stage: 'written_test',
      stageLabel: '笔试', lastProgressAt: eventTime, currentAction: 'Original process action', notes: 'Original process note' }]
    const original = upgradeSnapshotToLatest(snapshot)
    const result = applyUserDomainCommand(original, { commandId: 'correct-process', kind: 'reschedule_occurrence', occurrenceId: snapshot.data.scheduleNodes![0].occurrenceId, temporal: {
      shape: 'fixed_range', precision: 'datetime', timezone: 'UTC', startAt: '2026-10-09T08:00:00.000Z', resolutionBasis: 'user_explicit',
    } }, now)
    if (result.status !== 'APPLIED') throw new Error(result.status)
    return { original, result }
  }

  it('Undo restores only occurrence-owned fields and preserves later independent owner edits', () => {
    const { original, result } = processBackedCorrection()
    const edited = structuredClone(result.snapshot)
    edited.data.opportunities[0].role = 'Later independent role'
    edited.data.actions[0].title = 'Later independent task title'
    edited.data.processEvents[0].notes = 'Later independent event note'
    edited.data.processes[0].notes = 'Later independent process note'
    const restored = applyDomainCompensation(edited, result.compensation, now)
    expect(restored.data.opportunities[0].role).toBe('Later independent role')
    expect(restored.data.actions[0].title).toBe('Later independent task title')
    expect(restored.data.processEvents[0].notes).toBe('Later independent event note')
    expect(restored.data.processes[0].notes).toBe('Later independent process note')
    expect(restored.data.processEvents[0].dueAt).toBe(original.data.processEvents[0].dueAt)
    expect(restored.data.actions[0].dueAt).toBe(original.data.actions[0].dueAt)
    expect(restored.data.processes[0].lastProgressAt).toBe(original.data.processes[0].lastProgressAt)
    expect(restored.data.scheduleNodes).toEqual(original.data.scheduleNodes)
  })

  it.each([false, true])('Undo preserves timestamped event notes and derived provenance with normalizedInput=%s', normalizedInput => {
    const { original, result } = processBackedCorrection(true)
    const edited = structuredClone(result.snapshot)
    edited.data.processEvents[0].notes = 'Independent notes after rescheduling'
    edited.data.processEvents[0].updatedAt = '2026-10-06T13:00:00.000Z'
    const rawNode = structuredClone(edited.data.scheduleNodes!.find(item => item.version === 2)!)
    const input = normalizedInput ? upgradeSnapshotToLatest(edited) : edited
    const beforeUndo = structuredClone(input)
    if (normalizedInput) expect(input.data.scheduleNodes!.find(item => item.version === 2)!.sourceVersionRefs).toContain('process-event:invitation:2026-10-06T13:00:00.000Z')
    const restored = applyDomainCompensation(input, result.compensation, new Date('2026-10-06T14:00:00.000Z'))
    expect(input).toEqual(beforeUndo)
    expect(rawNode).toEqual(result.snapshot.data.scheduleNodes!.find(item => item.version === 2))
    expect(restored.data.processEvents[0]).toMatchObject({ notes: 'Independent notes after rescheduling', updatedAt: '2026-10-06T13:00:00.000Z', dueAt: original.data.processEvents[0].dueAt })
    const restoredNode = restored.data.scheduleNodes!.find(item => item.occurrenceId === 'process-event:invitation')!
    expect(restoredNode.id).toBe('schedule:process-event:invitation:v1')
    expect(restoredNode.sourceVersionRefs).toEqual(expect.arrayContaining([
      ...original.data.scheduleNodes![0].sourceVersionRefs, 'process-event:invitation:2026-10-06T13:00:00.000Z',
    ]))
    expect(restored.data.timeline).toEqual(result.snapshot.data.timeline)
  })

  it.each(['unverified_ref', 'removed_ref', 'structural_source_change'] as const)('Undo refuses %s instead of treating it as derived provenance', variation => {
    const { result } = processBackedCorrection(true)
    const edited = structuredClone(result.snapshot)
    edited.data.processEvents[0].notes = 'Independent note'
    edited.data.processEvents[0].updatedAt = '2026-10-06T13:00:00.000Z'
    if (variation === 'structural_source_change') edited.data.processEvents[0].temporal = {
      shape: 'date_only', precision: 'date', timezone: 'floating-date', date: '2026-10-15', resolutionBasis: 'source_explicit',
    }
    const normalized = upgradeSnapshotToLatest(edited)
    const replacement = normalized.data.scheduleNodes!.find(item => item.version === 2)!
    if (variation === 'unverified_ref') replacement.sourceVersionRefs.push('unverified-independent-source')
    if (variation === 'removed_ref') replacement.sourceVersionRefs = replacement.sourceVersionRefs.filter(ref => !result.snapshot.data.scheduleNodes!.find(item => item.version === 2)!.sourceVersionRefs.includes(ref))
    const beforeUndo = structuredClone(normalized)
    expect(() => applyDomainCompensation(normalized, result.compensation, now)).toThrow(/Confirmed occurrence changed/)
    expect(normalized).toEqual(beforeUndo)
  })

  it('Undo refuses a later conflicting occurrence-owned field without mutating its input', () => {
    const { result } = processBackedCorrection()
    const edited = structuredClone(result.snapshot)
    edited.data.processEvents[0].dueAt = '2026-10-12T08:00:00.000Z'
    const original = structuredClone(edited)
    expect(() => applyDomainCompensation(edited, result.compensation, now)).toThrow(/Occurrence-owned field changed/)
    expect(edited).toEqual(original)
  })

  it('Undo refuses an independently changed confirmed occurrence instead of deleting it', () => {
    const { result } = processBackedCorrection()
    const edited = structuredClone(result.snapshot)
    edited.data.scheduleNodes!.find(item => item.version === 2)!.evidenceRefs.push('later-independent-evidence')
    const original = structuredClone(edited)
    expect(() => applyDomainCompensation(edited, result.compensation, now)).toThrow(/Confirmed occurrence changed/)
    expect(edited).toEqual(original)
  })

  it.each(['completed', 'cancelled'] as const)('keeps an independently evidenced %s occurrence protected', state => {
    const snapshot = checkboxSnapshot(state === 'completed' ? 'done' : 'skipped', true)
    snapshot.data.timeline!.push(log('real-terminal', 'semantic_intake_applied', {
      scheduleNodeId: 'meeting', commandOperation: state === 'completed' ? 'complete_occurrence' : 'cancel_occurrence',
    }))
    const original = structuredClone(snapshot)
    for (const kind of ['complete_occurrence', 'cancel_occurrence', 'reschedule_occurrence'] as const) {
      const command: UserDomainCommand = kind === 'reschedule_occurrence'
        ? { commandId: `protected:${kind}`, kind, occurrenceId: 'meeting', temporal: snapshot.data.scheduleNodes![0].temporal }
        : { commandId: `protected:${kind}`, kind, occurrenceId: 'meeting' }
      const result = applyUserDomainCommand(snapshot, command, now)
      expect(result.status).toBe(kind === (state === 'completed' ? 'complete_occurrence' : 'cancel_occurrence') ? 'ALREADY_APPLIED' : 'NEEDS_CONFIRMATION')
      expect(result.snapshot).toEqual(original)
    }
  })

  it('preserves the actual later submission without treating the earlier checkbox time as an event or leaving a duplicate deadline', () => {
    const snapshot = empty()
    snapshot.data.actions = [{ ...action('apply:job', '投递', 'job'), kind: 'apply', status: 'done' }]
    snapshot.data.scheduleNodes = [node('application', { kind: 'application_deadline', opportunityId: 'job', relatedActionIds: ['apply:job'], state: 'completed', completedAt: eventTime })]
    snapshot.data.timeline = [log('apply-checkbox', 'action_status_changed', { actionId: 'apply:job', occurredAt: eventTime, changes: { status: { before: 'todo', after: 'done' } } })]
    const result = applyUserDomainCommand(snapshot, { commandId: 'actual-submission', kind: 'record_application_submission', opportunityId: 'job', occurredAt: now.toISOString() }, now)
    if (result.status !== 'APPLIED') throw new Error(result.status)
    const original = structuredClone(result.snapshot)
    const stream = buildScheduleStream(result.snapshot, context)
    expect(stream.sections.history).toHaveLength(0)
    expect(result.snapshot.data.timeline!.find(item => item.kind === 'application_submitted')).toMatchObject({ occurredAt: now.toISOString() })
    expect(stream.sections.upcoming).toEqual([])
    expect(stream.sections.unresolved).toEqual([])
    expect(result.snapshot).toEqual(original)
    expect(result.snapshot.data.scheduleNodes![0].completedAt).toBe(eventTime)
  })
})
function empty() {
  const snapshot = workspace()
  snapshot.data.opportunities = [opportunity('job', '真实公司', '产品经理')]
  snapshot.data.actions = []
  snapshot.data.processEvents = []
  snapshot.data.processes = []
  snapshot.data.scheduleNodes = []
  snapshot.data.timeline = []
  return snapshot
}
function node(id: string, extra: Partial<ScheduleNode> = {}): ScheduleNode {
  return { id, occurrenceId: id, version: 1, kind: 'interview', state: 'scheduled',
    temporal: { shape: 'fixed_range', precision: 'datetime', timezone: 'UTC', startAt: '2026-10-07T08:00:00.000Z', resolutionBasis: 'source_explicit' },
    constraintKind: 'employer_hard', evidenceRefs: [], sourceVersionRefs: [], relatedActionIds: [], relatedPrepIds: [],
    createdAt: eventTime, updatedAt: now.toISOString(), ...extra }
}
function event(id: string, type: ProcessEvent['type'] = 'interview_invite'): ProcessEvent {
  return { id, opportunityId: 'job', company: '真实公司', role: '产品经理', type, occurredAt: eventTime,
    source: 'email', createdAt: now.toISOString(), updatedAt: now.toISOString() }
}

describe('schedule event / operation boundary', () => {
  it('does not project an explicit opportunity write as a calendar event', async () => {
    let snapshot = empty()
    const result = await invokeAddOpportunities({
      read: async () => ({ snapshot, context: { now, workspaceVersion: '1' } }),
      write: async (input: { snapshot: typeof snapshot }) => { snapshot = input.snapshot; return { snapshot, context: { now, workspaceVersion: '2' } } },
    }, { opportunities: [{ company: '示例科技', role: '软件产品经理 P100｜2027校招',
      sourceUrl: 'https://example.test/jobs/P100', sourceTitle: '官方招聘岗位' }] })
    expect(result.isError).not.toBe(true)
    expect(snapshot.data.timeline?.some(item => item.kind === 'opportunity_added')).toBe(true)
    expect(snapshot.data.opportunities.find(item => item.company === '示例科技')?.processStage).toBe('not_applied')
    const stream = buildScheduleStream(snapshot, context)
    expect(stream.sections.history).toEqual([])
    expect(stream.sections.upcoming).toEqual([])
    expect(stream.sections.undated).toEqual([])
  })

  it('retains all operations in the raw audit but excludes them from schedule filters and counts', () => {
    const snapshot = empty()
    snapshot.data.timeline = (['opportunity_added', 'opportunity_updated', 'opportunity_renamed', 'decision_resolved',
      'semantic_undo_applied', 'process_event_deleted', 'action_added', 'rules_changed', 'excel_imported'] as const).map(kind => log(kind, kind))
    snapshot.data.timeline.push(log('skip', 'action_status_changed', { title: '跳过行动｜完成示例游戏｜笔试', actionId: 'task', changes: { status: { after: 'skipped' } } }))
    const original = structuredClone(snapshot)
    const stream = buildScheduleStream(snapshot, context)
    expect(stream.counts.history).toBe(0)
    expect(stream.counts.undated).toBe(0)
    expect(stream.counts.upcoming).toBe(0)
    expect(snapshot).toEqual(original)
  })

  it('uses real event time for late submissions and operation time for the new receipt', () => {
    const result = applyUserDomainCommand(empty(), { commandId: 'backdate', kind: 'record_application_submission', opportunityId: 'job', occurredAt: eventTime }, now)
    if (result.status !== 'APPLIED') throw new Error(result.status)
    const fact = result.snapshot.data.timeline!.find(item => item.kind === 'application_submitted')!
    expect(fact.occurredAt).toBe(eventTime)
    expect(fact.recordedAt).toBe(now.toISOString())
    const later = log('newer', 'application_submitted', { opportunityId: 'other', occurredAt: '2026-10-04T08:00:00.000Z', recordedAt: eventTime })
    result.snapshot.data.timeline!.push(later)
    result.snapshot.data.scheduleNodes = [node('real-earlier', { state: 'completed', completedAt: eventTime }), node('real-later', { state: 'completed', completedAt: later.occurredAt })]
    const first = buildScheduleStream(result.snapshot, context).sections.history.map(item => [item.id, item.occurredAt])
    result.snapshot.data.timeline!.forEach(item => { item.recordedAt = '2026-10-01T00:00:00.000Z' })
    expect(buildScheduleStream(result.snapshot, context).sections.history.map(item => [item.id, item.occurredAt])).toEqual(first)
    expect(first.map(item => item[1])).toEqual([eventTime, later.occurredAt])
  })

  it('deduplicates exact application facts across synced sources and raw process facts including rejection', () => {
    const snapshot = empty()
    snapshot.data.processEvents = [event('test', 'written_test_invite'), event('interview'), event('reject', 'rejection')]
    snapshot.data.timeline = [log('submission-a', 'application_submitted', { occurredAt: eventTime }),
      log('submission-b', 'application_submitted', { occurredAt: eventTime, source: 'gmail', recordedAt: '2026-10-05T08:00:00.000Z' }),
      ...snapshot.data.processEvents.flatMap(item => [log(`log:${item.id}`, item.type === 'rejection' ? 'process_closed' : 'process_event_recorded', { processEventId: item.id, occurredAt: eventTime }),
        log(`sync:${item.id}`, item.type === 'rejection' ? 'process_closed' : 'process_event_recorded', { processEventId: item.id, occurredAt: eventTime, source: 'mcp' })])]
    const stream = buildScheduleStream(snapshot, context)
    expect(stream.counts.history).toBe(0)
    expect(snapshot.data.timeline).toHaveLength(8)
    expect(snapshot.data.processEvents).toHaveLength(3)
  })

  it('links exact legacy progress identities without changing completion wording or inferring from it', () => {
    const snapshot = empty()
    snapshot.data.processEvents = [event('progress-event:legacy-completion', 'written_test_invite')]
    snapshot.data.timeline = [log('timeline:progress:legacy-completion', 'process_event_recorded', {
      source: 'natural_language', occurredAt: eventTime, title: '完成笔试',
    })]
    const original = structuredClone(snapshot)
    const stream = buildScheduleStream(snapshot, context)
    expect(stream.sections.history).toEqual([])
    expect(snapshot.data.timeline![0]).toMatchObject({ title: '完成笔试', occurredAt: eventTime })
    expect(snapshot).toEqual(original)
  })

  it('does not collapse invalid legacy event times by comparing two missing parsed values', () => {
    const snapshot = empty()
    snapshot.data.processEvents = [{ ...event('progress-event:legacy-unknown'), occurredAt: 'invalid-event-time' }]
    snapshot.data.timeline = [log('timeline:progress:legacy-unknown', 'process_event_recorded', { occurredAt: 'different-invalid-time' })]
    const stream = buildScheduleStreamNormalized(snapshot, context)
    expect(stream.sections.undated).toHaveLength(0)
    expect(stream.sections.history).toEqual([])
  })

  it.each(['done', 'skipped'] as const)('does not turn a %s checkbox into application or test attendance', status => {
    let snapshot = empty()
    snapshot.data.actions = [{ ...action('apply:job', '投递', 'job'), kind: 'apply', dueAt: '2026-10-07T08:00:00.000Z' },
      { ...action('test-task', '完成笔试', 'job'), processEventId: 'test' }]
    snapshot.data.processEvents = [{ ...event('test', 'written_test_invite'), dueAt: '2026-10-07T08:00:00.000Z', timingMode: 'fixed' }]
    for (const actionId of ['apply:job', 'test-task']) {
      const result = applyUserDomainCommand(snapshot, { commandId: `checkbox:${actionId}`, kind: 'set_action_status', actionId, status }, now)
      if (result.status !== 'APPLIED') throw new Error(result.status)
      snapshot = result.snapshot
    }
    const original = structuredClone(snapshot)
    const stream = buildScheduleStream(snapshot, context)
    expect(stream.sections.history).toEqual([])
    expect(stream.sections.upcoming.filter(item => item.node?.kind === 'written_test')).toHaveLength(1)
    expect(stream.sections.upcoming.every(item => item.state !== 'completed')).toBe(true)
    expect(snapshot).toEqual(original)
  })

  it('preserves explicit occurrence completion, its receipt time and a distinct invitation receipt', () => {
    const snapshot = empty()
    snapshot.data.processEvents = [event('interview')]
    snapshot.data.scheduleNodes = [node('meeting', { processEventId: 'interview', opportunityId: 'job' })]
    const result = applyUserDomainCommand(snapshot, { commandId: 'complete', kind: 'complete_occurrence', occurrenceId: 'meeting', occurredAt: '2026-10-05T08:00:00.000Z' }, now)
    if (result.status !== 'APPLIED') throw new Error(result.status)
    const stream = buildScheduleStream(result.snapshot, context)
    expect(stream.sections.history.map(item => item.id)).toEqual(['node:meeting'])
    expect(stream.sections.history[0]).toMatchObject({ state: 'completed', occurredAt: '2026-10-05T08:00:00.000Z' })
    expect(stream.sections.history[0].sourceRefs.some(ref => ref.startsWith('timeline:'))).toBe(true)
  })

  it('shows only the latest arrangement after edits, preserving canceled planned time and raw versions', () => {
    const snapshot = empty()
    snapshot.data.scheduleNodes = [node('old', { occurrenceId: 'same', state: 'superseded', supersededByNodeId: 'new' }),
      node('new', { occurrenceId: 'same', version: 2, supersedesNodeId: 'old' }),
      node('cancelled', { state: 'cancelled', cancelledAt: now.toISOString() })]
    const stream = buildScheduleStream(snapshot, context)
    expect(Object.values(stream.sections).flat().some(item => item.nodeId === 'old')).toBe(false)
    expect(stream.sections.upcoming.map(item => item.nodeId)).toEqual(['new'])
    expect(stream.sections.history.find(item => item.nodeId === 'cancelled')).toMatchObject({ date: '2026-10-07', occurredAt: undefined })
    expect(snapshot.data.scheduleNodes).toHaveLength(3)
  })

  it('keeps genuine undated completion without borrowing write time, excluding generic task-only completion', () => {
    const snapshot = empty()
    snapshot.data.scheduleNodes = [node('unknown', { state: 'completed' }), node('prep', { kind: 'prep_trigger', constraintKind: 'user_plan', temporal: { shape: 'fixed_range', precision: 'datetime', timezone: 'UTC', startAt: eventTime, resolutionBasis: 'user_explicit' }, state: 'completed', completedAt: eventTime })]
    snapshot.data.actions = [{ ...action('plain', '一般任务'), status: 'done' }]
    snapshot.data.timeline = [log('plain-done', 'action_status_changed', { actionId: 'plain', changes: { status: { after: 'done' } } })]
    const stream = buildScheduleStream(snapshot, context)
    expect(stream.sections.undated.map(item => item.id)).toEqual(['node:unknown'])
    expect(stream.sections.undated[0].occurredAt).toBeUndefined()
    expect(stream.sections.history.map(item => item.id)).toEqual(['node:prep'])
    expect(stream.completedActions?.map(item => item.actionId)).toEqual(['plain'])
  })

  it('does not guess event time from recordedAt when an old typed fact has no usable time', () => {
    const snapshot = empty()
    snapshot.data.timeline = [log('unknown-fact', 'application_submitted', { occurredAt: '' })]
    snapshot.data.processEvents = [{ ...event('unknown-event'), occurredAt: '' }]
    const stream = buildScheduleStreamNormalized(snapshot, context)
    expect(stream.sections.history).toEqual([])
    expect(stream.sections.undated).toHaveLength(0)
    expect(stream.sections.undated.every(item => !item.date && !item.occurredAt)).toBe(true)
  })

  it.each([true, false])('counts an explicit completion and its matching task receipt once in Today (completedAt=%s)', knownCompletion => {
    for (const taskFirst of [true, false]) {
      const snapshot = empty()
      snapshot.data.scheduleNodes = [node('completed-meeting', {
        state: 'completed', relatedActionIds: ['meeting-task'], completedAt: knownCompletion ? now.toISOString() : undefined,
      })]
      const task = log('matching-task', 'action_status_changed', {
        actionId: 'meeting-task', changes: { status: { before: 'todo', after: 'done' } },
      })
      const completion = log('explicit-completion', 'semantic_intake_applied', {
        scheduleNodeId: 'completed-meeting', commandOperation: 'complete_occurrence',
      })
      snapshot.data.timeline = taskFirst ? [task, completion] : [completion, task]
      const original = structuredClone(snapshot)
      const stream = buildScheduleStream(snapshot, context)
      expect(stream.sections.history.map(item => item.id)).toEqual(['node:completed-meeting'])
      expect(stream.sections.history[0].occurredAt).toBe(now.toISOString())
      expect(stream.sections.history[0].sourceRefs).toContain('timeline:matching-task')
      expect(stream.completedActions).toEqual([])
      expect(snapshot).toEqual(original)
    }
  })

  it('does not fold a differently timed task receipt into an explicit occurrence completion', () => {
    const snapshot = empty()
    snapshot.data.scheduleNodes = [node('completed-meeting', {
      state: 'completed', relatedActionIds: ['meeting-task'], completedAt: eventTime,
    })]
    snapshot.data.timeline = [log('separate-task', 'action_status_changed', {
      actionId: 'meeting-task', changes: { status: { before: 'todo', after: 'done' } },
    }), log('explicit-completion', 'semantic_intake_applied', {
      scheduleNodeId: 'completed-meeting', commandOperation: 'complete_occurrence', occurredAt: eventTime,
    })]
    const stream = buildScheduleStream(snapshot, context)
    expect(stream.sections.history).toHaveLength(1)
    expect(stream.sections.history[0].occurredAt).toBe(eventTime)
    expect(stream.sections.history[0].sourceRefs).not.toContain('timeline:separate-task')
    expect(stream.completedActions?.map(item => item.id)).toEqual(['task:separate-task'])
  })


  it('does not reuse an earlier explicit completion as evidence for a later task checkbox', () => {
    const snapshot = empty()
    snapshot.data.scheduleNodes = [node('meeting', { state: 'completed', relatedActionIds: ['task'], completedAt: now.toISOString() })]
    snapshot.data.timeline = [log('earlier-completion', 'semantic_intake_applied', {
      scheduleNodeId: 'meeting', commandOperation: 'complete_occurrence', occurredAt: eventTime,
    }), log('later-checkbox', 'action_status_changed', { actionId: 'task', changes: { status: { after: 'done' } } })]
    const stream = buildScheduleStream(snapshot, context)
    expect(stream.sections.history).toEqual([])
    expect(stream.sections.upcoming[0]).toMatchObject({ nodeId: 'meeting', state: 'scheduled' })
    expect(snapshot.data.scheduleNodes[0].state).toBe('completed')
  })

  it.each(['record_application_submission', 'abandon_opportunity'] as const)('retains event and original write timestamps when replaying %s', kind => {
    const command = { commandId: `replay:${kind}`, kind, opportunityId: 'job', occurredAt: eventTime }
    const first = applyUserDomainCommand(empty(), command, now)
    if (first.status !== 'APPLIED') throw new Error(first.status)
    const original = structuredClone(first.snapshot)
    const replay = applyUserDomainCommand(first.snapshot, command, new Date('2026-10-08T15:00:00.000Z'))
    expect(replay.status).toBe('ALREADY_APPLIED')
    expect(replay.snapshot).toEqual(original)
    const receipts = replay.snapshot.data.timeline!.filter(item => item.commandId === command.commandId)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ occurredAt: eventTime, recordedAt: now.toISOString() })
  })
})
