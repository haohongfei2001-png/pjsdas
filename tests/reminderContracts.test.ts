import { describe, expect, it } from 'vitest'
import type { ScheduleNode } from '../src/model.js'
import {
  buildReminderIntent,
  reminderDedupeKey,
  resolveReminderTrigger,
  validateReminderIntent,
  validateReminderOutbox,
} from '../src/reminders.js'
import { createSnapshot, validateSnapshot } from '../src/snapshot.js'

const node: ScheduleNode = {
  id: 'schedule:written-test-1:v1',
  occurrenceId: 'written-test-1',
  version: 1,
  kind: 'written_test',
  state: 'scheduled',
  temporal: {
    shape: 'fixed_range',
    precision: 'datetime',
    timezone: 'Asia/Shanghai',
    startAt: '2026-09-25T02:00:00.000Z',
    endAt: '2026-09-25T03:30:00.000Z',
    resolutionBasis: 'source_explicit',
  },
  constraintKind: 'employer_hard',
  evidenceRefs: ['source:test'],
  sourceVersionRefs: ['source:test:v1'],
  relatedActionIds: [],
  relatedPrepIds: [],
  createdAt: '2026-09-20T00:00:00.000Z',
  updatedAt: '2026-09-20T00:00:00.000Z',
}

function base() {
  return createSnapshot({
    opportunities: [],
    processes: [],
    processEvents: [],
    actions: [],
    scheduleNodes: [structuredClone(node)],
    prep: [],
    applicationGroups: [],
  }, '2026-09-20T00:00:00.000Z')
}

describe('UU-07 ReminderIntent contract', () => {
  it('derives a deterministic node-version-purpose dedupe key and exact offset trigger', () => {
    expect(reminderDedupeKey(node, 'upcoming')).toBe('schedule:written-test-1:v1@1|upcoming')
    expect(resolveReminderTrigger(node, { purpose: 'upcoming', offsetMinutesBefore: 30 }))
      .toBe('2026-09-25T01:30:00.000Z')
  })

  it('keeps exactly one delivery owner and degrades unsupported external task delivery truthfully', () => {
    const built = buildReminderIntent({
      node,
      purpose: 'prep',
      triggerAt: '2026-09-25T00:00:00.000Z',
      deliveryOwner: 'external_task',
      channel: 'task',
      capabilityStates: { chatgpt_tasks: 'unsupported' },
      now: '2026-09-20T00:00:00.000Z',
    })
    expect(built.reminder).toMatchObject({
      deliveryOwner: 'external_task',
      channel: 'task',
      capability: 'chatgpt_tasks',
      state: 'unsupported',
      externalLink: { state: 'failed', lastErrorCode: 'CAPABILITY_UNSUPPORTED' },
    })
    expect(built.outbox).toMatchObject({
      operation: 'upsert',
      capability: 'chatgpt_tasks',
      state: 'unsupported',
      receiptCode: 'CAPABILITY_UNSUPPORTED',
    })
    expect(() => buildReminderIntent({
      node,
      purpose: 'prep',
      triggerAt: '2026-09-25T00:00:00.000Z',
      deliveryOwner: 'external_task',
      channel: 'calendar',
      capabilityStates: { chatgpt_tasks: 'available' },
      now: '2026-09-20T00:00:00.000Z',
    })).toThrow(/single delivery owner|channel/i)
  })

  it('validates ReminderIntent/outbox references and rejects duplicate dedupe keys in Snapshot v4', () => {
    const snapshot = base()
    const built = buildReminderIntent({
      node,
      purpose: 'deadline',
      triggerAt: '2026-09-25T01:00:00.000Z',
      now: '2026-09-20T00:00:00.000Z',
    })
    snapshot.data.reminderIntents = [built.reminder]
    snapshot.data.reminderOutbox = []
    expect(validateReminderIntent(built.reminder, new Set([node.id]))).toEqual([])
    validateSnapshot(snapshot)

    const duplicate = structuredClone(built.reminder)
    duplicate.id = 'reminder:duplicate'
    snapshot.data.reminderIntents = [built.reminder, duplicate]
    expect(() => validateSnapshot(snapshot)).toThrow(/dedupeKey.*重复/)
  })

  it('does not invent a clock time for date-only schedule nodes', () => {
    const dateOnly = structuredClone(node)
    dateOnly.id = 'schedule:date-only:v1'
    dateOnly.occurrenceId = 'date-only'
    dateOnly.temporal = {
      shape: 'date_only',
      precision: 'date',
      timezone: 'Asia/Shanghai',
      date: '2026-09-25',
      resolutionBasis: 'source_explicit',
    }
    expect(() => resolveReminderTrigger(dateOnly, { purpose: 'deadline', offsetMinutesBefore: 60 }))
      .toThrow(/exact datetime/)
  })

  it('validates outbox back-references when external delivery is available', () => {
    const built = buildReminderIntent({
      node,
      purpose: 'upcoming',
      triggerAt: '2026-09-25T01:30:00.000Z',
      deliveryOwner: 'external_calendar',
      channel: 'calendar',
      capabilityStates: { google_calendar: 'available' },
      now: '2026-09-20T00:00:00.000Z',
    })
    expect(built.outbox?.state).toBe('pending')
    expect(validateReminderOutbox(built.outbox!, new Set([built.reminder.id]))).toEqual([])
  })
})
