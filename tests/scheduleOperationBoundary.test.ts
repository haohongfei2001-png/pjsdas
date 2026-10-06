import { describe, expect, it } from 'vitest'
import { action, opportunity, workspace } from '../e2e/fixtures/todayWorkspace.js'
import type { ScheduleNode, TimelineRecord, ProcessEvent } from '../src/model.js'
import { applyUserDomainCommand } from '../src/domainCommands.js'
import { buildScheduleStream, buildScheduleStreamNormalized } from '../src/schedule/scheduleStream.js'
import { invokeAddOpportunities } from '../gateway/addOpportunities.js'

const now = new Date('2026-10-06T12:00:00.000Z')
const eventTime = '2026-10-02T08:00:00.000Z'
const context = { accountKey: 'synthetic', workspaceRevision: '1', timezone: 'Asia/Shanghai', now }
const log = (id: string, kind: TimelineRecord['kind'], extra: Partial<TimelineRecord> = {}): TimelineRecord => ({
  id, kind, category: 'opportunity', source: 'user_action', occurredAt: now.toISOString(),
  recordedAt: now.toISOString(), title: id, opportunityId: 'job', ...extra,
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
    }, { opportunities: [{ company: '示例科技', role: '软件产品经理 P100｜2027校招', roleType: 'core',
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
    expect(stream.counts.history).toBe(4)
    expect(stream.sections.history.filter(item => item.processEventId === 'reject')).toHaveLength(1)
    expect(stream.sections.history.find(item => item.id === 'fact:submission-a')?.sourceRefs).toContain('timeline:submission-b')
  })

  it('links exact legacy progress identities without changing completion wording or inferring from it', () => {
    const snapshot = empty()
    snapshot.data.processEvents = [event('progress-event:legacy-completion', 'written_test_invite')]
    snapshot.data.timeline = [log('timeline:progress:legacy-completion', 'process_event_recorded', {
      source: 'natural_language', occurredAt: eventTime, title: '完成笔试',
    })]
    const original = structuredClone(snapshot)
    const stream = buildScheduleStream(snapshot, context)
    expect(stream.sections.history).toHaveLength(1)
    expect(stream.sections.history[0]).toMatchObject({ id: 'process:progress-event:legacy-completion', title: '完成笔试', occurredAt: eventTime })
    expect(stream.sections.history[0].sourceRefs).toContain('timeline:timeline:progress:legacy-completion')
    expect(stream.sections.history[0].state).toBeUndefined()
    expect(snapshot).toEqual(original)
  })

  it('does not collapse invalid legacy event times by comparing two missing parsed values', () => {
    const snapshot = empty()
    snapshot.data.processEvents = [{ ...event('progress-event:legacy-unknown'), occurredAt: 'invalid-event-time' }]
    snapshot.data.timeline = [log('timeline:progress:legacy-unknown', 'process_event_recorded', { occurredAt: 'different-invalid-time' })]
    const stream = buildScheduleStreamNormalized(snapshot, context)
    expect(stream.sections.undated).toHaveLength(2)
    expect(stream.sections.history).toEqual([])
  })

  it.each(['done', 'skipped'] as const)('does not turn a %s checkbox into application or test attendance', status => {
    let snapshot = empty()
    snapshot.data.actions = [{ ...action('apply:job', '投递', 'job'), kind: 'apply', dueAt: '2026-10-07T08:00:00.000Z' },
      { ...action('test-task', '完成笔试', 'job'), processEventId: 'test' }]
    snapshot.data.processEvents = [{ ...event('test', 'written_test_invite'), dueAt: '2026-10-07T08:00:00.000Z' }]
    for (const actionId of ['apply:job', 'test-task']) {
      const result = applyUserDomainCommand(snapshot, { commandId: `checkbox:${actionId}`, kind: 'set_action_status', actionId, status }, now)
      if (result.status !== 'APPLIED') throw new Error(result.status)
      snapshot = result.snapshot
    }
    const original = structuredClone(snapshot)
    const stream = buildScheduleStream(snapshot, context)
    expect(stream.sections.history.map(item => item.id)).toEqual(['process:test'])
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
    expect(stream.sections.history.map(item => item.id)).toEqual(['process:interview', 'node:meeting'])
    expect(stream.sections.history[1]).toMatchObject({ state: 'completed', occurredAt: '2026-10-05T08:00:00.000Z' })
    expect(stream.sections.history[1].sourceRefs.some(ref => ref.startsWith('timeline:'))).toBe(true)
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
    snapshot.data.scheduleNodes = [node('unknown', { state: 'completed' }), node('prep', { kind: 'prep_trigger', state: 'completed', completedAt: eventTime })]
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
    expect(stream.sections.undated).toHaveLength(2)
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
