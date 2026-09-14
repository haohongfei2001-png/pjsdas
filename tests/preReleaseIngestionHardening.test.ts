import { describe, expect, it } from 'vitest'
import { applyGmailIngestion, applyMonitorIngestion, type MonitorJobObservation } from '../src/autonomousIngestion.js'
import {
  applyGmailIngestionHardened,
  applyMonitorIngestionHardened,
} from '../src/ingestionHardening.js'
import { createDefaultDecisionRules } from '../src/decisionRules.js'
import { createDefaultDiscoveryProfile } from '../src/discoveryProfile.js'
import { summarizeCoverage } from '../src/ingestion.js'
import { createSnapshot } from '../src/snapshot.js'
import { normalizeGmailMessagesForWorkspace } from '../gateway/ingestSources.js'
import type { Opportunity } from '../src/model.js'

function opportunity(id: string, company: string, role: string): Opportunity {
  return {
    id,
    company,
    role,
    currentStageLabel: '筛选中',
    processStage: 'screening',
    roleType: 'core',
    early: false,
    opportunityValue: 80,
    fitScore: 70,
    locallyManaged: true,
    importedAt: '2026-09-13T00:00:00.000Z',
  }
}

function baseSnapshot(opportunities: Opportunity[] = []) {
  return createSnapshot({
    opportunities,
    processes: [],
    processEvents: [],
    actions: [],
    prep: [],
    applicationGroups: [],
    decisionRules: createDefaultDecisionRules('2026-09-13T00:00:00.000Z'),
    discoveryProfile: createDefaultDiscoveryProfile('2026-09-13T00:00:00.000Z'),
    discoveryInbox: [],
    timeline: [],
    changeSets: [],
  }, '2026-09-13T00:00:00.000Z')
}

function monitorObservation(overrides: Partial<MonitorJobObservation> = {}): MonitorJobObservation {
  return {
    sourceRecordId: 'job-1',
    company: '示例科技',
    role: 'AI产品经理',
    sourceUrl: 'https://careers.example.com/jobs/123?utm_source=monitor',
    sourceTitle: 'AI产品经理',
    location: '北京',
    rationale: 'source backed',
    roleType: 'core',
    opportunityValue: 82,
    fitScore: 78,
    fitConfidence: 'high',
    opportunityValueConfidence: 'high',
    postingStatus: 'open',
    discoveredAt: '2026-09-13T01:00:00.000Z',
    ...overrides,
  }
}

describe('v1.9 pre-release ingestion hardening', () => {
  it('does not silently pick the first role when one monitor observation ambiguously matches multiple same-company opportunities', () => {
    const snapshot = baseSnapshot([
      opportunity('p1', '示例科技', 'AI产品经理'),
      opportunity('p2', '示例科技', '技术产品经理'),
    ])

    const result = applyMonitorIngestionHardened(snapshot, {
      runId: 'ambiguous-monitor-run',
      sourceId: 'monitor:hardening',
      startedAt: '2026-09-13T00:55:00.000Z',
      completedAt: '2026-09-13T01:05:00.000Z',
      observations: [monitorObservation({ role: '产品经理', sourceTitle: '产品经理' })],
    })

    expect(result.snapshot.data.opportunities).toHaveLength(2)
    expect(result.run.outcomes.unresolved).toBe(1)
    expect(result.run.accountedCount).toBe(result.run.receivedCount)
  })

  it('treats tracking-only URL variants as the same posting instead of creating another logical job', () => {
    const first = applyMonitorIngestionHardened(baseSnapshot(), {
      runId: 'tracking-run-a',
      sourceId: 'monitor:a',
      startedAt: '2026-09-13T01:00:00.000Z',
      completedAt: '2026-09-13T01:05:00.000Z',
      observations: [monitorObservation()],
    })
    const second = applyMonitorIngestionHardened(first.snapshot, {
      runId: 'tracking-run-b',
      sourceId: 'monitor:b',
      startedAt: '2026-09-13T02:00:00.000Z',
      completedAt: '2026-09-13T02:05:00.000Z',
      observations: [monitorObservation({
        sourceRecordId: 'job-1-other-monitor',
        sourceUrl: 'https://careers.example.com/jobs/123?utm_campaign=fall&ref=chatgpt',
        discoveredAt: '2026-09-13T02:01:00.000Z',
      })],
    })

    expect(second.snapshot.data.opportunities).toHaveLength(1)
    expect(second.snapshot.data.actions.filter((item) => item.kind === 'apply')).toHaveLength(1)
    expect((second.run.outcomes.merged ?? 0) + (second.run.outcomes.duplicate ?? 0)).toBe(1)
  })

  it('keeps a role-less Gmail message unresolved when the same company has multiple active opportunities', () => {
    const opportunities = [
      opportunity('jd-pm', '京东', '技术产品经理'),
      opportunity('jd-tet', '京东', 'TET综合管培生'),
    ]
    const normalized = normalizeGmailMessagesForWorkspace([{
      sourceRecordId: 'gmail-jd-unknown-role',
      receivedAt: '2026-09-13T03:00:00.000Z',
      classification: 'recruiting',
      confidence: 'high',
      company: '京东',
      subject: '测评通知',
      eventType: 'assessment_invite',
    }], opportunities)

    expect(normalized[0]?.confidence).toBe('medium')
    expect(normalized[0]?.role).toBeUndefined()

    const result = applyGmailIngestionHardened(baseSnapshot(opportunities), {
      runId: 'gmail-ambiguous-role',
      sourceId: 'gmail:primary',
      startedAt: '2026-09-13T03:00:00.000Z',
      completedAt: '2026-09-13T03:05:00.000Z',
      messages: normalized,
    })
    expect(result.run.outcomes.unresolved).toBe(1)
    expect(result.snapshot.data.processEvents).toHaveLength(0)
  })

  it('is idempotent when a seven-day Gmail catch-up scan sees an already-accounted message again', () => {
    const existing = opportunity('jd-pm', '京东', '技术产品经理')
    const message = {
      sourceRecordId: 'gmail-message-stable-1',
      receivedAt: '2026-09-10T03:00:00.000Z',
      classification: 'recruiting' as const,
      confidence: 'high' as const,
      company: '京东',
      role: '技术产品经理',
      eventType: 'assessment_invite' as const,
      dueAt: '2026-09-15T15:59:59.000Z',
      timingMode: 'deadline' as const,
    }
    const first = applyGmailIngestionHardened(baseSnapshot([existing]), {
      runId: 'gmail-original', sourceId: 'gmail:primary',
      startedAt: '2026-09-10T03:00:00.000Z', completedAt: '2026-09-10T03:05:00.000Z', messages: [message],
    })
    const catchUp = applyGmailIngestionHardened(first.snapshot, {
      runId: 'gmail-seven-day-catchup', sourceId: 'gmail:primary',
      startedAt: '2026-09-13T03:00:00.000Z', completedAt: '2026-09-13T03:05:00.000Z', messages: [message],
    })

    expect(catchUp.snapshot.data.processEvents).toHaveLength(1)
    expect(catchUp.snapshot.data.actions).toHaveLength(1)
    expect(catchUp.run.outcomes.duplicate).toBe(1)
  })

  it('reconciles invitation -> reschedule -> completion into one logical Gmail process event and one completed action', () => {
    const existing = opportunity('jd-pm', '京东', '技术产品经理')
    const invited = applyGmailIngestionHardened(baseSnapshot([existing]), {
      runId: 'gmail-invite', sourceId: 'gmail:primary',
      startedAt: '2026-09-13T05:00:00.000Z', completedAt: '2026-09-13T05:05:00.000Z',
      messages: [{
        sourceRecordId: 'gmail-invite-msg', receivedAt: '2026-09-13T05:01:00.000Z',
        classification: 'recruiting', confidence: 'high', company: '京东', role: '技术产品经理',
        eventType: 'assessment_invite', eventKey: 'jd-tech-pm-assessment-2026-fall', eventState: 'scheduled',
        dueAt: '2026-09-15T15:59:59.000Z', timingMode: 'deadline',
      }],
    })
    const rescheduled = applyGmailIngestionHardened(invited.snapshot, {
      runId: 'gmail-reschedule', sourceId: 'gmail:primary',
      startedAt: '2026-09-13T06:00:00.000Z', completedAt: '2026-09-13T06:05:00.000Z',
      messages: [{
        sourceRecordId: 'gmail-reschedule-msg', receivedAt: '2026-09-13T06:01:00.000Z',
        classification: 'recruiting', confidence: 'high', company: '京东', role: '技术产品经理',
        eventType: 'assessment_invite', eventKey: 'jd-tech-pm-assessment-2026-fall', eventState: 'rescheduled',
        dueAt: '2026-09-17T15:59:59.000Z', timingMode: 'deadline',
      }],
    })
    const completed = applyGmailIngestionHardened(rescheduled.snapshot, {
      runId: 'gmail-complete', sourceId: 'gmail:primary',
      startedAt: '2026-09-13T07:00:00.000Z', completedAt: '2026-09-13T07:05:00.000Z',
      messages: [{
        sourceRecordId: 'gmail-complete-msg', receivedAt: '2026-09-13T07:01:00.000Z',
        classification: 'recruiting', confidence: 'high', company: '京东', role: '技术产品经理',
        eventType: 'assessment_invite', eventKey: 'jd-tech-pm-assessment-2026-fall', eventState: 'completed',
      }],
    })

    expect(completed.snapshot.data.processEvents).toHaveLength(1)
    expect(completed.snapshot.data.processEvents[0]?.dueAt).toBe('2026-09-17T15:59:59.000Z')
    expect(completed.snapshot.data.actions).toHaveLength(1)
    expect(completed.snapshot.data.actions[0]?.status).toBe('done')
    expect(completed.run.outcomes.updated).toBe(1)
  })

  it('downgrades an event update without eventKey instead of creating a second process event', () => {
    const existing = opportunity('jd-pm', '京东', '技术产品经理')
    const result = applyGmailIngestionHardened(baseSnapshot([existing]), {
      runId: 'gmail-update-without-key', sourceId: 'gmail:primary',
      startedAt: '2026-09-13T08:00:00.000Z', completedAt: '2026-09-13T08:05:00.000Z',
      messages: [{
        sourceRecordId: 'gmail-update-no-key', receivedAt: '2026-09-13T08:01:00.000Z',
        classification: 'recruiting', confidence: 'high', company: '京东', role: '技术产品经理',
        eventType: 'assessment_invite', eventState: 'rescheduled', dueAt: '2026-09-18T15:59:59.000Z',
      }],
    })

    expect(result.snapshot.data.processEvents).toHaveLength(0)
    expect(result.run.outcomes.unresolved).toBe(1)
  })

  it('never reports All caught up for an explicitly unresolved source record', () => {
    const result = applyGmailIngestion(baseSnapshot(), {
      runId: 'gmail-unresolved', sourceId: 'gmail:primary',
      startedAt: '2026-09-13T04:00:00.000Z', completedAt: '2026-09-13T04:05:00.000Z',
      messages: [{
        sourceRecordId: 'gmail-unresolved-1', receivedAt: '2026-09-13T04:01:00.000Z',
        classification: 'recruiting', confidence: 'medium', subject: '下一步安排',
      }],
    })

    const coverage = summarizeCoverage(result.snapshot.data.timeline)
    expect(coverage.allCaughtUp).toBe(false)
    expect(coverage.totalReceived).toBe(coverage.totalAccounted)
    expect(coverage.unresolvedCount).toBe(1)
  })
})
