import { describe, expect, it } from 'vitest'
import {
  applyGmailIngestion,
  applyMonitorIngestion,
  type MonitorJobObservation,
} from '../src/autonomousIngestion.js'
import { createDefaultDecisionRules } from '../src/decisionRules.js'
import { createDefaultDiscoveryProfile } from '../src/discoveryProfile.js'
import { summarizeCoverage } from '../src/ingestion.js'
import { createSnapshot } from '../src/snapshot.js'
import type { Opportunity } from '../src/model.js'

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

function observation(overrides: Partial<MonitorJobObservation> = {}): MonitorJobObservation {
  return {
    sourceRecordId: 'monitor-item-1',
    company: 'Example Tech',
    role: 'AI Product Manager',
    sourceUrl: 'https://careers.example.com/jobs/123?utm_source=chatgpt',
    sourceTitle: 'AI Product Manager - Example Tech',
    location: '北京',
    rationale: 'Matches the explicit AI product direction.',
    roleType: 'core',
    opportunityValue: 84,
    fitScore: 78,
    fitConfidence: 'high',
    opportunityValueConfidence: 'high',
    postingStatus: 'open',
    discoveredAt: '2026-09-13T00:05:00.000Z',
    ...overrides,
  }
}

const monitorRun = {
  runId: 'monitor-run-1',
  sourceId: 'monitor-ai-pm',
  startedAt: '2026-09-13T00:00:00.000Z',
  completedAt: '2026-09-13T00:10:00.000Z',
}

describe('autonomous monitor ingestion', () => {
  it('creates a new opportunity and apply action while fully accounting the run', () => {
    const result = applyMonitorIngestion(baseSnapshot(), {
      ...monitorRun,
      observations: [observation()],
    })

    expect(result.alreadyApplied).toBe(false)
    expect(result.snapshot.data.opportunities).toHaveLength(1)
    expect(result.snapshot.data.actions).toHaveLength(1)
    expect(result.snapshot.data.actions[0]).toMatchObject({ kind: 'apply', status: 'todo' })
    expect(result.run).toMatchObject({ receivedCount: 1, accountedCount: 1, outcomes: { created: 1 } })
    expect(summarizeCoverage(result.snapshot.data.timeline).allCaughtUp).toBe(true)
  })

  it('merges a second public source into the existing logical job instead of duplicating it', () => {
    const first = applyMonitorIngestion(baseSnapshot(), {
      ...monitorRun,
      observations: [observation()],
    })
    const second = applyMonitorIngestion(first.snapshot, {
      runId: 'monitor-run-2',
      sourceId: 'monitor-product',
      startedAt: '2026-09-13T01:00:00.000Z',
      completedAt: '2026-09-13T01:10:00.000Z',
      observations: [observation({
        sourceRecordId: 'other-source-77',
        sourceUrl: 'https://jobs.example.org/positions/ai-product-123?ref=feed',
        sourceTitle: 'Example Tech AI Product Manager',
        compensationText: '30-40万',
        discoveredAt: '2026-09-13T01:05:00.000Z',
      })],
    })

    expect(second.snapshot.data.opportunities).toHaveLength(1)
    expect(second.run.outcomes.merged).toBe(1)
    expect(second.snapshot.data.opportunities[0].detail?.discovery?.postingHistory?.length).toBe(1)
    expect(second.snapshot.data.actions).toHaveLength(1)
  })

  it('accounts the same durable source record again as duplicate without creating another job', () => {
    const first = applyMonitorIngestion(baseSnapshot(), {
      ...monitorRun,
      observations: [observation()],
    })
    const second = applyMonitorIngestion(first.snapshot, {
      runId: 'monitor-run-2',
      sourceId: monitorRun.sourceId,
      startedAt: '2026-09-13T02:00:00.000Z',
      completedAt: '2026-09-13T02:10:00.000Z',
      observations: [observation({ discoveredAt: '2026-09-13T02:05:00.000Z' })],
    })

    expect(second.snapshot.data.opportunities).toHaveLength(1)
    expect(second.run.outcomes.duplicate).toBe(1)
    expect(second.run.receivedCount).toBe(second.run.accountedCount)
  })

  it('records hard Discovery Profile rejection as filtered instead of silently dropping it', () => {
    const snapshot = baseSnapshot()
    snapshot.data.discoveryProfile = {
      ...createDefaultDiscoveryProfile('2026-09-13T00:00:00.000Z'),
      mustNotHave: ['销售'],
    }
    const result = applyMonitorIngestion(snapshot, {
      ...monitorRun,
      observations: [observation({ role: '销售经理', sourceTitle: '销售经理' })],
    })

    expect(result.snapshot.data.opportunities).toHaveLength(0)
    expect(result.run.outcomes.filtered).toBe(1)
    expect(result.run.receivedCount).toBe(1)
    expect(result.run.accountedCount).toBe(1)
    expect(summarizeCoverage(result.snapshot.data.timeline).allCaughtUp).toBe(true)
  })

  it('is idempotent for an already-completed run id', () => {
    const first = applyMonitorIngestion(baseSnapshot(), {
      ...monitorRun,
      observations: [observation()],
    })
    const repeated = applyMonitorIngestion(first.snapshot, {
      ...monitorRun,
      observations: [observation()],
    })

    expect(repeated.alreadyApplied).toBe(true)
    expect(repeated.snapshot.data.opportunities).toHaveLength(1)
    expect(repeated.records).toHaveLength(0)
    expect(repeated.run.runId).toBe(monitorRun.runId)
  })
})

describe('autonomous Gmail ingestion', () => {
  const existing: Opportunity = {
    id: 'jd-pm',
    company: '京东',
    role: '技术产品经理',
    currentStageLabel: '筛选中',
    processStage: 'screening',
    roleType: 'core',
    early: false,
    opportunityValue: 86,
    fitScore: 75,
    locallyManaged: true,
    importedAt: '2026-09-10T00:00:00.000Z',
  }

  it('turns a high-confidence assessment email into one process event and one action', () => {
    const result = applyGmailIngestion(baseSnapshot([existing]), {
      runId: 'gmail-run-1',
      sourceId: 'gmail-primary',
      startedAt: '2026-09-13T03:00:00.000Z',
      completedAt: '2026-09-13T03:05:00.000Z',
      cursor: 'history-100',
      messages: [{
        sourceRecordId: 'gmail-message-1',
        receivedAt: '2026-09-13T03:01:00.000Z',
        classification: 'recruiting',
        confidence: 'high',
        sender: 'campus@jd.com',
        subject: '在线测评通知',
        company: '京东',
        role: '技术产品经理',
        eventType: 'assessment_invite',
        dueAt: '2026-09-15T15:59:59.000Z',
        timingMode: 'deadline',
        estimatedMinutes: 45,
      }],
    })

    expect(result.snapshot.data.opportunities).toHaveLength(1)
    expect(result.snapshot.data.processEvents).toHaveLength(1)
    expect(result.snapshot.data.processEvents[0]).toMatchObject({ opportunityId: 'jd-pm', source: 'email' })
    expect(result.snapshot.data.actions).toHaveLength(1)
    expect(result.snapshot.data.actions[0]).toMatchObject({ processEventId: result.snapshot.data.processEvents[0].id, status: 'todo' })
    expect(result.run.outcomes.updated).toBe(1)
    expect(summarizeCoverage(result.snapshot.data.timeline).allCaughtUp).toBe(true)
  })

  it('does not duplicate an already-accounted Gmail message in a later run', () => {
    const first = applyGmailIngestion(baseSnapshot([existing]), {
      runId: 'gmail-run-1',
      sourceId: 'gmail-primary',
      startedAt: '2026-09-13T03:00:00.000Z',
      completedAt: '2026-09-13T03:05:00.000Z',
      messages: [{
        sourceRecordId: 'gmail-message-1',
        receivedAt: '2026-09-13T03:01:00.000Z',
        classification: 'recruiting', confidence: 'high', company: '京东', role: '技术产品经理', eventType: 'assessment_invite',
      }],
    })
    const second = applyGmailIngestion(first.snapshot, {
      runId: 'gmail-run-2',
      sourceId: 'gmail-primary',
      startedAt: '2026-09-13T04:00:00.000Z',
      completedAt: '2026-09-13T04:05:00.000Z',
      messages: [{
        sourceRecordId: 'gmail-message-1',
        receivedAt: '2026-09-13T03:01:00.000Z',
        classification: 'recruiting', confidence: 'high', company: '京东', role: '技术产品经理', eventType: 'assessment_invite',
      }],
    })

    expect(second.snapshot.data.processEvents).toHaveLength(1)
    expect(second.run.outcomes.duplicate).toBe(1)
  })

  it('keeps low-confidence recruiting mail as an explicit unresolved exception rather than guessing', () => {
    const result = applyGmailIngestion(baseSnapshot([existing]), {
      runId: 'gmail-run-low',
      sourceId: 'gmail-primary',
      startedAt: '2026-09-13T05:00:00.000Z',
      completedAt: '2026-09-13T05:05:00.000Z',
      messages: [{
        sourceRecordId: 'gmail-message-low',
        receivedAt: '2026-09-13T05:01:00.000Z',
        classification: 'recruiting',
        confidence: 'medium',
        subject: '下一轮安排',
      }],
    })
    const coverage = summarizeCoverage(result.snapshot.data.timeline)

    expect(result.snapshot.data.processEvents).toHaveLength(0)
    expect(result.run.outcomes.unresolved).toBe(1)
    expect(result.run.receivedCount).toBe(result.run.accountedCount)
    expect(coverage.allCaughtUp).toBe(false)
    expect(coverage.unresolvedCount).toBe(1)
    expect(coverage.exceptions[0].ingestion?.sourceRecordId).toBe('gmail-message-low')
  })

  it('accounts explicitly ignored mail without creating job-search objects', () => {
    const result = applyGmailIngestion(baseSnapshot(), {
      runId: 'gmail-run-ignore',
      sourceId: 'gmail-primary',
      startedAt: '2026-09-13T06:00:00.000Z',
      completedAt: '2026-09-13T06:05:00.000Z',
      messages: [{
        sourceRecordId: 'gmail-promo-1',
        receivedAt: '2026-09-13T06:01:00.000Z',
        classification: 'ignored',
        confidence: 'high',
        subject: '商城优惠',
      }],
    })

    expect(result.run.outcomes.ignored).toBe(1)
    expect(result.snapshot.data.opportunities).toHaveLength(0)
    expect(result.snapshot.data.processEvents).toHaveLength(0)
    expect(summarizeCoverage(result.snapshot.data.timeline).allCaughtUp).toBe(true)
  })
})
