import { describe, expect, it } from 'vitest'
import { invokeReadTool } from '../gateway/readTools.js'
import { createFileWorkspaceSource, type WorkspaceSource } from '../gateway/workspaceSource.js'

const base = createFileWorkspaceSource({
  file: new URL('../gateway/fixtures/demo-workspace.json', import.meta.url),
  now: new Date('2026-09-12T08:00:00+08:00'),
  timezone: 'Asia/Shanghai',
  workspaceVersion: 'drive:21',
})

const source: WorkspaceSource = {
  async read() {
    const workspace = await base.read()
    const opportunities = workspace.snapshot.data.opportunities.map((item) => item.id === 'opp-alpha' ? {
      ...item,
      detail: {
        ...item.detail,
        facts: {
          version: 1 as const,
          identity: {},
          role: { skills: ['SQL'] },
          application: {},
          compensation: {},
          evidence: {
            sourceUrl: 'https://example.com/alpha',
            sourceTitle: 'alpha',
            verifiedAt: '2026-09-12T00:00:00.000Z',
          },
          unknownFields: [],
        },
        assessment: {
          version: 1 as const,
          mode: 'component' as const,
          fit: { skills: { score: 50, confidence: 'high' as const, rationale: 'SQL 需要补强。' } },
          opportunityValue: { companyQuality: { score: 88, confidence: 'high' as const, rationale: '平台较强。' } },
          assessedAt: '2026-09-12T00:00:00.000Z',
        },
      },
    } : item)
    return {
      ...workspace,
      snapshot: {
        ...workspace.snapshot,
        data: {
          ...workspace.snapshot.data,
          opportunities,
          prep: [{
            id: 'prep:sql',
            title: 'SQL 刷题',
            triggeredBy: 'opp-alpha',
            sourceStatus: '等待触发',
            estimatedMinutes: 90,
            createdAt: '2026-09-10T00:00:00.000Z',
            updatedAt: '2026-09-10T00:00:00.000Z',
          }],
        },
      },
    }
  },
}

function jsonFrom(result: Awaited<ReturnType<typeof invokeReadTool>>) {
  const item = result.content[0]
  if (!item || item.type !== 'text') throw new Error('Expected text result')
  return JSON.parse(item.text) as Record<string, any>
}

describe('v1.6 Round 2 Prep Graph read tool', () => {
  it('returns deterministic prep coverage and trigger suggestions without mutation', async () => {
    const result = await invokeReadTool(source, 'get_prep_graph', { prepId: 'prep:sql' })
    expect(result.isError).not.toBe(true)
    const data = jsonFrom(result)
    expect(data.meta).toMatchObject({ source: 'pjsdas', workspaceVersion: 'drive:21', timezone: 'Asia/Shanghai' })
    expect(data.nodes).toHaveLength(1)
    expect(data.nodes[0]).toMatchObject({ prepId: 'prep:sql', coverageCount: 1, triggerSuggested: true })
    expect(data.nodes[0].links.some((link: any) => link.source === 'explicit_trigger')).toBe(true)
    expect(data.policy).toMatchObject({ explicitOrExactOnly: true, fuzzySemanticLinks: false, automaticTaskCreation: false })
  })

  it('returns NOT_FOUND for an exact unknown Prep id', async () => {
    const result = await invokeReadTool(source, 'get_prep_graph', { prepId: 'prep:missing' })
    expect(result.isError).toBe(true)
    expect(jsonFrom(result)).toMatchObject({ code: 'NOT_FOUND', retryable: false })
  })
})
