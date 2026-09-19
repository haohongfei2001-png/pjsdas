import { describe, expect, it } from 'vitest'
import {
  applyGmailIngestionHardened,
  applyMonitorIngestionHardened,
} from '../../src/ingestionHardening.js'
import type { MonitorJobObservation } from '../../src/autonomousIngestion.js'
import type { PJSDASSnapshot } from '../../src/snapshot.js'
import { projectReliabilityState, reliabilitySnapshot } from './harness.js'

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items]
  return items.flatMap((item, index) =>
    permutations(items.filter((_, candidateIndex) => candidateIndex !== index))
      .map((tail) => [item, ...tail]),
  )
}

function observation(input: {
  id: string
  role: string
  location: string
  url: string
  title?: string
}): MonitorJobObservation {
  return {
    sourceRecordId: input.id,
    company: '压力测试科技',
    role: input.role,
    sourceUrl: input.url,
    sourceTitle: input.title ?? input.role,
    location: input.location,
    rationale: 'deterministic state-invariant stress fixture',
    roleType: 'core',
    opportunityValue: 82,
    fitScore: 79,
    fitConfidence: 'high',
    opportunityValueConfidence: 'high',
    postingStatus: 'open',
    sourceVerification: 'verified',
    sourceVerifiedAt: '2026-09-14T08:00:00.000Z',
    discoveredAt: '2026-09-14T08:00:00.000Z',
  }
}

function applyMonitor(snapshot: PJSDASSnapshot, item: MonitorJobObservation, index: number) {
  return applyMonitorIngestionHardened(snapshot, {
    runId: `stress-run-${item.sourceRecordId}`,
    sourceId: `monitor:stress-${item.sourceRecordId}`,
    startedAt: `2026-09-14T${String(8 + index).padStart(2, '0')}:00:00.000Z`,
    completedAt: `2026-09-14T${String(8 + index).padStart(2, '0')}:05:00.000Z`,
    observations: [item],
  }).snapshot
}

function businessState(snapshot: PJSDASSnapshot) {
  const state = projectReliabilityState(snapshot)
  return {
    opportunities: state.opportunities,
    processEvents: state.processEvents,
    actions: state.actions,
    integrity: state.integrity,
  }
}

function assertBalancedRuns(snapshot: PJSDASSnapshot) {
  for (const entry of snapshot.data.timeline ?? []) {
    const run = entry.ingestionRun
    if (!run) continue
    const outcomeTotal = Object.values(run.outcomes).reduce((sum, value) => sum + (value ?? 0), 0)
    expect(run.receivedCount, `received/accounted mismatch for ${run.runId}`).toBe(run.accountedCount)
    expect(run.accountedCount, `accounted/outcomes mismatch for ${run.runId}`).toBe(outcomeTotal)
  }
}

const MONITOR_FIXTURES = [
  observation({
    id: 'beijing-a',
    role: 'AI产品经理',
    location: '北京',
    url: 'https://careers.stress.example/jobs/42?utm_source=gpt&utm_campaign=fall',
  }),
  observation({
    id: 'beijing-b',
    role: 'AI产品经理',
    location: '北京',
    url: 'https://careers.stress.example/jobs/42?ref=chatgpt',
  }),
  observation({
    id: 'shanghai',
    role: 'AI产品经理',
    location: '上海',
    url: 'https://careers.stress.example/jobs/84?utm_medium=assistant',
  }),
  observation({
    id: 'technical',
    role: '技术产品经理',
    location: '北京',
    url: 'https://careers.stress.example/jobs/55?utm_source=monitor',
  }),
]

describe('v1.10 deterministic state-invariant stress', () => {
  it('keeps canonical business state invariant across every discovery arrival order', () => {
    const variants = permutations(MONITOR_FIXTURES)
    expect(variants).toHaveLength(24)

    let expected: ReturnType<typeof businessState> | undefined
    for (const sequence of variants) {
      let snapshot = reliabilitySnapshot()
      sequence.forEach((item, index) => {
        snapshot = applyMonitor(snapshot, item, index)
      })

      assertBalancedRuns(snapshot)
      const state = businessState(snapshot)
      expect(state.integrity.criticalCount).toBe(0)
      expect(state.opportunities).toHaveLength(3)
      expect(state.actions.filter((item) => item.kind === 'apply')).toHaveLength(3)

      if (!expected) expected = state
      else expect(state).toEqual(expected)
    }
  })

  it('keeps exact-run retries idempotent even when unrelated discovery occurs between attempts', () => {
    const stable = MONITOR_FIXTURES[0]!
    const unrelated = observation({
      id: 'unrelated',
      role: '商业分析',
      location: '北京',
      url: 'https://careers.stress.example/jobs/99',
    })
    const stableRun = {
      runId: 'stable-retry-run',
      sourceId: 'monitor:stable-retry',
      startedAt: '2026-09-14T08:00:00.000Z',
      completedAt: '2026-09-14T08:05:00.000Z',
      observations: [stable],
    }

    const first = applyMonitorIngestionHardened(reliabilitySnapshot(), stableRun)
    const middle = applyMonitorIngestionHardened(first.snapshot, {
      runId: 'unrelated-run',
      sourceId: 'monitor:unrelated',
      startedAt: '2026-09-14T09:00:00.000Z',
      completedAt: '2026-09-14T09:05:00.000Z',
      observations: [unrelated],
    })
    const retried = applyMonitorIngestionHardened(middle.snapshot, stableRun)

    expect(businessState(retried.snapshot)).toEqual(businessState(middle.snapshot))
    const stableLedgerEntries = (retried.snapshot.data.timeline ?? [])
      .filter((entry) => entry.ingestionRun?.runId === stableRun.runId)
    expect(stableLedgerEntries).toHaveLength(1)
    assertBalancedRuns(retried.snapshot)
  })

  it('preserves one Gmail lifecycle while duplicate/noise ingestion is interleaved at different points', () => {
    const baseDiscovery = applyMonitorIngestionHardened(reliabilitySnapshot(), {
      runId: 'lifecycle-discovery',
      sourceId: 'monitor:lifecycle',
      startedAt: '2026-09-14T08:00:00.000Z',
      completedAt: '2026-09-14T08:05:00.000Z',
      observations: [MONITOR_FIXTURES[0]!],
    }).snapshot

    const invitation = {
      sourceRecordId: 'gmail-invite',
      receivedAt: '2026-09-14T09:01:00.000Z',
      classification: 'recruiting' as const,
      confidence: 'high' as const,
      company: '压力测试科技',
      role: 'AI产品经理',
      eventType: 'interview_invite' as const,
      eventKey: 'stress-interview-1',
      eventState: 'scheduled' as const,
      stage: 'interview' as const,
      dueAt: '2026-09-20T09:00:00.000Z',
      timingMode: 'fixed' as const,
    }
    const reschedule = {
      ...invitation,
      sourceRecordId: 'gmail-reschedule',
      receivedAt: '2026-09-14T10:01:00.000Z',
      eventState: 'rescheduled' as const,
      dueAt: '2026-09-21T14:30:00.000Z',
    }
    const completion = {
      ...invitation,
      sourceRecordId: 'gmail-completion',
      receivedAt: '2026-09-14T11:01:00.000Z',
      eventState: 'completed' as const,
      dueAt: undefined,
    }

    function applyGmail(snapshot: PJSDASSnapshot, runId: string, hour: number, message: typeof invitation | typeof reschedule | typeof completion) {
      return applyGmailIngestionHardened(snapshot, {
        runId,
        sourceId: 'gmail:primary',
        startedAt: `2026-09-14T${String(hour).padStart(2, '0')}:00:00.000Z`,
        completedAt: `2026-09-14T${String(hour).padStart(2, '0')}:05:00.000Z`,
        messages: [message],
      }).snapshot
    }

    const noise = observation({
      id: 'noise-role',
      role: '战略分析',
      location: '北京',
      url: 'https://careers.stress.example/jobs/noise',
    })

    const interleavePositions = [0, 1, 2, 3]
    let expectedLifecycle: ReturnType<typeof businessState> | undefined
    for (const position of interleavePositions) {
      let snapshot = baseDiscovery
      const steps = [
        () => { snapshot = applyGmail(snapshot, 'invite-run', 9, invitation) },
        () => { snapshot = applyGmail(snapshot, 'reschedule-run', 10, reschedule) },
        () => { snapshot = applyGmail(snapshot, 'completion-run', 11, completion) },
      ]
      steps.splice(position, 0, () => {
        snapshot = applyMonitorIngestionHardened(snapshot, {
          runId: `noise-run-${position}`,
          sourceId: `monitor:noise-${position}`,
          startedAt: '2026-09-14T09:30:00.000Z',
          completedAt: '2026-09-14T09:35:00.000Z',
          observations: [noise],
        }).snapshot
      })
      steps.forEach((step) => step())

      assertBalancedRuns(snapshot)
      const state = businessState(snapshot)
      expect(state.integrity.criticalCount).toBe(0)
      expect(state.processEvents.filter((item) => item.type === 'interview_invite')).toHaveLength(1)
      expect(state.actions.filter((item) => item.eventLinked && item.status === 'done')).toHaveLength(1)

      const lifecycleOnly = {
        processEvents: state.processEvents.filter((item) => item.type === 'interview_invite'),
        eventActions: state.actions.filter((item) => item.eventLinked),
      }
      if (!expectedLifecycle) expectedLifecycle = state
      expect(lifecycleOnly).toEqual({
        processEvents: [{
          company: '压力测试科技',
          role: 'AI产品经理',
          type: 'interview_invite',
          dueAt: '2026-09-21T14:30:00.000Z',
          timingMode: 'fixed',
        }],
        eventActions: [{
          kind: 'manual',
          status: 'done',
          processStage: 'interview',
          dueAt: '2026-09-21T14:30:00.000Z',
          eventLinked: true,
        }],
      })
    }
  })
})
