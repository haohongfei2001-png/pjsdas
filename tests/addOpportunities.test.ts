import { describe, expect, it } from 'vitest'
import { applySemanticCompensation } from '../src/semanticIntake.js'
import { invokeAddOpportunities } from '../gateway/addOpportunities.js'
import type { GatewayWorkspace, WorkspaceSource, WorkspaceWriteInput } from '../gateway/workspaceSource.js'
import { createDefaultDecisionRules } from '../src/decisionRules.js'
import { createDefaultDiscoveryProfile } from '../src/discoveryProfile.js'
import { createSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'

function initialSnapshot() {
  return createSnapshot({
    opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [],
    decisionRules: createDefaultDecisionRules('2026-09-17T10:00:00.000Z'),
    discoveryProfile: createDefaultDiscoveryProfile('2026-09-17T10:00:00.000Z'),
    discoveryInbox: [], timeline: [], changeSets: [],
  }, '2026-09-17T10:00:00.000Z')
}

function args() {
  return {
    opportunities: [{
      company: 'Example AI',
      role: 'AI Product Manager',
      sourceUrl: 'https://careers.example.com/jobs/ai-pm?utm_source=test',
      sourceTitle: 'AI Product Manager - Campus Recruiting',
      location: 'Shanghai',
      deadline: '2026-10-10',
    }],
  }
}

class WritableSource implements WorkspaceSource {
  snapshot: PJSDASSnapshot = initialSnapshot()
  version = 4
  writes: WorkspaceWriteInput[] = []

  async read(): Promise<GatewayWorkspace> {
    return { snapshot: this.snapshot, context: { workspaceVersion: `drive:${this.version}`, now: new Date('2026-09-17T10:30:00.000Z') } }
  }

  async write(input: WorkspaceWriteInput): Promise<GatewayWorkspace> {
    expect(input.expectedWorkspaceVersion).toBe(`drive:${this.version}`)
    expect(input.updatedByDevice).toBe('mcp-explicit-user-write')
    this.writes.push(input)
    this.snapshot = input.snapshot
    this.version += 1
    return { snapshot: this.snapshot, context: { workspaceVersion: `drive:${this.version}`, now: new Date('2026-09-17T10:30:00.000Z') } }
  }
}

function textError(result: Awaited<ReturnType<typeof invokeAddOpportunities>>) {
  const first = result.content[0]
  if (!first || first.type !== 'text') return {}
  return JSON.parse(first.text) as { code?: string; message?: string }
}

describe('explicit user-authorized opportunity writes', () => {
  it('adds a source-backed opportunity as facts only with the shared domain receipt and audit timeline, without a review step', async () => {
    const source = new WritableSource()
    const result = await invokeAddOpportunities(source, args())

    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({
      applied: true,
      reviewRequired: false,
      workspaceVersion: 'drive:5',
      createdCount: 1,
      duplicateCount: 0,
    })
    expect(source.writes).toHaveLength(1)
    expect(source.snapshot.data.opportunities).toHaveLength(1)
    expect(source.snapshot.data.actions).toHaveLength(0)
    expect(source.snapshot.data.timeline!.filter(item => item.kind === 'opportunity_added')).toHaveLength(1)
    expect(source.snapshot.data.scheduleNodes).toHaveLength(0)
    expect(source.writes[0].command?.compensation).toBeDefined()

    const opportunity = source.snapshot.data.opportunities[0]!
    expect(opportunity).toMatchObject({
      company: 'Example AI',
      role: 'AI Product Manager',
      processStage: 'not_applied',
      currentStageLabel: '未投递',
      opportunityValue: 0,
      fitScore: 0,
      locallyManaged: true,
    })
    expect(opportunity.detail?.userFacts?.applicationUrl).toBe('https://careers.example.com/jobs/ai-pm')
    expect(opportunity.detail?.userFacts?.provenance).toBe('user_asserted')
    expect(opportunity.roleType).toBeUndefined()
    expect(opportunity.detail?.discovery).toBeUndefined()
    expect(source.snapshot.data.timeline?.[0]).toMatchObject({
      kind: 'opportunity_added',
      source: 'mcp',
      opportunityId: opportunity.id,
    })
  })

  it('is idempotent at the logical-job boundary and does not require a second workspace write for a retry', async () => {
    const source = new WritableSource()
    const first = await invokeAddOpportunities(source, args())
    expect(first.isError).not.toBe(true)
    expect(source.writes).toHaveLength(1)

    const second = await invokeAddOpportunities(source, args())
    expect(second.isError).not.toBe(true)
    expect(second.structuredContent).toMatchObject({
      applied: true,
      reviewRequired: false,
      workspaceVersion: 'drive:5',
      createdCount: 0,
      duplicateCount: 1,
    })
    expect(source.writes).toHaveLength(1)
    expect(source.snapshot.data.opportunities).toHaveLength(1)
    expect(source.snapshot.data.actions).toHaveLength(0)
  })

  it('keeps same-company same-title roles distinct when exact posting URLs differ', async () => {
    const source = new WritableSource()
    const first = await invokeAddOpportunities(source, args())
    expect(first.isError).not.toBe(true)

    const second = await invokeAddOpportunities(source, {
      opportunities: [{
        ...args().opportunities[0],
        sourceUrl: 'https://careers.example.com/jobs/ai-pm-community',
        sourceTitle: 'AI Product Manager - Community Product',
      }],
    })

    expect(second.isError).not.toBe(true)
    expect(second.structuredContent).toMatchObject({
      applied: true,
      reviewRequired: false,
      createdCount: 1,
      duplicateCount: 0,
      ambiguityCount: 0,
    })
    expect(source.writes).toHaveLength(2)
    expect(source.snapshot.data.opportunities).toHaveLength(2)
    expect(source.snapshot.data.opportunities.map((item) => item.detail?.userFacts?.applicationUrl).sort()).toEqual([
      'https://careers.example.com/jobs/ai-pm',
      'https://careers.example.com/jobs/ai-pm-community',
    ])
  })

  it('deduplicates tracking variants of the same exact posting URL', async () => {
    const source = new WritableSource()
    await invokeAddOpportunities(source, args())
    const second = await invokeAddOpportunities(source, {
      opportunities: [{
        ...args().opportunities[0],
        sourceUrl: 'https://careers.example.com/jobs/ai-pm?utm_source=another&ref=campaign',
      }],
    })
    expect(second.structuredContent).toMatchObject({
      applied: true,
      reviewRequired: false,
      createdCount: 0,
      duplicateCount: 1,
      ambiguityCount: 0,
    })
    expect(source.writes).toHaveLength(1)
    expect(source.snapshot.data.opportunities).toHaveLength(1)
  })

  it('fails closed on a read-only workspace instead of pretending the explicit write succeeded', async () => {
    const source: WorkspaceSource = {
      async read() {
        return { snapshot: initialSnapshot(), context: { workspaceVersion: 'file:1', now: new Date('2026-09-17T10:30:00.000Z') } }
      },
    }
    const result = await invokeAddOpportunities(source, args())
    expect(result.isError).toBe(true)
    expect(textError(result).code).toBe('WORKSPACE_READ_ONLY')
  })
  it('does not revive an undone Drive job when the original command ID is replayed', async () => {
    const source = new WritableSource()
    const request = { ...args(), commandId: 'explicit-drive-undo-001' }
    await invokeAddOpportunities(source, request)
    source.snapshot = applySemanticCompensation(source.snapshot, source.writes[0].command!.compensation as any, new Date('2026-09-17T11:00:00Z'))
    source.version += 1
    const before = structuredClone(source.snapshot)
    const result = await invokeAddOpportunities(source, request)
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({ applied: false, alreadyApplied: true, createdCount: 0 })
    expect(source.snapshot).toEqual(before); expect(source.writes).toHaveLength(1)
    expect(source.snapshot.data.opportunities).toEqual([])
    const changed = await invokeAddOpportunities(source, { ...request, opportunities: [{ company: 'Changed', role: 'Different' }] })
    expect(textError(changed).code).toBe('COMMAND_ID_REUSED'); expect(source.writes).toHaveLength(1)
  })
  it('accepts company/title alone, rejects retired fields, and binds replay to exact facts', async () => {
    const source = new WritableSource()
    const input = { commandId: 'synthetic-manual-job', opportunities: [{ company: 'No Link', role: 'Product' }] }
    expect((await invokeAddOpportunities(source, input)).isError).not.toBe(true)
    const before = structuredClone(source.snapshot)
    expect((await invokeAddOpportunities(source, { ...input, opportunities: [{ company: 'Changed', role: 'Product' }] })).isError).toBe(true)
    expect((await invokeAddOpportunities(source, { opportunities: [{ company: 'Forbidden', role: 'Product', roleType: 'core' }] })).isError).toBe(true)
    expect(source.snapshot).toEqual(before)
    expect(source.snapshot.data.actions).toEqual([])
    expect(source.snapshot.data.scheduleNodes).toEqual([])
  })

})
