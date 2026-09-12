import { describe, expect, it } from 'vitest'
import { invokeCoverageStatus } from '../gateway/coverageTool.js'
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

function monitorArgs(runId = 'run-1') {
  return {
    runId,
    sourceId: 'monitor-core',
    startedAt: '2026-09-13T00:00:00.000Z',
    completedAt: '2026-09-13T00:05:00.000Z',
    observations: [{
      sourceRecordId: 'job-123',
      company: 'Example',
      role: 'AI Product Manager',
      sourceUrl: 'https://careers.example.com/job/123',
      sourceTitle: 'AI Product Manager',
      rationale: 'Explicitly matches the configured direction.',
      roleType: 'core',
      opportunityValue: 80,
      fitScore: 78,
      fitConfidence: 'high',
      opportunityValueConfidence: 'high',
      postingStatus: 'open',
    }],
  }
}

class WritableSource implements WorkspaceSource {
  snapshot: PJSDASSnapshot = initialSnapshot()
  version = 5
  writes: WorkspaceWriteInput[] = []

  async read(): Promise<GatewayWorkspace> {
    return { snapshot: this.snapshot, context: { workspaceVersion: `drive:${this.version}`, now: new Date('2026-09-13T00:10:00.000Z') } }
  }

  async write(input: WorkspaceWriteInput): Promise<GatewayWorkspace> {
    expect(input.expectedWorkspaceVersion).toBe(`drive:${this.version}`)
    this.writes.push(input)
    this.snapshot = input.snapshot
    this.version += 1
    return { snapshot: this.snapshot, context: { workspaceVersion: `drive:${this.version}`, now: new Date('2026-09-13T00:10:00.000Z') } }
  }
}

function textError(result: Awaited<ReturnType<typeof invokeTrustedIngestion>>) {
  const first = result.content[0]
  if (!first || first.type !== 'text') return {}
  return JSON.parse(first.text) as { code?: string; message?: string }
}

describe('trusted ingestion MCP boundary', () => {
  it('writes a monitor run once and treats exact run retry as idempotent', async () => {
    const source = new WritableSource()

    const first = await invokeTrustedIngestion(source, 'ingest_discovery_run', monitorArgs())
    expect(first.isError).not.toBe(true)
    expect(source.writes).toHaveLength(1)
    expect(first.structuredContent).toMatchObject({
      workspaceVersion: 'drive:6',
      alreadyApplied: false,
      allInputsAccounted: true,
      unresolvedCount: 0,
    })

    const second = await invokeTrustedIngestion(source, 'ingest_discovery_run', monitorArgs())
    expect(second.isError).not.toBe(true)
    expect(source.writes).toHaveLength(1)
    expect(second.structuredContent).toMatchObject({ alreadyApplied: true, allInputsAccounted: true })
  })

  it('fails closed when trusted ingestion is invoked on a read-only source', async () => {
    const source: WorkspaceSource = {
      async read() {
        return { snapshot: initialSnapshot(), context: { workspaceVersion: 'file:1' } }
      },
    }

    const result = await invokeTrustedIngestion(source, 'ingest_discovery_run', monitorArgs('run-readonly'))
    expect(result.isError).toBe(true)
    expect(textError(result).code).toBe('WORKSPACE_READ_ONLY')
  })

  it('exposes durable reconciliation through get_coverage_status', async () => {
    const source = new WritableSource()
    await invokeTrustedIngestion(source, 'ingest_discovery_run', monitorArgs())

    const result = await invokeCoverageStatus(source)
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({
      coverage: {
        allCaughtUp: true,
        sourceCount: 1,
        totalReceived: 1,
        totalAccounted: 1,
        unresolvedCount: 0,
      },
    })
  })
})
