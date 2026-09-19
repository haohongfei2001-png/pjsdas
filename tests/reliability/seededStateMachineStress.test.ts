import { describe, expect, it } from 'vitest'
import {
  applyGmailIngestionHardened,
  applyMonitorIngestionHardened,
} from '../../src/ingestionHardening.js'
import type { MonitorJobObservation } from '../../src/autonomousIngestion.js'
import type { PJSDASSnapshot } from '../../src/snapshot.js'
import { projectReliabilityState, reliabilitySnapshot } from './harness.js'

type Step = (snapshot: PJSDASSnapshot) => PJSDASSnapshot

function mulberry32(seed: number) {
  return () => {
    let value = seed += 0x6D2B79F5
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle<T>(items: T[], random: () => number) {
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1))
    ;[copy[index], copy[swapIndex]] = [copy[swapIndex]!, copy[index]!]
  }
  return copy
}

function monitorObservation(input: {
  sourceRecordId: string
  role: string
  location: string
  sourceUrl: string
}): MonitorJobObservation {
  return {
    sourceRecordId: input.sourceRecordId,
    company: '种子测试科技',
    role: input.role,
    sourceUrl: input.sourceUrl,
    sourceTitle: `${input.role} - 种子测试科技`,
    location: input.location,
    rationale: 'seeded deterministic reliability stress',
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

function monitorStep(input: {
  runId: string
  sourceId: string
  observation: MonitorJobObservation
  hour: number
}): Step {
  return (snapshot) => applyMonitorIngestionHardened(snapshot, {
    runId: input.runId,
    sourceId: input.sourceId,
    startedAt: `2026-09-14T${String(input.hour).padStart(2, '0')}:00:00.000Z`,
    completedAt: `2026-09-14T${String(input.hour).padStart(2, '0')}:05:00.000Z`,
    observations: [input.observation],
  }).snapshot
}

function gmailStep(input: {
  runId: string
  sourceRecordId: string
  eventState: 'scheduled' | 'rescheduled' | 'completed'
  hour: number
  dueAt?: string
}): Step {
  return (snapshot) => applyGmailIngestionHardened(snapshot, {
    runId: input.runId,
    sourceId: 'gmail:primary',
    startedAt: `2026-09-14T${String(input.hour).padStart(2, '0')}:00:00.000Z`,
    completedAt: `2026-09-14T${String(input.hour).padStart(2, '0')}:05:00.000Z`,
    messages: [{
      sourceRecordId: input.sourceRecordId,
      receivedAt: `2026-09-14T${String(input.hour).padStart(2, '0')}:01:00.000Z`,
      classification: 'recruiting',
      confidence: 'high',
      company: '种子测试科技',
      role: 'AI产品经理',
      eventType: 'interview_invite',
      eventKey: 'seeded-interview-1',
      eventState: input.eventState,
      stage: 'interview',
      dueAt: input.dueAt,
      timingMode: 'fixed',
    }],
  }).snapshot
}

function assertAccounting(snapshot: PJSDASSnapshot, seed: number) {
  for (const entry of snapshot.data.timeline ?? []) {
    const run = entry.ingestionRun
    if (!run) continue
    const outcomes = Object.values(run.outcomes).reduce((sum, value) => sum + (value ?? 0), 0)
    expect(run.receivedCount, `seed=${seed} run=${run.runId} received/accounted`).toBe(run.accountedCount)
    expect(run.accountedCount, `seed=${seed} run=${run.runId} accounted/outcomes`).toBe(outcomes)
  }
}

function runSeed(seed: number) {
  const random = mulberry32(seed)
  const canonical = monitorObservation({
    sourceRecordId: `canonical-${seed}`,
    role: 'AI产品经理',
    location: '北京',
    sourceUrl: `https://careers.seed.example/jobs/42?utm_source=seed-${seed}`,
  })
  const trackingVariant = monitorObservation({
    sourceRecordId: `tracking-${seed}`,
    role: 'AI产品经理',
    location: '北京',
    sourceUrl: `https://careers.seed.example/jobs/42?ref=assistant&utm_campaign=${seed}`,
  })
  const distinctLocation = monitorObservation({
    sourceRecordId: `shanghai-${seed}`,
    role: 'AI产品经理',
    location: '上海',
    sourceUrl: `https://careers.seed.example/jobs/84?utm_medium=${seed}`,
  })
  const distinctRole = monitorObservation({
    sourceRecordId: `strategy-${seed}`,
    role: '战略分析',
    location: '北京',
    sourceUrl: `https://careers.seed.example/jobs/99?utm_source=${seed}`,
  })

  const discoverySteps = shuffle<Step>([
    monitorStep({ runId: `canonical-run-${seed}`, sourceId: `monitor:canonical-${seed}`, observation: canonical, hour: 8 }),
    monitorStep({ runId: `tracking-run-${seed}`, sourceId: `monitor:tracking-${seed}`, observation: trackingVariant, hour: 9 }),
    monitorStep({ runId: `shanghai-run-${seed}`, sourceId: `monitor:shanghai-${seed}`, observation: distinctLocation, hour: 10 }),
    monitorStep({ runId: `strategy-run-${seed}`, sourceId: `monitor:strategy-${seed}`, observation: distinctRole, hour: 11 }),
  ], random)

  let snapshot = reliabilitySnapshot()
  for (const step of discoverySteps) snapshot = step(snapshot)

  // Retry a previously completed run after unrelated state changes. This must be a no-op.
  snapshot = monitorStep({
    runId: `canonical-run-${seed}`,
    sourceId: `monitor:canonical-${seed}`,
    observation: canonical,
    hour: 12,
  })(snapshot)

  const invitation = gmailStep({
    runId: `invite-run-${seed}`,
    sourceRecordId: `invite-message-${seed}`,
    eventState: 'scheduled',
    hour: 13,
    dueAt: '2026-09-20T09:00:00.000Z',
  })
  const reschedule = gmailStep({
    runId: `reschedule-run-${seed}`,
    sourceRecordId: `reschedule-message-${seed}`,
    eventState: 'rescheduled',
    hour: 14,
    dueAt: '2026-09-21T14:30:00.000Z',
  })
  const completion = gmailStep({
    runId: `completion-run-${seed}`,
    sourceRecordId: `completion-message-${seed}`,
    eventState: 'completed',
    hour: 15,
  })

  // Preserve causal event order while varying transport noise around each transition.
  const lifecycle = [invitation, reschedule, completion]
  for (let index = 0; index < lifecycle.length; index += 1) {
    if (random() > 0.45) {
      snapshot = monitorStep({
        runId: `noise-before-${seed}-${index}`,
        sourceId: `monitor:noise-before-${seed}-${index}`,
        observation: distinctRole,
        hour: 16 + index,
      })(snapshot)
    }

    snapshot = lifecycle[index]!(snapshot)

    if (random() > 0.35) {
      // A later Gmail run re-sees the exact durable source record. It must be accounted as duplicate.
      const originalId = index === 0 ? `invite-message-${seed}` : index === 1 ? `reschedule-message-${seed}` : `completion-message-${seed}`
      const state = index === 0 ? 'scheduled' : index === 1 ? 'rescheduled' : 'completed'
      const dueAt = index === 0
        ? '2026-09-20T09:00:00.000Z'
        : index === 1
          ? '2026-09-21T14:30:00.000Z'
          : undefined
      snapshot = gmailStep({
        runId: `duplicate-gmail-run-${seed}-${index}`,
        sourceRecordId: originalId,
        eventState: state,
        hour: 19 + index,
        dueAt,
      })(snapshot)
    }
  }

  return snapshot
}

describe('v1.10 reproducible seeded state-machine stress', () => {
  it('keeps canonical workspace semantics and accounting valid across 64 reproducible seeds', () => {
    for (let seed = 1; seed <= 64; seed += 1) {
      const snapshot = runSeed(seed)
      assertAccounting(snapshot, seed)
      const state = projectReliabilityState(snapshot)

      expect(state.integrity.criticalCount, `seed=${seed} critical integrity defects`).toBe(0)
      expect(state.opportunities, `seed=${seed} canonical opportunity count`).toHaveLength(3)
      expect(
        state.opportunities.filter((item) => item.company === '种子测试科技' && item.role === 'AI产品经理' && item.location === '北京'),
        `seed=${seed} tracking variants must converge`,
      ).toHaveLength(1)
      expect(
        state.opportunities.filter((item) => item.company === '种子测试科技' && item.role === 'AI产品经理' && item.location === '上海'),
        `seed=${seed} explicit locations remain distinct`,
      ).toHaveLength(1)
      expect(
        state.processEvents.filter((item) => item.type === 'interview_invite'),
        `seed=${seed} Gmail lifecycle must converge`,
      ).toEqual([{
        company: '种子测试科技',
        role: 'AI产品经理',
        type: 'interview_invite',
        dueAt: '2026-09-21T14:30:00.000Z',
        timingMode: 'fixed',
      }])
      expect(
        state.actions.filter((item) => item.eventLinked),
        `seed=${seed} lifecycle must retain one event-linked action`,
      ).toEqual([{
        kind: 'manual',
        status: 'done',
        processStage: 'interview',
        dueAt: '2026-09-21T14:30:00.000Z',
        eventLinked: true,
      }])
    }
  })
})
