import { describe, expect, it } from 'vitest'
import { buildTimePlan, rankActions } from '../src/decisionV2'
import {
  actionForProcessEvent,
  createProcessEvent,
  overlayProcessEventsOnOpportunities,
  overlayProcessEventsOnProcesses,
  suppressSupersededActions,
} from '../src/processEvents'
import type { Action, Opportunity, ProcessEvent, ProcessRecord } from '../src/model'

const opportunity: Opportunity = {
  id: 'OPP-001',
  company: '测试公司',
  role: '产品经理',
  currentStageLabel: '筛选中',
  processStage: 'screening',
  roleType: 'core',
  early: false,
  opportunityValue: 94,
  fitScore: 76,
  importedAt: '2026-09-01T00:00:00.000Z',
}

function event(overrides: Partial<ProcessEvent> = {}): ProcessEvent {
  return {
    id: 'evt-1',
    opportunityId: opportunity.id,
    company: opportunity.company,
    role: opportunity.role,
    type: 'interview_invite',
    occurredAt: '2026-09-10T01:00:00.000Z',
    dueAt: '2026-09-10T08:00:00.000Z',
    estimatedMinutes: 90,
    source: 'manual',
    createdAt: '2026-09-10T01:00:00.000Z',
    updatedAt: '2026-09-10T01:00:00.000Z',
    ...overrides,
  }
}

function importedAction(kind: Action['kind'], id: string): Action {
  return {
    id,
    kind,
    title: id,
    opportunityId: opportunity.id,
    dueAt: '2026-09-12T15:59:59.000Z',
    estimatedMinutes: 20,
    leverage: 70,
    delayCost: 60,
    status: 'todo',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  }
}

describe('process event actions', () => {
  it('turns an actionable invite into a deadline-bearing action', () => {
    const created = createProcessEvent({
      opportunity,
      type: 'assessment_invite',
      occurredAt: '2026-09-10T01:00:00.000Z',
      dueAt: '2026-09-10T10:00:00.000Z',
      estimatedMinutes: 45,
    })
    const action = actionForProcessEvent(created)
    expect(action?.processEventId).toBe(created.id)
    expect(action?.processStage).toBe('assessment')
    expect(action?.dueAt).toBe('2026-09-10T10:00:00.000Z')
    expect(action?.sourceLabel).toBe('流程事件')
  })

  it('does not invent an action for an offer or rejection event', () => {
    expect(actionForProcessEvent(event({ type: 'offer' }))).toBeUndefined()
    expect(actionForProcessEvent(event({ type: 'rejection' }))).toBeUndefined()
  })

  it('protects a real interview deadline inside the time plan', () => {
    const action = actionForProcessEvent(event())!
    const now = new Date('2026-09-10T02:00:00.000Z')
    const ranked = rankActions([action], [opportunity], now)
    const plan = buildTimePlan(ranked, 60, now)

    expect(plan.planned.map((item) => item.action.id)).toContain(action.id)
    expect(plan.requiredTodayMinutes).toBe(90)
    expect(plan.overrunReason).toBe('today_deadlines')
  })
})

describe('process event projection', () => {
  const importedProcess: ProcessRecord = {
    id: 'pipeline:1',
    opportunityId: opportunity.id,
    company: opportunity.company,
    role: opportunity.role,
    stage: 'screening',
    stageLabel: '筛选中',
    lastProgressAt: '2026-09-05T00:00:00.000Z',
    nextCheckAt: '2026-09-12T00:00:00.000Z',
  }

  it('projects a newer event onto both Opportunity and Pipeline without mutating import data', () => {
    const latest = event()
    const projectedOpportunities = overlayProcessEventsOnOpportunities(
      [opportunity],
      [latest],
      [importedProcess],
    )
    const projectedProcesses = overlayProcessEventsOnProcesses(
      [importedProcess],
      [opportunity],
      [latest],
    )

    expect(projectedOpportunities[0].processStage).toBe('interview')
    expect(projectedOpportunities[0].currentStageLabel).toBe('面试')
    expect(projectedOpportunities[0].effectiveProcessEventId).toBe(latest.id)
    expect(projectedProcesses[0].stage).toBe('interview')
    expect(projectedProcesses[0].nextCheckAt).toBeUndefined()
    expect(projectedProcesses[0].effectiveProcessEventId).toBe(latest.id)
    expect(importedProcess.stage).toBe('screening')
  })

  it('does not let an older manually-entered event downgrade a newer imported pipeline state', () => {
    const older = event({ occurredAt: '2026-09-01T00:00:00.000Z' })
    const projected = overlayProcessEventsOnProcesses(
      [importedProcess],
      [opportunity],
      [older],
    )
    expect(projected[0].stage).toBe('screening')
    expect(projected[0].nextCheckAt).toBe('2026-09-12T00:00:00.000Z')
  })

  it('hides stale apply and follow-up actions once a newer real stage event exists', () => {
    const latest = event()
    const projectedOpportunity = overlayProcessEventsOnOpportunities(
      [opportunity],
      [latest],
      [importedProcess],
    )[0]
    const eventAction = actionForProcessEvent(latest)!
    const actions = [
      importedAction('apply', 'apply:OPP-001'),
      importedAction('follow_up', 'follow-up:1'),
      importedAction('prep', 'prep:shared'),
      eventAction,
    ]

    const visible = suppressSupersededActions(actions, [projectedOpportunity])
    expect(visible.map((item) => item.id)).toEqual(['prep:shared', eventAction.id])
  })

  it('keeps only the newest effective process-event action for one opportunity', () => {
    const assessment = event({
      id: 'evt-assessment',
      type: 'assessment_invite',
      occurredAt: '2026-09-08T01:00:00.000Z',
      dueAt: '2026-09-08T10:00:00.000Z',
      estimatedMinutes: 45,
    })
    const interview = event({ id: 'evt-interview' })
    const projectedOpportunity = overlayProcessEventsOnOpportunities(
      [opportunity],
      [assessment, interview],
      [importedProcess],
    )[0]

    const visible = suppressSupersededActions(
      [actionForProcessEvent(assessment)!, actionForProcessEvent(interview)!],
      [projectedOpportunity],
    )

    expect(projectedOpportunity.effectiveProcessEventId).toBe(interview.id)
    expect(visible.map((item) => item.processEventId)).toEqual([interview.id])
  })

  it('hides a local event action when the imported baseline is already newer', () => {
    const older = event({
      id: 'evt-old',
      occurredAt: '2026-09-01T00:00:00.000Z',
    })
    const projectedOpportunity = overlayProcessEventsOnOpportunities(
      [opportunity],
      [older],
      [importedProcess],
    )[0]
    const visible = suppressSupersededActions(
      [actionForProcessEvent(older)!],
      [projectedOpportunity],
    )

    expect(projectedOpportunity.effectiveProcessEventId).toBeUndefined()
    expect(visible).toHaveLength(0)
  })

  it('turns a completed process action into a waiting-for-result Pipeline state', () => {
    const assessment = event({
      id: 'evt-done',
      type: 'assessment_invite',
      occurredAt: '2026-09-10T01:00:00.000Z',
      dueAt: '2026-09-10T10:00:00.000Z',
      timingMode: 'deadline',
      estimatedMinutes: 45,
    })
    const completedAction: Action = {
      ...actionForProcessEvent(assessment)!,
      status: 'done',
    }

    const projected = overlayProcessEventsOnProcesses(
      [importedProcess],
      [opportunity],
      [assessment],
      [completedAction],
    )[0]

    expect(projected.stage).toBe('assessment')
    expect(projected.stageLabel).toBe('测评完成 · 等待结果')
    expect(projected.currentAction).toBeUndefined()
  })
})
