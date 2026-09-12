import { describe, expect, it } from 'vitest'
import { createDefaultDecisionRules } from '../src/decisionRules.js'
import { listOpportunities, getPipeline, getTodayPlan } from '../src/ai/readLayer.js'
import { actionForProcessEvent } from '../src/processEvents.js'
import { createSnapshot } from '../src/snapshot.js'
import type { Action, Opportunity, ProcessEvent, ProcessRecord } from '../src/model.js'

const NOW = new Date('2026-09-12T12:00:00.000Z')

describe('AI read consistency after process-task completion', () => {
  it('reports a completed JD assessment consistently and removes it from Today', () => {
    const opportunity: Opportunity = {
      id: 'JD-PM',
      company: '京东',
      role: '技术产品经理',
      currentStageLabel: '筛选中',
      processStage: 'screening',
      roleType: 'core',
      early: false,
      opportunityValue: 90,
      fitScore: 75,
      importedAt: '2026-09-10T00:00:00.000Z',
    }
    const process: ProcessRecord = {
      id: 'process-jd',
      opportunityId: opportunity.id,
      company: opportunity.company,
      role: opportunity.role,
      stage: 'screening',
      stageLabel: '筛选中',
      lastProgressAt: '2026-09-10T02:00:00.000Z',
    }
    const event: ProcessEvent = {
      id: 'jd-assessment',
      opportunityId: opportunity.id,
      company: opportunity.company,
      role: opportunity.role,
      type: 'assessment_invite',
      occurredAt: '2026-09-11T02:00:00.000Z',
      dueAt: '2026-09-12T15:59:59.000Z',
      timingMode: 'deadline',
      estimatedMinutes: 45,
      source: 'manual',
      createdAt: '2026-09-11T02:00:00.000Z',
      updatedAt: '2026-09-11T02:00:00.000Z',
    }
    const action: Action = { ...actionForProcessEvent(event)!, status: 'done', updatedAt: '2026-09-12T10:00:00.000Z' }
    const snapshot = createSnapshot({
      opportunities: [opportunity],
      processes: [process],
      processEvents: [event],
      actions: [action],
      prep: [],
      applicationGroups: [],
      decisionRules: createDefaultDecisionRules('2026-09-10T12:00:00.000Z'),
      timeline: [],
      changeSets: [],
    }, NOW.toISOString())

    const opportunityRead = listOpportunities(snapshot, {}, { now: NOW })
    const pipelineRead = getPipeline(snapshot, {}, { now: NOW })
    const todayRead = getTodayPlan(snapshot, { availableMinutes: 180 }, { now: NOW })

    expect(opportunityRead.opportunities[0]).toMatchObject({
      opportunityId: 'JD-PM',
      stage: 'assessment',
      stageLabel: '测评完成 · 等待结果',
    })
    expect(pipelineRead.processes[0]).toMatchObject({
      opportunityId: 'JD-PM',
      stage: 'assessment',
      stageLabel: '测评完成 · 等待结果',
      currentAction: undefined,
    })
    expect(todayRead.startableActions.some((item) => item.actionId === 'event-action:jd-assessment')).toBe(false)
  })
})
