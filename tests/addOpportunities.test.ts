import { describe, expect, it } from 'vitest'
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
      rationale: 'The user explicitly asked to add this source-backed role.',
      roleType: 'core' as const,
      postingStatus: 'open' as const,
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
  it('adds a source-backed opportunity immediately with an apply action and audit timeline, without a review step', async () => {
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
    expect(source.snapshot.data.actions).toHaveLength(1)
    expect(source.snapshot.data.timeline).toHaveLength(1)

    const opportunity = source.snapshot.data.opportunities[0]!
    expect(opportunity).toMatchObject({
      company: 'Example AI',
      role: 'AI Product Manager',
      processStage: 'not_applied',
      currentStageLabel: '待投',
      roleType: 'core',
      opportunityValue: 50,
      fitScore: 50,
      sourcePriority: 'ChatGPT 明确写入 · 待补评估',
      assessmentStatus: 'unassessed',
      locallyManaged: true,
    })
    expect(opportunity.detail?.discovery?.posting?.canonicalSourceUrl).toBe('https://careers.example.com/jobs/ai-pm')
    expect(opportunity.detail?.discovery?.fitConfidence).toBe('low')
    expect(opportunity.detail?.discovery?.opportunityValueConfidence).toBe('low')
    expect(source.snapshot.data.actions[0]).toMatchObject({
      kind: 'apply',
      opportunityId: opportunity.id,
      status: 'todo',
      sourceLabel: 'ChatGPT 明确写入',
    })
    expect(source.snapshot.data.timeline?.[0]).toMatchObject({
      kind: 'opportunity_added',
      source: 'user_action',
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
    expect(source.snapshot.data.actions).toHaveLength(1)
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
})
