import { describe, expect, it } from 'vitest'
import { applyUserDomainCommand } from '../src/domainCommands.js'
import { rankActions } from '../src/decisionV3.js'
import type { Opportunity } from '../src/model.js'
import type { PJSDASSnapshot } from '../src/snapshot.js'

function opportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    id: 'opp-1',
    company: 'Example Co',
    role: 'Product Manager',
    currentStageLabel: '待投',
    processStage: 'not_applied',
    roleType: 'core',
    early: false,
    opportunityValue: 50,
    fitScore: 50,
    assessmentStatus: 'unassessed',
    locallyManaged: true,
    importedAt: '2026-09-19T00:00:00.000Z',
    ...overrides,
  }
}

function snapshot(): PJSDASSnapshot {
  return {
    schema: 'pjsdas-local-snapshot',
    version: 1,
    exportedAt: '2026-09-19T00:00:00.000Z',
    data: {
      opportunities: [opportunity()],
      processes: [],
      processEvents: [],
      actions: [{
        id: 'apply:opp-1',
        kind: 'apply',
        title: '投递 Example Co｜Product Manager',
        opportunityId: 'opp-1',
        processStage: 'not_applied',
        estimatedMinutes: 45,
        leverage: 80,
        delayCost: 40,
        status: 'todo',
        createdAt: '2026-09-19T00:00:00.000Z',
        updatedAt: '2026-09-19T00:00:00.000Z',
      }],
      prep: [],
      applicationGroups: [],
      timeline: [],
    },
  }
}

describe('bounded explicit user domain commands', () => {
  it('records an application and completes the apply action without inventing a new Opportunity', () => {
    const result = applyUserDomainCommand(snapshot(), {
      commandId: 'cmd-application-1',
      kind: 'record_application_submission',
      opportunityId: 'opp-1',
      occurredAt: '2026-09-19T03:00:00.000Z',
    }, new Date('2026-09-19T03:00:00.000Z'))

    expect(result.status).toBe('APPLIED')
    if (result.status !== 'APPLIED') return
    expect(result.snapshot.data.opportunities[0]).toMatchObject({
      id: 'opp-1',
      processStage: 'screening',
      currentStageLabel: '筛选中',
      participationStatus: 'active',
    })
    expect(result.snapshot.data.actions[0]).toMatchObject({ status: 'done' })
    expect(result.snapshot.data.processes[0]).toMatchObject({
      opportunityId: 'opp-1',
      stage: 'screening',
    })
    expect(result.snapshot.data.timeline?.[0]).toMatchObject({
      kind: 'application_submitted',
      commandId: 'cmd-application-1',
      commandOperation: 'record_application_submission',
    })
  })

  it('records a process event with explicit date precision and produces the linked Action', () => {
    const result = applyUserDomainCommand(snapshot(), {
      commandId: 'cmd-interview-1',
      kind: 'record_process_event',
      opportunityId: 'opp-1',
      eventType: 'interview_invite',
      dueAt: '2026-09-22T15:00:00.000Z',
      duePrecision: 'datetime',
    }, new Date('2026-09-19T03:00:00.000Z'))

    expect(result.status).toBe('APPLIED')
    if (result.status !== 'APPLIED') return
    const event = result.snapshot.data.processEvents[0]!
    expect(event).toMatchObject({
      id: expect.stringMatching(/^user-event:/),
      opportunityId: 'opp-1',
      type: 'interview_invite',
      duePrecision: 'datetime',
    })
    expect(result.snapshot.data.actions[1]).toMatchObject({
      processEventId: event.id,
      duePrecision: 'datetime',
      status: 'todo',
    })
  })

  it('preserves date-only deadline precision and stores the correction as user-asserted fact', () => {
    const result = applyUserDomainCommand(snapshot(), {
      commandId: 'cmd-deadline-1',
      kind: 'set_deadline',
      opportunityId: 'opp-1',
      deadline: '2026-09-22',
      precision: 'date',
    }, new Date('2026-09-19T03:00:00.000Z'))

    expect(result.status).toBe('APPLIED')
    if (result.status !== 'APPLIED') return
    expect(result.snapshot.data.opportunities[0]).toMatchObject({
      deadline: '2026-09-22',
      deadlinePrecision: 'date',
      detail: {
        userFacts: {
          provenance: 'user_asserted',
          deadline: '2026-09-22',
          deadlinePrecision: 'date',
        },
      },
    })
    expect(result.snapshot.data.actions[0]).toMatchObject({
      dueAt: '2026-09-22',
      duePrecision: 'date',
    })
  })

  it('marks abandonment as user participation state without closing the recruiting process', () => {
    const base = snapshot()
    base.data.opportunities[0]!.processStage = 'screening'
    base.data.opportunities[0]!.currentStageLabel = '筛选中'
    const result = applyUserDomainCommand(base, {
      commandId: 'cmd-abandon-1',
      kind: 'abandon_opportunity',
      opportunityId: 'opp-1',
    }, new Date('2026-09-19T03:00:00.000Z'))

    expect(result.status).toBe('APPLIED')
    if (result.status !== 'APPLIED') return
    expect(result.snapshot.data.opportunities[0]).toMatchObject({
      processStage: 'screening',
      currentStageLabel: '筛选中',
      participationStatus: 'abandoned',
    })
    expect(result.snapshot.data.actions[0]).toMatchObject({ status: 'skipped' })
    expect(result.snapshot.data.timeline?.[0]).toMatchObject({
      title: '放弃岗位',
      changes: { participationStatus: { before: 'active', after: 'abandoned' } },
    })
  })

  it('suppresses abandoned opportunity actions from Today ranking without deleting them', () => {
    const base = snapshot()
    base.data.opportunities[0]!.participationStatus = 'abandoned'
    const ranked = rankActions(base.data.actions, base.data.opportunities, new Date('2026-09-19T03:00:00.000Z'))
    expect(ranked).toHaveLength(0)
    expect(base.data.actions).toHaveLength(1)
  })

  it('is idempotent by commandId before mutating a second time', () => {
    const first = applyUserDomainCommand(snapshot(), {
      commandId: 'cmd-pref-1',
      kind: 'set_opportunity_preference',
      opportunityId: 'opp-1',
      roleType: 'reach',
    }, new Date('2026-09-19T03:00:00.000Z'))
    expect(first.status).toBe('APPLIED')
    if (first.status !== 'APPLIED') return

    const second = applyUserDomainCommand(first.snapshot, {
      commandId: 'cmd-pref-1',
      kind: 'set_opportunity_preference',
      opportunityId: 'opp-1',
      roleType: 'reach',
    }, new Date('2026-09-19T03:01:00.000Z'))
    expect(second.status).toBe('ALREADY_APPLIED')
    expect(second.snapshot.data.timeline).toHaveLength(1)
  })

  it('requires confirmation before reactivating an explicitly abandoned opportunity via application submission', () => {
    const base = snapshot()
    base.data.opportunities[0]!.participationStatus = 'abandoned'
    const result = applyUserDomainCommand(base, {
      commandId: 'cmd-app-after-abandon',
      kind: 'record_application_submission',
      opportunityId: 'opp-1',
    }, new Date('2026-09-19T03:00:00.000Z'))
    expect(result).toMatchObject({
      status: 'NEEDS_CONFIRMATION',
      reason: 'TARGET_ABANDONED',
    })
    expect(result.snapshot.data.opportunities[0]?.processStage).toBe('not_applied')
  })
})
