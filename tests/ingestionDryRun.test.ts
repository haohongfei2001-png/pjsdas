import { describe, expect, it } from 'vitest'
import { invokeTrustedIngestion } from '../gateway/ingestSources.js'
import type { GatewayWorkspace, WorkspaceSource, WorkspaceWriteInput } from '../gateway/workspaceSource.js'
import { createDefaultDecisionRules } from '../src/decisionRules.js'
import { createDefaultDiscoveryProfile } from '../src/discoveryProfile.js'
import { createSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'

function initialSnapshot() {
  return createSnapshot({
    opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [],
    decisionRules: createDefaultDecisionRules('2026-09-13T00:00:00.000Z'),
    discoveryProfile: createDefaultDiscoveryProfile('2026-09-13T00:00:00.000Z'),
    discoveryInbox: [], timeline: [], changeSets: [],
  }, '2026-09-13T00:00:00.000Z')
}

function args(runId: string, extras: Record<string, unknown> = {}) {
  return {
    runId,
    sourceId: 'monitor:urgent-campus',
    startedAt: '2026-09-13T00:00:00.000Z',
    completedAt: '2026-09-13T00:05:00.000Z',
    observations: [{
      sourceRecordId: 'job-1', company: 'Example', role: 'AI Product Manager', sourceUrl: 'https://example.com/jobs/1', sourceTitle: 'AI Product Manager',
      rationale: 'source backed', roleType: 'core', opportunityValue: 80, fitScore: 75, fitConfidence: 'high', opportunityValueConfidence: 'high', postingStatus: 'open',
    }],
    ...extras,
  }
}

class Writable implements WorkspaceSource {
  snapshot: PJSDASSnapshot = initialSnapshot()
  writes: WorkspaceWriteInput[] = []
  version = 1
  async read(): Promise<GatewayWorkspace> { return { snapshot: this.snapshot, context: { workspaceVersion: `drive:${this.version}`, now: new Date('2026-09-13T00:10:00Z') } } }
  async write(input: WorkspaceWriteInput): Promise<GatewayWorkspace> {
    this.writes.push(input); this.snapshot = input.snapshot; this.version += 1
    return { snapshot: this.snapshot, context: { workspaceVersion: `drive:${this.version}`, now: new Date('2026-09-13T00:10:00Z') } }
  }
}


const verifiedSource = async (observation: any) => ({
  ...observation,
  sourceVerification: 'verified' as const,
  sourceVerifiedAt: '2026-09-13T00:04:00.000Z',
})

function structured(result: Awaited<ReturnType<typeof invokeTrustedIngestion>>) {
  return result.structuredContent as Record<string, any>
}

describe('trusted ingestion dry-run and replay', () => {
  it('simulates a run without writing or mutating the source workspace', async () => {
    const source = new Writable()
    const before = JSON.stringify(source.snapshot)
    const result = await invokeTrustedIngestion(source, 'ingest_discovery_run', args('dry-1', { dryRun: true }), { sourceVerifier: verifiedSource })
    expect(result.isError).not.toBe(true)
    expect(source.writes).toHaveLength(0)
    expect(JSON.stringify(source.snapshot)).toBe(before)
    expect(structured(result)).toMatchObject({ dryRun: true, allInputsAccounted: true, createdOpportunityIds: expect.any(Array) })
    expect(structured(result).createdOpportunityIds).toHaveLength(1)
  })

  it('allows dry-run on a read-only source because no mutation is attempted', async () => {
    const snapshot = initialSnapshot()
    const source: WorkspaceSource = { async read() { return { snapshot, context: { workspaceVersion: 'file:1' } } } }
    const result = await invokeTrustedIngestion(source, 'ingest_discovery_run', args('dry-readonly', { dryRun: true }), { sourceVerifier: verifiedSource })
    expect(result.isError).not.toBe(true)
    expect(structured(result).dryRun).toBe(true)
  })

  it('replays a prior run against current state, compares outcomes, and still performs zero writes', async () => {
    const source = new Writable()
    const applied = await invokeTrustedIngestion(source, 'ingest_discovery_run', args('original'), { sourceVerifier: verifiedSource })
    expect(applied.isError).not.toBe(true)
    expect(source.writes).toHaveLength(1)

    const replay = await invokeTrustedIngestion(source, 'ingest_discovery_run', args('replay-attempt', {
      dryRun: true,
      replayOfRunId: 'original',
    }), { sourceVerifier: verifiedSource })
    expect(replay.isError).not.toBe(true)
    expect(source.writes).toHaveLength(1)
    expect(structured(replay).replay).toMatchObject({ replayOfRunId: 'original', baselineFound: true })
    expect(structured(replay).replay.baseline.receivedCount).toBe(1)
    expect(structured(replay).replay.preview.receivedCount).toBe(1)
  })

  it('rejects replay without dryRun so historical debugging can never mutate state', async () => {
    const source = new Writable()
    const result = await invokeTrustedIngestion(source, 'ingest_discovery_run', args('bad-replay', { replayOfRunId: 'anything' }), { sourceVerifier: verifiedSource })
    expect(result.isError).toBe(true)
    expect(source.writes).toHaveLength(0)
  })
})
