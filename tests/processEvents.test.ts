import { describe, expect, it } from 'vitest'
import { buildTimePlan, rankActions } from '../src/decisionV2'
import {
  actionForProcessEvent,
  createProcessEvent,
  overlayProcessEventsOnOpportunities,
  overlayProcessEventsOnProcesses,
} from '../src/processEvents'
import type { Opportunity, ProcessEvent, ProcessRecord } from '../src/model'

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
    expect(projectedProcesses[0].stage).toBe('interview')
    expect(projectedProcesses[0].nextCheckAt).toBeUndefined()
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
})
