import { describe, expect, it } from 'vitest'
import {
  defaultExternalCapabilityProbes,
  invokeExternalCapabilities,
  invokeListReminderIntents,
} from '../gateway/reminderTools.js'
import { createSnapshot } from '../src/snapshot.js'
import type { WorkspaceSource } from '../gateway/workspaceSource.js'

function source(): WorkspaceSource {
  const snapshot = createSnapshot({
    opportunities: [],
    processes: [],
    processEvents: [],
    actions: [],
    scheduleNodes: [{
      id: 'node-1',
      occurrenceId: 'occ-1',
      version: 1,
      kind: 'interview',
      state: 'scheduled',
      temporal: {
        shape: 'fixed_range',
        precision: 'datetime',
        timezone: 'Asia/Shanghai',
        startAt: '2026-09-25T02:00:00.000Z',
        endAt: '2026-09-25T03:00:00.000Z',
        resolutionBasis: 'source_explicit',
      },
      constraintKind: 'employer_hard',
      evidenceRefs: ['gmail:private-source-record'],
      sourceVersionRefs: [],
      relatedActionIds: [],
      relatedPrepIds: [],
      createdAt: '2026-09-20T00:00:00.000Z',
      updatedAt: '2026-09-20T00:00:00.000Z',
    }],
    reminderIntents: [{
      id: 'reminder-1',
      scheduleNodeId: 'node-1',
      scheduleNodeVersion: 1,
      purpose: 'upcoming',
      triggerAt: '2026-09-25T01:30:00.000Z',
      deliveryOwner: 'pjsdas',
      channel: 'in_product',
      state: 'active',
      dedupeKey: 'node-1@1|upcoming',
      createdAt: '2026-09-20T00:00:00.000Z',
      updatedAt: '2026-09-20T00:00:00.000Z',
    }],
    reminderOutbox: [],
    prep: [],
    applicationGroups: [],
  }, '2026-09-20T00:00:00.000Z')
  return {
    async read() {
      return {
        snapshot,
        context: { workspaceVersion: 'txn:7', timezone: 'Asia/Shanghai', now: new Date('2026-09-20T00:00:00.000Z') },
      }
    },
  }
}

describe('UU-07 reminder MCP read tools', () => {
  it('reports external delivery as unsupported unless PJSDAS itself has an authorized adapter', async () => {
    const probes = defaultExternalCapabilityProbes(new Date('2026-09-20T00:00:00.000Z'))
    expect(probes).toEqual([
      expect.objectContaining({ id: 'chatgpt_tasks', state: 'unsupported' }),
      expect.objectContaining({ id: 'google_calendar', state: 'unsupported' }),
    ])
    const result = await invokeExternalCapabilities({}, probes)
    expect(result.isError).not.toBe(true)
    expect(JSON.stringify(result.structuredContent)).toContain('delivery channels only')
    expect(JSON.stringify(result.structuredContent)).not.toContain('available\"')
  })

  it('lists bounded ReminderIntent state without exposing source evidence from the ScheduleNode', async () => {
    const result = await invokeListReminderIntents(source(), { limit: 10 })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({
      workspaceVersion: 'txn:7',
      reminders: [{
        id: 'reminder-1',
        scheduleNodeId: 'node-1',
        deliveryOwner: 'pjsdas',
        channel: 'in_product',
        state: 'active',
      }],
    })
    expect(JSON.stringify(result.structuredContent)).not.toContain('private-source-record')
  })
})
