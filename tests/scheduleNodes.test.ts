import { describe, expect, it } from 'vitest'
import type {
  Action,
  Opportunity,
  ProcessEvent,
  ProcessRecord,
  ScheduleNode,
} from '../src/model.js'
import {
  effectiveScheduleNodeState,
  supersedeScheduleOccurrence,
  validateScheduleNode,
} from '../src/scheduleNodes.js'
import {
  parseSnapshotText,
  upgradeSnapshotToLatest,
  type PJSDASSnapshot,
} from '../src/snapshot.js'

function opportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    id: 'opp-1',
    company: 'Example Co',
    role: 'Product Manager',
    currentStageLabel: '笔试',
    processStage: 'written_test',
    roleType: 'core',
    participationStatus: 'active',
    early: false,
    opportunityValue: 80,
    fitScore: 80,
    importedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

function process(overrides: Partial<ProcessRecord> = {}): ProcessRecord {
  return {
    id: 'process-1',
    opportunityId: 'opp-1',
    company: 'Example Co',
    role: 'Product Manager',
    stage: 'written_test',
    stageLabel: '笔试',
    lastProgressAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  }
}

function event(id: string, dueAt: string, overrides: Partial<ProcessEvent> = {}): ProcessEvent {
  return {
    id,
    opportunityId: 'opp-1',
    company: 'Example Co',
    role: 'Product Manager',
    type: 'written_test_invite',
    occurredAt: '2026-09-10T00:00:00.000Z',
    dueAt,
    duePrecision: 'datetime',
    timingMode: 'fixed',
    estimatedMinutes: 90,
    source: 'manual',
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  }
}

function actionFor(eventId: string, dueAt: string, status: Action['status'] = 'todo'): Action {
  return {
    id: `event-action:${eventId}`,
    kind: 'manual',
    title: 'Complete written test',
    opportunityId: 'opp-1',
    processEventId: eventId,
    processStage: 'written_test',
    dueAt,
    duePrecision: 'datetime',
    timingMode: 'fixed',
    estimatedMinutes: 90,
    leverage: 95,
    delayCost: 95,
    status,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
  }
}

function legacySnapshot(input: {
  opportunity?: Opportunity
  processes?: ProcessRecord[]
  events?: ProcessEvent[]
  actions?: Action[]
} = {}): PJSDASSnapshot {
  return {
    schema: 'pjsdas-local-snapshot',
    version: 1,
    exportedAt: '2026-09-10T12:00:00.000Z',
    data: {
      opportunities: [input.opportunity ?? opportunity()],
      processes: input.processes ?? [process()],
      processEvents: input.events ?? [],
      actions: input.actions ?? [],
      prep: [],
      applicationGroups: [],
      timeline: [{
        id: 'timeline-history-1',
        kind: 'process_event_recorded',
        category: 'process',
        source: 'system',
        occurredAt: '2026-09-09T00:00:00.000Z',
        recordedAt: '2026-09-09T00:00:00.000Z',
        title: 'Historical fact',
      }],
    },
  }
}

function replacement(occurrenceId: string, startAt: string, updatedAt: string): Omit<ScheduleNode, 'id' | 'version' | 'supersedesNodeId' | 'supersededByNodeId'> {
  return {
    occurrenceId,
    opportunityId: 'opp-1',
    kind: 'interview',
    state: 'scheduled',
    temporal: {
      shape: 'fixed_range',
      precision: 'datetime',
      timezone: 'Asia/Shanghai',
      startAt,
      endAt: new Date(new Date(startAt).getTime() + 60 * 60_000).toISOString(),
      resolutionBasis: 'source_explicit',
      legacyProjectionAt: startAt,
    },
    constraintKind: 'employer_hard',
    estimatedMinutes: 60,
    estimateProvenance: 'source',
    evidenceRefs: ['mail:1'],
    sourceVersionRefs: [`mail:1:${updatedAt}`],
    relatedActionIds: [],
    relatedPrepIds: [],
    createdAt: updatedAt,
    updatedAt,
  }
}

describe('UU-01 ScheduleNode contract', () => {
  it('migrates a date-only application deadline without inventing a clock time', () => {
    const legacy = legacySnapshot({
      opportunity: opportunity({
        processStage: 'not_applied',
        currentStageLabel: '待投',
        deadline: '2026-09-22T23:59:59.000Z',
        deadlinePrecision: 'date',
      }),
      processes: [],
      actions: [{
        id: 'apply:opp-1',
        kind: 'apply',
        title: 'Apply',
        opportunityId: 'opp-1',
        processStage: 'not_applied',
        dueAt: '2026-09-22T23:59:59.000Z',
        duePrecision: 'date',
        timingMode: 'deadline',
        estimatedMinutes: 30,
        leverage: 80,
        delayCost: 80,
        status: 'todo',
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      }],
    })
    const migrated = upgradeSnapshotToLatest(legacy)
    const node = migrated.data.scheduleNodes?.find((item) => item.kind === 'application_deadline')
    expect(migrated.version).toBe(4)
    expect(node?.temporal).toMatchObject({
      shape: 'date_only',
      precision: 'date',
      date: '2026-09-22',
      timezone: 'floating-date',
    })
    expect(node?.temporal.deadlineAt).toBeUndefined()
    expect(node?.temporal.startAt).toBeUndefined()
    expect(node?.temporal.endAt).toBeUndefined()
    expect(migrated.data.opportunities[0]?.deadline).toBe('2026-09-22T23:59:59.000Z')
  })

  it('preserves explicit timezone offsets across a DST fold and rejects ambiguous floating datetimes', () => {
    const node: ScheduleNode = {
      ...replacement('interview:dst', '2026-11-01T01:30:00-04:00', '2026-10-20T00:00:00.000Z'),
      id: 'schedule:interview:dst:v1',
      version: 1,
      temporal: {
        shape: 'fixed_range',
        precision: 'datetime',
        timezone: 'America/New_York',
        startAt: '2026-11-01T01:30:00-04:00',
        endAt: '2026-11-01T01:30:00-05:00',
        resolutionBasis: 'source_explicit',
      },
    }
    expect(validateScheduleNode(node)).toEqual([])
    expect(new Date(node.temporal.endAt!).getTime() - new Date(node.temporal.startAt!).getTime()).toBe(60 * 60_000)

    const ambiguous = structuredClone(node)
    ambiguous.temporal.startAt = '2026-11-01T01:30:00'
    expect(validateScheduleNode(ambiguous)).toContain('Fixed ScheduleNode requires an offset-aware startAt.')
  })

  it('accepts an explicit latest-start inside an availability window and rejects it outside the window', () => {
    const node: ScheduleNode = {
      ...replacement('written:window', '2026-09-23T18:00:00+08:00', '2026-09-21T12:28:00.000Z'),
      id: 'schedule:written:window:v1',
      version: 1,
      kind: 'written_test',
      temporal: {
        shape: 'availability_window',
        precision: 'datetime',
        timezone: 'Asia/Shanghai',
        startAt: '2026-09-23T18:00:00+08:00',
        endAt: '2026-09-23T20:00:00+08:00',
        latestStartAt: '2026-09-23T18:20:00+08:00',
        resolutionBasis: 'source_explicit',
      },
    }
    expect(validateScheduleNode(node)).toEqual([])
    const invalid = structuredClone(node)
    invalid.temporal.latestStartAt = '2026-09-23T20:30:00+08:00'
    expect(validateScheduleNode(invalid)).toContain('ScheduleNode latestStartAt exceeds endAt.')
  })

  it('keeps multiple rounds for the same opportunity as separate occurrences', () => {
    const first = event('round-1', '2026-09-12T02:00:00.000Z', { type: 'interview_invite' })
    const second = event('round-2', '2026-09-18T02:00:00.000Z', {
      type: 'interview_invite',
      occurredAt: '2026-09-15T00:00:00.000Z',
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:00.000Z',
    })
    const migrated = upgradeSnapshotToLatest(legacySnapshot({
      events: [first, second],
      actions: [
        { ...actionFor(first.id, first.dueAt!), processStage: 'interview' },
        { ...actionFor(second.id, second.dueAt!), processStage: 'interview' },
      ],
      processes: [process({ stage: 'interview', stageLabel: '面试' })],
    }))
    const interviews = migrated.data.scheduleNodes?.filter((item) => item.kind === 'interview') ?? []
    expect(interviews).toHaveLength(2)
    expect(new Set(interviews.map((item) => item.occurrenceId)).size).toBe(2)
    expect(interviews.map((item) => item.processEventId)).toEqual(expect.arrayContaining(['round-1', 'round-2']))
  })

  it('projects an elapsed fixed event as unresolved instead of completed', () => {
    const migrated = upgradeSnapshotToLatest(legacySnapshot({
      events: [event('elapsed', '2026-09-10T02:00:00.000Z')],
      actions: [actionFor('elapsed', '2026-09-10T02:00:00.000Z')],
    }))
    const node = migrated.data.scheduleNodes?.find((item) => item.processEventId === 'elapsed')
    expect(node?.state).toBe('scheduled')
    expect(effectiveScheduleNodeState(node!, new Date('2026-09-10T04:00:00.000Z'))).toBe('elapsed_unresolved')
    expect(node?.completedAt).toBeUndefined()
  })

  it('supersedes a node version while retaining one stable occurrence identity and history', () => {
    const nodes: ScheduleNode[] = []
    const first = supersedeScheduleOccurrence(nodes, replacement(
      'interview:stable-occurrence',
      '2026-09-22T02:00:00.000Z',
      '2026-09-20T00:00:00.000Z',
    ))
    const second = supersedeScheduleOccurrence(nodes, replacement(
      'interview:stable-occurrence',
      '2026-09-23T03:00:00.000Z',
      '2026-09-21T00:00:00.000Z',
    ))
    expect(first.occurrenceId).toBe(second.occurrenceId)
    expect(first.version).toBe(1)
    expect(second.version).toBe(2)
    expect(first.state).toBe('superseded')
    expect(first.supersededByNodeId).toBe(second.id)
    expect(second.supersedesNodeId).toBe(first.id)
    expect(nodes).toHaveLength(2)
  })

  it('separates written-test completion from the overall recruiting process result', () => {
    const written = event('written-1', '2026-09-12T02:00:00.000Z')
    const migrated = upgradeSnapshotToLatest(legacySnapshot({
      events: [written],
      actions: [actionFor(written.id, written.dueAt!, 'done')],
    }))
    expect(migrated.data.processes[0]).toMatchObject({
      stage: 'written_test',
      progress: 'waiting_result',
      result: 'pending',
      participationState: 'active',
    })
    expect(migrated.data.scheduleNodes?.find((item) => item.processEventId === written.id)).toMatchObject({
      state: 'completed',
    })
  })

  it('round-trips v1 history into the latest snapshot without losing timeline or event identity', () => {
    const written = event('roundtrip', '2026-09-12T02:00:00.000Z')
    const restored = parseSnapshotText(JSON.stringify(legacySnapshot({
      events: [written],
      actions: [actionFor(written.id, written.dueAt!)],
    })))
    expect(restored.version).toBe(4)
    expect(restored.data.timeline?.map((item) => item.id)).toContain('timeline-history-1')
    expect(restored.data.processEvents[0]?.id).toBe('roundtrip')
    expect(restored.data.scheduleNodes?.some((item) => item.processEventId === 'roundtrip')).toBe(true)
  })
})
