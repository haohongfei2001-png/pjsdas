import { describe, expect, it } from 'vitest'
import { invokeTrustedIngestion } from '../../gateway/ingestSources.js'
import {
  WorkspaceSourceError,
  type GatewayWorkspace,
  type WorkspaceSource,
  type WorkspaceWriteInput,
} from '../../gateway/workspaceSource.js'
import type { PJSDASSnapshot } from '../../src/snapshot.js'
import {
  projectReliabilityState,
  reliabilityAction,
  reliabilitySnapshot,
} from './harness.js'

type FaultMode =
  | 'none'
  | 'stale-before-write-once'
  | 'fail-before-commit-once'
  | 'commit-then-fail-once'

function discoveryArgs(input: {
  runId: string
  sourceRecordId: string
  role?: string
  sourceUrl?: string
  extras?: Record<string, unknown>
}) {
  return {
    runId: input.runId,
    sourceId: 'monitor:urgent-campus',
    startedAt: '2026-09-14T08:00:00.000Z',
    completedAt: '2026-09-14T08:05:00.000Z',
    observations: [{
      sourceRecordId: input.sourceRecordId,
      company: '故障注入科技',
      role: input.role ?? 'AI产品经理',
      sourceUrl: input.sourceUrl ?? `https://careers.fault.example/jobs/${input.sourceRecordId}`,
      sourceTitle: input.role ?? 'AI产品经理',
      location: '北京',
      rationale: 'synthetic Drive-boundary fault injection',
      roleType: 'core',
      opportunityValue: 82,
      fitScore: 79,
      fitConfidence: 'high',
      opportunityValueConfidence: 'high',
      postingStatus: 'open',
      discoveredAt: '2026-09-14T08:01:00.000Z',
    }],
    ...input.extras,
  }
}


const verifiedSource = async (observation: any) => ({
  ...observation,
  sourceVerification: 'verified' as const,
  sourceVerifiedAt: '2026-09-14T08:04:00.000Z',
})

function invokeVerified(source: WorkspaceSource, args: unknown) {
  return invokeVerified(source, args, { sourceVerifier: verifiedSource })
}

function resultPayload(result: Awaited<ReturnType<typeof invokeTrustedIngestion>>) {
  return result.structuredContent as Record<string, any>
}

function errorPayload(result: Awaited<ReturnType<typeof invokeTrustedIngestion>>) {
  const text = result.content.find((item) => item.type === 'text')
  if (!text || text.type !== 'text') throw new Error('Expected text error payload')
  return JSON.parse(text.text) as { code: string; message: string; retryable: boolean }
}

function durableRunIds(snapshot: PJSDASSnapshot) {
  return (snapshot.data.timeline ?? [])
    .map((item) => item.ingestionRun?.runId)
    .filter((value): value is string => Boolean(value))
}

function assertRunAccounting(snapshot: PJSDASSnapshot) {
  for (const item of snapshot.data.timeline ?? []) {
    const run = item.ingestionRun
    if (!run) continue
    const outcomeTotal = Object.values(run.outcomes).reduce((sum, value) => sum + (value ?? 0), 0)
    expect(run.receivedCount, `run=${run.runId} received/accounted`).toBe(run.accountedCount)
    expect(run.accountedCount, `run=${run.runId} accounted/outcomes`).toBe(outcomeTotal)
  }
}

class FaultInjectingDriveSource implements WorkspaceSource {
  snapshot: PJSDASSnapshot = reliabilitySnapshot()
  version = 1
  writeAttempts = 0
  committedWrites = 0
  private faultUsed = false

  constructor(private readonly mode: FaultMode = 'none') {}

  async read(): Promise<GatewayWorkspace> {
    return {
      snapshot: structuredClone(this.snapshot),
      context: {
        workspaceVersion: `drive:${this.version}`,
        now: new Date('2026-09-14T12:00:00.000Z'),
      },
    }
  }

  async write(input: WorkspaceWriteInput): Promise<GatewayWorkspace> {
    this.writeAttempts += 1

    if (this.mode === 'stale-before-write-once' && !this.faultUsed) {
      this.faultUsed = true
      this.snapshot.data.actions.push(reliabilityAction({
        id: 'concurrent-browser-action',
        kind: 'manual',
        title: '浏览器并发新增的真实任务',
        opportunityId: undefined,
      }))
      this.version += 1
    }

    const actualVersion = `drive:${this.version}`
    if (input.expectedWorkspaceVersion && input.expectedWorkspaceVersion !== actualVersion) {
      throw new WorkspaceSourceError(
        'WORKSPACE_CONFLICT',
        `Synthetic Drive baseline moved (${input.expectedWorkspaceVersion} -> ${actualVersion}).`,
        true,
      )
    }

    if (this.mode === 'fail-before-commit-once' && !this.faultUsed) {
      this.faultUsed = true
      throw new WorkspaceSourceError(
        'GOOGLE_DRIVE_UNAVAILABLE',
        'Synthetic network failure before Drive commit.',
        true,
      )
    }

    this.snapshot = structuredClone(input.snapshot)
    this.version += 1
    this.committedWrites += 1

    if (this.mode === 'commit-then-fail-once' && !this.faultUsed) {
      this.faultUsed = true
      throw new WorkspaceSourceError(
        'GOOGLE_DRIVE_UNAVAILABLE',
        'Synthetic acknowledgement loss after Drive commit.',
        true,
      )
    }

    return {
      snapshot: structuredClone(this.snapshot),
      context: {
        workspaceVersion: `drive:${this.version}`,
        now: new Date('2026-09-14T12:00:00.000Z'),
      },
    }
  }
}

class ParallelDriveSource implements WorkspaceSource {
  snapshot: PJSDASSnapshot = reliabilitySnapshot()
  version = 1
  writeAttempts = 0
  committedWrites = 0
  private readsAtBarrier = 0
  private releaseBarrier!: () => void
  private readonly barrier = new Promise<void>((resolve) => {
    this.releaseBarrier = resolve
  })

  async read(): Promise<GatewayWorkspace> {
    const observedSnapshot = structuredClone(this.snapshot)
    const observedVersion = this.version

    if (this.readsAtBarrier < 2) {
      this.readsAtBarrier += 1
      if (this.readsAtBarrier === 2) this.releaseBarrier()
      await this.barrier
    }

    return {
      snapshot: observedSnapshot,
      context: {
        workspaceVersion: `drive:${observedVersion}`,
        now: new Date('2026-09-14T12:00:00.000Z'),
      },
    }
  }

  async write(input: WorkspaceWriteInput): Promise<GatewayWorkspace> {
    this.writeAttempts += 1
    const actualVersion = `drive:${this.version}`
    if (input.expectedWorkspaceVersion !== actualVersion) {
      throw new WorkspaceSourceError(
        'WORKSPACE_CONFLICT',
        `Parallel writer lost optimistic race (${input.expectedWorkspaceVersion} -> ${actualVersion}).`,
        true,
      )
    }

    this.snapshot = structuredClone(input.snapshot)
    this.version += 1
    this.committedWrites += 1
    return {
      snapshot: structuredClone(this.snapshot),
      context: {
        workspaceVersion: `drive:${this.version}`,
        now: new Date('2026-09-14T12:00:00.000Z'),
      },
    }
  }
}

describe('v1.10 Drive / sync / replay fault injection', () => {
  it('fails closed on a browser/cloud race, then retries from the latest workspace without overwriting the concurrent user change', async () => {
    const source = new FaultInjectingDriveSource('stale-before-write-once')
    const args = discoveryArgs({ runId: 'race-run', sourceRecordId: 'race-job' })

    const raced = await invokeVerified(source, args)
    expect(raced.isError).toBe(true)
    expect(errorPayload(raced)).toMatchObject({ code: 'WORKSPACE_CONFLICT', retryable: true })
    expect(source.committedWrites).toBe(0)
    expect(source.snapshot.data.opportunities).toHaveLength(0)
    expect(source.snapshot.data.actions.map((item) => item.id)).toContain('concurrent-browser-action')

    const retried = await invokeVerified(source, args)
    expect(retried.isError).not.toBe(true)
    expect(source.committedWrites).toBe(1)
    expect(source.snapshot.data.opportunities).toHaveLength(1)
    expect(source.snapshot.data.actions.map((item) => item.id)).toContain('concurrent-browser-action')
    expect(durableRunIds(source.snapshot)).toEqual(['race-run'])
    expect(projectReliabilityState(source.snapshot).integrity.criticalCount).toBe(0)
    assertRunAccounting(source.snapshot)
  })

  it('retries a network failure that happened before commit exactly once without inventing partial durable state', async () => {
    const source = new FaultInjectingDriveSource('fail-before-commit-once')
    const args = discoveryArgs({ runId: 'precommit-run', sourceRecordId: 'precommit-job' })

    const failed = await invokeVerified(source, args)
    expect(failed.isError).toBe(true)
    expect(errorPayload(failed)).toMatchObject({ code: 'GOOGLE_DRIVE_UNAVAILABLE', retryable: true })
    expect(source.version).toBe(1)
    expect(source.committedWrites).toBe(0)
    expect(source.snapshot.data.opportunities).toHaveLength(0)
    expect(durableRunIds(source.snapshot)).toEqual([])

    const retried = await invokeVerified(source, args)
    expect(retried.isError).not.toBe(true)
    expect(source.version).toBe(2)
    expect(source.committedWrites).toBe(1)
    expect(source.snapshot.data.opportunities).toHaveLength(1)
    expect(durableRunIds(source.snapshot)).toEqual(['precommit-run'])
    assertRunAccounting(source.snapshot)
  })

  it('survives acknowledgement loss after commit: retry observes the durable run and never writes it twice', async () => {
    const source = new FaultInjectingDriveSource('commit-then-fail-once')
    const args = discoveryArgs({ runId: 'lost-ack-run', sourceRecordId: 'lost-ack-job' })

    const uncertain = await invokeVerified(source, args)
    expect(uncertain.isError).toBe(true)
    expect(errorPayload(uncertain)).toMatchObject({ code: 'GOOGLE_DRIVE_UNAVAILABLE', retryable: true })
    expect(source.version).toBe(2)
    expect(source.committedWrites).toBe(1)
    expect(source.snapshot.data.opportunities).toHaveLength(1)
    expect(durableRunIds(source.snapshot)).toEqual(['lost-ack-run'])

    const retried = await invokeVerified(source, args)
    expect(retried.isError).not.toBe(true)
    expect(resultPayload(retried)).toMatchObject({ alreadyApplied: true, workspaceVersion: 'drive:2' })
    expect(source.writeAttempts).toBe(1)
    expect(source.committedWrites).toBe(1)
    expect(source.snapshot.data.opportunities).toHaveLength(1)
    expect(durableRunIds(source.snapshot)).toEqual(['lost-ack-run'])
    assertRunAccounting(source.snapshot)
  })

  it('serializes two autonomous writers through optimistic version conflicts instead of last-write-wins data loss', async () => {
    const source = new ParallelDriveSource()
    const firstArgs = discoveryArgs({ runId: 'parallel-ai-pm', sourceRecordId: 'parallel-ai', role: 'AI产品经理' })
    const secondArgs = discoveryArgs({ runId: 'parallel-strategy', sourceRecordId: 'parallel-strategy', role: '战略分析' })

    const results = await Promise.all([
      invokeVerified(source, firstArgs),
      invokeVerified(source, secondArgs),
    ])

    const errors = results.map((result, index) => ({ result, index })).filter(({ result }) => result.isError)
    const successes = results.filter((result) => !result.isError)
    expect(errors).toHaveLength(1)
    expect(successes).toHaveLength(1)
    expect(errorPayload(errors[0]!.result)).toMatchObject({ code: 'WORKSPACE_CONFLICT', retryable: true })
    expect(source.committedWrites).toBe(1)
    expect(source.snapshot.data.opportunities).toHaveLength(1)

    const failedArgs = errors[0]!.index === 0 ? firstArgs : secondArgs
    const retry = await invokeVerified(source, failedArgs)
    expect(retry.isError).not.toBe(true)
    expect(source.committedWrites).toBe(2)
    expect(source.snapshot.data.opportunities).toHaveLength(2)
    expect(source.snapshot.data.opportunities.map((item) => item.role).sort()).toEqual(['AI产品经理', '战略分析'].sort())
    expect(durableRunIds(source.snapshot).sort()).toEqual(['parallel-ai-pm', 'parallel-strategy'].sort())
    expect(projectReliabilityState(source.snapshot).integrity.criticalCount).toBe(0)
    assertRunAccounting(source.snapshot)
  })

  it('keeps replay read-only even after later durable workspace changes', async () => {
    const source = new FaultInjectingDriveSource()
    const original = discoveryArgs({ runId: 'replay-original', sourceRecordId: 'replay-job-a', role: 'AI产品经理' })
    const later = discoveryArgs({ runId: 'replay-later', sourceRecordId: 'replay-job-b', role: '商业分析' })

    expect((await invokeVerified(source, original)).isError).not.toBe(true)
    expect((await invokeVerified(source, later)).isError).not.toBe(true)

    const before = JSON.stringify(source.snapshot)
    const beforeVersion = source.version
    const beforeWrites = source.committedWrites
    const replay = await invokeVerified(source, discoveryArgs({
      runId: 'replay-preview',
      sourceRecordId: 'replay-job-a',
      role: 'AI产品经理',
      extras: { dryRun: true, replayOfRunId: 'replay-original' },
    }))

    expect(replay.isError).not.toBe(true)
    expect(resultPayload(replay).replay).toMatchObject({ replayOfRunId: 'replay-original', baselineFound: true })
    expect(source.version).toBe(beforeVersion)
    expect(source.committedWrites).toBe(beforeWrites)
    expect(JSON.stringify(source.snapshot)).toBe(before)
    expect(source.snapshot.data.opportunities).toHaveLength(2)
    assertRunAccounting(source.snapshot)
  })
})
