import { discoveryReceiptFixture, verifiedPostingFixture } from './fixtures/verifiedDiscovery.js'
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
    discoveryProfile: { ...createDefaultDiscoveryProfile('2026-09-13T00:00:00.000Z'), searchScopeVersion: 1, targetRoleQueries: ['AI Product Manager'] },
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
      sourceRecordId: 'job-1', company: 'Example', role: 'AI Product Manager', sourceUrl: 'https://www.liepin.com/job/9421.shtml', sourceTitle: 'AI Product Manager',
      postingStatus: 'unknown',
    }],
    ...extras,
  }
}

class Writable implements WorkspaceSource {
  snapshot: PJSDASSnapshot = initialSnapshot()
  writes: WorkspaceWriteInput[] = []
  version = 1
  receipts = new Map<string, NonNullable<ReturnType<typeof discoveryReceiptFixture>>>()
  async readCommandReceipt(commandId: string) { return structuredClone(this.receipts.get(commandId) ?? null) }
  async read(): Promise<GatewayWorkspace> { return { snapshot: this.snapshot, context: { workspaceVersion: `txn:${this.version}`, now: new Date('2026-09-13T00:10:00Z') } } }
  async write(input: WorkspaceWriteInput): Promise<GatewayWorkspace> {
    expect(input.expectedWorkspaceVersion).toBe(`txn:${this.version}`)
    expect(input.command?.discoveryAuthorization).toMatchObject({ kind: 'delegated_mcp', userId: 'synthetic-account', sourceId: input.command?.provenance?.sourceId })
    const existing = this.receipts.get(input.command!.commandId)
    if (existing) throw new Error('The adapter must reconcile the original command before proposing another write')
    this.writes.push(input); this.snapshot = structuredClone(input.snapshot); this.version += 1
    const recorded = discoveryReceiptFixture(input, this.version, '2026-09-13T00:10:00.000Z')!
    this.receipts.set(recorded.commandId, recorded)
    return { snapshot: structuredClone(this.snapshot), context: { workspaceVersion: `txn:${this.version}`, now: new Date('2026-09-13T00:10:00.000Z') }, commandOutcome: 'COMMITTED', commandReceipt: structuredClone(recorded.receipt) }
  }
}


const verifiedSource = async (observation: any) => verifiedPostingFixture(observation, '2026-09-13T00:04:00.000Z')
const sourceOptions = { sourceVerifier: verifiedSource, authorize: async (_name: unknown, sourceId: string) => ({ kind: 'delegated_mcp' as const,
  userId: 'synthetic-account', clientId: 'synthetic-client', sourceId, grantId: '11111111-1111-4111-8111-111111111111', grantRevision: 1 }) }


function structured(result: Awaited<ReturnType<typeof invokeTrustedIngestion>>) {
  return result.structuredContent as Record<string, any>
}

describe('trusted ingestion dry-run and replay', () => {
  it('simulates a run without writing or mutating the source workspace', async () => {
    const source = new Writable()
    const before = JSON.stringify(source.snapshot)
    const result = await invokeTrustedIngestion(source, 'ingest_discovery_run', args('dry-1', { dryRun: true }), sourceOptions)
    expect(result.isError).not.toBe(true)
    expect(source.writes).toHaveLength(0)
    expect(JSON.stringify(source.snapshot)).toBe(before)
    expect(structured(result)).toMatchObject({ dryRun: true, allInputsAccounted: true, createdOpportunityIds: expect.any(Array) })
    expect(structured(result).createdOpportunityIds).toHaveLength(1)
  })

  it('allows dry-run on a read-only source because no mutation is attempted', async () => {
    const snapshot = initialSnapshot()
    const source: WorkspaceSource = { async read() { return { snapshot, context: { workspaceVersion: 'file:1' } } } }
    const result = await invokeTrustedIngestion(source, 'ingest_discovery_run', args('dry-readonly', { dryRun: true }), sourceOptions)
    expect(result.isError).not.toBe(true)
    expect(structured(result).dryRun).toBe(true)
  })

  it('replays a prior run against current state, compares outcomes, and still performs zero writes', async () => {
    const source = new Writable()
    const applied = await invokeTrustedIngestion(source, 'ingest_discovery_run', args('original'), sourceOptions)
    expect(applied.isError).not.toBe(true)
    expect(source.writes).toHaveLength(1)

    const replay = await invokeTrustedIngestion(source, 'ingest_discovery_run', args('replay-attempt', {
      dryRun: true,
      replayOfRunId: 'original',
    }), sourceOptions)
    expect(replay.isError).not.toBe(true)
    expect(source.writes).toHaveLength(1)
    expect(structured(replay).replay).toMatchObject({ replayOfRunId: 'original', baselineFound: true })
    expect(structured(replay).replay.baseline.receivedCount).toBe(1)
    expect(structured(replay).replay.preview.receivedCount).toBe(1)
  })

  it('rejects replay without dryRun so historical debugging can never mutate state', async () => {
    const source = new Writable()
    const result = await invokeTrustedIngestion(source, 'ingest_discovery_run', args('bad-replay', { replayOfRunId: 'anything' }), sourceOptions)
    expect(result.isError).toBe(true)
    expect(source.writes).toHaveLength(0)
  })
})
