import { describe, expect, it } from 'vitest'
import {
  applyGmailIngestionHardened,
  applyMonitorIngestionHardened,
} from '../../src/ingestionHardening.js'
import type { MonitorJobObservation } from '../../src/autonomousIngestion.js'
import { projectReliabilityState, reliabilitySnapshot } from './harness.js'

function observation(overrides: Partial<MonitorJobObservation> = {}): MonitorJobObservation {
  return {
    sourceRecordId: 'job-1',
    company: '矩阵科技',
    role: 'AI产品经理',
    sourceUrl: 'https://careers.matrix.example/jobs/42?utm_source=monitor',
    sourceTitle: 'AI产品经理',
    location: '北京',
    rationale: 'adversarial reliability scenario',
    roleType: 'core',
    opportunityValue: 84,
    fitScore: 81,
    fitConfidence: 'high',
    opportunityValueConfidence: 'high',
    postingStatus: 'open',
    sourceVerification: 'verified',
    sourceVerifiedAt: '2026-09-14T08:00:00.000Z',
    discoveredAt: '2026-09-14T08:01:00.000Z',
    ...overrides,
  }
}

function monitorRun(sourceId: string, runId: string, item: MonitorJobObservation, hour: number) {
  return {
    runId,
    sourceId,
    startedAt: `2026-09-14T${String(hour).padStart(2, '0')}:00:00.000Z`,
    completedAt: `2026-09-14T${String(hour).padStart(2, '0')}:05:00.000Z`,
    observations: [item],
  }
}

function durableBusinessState(snapshot: Parameters<typeof projectReliabilityState>[0]) {
  const state = projectReliabilityState(snapshot)
  return {
    opportunities: state.opportunities,
    processEvents: state.processEvents,
    actions: state.actions,
    integrity: state.integrity,
  }
}

describe('v1.10 adversarial ingestion matrix', () => {
  it('converges to the same durable workspace regardless of which tracking variant arrives first', () => {
    const sourceA = observation({
      sourceRecordId: 'source-a',
      sourceUrl: 'https://careers.matrix.example/jobs/42?utm_source=gpt&utm_campaign=fall',
    })
    const sourceB = observation({
      sourceRecordId: 'source-b',
      sourceUrl: 'https://careers.matrix.example/jobs/42?ref=chatgpt',
      discoveredAt: '2026-09-14T09:01:00.000Z',
    })

    const aThenBFirst = applyMonitorIngestionHardened(
      reliabilitySnapshot(),
      monitorRun('monitor:a', 'run-a', sourceA, 8),
    )
    const aThenB = applyMonitorIngestionHardened(
      aThenBFirst.snapshot,
      monitorRun('monitor:b', 'run-b', sourceB, 9),
    )

    const bThenAFirst = applyMonitorIngestionHardened(
      reliabilitySnapshot(),
      monitorRun('monitor:b', 'run-b', sourceB, 8),
    )
    const bThenA = applyMonitorIngestionHardened(
      bThenAFirst.snapshot,
      monitorRun('monitor:a', 'run-a', sourceA, 9),
    )

    expect(durableBusinessState(aThenB.snapshot)).toEqual(durableBusinessState(bThenA.snapshot))
    const state = projectReliabilityState(aThenB.snapshot)
    expect(state.opportunities).toHaveLength(1)
    expect(state.opportunities[0]?.canonicalSourceUrl).toBe('https://careers.matrix.example/jobs/42')
    expect(state.actions.filter((item) => item.kind === 'apply')).toHaveLength(1)
  })

  it('makes an exact ingestion-run retry a true idempotent no-op', () => {
    const run = monitorRun('monitor:retry', 'stable-run-id', observation({ sourceRecordId: 'stable-record-id' }), 10)
    const first = applyMonitorIngestionHardened(reliabilitySnapshot(), run)
    const replay = applyMonitorIngestionHardened(first.snapshot, run)

    expect(projectReliabilityState(replay.snapshot)).toEqual(projectReliabilityState(first.snapshot))
    expect(projectReliabilityState(replay.snapshot).ingestionRuns).toHaveLength(1)
  })

  it('accounts a repeated Gmail source record in a later run without duplicating its Process Event or Action', () => {
    const discovered = applyMonitorIngestionHardened(
      reliabilitySnapshot(),
      monitorRun('monitor:gmail-replay', 'discover-run', observation({ sourceRecordId: 'discover-record' }), 11),
    )
    const message = {
      sourceRecordId: 'gmail-message-stable',
      receivedAt: '2026-09-14T12:01:00.000Z',
      classification: 'recruiting' as const,
      confidence: 'high' as const,
      company: '矩阵科技',
      role: 'AI产品经理',
      eventType: 'assessment_invite' as const,
      eventKey: 'matrix-ai-pm-assessment',
      eventState: 'scheduled' as const,
      stage: 'assessment' as const,
      dueAt: '2026-09-18T12:00:00.000Z',
      timingMode: 'deadline' as const,
    }
    const first = applyGmailIngestionHardened(discovered.snapshot, {
      runId: 'gmail-first-run',
      sourceId: 'gmail:primary',
      startedAt: '2026-09-14T12:00:00.000Z',
      completedAt: '2026-09-14T12:05:00.000Z',
      messages: [message],
    })
    const repeated = applyGmailIngestionHardened(first.snapshot, {
      runId: 'gmail-second-run',
      sourceId: 'gmail:primary',
      startedAt: '2026-09-14T13:00:00.000Z',
      completedAt: '2026-09-14T13:05:00.000Z',
      messages: [message],
    })

    const state = projectReliabilityState(repeated.snapshot)
    expect(state.processEvents).toHaveLength(1)
    expect(state.actions.filter((item) => item.eventLinked)).toHaveLength(1)
    const gmailRuns = state.ingestionRuns.filter((run) => run.sourceKind === 'gmail')
    expect(gmailRuns).toHaveLength(2)
    expect(gmailRuns.every((run) => run.receivedCount === 1 && run.accountedCount === 1)).toBe(true)
  })

  it('preserves one logical event/action through invite, reschedule and completion', () => {
    const discovered = applyMonitorIngestionHardened(
      reliabilitySnapshot(),
      monitorRun('monitor:event-lifecycle', 'discover-lifecycle-run', observation({ sourceRecordId: 'lifecycle-job' }), 14),
    )
    const baseMessage = {
      classification: 'recruiting' as const,
      confidence: 'high' as const,
      company: '矩阵科技',
      role: 'AI产品经理',
      eventType: 'interview_invite' as const,
      eventKey: 'matrix-ai-pm-interview-1',
      stage: 'interview' as const,
      timingMode: 'fixed' as const,
    }

    const invited = applyGmailIngestionHardened(discovered.snapshot, {
      runId: 'invite-run',
      sourceId: 'gmail:primary',
      startedAt: '2026-09-14T15:00:00.000Z',
      completedAt: '2026-09-14T15:05:00.000Z',
      messages: [{
        ...baseMessage,
        sourceRecordId: 'invite-message',
        receivedAt: '2026-09-14T15:01:00.000Z',
        eventState: 'scheduled',
        dueAt: '2026-09-20T09:00:00.000Z',
      }],
    })
    const rescheduled = applyGmailIngestionHardened(invited.snapshot, {
      runId: 'reschedule-run',
      sourceId: 'gmail:primary',
      startedAt: '2026-09-14T16:00:00.000Z',
      completedAt: '2026-09-14T16:05:00.000Z',
      messages: [{
        ...baseMessage,
        sourceRecordId: 'reschedule-message',
        receivedAt: '2026-09-14T16:01:00.000Z',
        eventState: 'rescheduled',
        dueAt: '2026-09-21T14:30:00.000Z',
      }],
    })
    const completed = applyGmailIngestionHardened(rescheduled.snapshot, {
      runId: 'completion-run',
      sourceId: 'gmail:primary',
      startedAt: '2026-09-14T17:00:00.000Z',
      completedAt: '2026-09-14T17:05:00.000Z',
      messages: [{
        ...baseMessage,
        sourceRecordId: 'completion-message',
        receivedAt: '2026-09-14T17:01:00.000Z',
        eventState: 'completed',
      }],
    })

    const state = projectReliabilityState(completed.snapshot)
    expect(state.processEvents).toEqual([{
      company: '矩阵科技',
      role: 'AI产品经理',
      type: 'interview_invite',
      dueAt: '2026-09-21T14:30:00.000Z',
      timingMode: 'fixed',
    }])
    expect(state.actions.filter((item) => item.eventLinked)).toEqual([{
      kind: 'manual',
      status: 'done',
      processStage: 'interview',
      dueAt: '2026-09-21T14:30:00.000Z',
      eventLinked: true,
    }])
    expect(state.integrity.criticalCount).toBe(0)
  })
})
