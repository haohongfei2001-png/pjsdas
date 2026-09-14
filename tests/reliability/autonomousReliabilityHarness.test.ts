import { describe, expect, it } from 'vitest'
import {
  applyGmailIngestionHardened,
  applyMonitorIngestionHardened,
} from '../../src/ingestionHardening.js'
import type { MonitorJobObservation } from '../../src/autonomousIngestion.js'
import {
  projectReliabilityState,
  reliabilityAction,
  reliabilityOpportunity,
  reliabilitySnapshot,
} from './harness.js'

function monitorObservation(overrides: Partial<MonitorJobObservation> = {}): MonitorJobObservation {
  return {
    sourceRecordId: 'job-1',
    company: '示例科技',
    role: 'AI产品经理',
    sourceUrl: 'https://careers.example.com/jobs/123?utm_source=monitor',
    sourceTitle: 'AI产品经理',
    location: '北京',
    rationale: 'source-backed reliability scenario',
    roleType: 'core',
    opportunityValue: 82,
    fitScore: 78,
    fitConfidence: 'high',
    opportunityValueConfidence: 'high',
    postingStatus: 'open',
    discoveredAt: '2026-09-14T01:01:00.000Z',
    ...overrides,
  }
}

describe('v1.10 autonomous reliability harness', () => {
  it('converges Monitor + tracking variant + Gmail lifecycle into one canonical job and one logical process event', () => {
    const firstMonitor = applyMonitorIngestionHardened(reliabilitySnapshot(), {
      runId: 'monitor-a-run',
      sourceId: 'monitor:a',
      startedAt: '2026-09-14T01:00:00.000Z',
      completedAt: '2026-09-14T01:05:00.000Z',
      observations: [monitorObservation({ sourceRecordId: 'monitor-a-job' })],
    })

    const secondMonitor = applyMonitorIngestionHardened(firstMonitor.snapshot, {
      runId: 'monitor-b-run',
      sourceId: 'monitor:b',
      startedAt: '2026-09-14T02:00:00.000Z',
      completedAt: '2026-09-14T02:05:00.000Z',
      observations: [monitorObservation({
        sourceRecordId: 'monitor-b-job',
        sourceUrl: 'https://careers.example.com/jobs/123?utm_campaign=fall&ref=chatgpt',
        discoveredAt: '2026-09-14T02:01:00.000Z',
      })],
    })

    const invited = applyGmailIngestionHardened(secondMonitor.snapshot, {
      runId: 'gmail-invite-run',
      sourceId: 'gmail:primary',
      startedAt: '2026-09-14T03:00:00.000Z',
      completedAt: '2026-09-14T03:05:00.000Z',
      messages: [{
        sourceRecordId: 'gmail-invite',
        receivedAt: '2026-09-14T03:01:00.000Z',
        classification: 'recruiting',
        confidence: 'high',
        company: '示例科技',
        role: 'AI产品经理',
        eventType: 'assessment_invite',
        eventKey: 'example-ai-pm-assessment-fall',
        eventState: 'scheduled',
        stage: 'assessment',
        dueAt: '2026-09-18T12:00:00.000Z',
        timingMode: 'deadline',
      }],
    })

    const completed = applyGmailIngestionHardened(invited.snapshot, {
      runId: 'gmail-complete-run',
      sourceId: 'gmail:primary',
      startedAt: '2026-09-14T04:00:00.000Z',
      completedAt: '2026-09-14T04:05:00.000Z',
      messages: [{
        sourceRecordId: 'gmail-complete',
        receivedAt: '2026-09-14T04:01:00.000Z',
        classification: 'recruiting',
        confidence: 'high',
        company: '示例科技',
        role: 'AI产品经理',
        eventType: 'assessment_invite',
        eventKey: 'example-ai-pm-assessment-fall',
        eventState: 'completed',
        stage: 'assessment',
      }],
    })

    expect(projectReliabilityState(completed.snapshot)).toEqual({
      opportunities: [{
        company: '示例科技',
        role: 'AI产品经理',
        location: '北京',
        processStage: 'assessment',
        canonicalSourceUrl: 'https://careers.example.com/jobs/123',
      }],
      processEvents: [{
        company: '示例科技',
        role: 'AI产品经理',
        type: 'assessment_invite',
        dueAt: '2026-09-18T12:00:00.000Z',
        timingMode: 'deadline',
      }],
      actions: [
        {
          kind: 'apply',
          status: 'todo',
          processStage: 'not_applied',
          dueAt: undefined,
          eventLinked: false,
        },
        {
          kind: 'manual',
          status: 'done',
          processStage: 'assessment',
          dueAt: '2026-09-18T12:00:00.000Z',
          eventLinked: true,
        },
      ],
      ingestionRuns: [
        {
          sourceKind: 'gmail', sourceId: 'gmail:primary', runId: 'gmail-complete-run',
          receivedCount: 1, accountedCount: 1, outcomes: { updated: 1 },
        },
        {
          sourceKind: 'gmail', sourceId: 'gmail:primary', runId: 'gmail-invite-run',
          receivedCount: 1, accountedCount: 1, outcomes: { updated: 1 },
        },
        {
          sourceKind: 'gpt_monitor', sourceId: 'monitor:a', runId: 'monitor-a-run',
          receivedCount: 1, accountedCount: 1, outcomes: { created: 1 },
        },
        {
          sourceKind: 'gpt_monitor', sourceId: 'monitor:b', runId: 'monitor-b-run',
          receivedCount: 1, accountedCount: 1, outcomes: { duplicate: 1 },
        },
      ],
      integrity: { status: 'healthy', criticalCount: 0, warningCount: 0, issueCodes: [] },
    })
  })

  it('keeps same-company same-role postings in different explicit locations as distinct logical opportunities', () => {
    const beijing = applyMonitorIngestionHardened(reliabilitySnapshot(), {
      runId: 'location-beijing-run',
      sourceId: 'monitor:location',
      startedAt: '2026-09-14T05:00:00.000Z',
      completedAt: '2026-09-14T05:05:00.000Z',
      observations: [monitorObservation({
        sourceRecordId: 'location-beijing',
        sourceUrl: 'https://careers.example.com/jobs/beijing-ai-pm',
        location: '北京',
        discoveredAt: '2026-09-14T05:01:00.000Z',
      })],
    })
    const shanghai = applyMonitorIngestionHardened(beijing.snapshot, {
      runId: 'location-shanghai-run',
      sourceId: 'monitor:location',
      startedAt: '2026-09-14T06:00:00.000Z',
      completedAt: '2026-09-14T06:05:00.000Z',
      observations: [monitorObservation({
        sourceRecordId: 'location-shanghai',
        sourceUrl: 'https://careers.example.com/jobs/shanghai-ai-pm',
        location: '上海',
        discoveredAt: '2026-09-14T06:01:00.000Z',
      })],
    })

    const state = projectReliabilityState(shanghai.snapshot)
    expect(state.opportunities).toHaveLength(2)
    expect(state.opportunities.map((item) => item.location).sort()).toEqual(['上海', '北京'].sort())
    expect(state.actions.filter((item) => item.kind === 'apply')).toHaveLength(2)
    expect(state.ingestionRuns.every((run) => run.receivedCount === run.accountedCount)).toBe(true)
    expect(state.integrity).toEqual({ status: 'healthy', criticalCount: 0, warningCount: 0, issueCodes: [] })
  })

  it('fails closed without mutating the workspace when a generic monitor role is ambiguous between existing same-company roles', () => {
    const initial = reliabilitySnapshot({
      opportunities: [
        reliabilityOpportunity({ id: 'opp-ai-pm', company: '示例科技', role: 'AI产品经理' }),
        reliabilityOpportunity({ id: 'opp-tech-pm', company: '示例科技', role: '技术产品经理' }),
      ],
    })
    const result = applyMonitorIngestionHardened(initial, {
      runId: 'ambiguous-generic-role-run',
      sourceId: 'monitor:ambiguous',
      startedAt: '2026-09-14T07:00:00.000Z',
      completedAt: '2026-09-14T07:05:00.000Z',
      observations: [monitorObservation({
        sourceRecordId: 'ambiguous-product-manager',
        role: '产品经理',
        sourceTitle: '产品经理',
        location: undefined,
        sourceUrl: 'https://careers.example.com/jobs/product-manager',
        discoveredAt: '2026-09-14T07:01:00.000Z',
      })],
    })

    const state = projectReliabilityState(result.snapshot)
    expect(state.opportunities).toHaveLength(2)
    expect(state.actions).toHaveLength(0)
    expect(state.processEvents).toHaveLength(0)
    expect(state.ingestionRuns).toEqual([{
      sourceKind: 'gpt_monitor',
      sourceId: 'monitor:ambiguous',
      runId: 'ambiguous-generic-role-run',
      receivedCount: 1,
      accountedCount: 1,
      outcomes: { unresolved: 1 },
    }])
  })

  it('reports a doing Action on a closed Opportunity instead of silently treating it as inactive', () => {
    const closed = reliabilityOpportunity({
      id: 'opp-closed',
      company: '示例科技',
      role: '已结束岗位',
      currentStageLabel: '流程结束',
      processStage: 'closed',
    })
    const doing = reliabilityAction({
      id: 'action-doing',
      opportunityId: closed.id,
      title: '仍在执行的流程任务',
      processStage: 'closed',
      status: 'doing',
    })

    const state = projectReliabilityState(reliabilitySnapshot({ opportunities: [closed], actions: [doing] }))
    expect(state.integrity).toEqual({
      status: 'watch',
      criticalCount: 0,
      warningCount: 1,
      issueCodes: ['closed_opportunity_active_action'],
    })
  })
})
