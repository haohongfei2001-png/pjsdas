import { describe, expect, it } from 'vitest'
import {
  createSnapshot,
  parseSnapshotText,
  SNAPSHOT_SCHEMA,
  SNAPSHOT_VERSION,
} from '../src/snapshot.js'
import type { Action, Opportunity, ProcessEvent } from '../src/model.js'

const opportunity: Opportunity = {
  id: 'OPP-001',
  company: '测试公司',
  role: '产品经理',
  currentStageLabel: '面试',
  processStage: 'interview',
  roleType: 'core',
  early: false,
  opportunityValue: 94,
  fitScore: 76,
  importedAt: '2026-09-01T00:00:00.000Z',
}

const event: ProcessEvent = {
  id: 'evt-1',
  opportunityId: opportunity.id,
  company: opportunity.company,
  role: opportunity.role,
  type: 'interview_invite',
  occurredAt: '2026-09-10T01:00:00.000Z',
  dueAt: '2026-09-11T02:00:00.000Z',
  timingMode: 'fixed',
  estimatedMinutes: 90,
  source: 'manual',
  createdAt: '2026-09-10T01:00:00.000Z',
  updatedAt: '2026-09-10T01:00:00.000Z',
}

const action: Action = {
  id: 'event-action:evt-1',
  kind: 'manual',
  title: '参加 测试公司｜面试',
  opportunityId: opportunity.id,
  processEventId: event.id,
  processStage: 'interview',
  dueAt: event.dueAt,
  timingMode: 'fixed',
  estimatedMinutes: 90,
  leverage: 98,
  delayCost: 100,
  status: 'todo',
  sourceLabel: '流程事件',
  createdAt: event.createdAt,
  updatedAt: event.updatedAt,
}

function data() {
  return {
    opportunities: [opportunity],
    processes: [],
    processEvents: [event],
    actions: [action],
    prep: [],
    applicationGroups: [],
  }
}

describe('PJSDAS local snapshot', () => {
  it('round-trips a valid snapshot', () => {
    const snapshot = createSnapshot(data(), '2026-09-10T05:00:00.000Z')
    const restored = parseSnapshotText(JSON.stringify(snapshot))

    expect(restored.schema).toBe(SNAPSHOT_SCHEMA)
    expect(restored.version).toBe(SNAPSHOT_VERSION)
    expect(restored.data.processEvents[0].id).toBe(event.id)
    expect(restored.data.actions[0].status).toBe('todo')
  })

  it('creates v4 reminder arrays and upgrades a valid v3 snapshot without inventing reminders', () => {
    const current = createSnapshot(data(), '2026-09-10T05:00:00.000Z')
    expect(current.version).toBe(4)
    expect(current.data.reminderIntents).toEqual([])
    expect(current.data.reminderOutbox).toEqual([])

    const legacyV3 = structuredClone(current) as any
    legacyV3.version = 3
    delete legacyV3.data.reminderIntents
    delete legacyV3.data.reminderOutbox
    const restored = parseSnapshotText(JSON.stringify(legacyV3))
    expect(restored.version).toBe(4)
    expect(restored.data.reminderIntents).toEqual([])
    expect(restored.data.reminderOutbox).toEqual([])
  })

  it('accepts a balanced Gmail reconciliation proof and rejects an unbalanced settlement', () => {
    const snapshot = createSnapshot({
      ...data(),
      timeline: [{
        id: 'timeline:gmail-reconciliation:test',
        kind: 'gmail_reconciliation_completed',
        category: 'data',
        source: 'gmail',
        occurredAt: '2026-09-10T05:00:00.000Z',
        recordedAt: '2026-09-10T05:00:00.000Z',
        title: 'Gmail reconciliation',
        gmailReconciliation: {
          version: 1,
          scannedCount: 4,
          recruitingRelevantCount: 3,
          stateCounts: {
            NO_ACTION: 1,
            WAITING: 0,
            ACTION_REQUIRED: 1,
            COMPLETED: 0,
            EXPLICITLY_DECLINED: 0,
            CLOSED: 0,
            UNRESOLVED: 1,
          },
          gmailOnlyCount: 1,
          pjsdasOnlyCount: 0,
          fixedOrHardWithin7DaysCount: 1,
          liveProcessCount: 1,
          unavailableMessageCount: 0,
        },
      }],
    }, '2026-09-10T05:00:00.000Z')
    expect(parseSnapshotText(JSON.stringify(snapshot)).data.timeline?.[0].kind)
      .toBe('gmail_reconciliation_completed')

    const broken = structuredClone(snapshot)
    broken.data.timeline![0]!.gmailReconciliation!.stateCounts.NO_ACTION = 2
    expect(() => parseSnapshotText(JSON.stringify(broken))).toThrow(/Gmail reconciliation 未守恒/)
  })

  it('rejects unsupported versions before restore', () => {
    const snapshot = createSnapshot(data(), '2026-09-10T05:00:00.000Z')
    const broken = { ...snapshot, version: 99 }
    expect(() => parseSnapshotText(JSON.stringify(broken))).toThrow(/不支持的备份版本/)
  })

  it('rejects duplicate IDs', () => {
    const snapshot = createSnapshot(data(), '2026-09-10T05:00:00.000Z')
    const broken = {
      ...snapshot,
      data: {
        ...snapshot.data,
        opportunities: [opportunity, { ...opportunity }],
      },
    }
    expect(() => parseSnapshotText(JSON.stringify(broken))).toThrow(/ID 重复/)
  })

  it('allows an archived process event to outlive a removed opportunity', () => {
    const snapshot = createSnapshot(data(), '2026-09-10T05:00:00.000Z')
    const archival = {
      ...snapshot,
      data: {
        ...snapshot.data,
        opportunities: [],
      },
    }
    const restored = parseSnapshotText(JSON.stringify(archival))
    expect(restored.data.opportunities).toHaveLength(0)
    expect(restored.data.processEvents[0].company).toBe('测试公司')
    expect(restored.data.actions[0].processEventId).toBe(event.id)
  })

  it('still rejects an ordinary action whose opportunity is missing', () => {
    const snapshot = createSnapshot(data(), '2026-09-10T05:00:00.000Z')
    const ordinaryAction: Action = {
      ...action,
      id: 'apply:OPP-001',
      kind: 'apply',
      processEventId: undefined,
      timingMode: undefined,
    }
    const broken = {
      ...snapshot,
      data: {
        ...snapshot.data,
        opportunities: [],
        actions: [ordinaryAction],
      },
    }
    expect(() => parseSnapshotText(JSON.stringify(broken))).toThrow(/不存在的岗位/)
  })

  it('rejects a local action whose process event is missing', () => {
    const snapshot = createSnapshot(data(), '2026-09-10T05:00:00.000Z')
    const broken = {
      ...snapshot,
      data: {
        ...snapshot.data,
        processEvents: [],
      },
    }
    expect(() => parseSnapshotText(JSON.stringify(broken))).toThrow(/不存在的流程事件/)
  })
})
