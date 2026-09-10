import { describe, expect, it } from 'vitest'
import { buildTimePlan, rankActions } from '../src/decisionV3'
import { parseRecruitingNotification } from '../src/notificationParser'
import {
  actionForProcessEvent,
  createProcessEvent,
  overlayProcessEventsOnOpportunities,
  overlayProcessEventsOnProcesses,
} from '../src/processEvents'
import type { Opportunity } from '../src/model'

const opportunity: Opportunity = {
  id: 'SMIC-PM',
  company: '中芯国际',
  role: '产学研合作/政府项目管理',
  currentStageLabel: '筛选中',
  processStage: 'screening',
  roleType: 'core',
  early: false,
  opportunityValue: 94,
  fitScore: 76,
  importedAt: '2026-09-01T00:00:00.000Z',
}

describe('pasted notification integration flow', () => {
  it('flows from parsed text to Process Event, Pipeline projection and Today planning', () => {
    const now = new Date(2026, 8, 10, 13, 0, 0)
    const parsed = parseRecruitingNotification(
      '中芯国际 产学研合作/政府项目管理：请于9月11日23:59前完成在线测评。',
      [opportunity],
      now,
    )

    expect(parsed.opportunity?.id).toBe(opportunity.id)
    expect(parsed.type).toBe('assessment_invite')
    expect(parsed.timingMode).toBe('deadline')
    expect(parsed.dueAt).toBeDefined()

    const event = createProcessEvent({
      opportunity: parsed.opportunity!,
      type: parsed.type!,
      occurredAt: now.toISOString(),
      dueAt: parsed.dueAt,
      timingMode: parsed.timingMode,
      estimatedMinutes: parsed.estimatedMinutes,
      source: 'manual',
    })
    const action = actionForProcessEvent(event)
    expect(action).toBeDefined()

    const projectedOpportunities = overlayProcessEventsOnOpportunities(
      [opportunity],
      [event],
      [],
    )
    expect(projectedOpportunities[0].processStage).toBe('assessment')
    expect(projectedOpportunities[0].currentStageLabel).toBe('测评')

    const projectedProcesses = overlayProcessEventsOnProcesses(
      [],
      [opportunity],
      [event],
      [action!],
    )
    expect(projectedProcesses).toHaveLength(1)
    expect(projectedProcesses[0].stage).toBe('assessment')
    expect(projectedProcesses[0].currentAction).toContain('测评')

    const ranked = rankActions([action!], projectedOpportunities, now)
    expect(ranked.map((item) => item.action.id)).toEqual([action!.id])

    const plan = buildTimePlan(ranked, 180, now)
    expect(plan.planned.map((item) => item.action.id)).toContain(action!.id)
  })
})
