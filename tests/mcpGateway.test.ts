import { describe, expect, it } from 'vitest'
import { READ_TOOL_NAMES, invokeReadTool, type ReadToolName } from '../gateway/readTools.js'
import { createPjsdasMcpServer } from '../gateway/serverFactory.js'
import { createFileWorkspaceSource } from '../gateway/workspaceSource.js'

const source = createFileWorkspaceSource({
  file: new URL('../gateway/fixtures/demo-workspace.json', import.meta.url),
  now: new Date('2026-09-11T09:00:00+08:00'),
  timezone: 'Asia/Shanghai',
  workspaceVersion: 'demo-v1',
})

function jsonFrom(result: Awaited<ReturnType<typeof invokeReadTool>>) {
  const item = result.content[0]
  if (!item || item.type !== 'text') throw new Error('Expected a text MCP tool result.')
  return JSON.parse(item.text) as Record<string, any>
}

describe('PJSDAS MCP gateway alpha', () => {
  it('exposes the bounded v1.5 Round 2 read-only tool set', () => {
    expect(READ_TOOL_NAMES).toEqual([
      'get_today_plan',
      'list_opportunities',
      'get_opportunity_assessment',
      'get_pipeline',
      'get_decision_rules',
      'get_discovery_context',
      'explain_priority',
      'get_recent_timeline',
    ])
  })

  it('constructs an MCP server without opening a transport', () => {
    expect(createPjsdasMcpServer(source)).toBeTruthy()
  })

  it.each([
    ['get_today_plan', { availableMinutes: 180 }],
    ['list_opportunities', { limit: 10 }],
    ['get_opportunity_assessment', { opportunityId: 'opp-alpha' }],
    ['get_pipeline', { attentionOnly: true }],
    ['get_decision_rules', {}],
    ['get_discovery_context', {}],
    ['explain_priority', { opportunityId: 'opp-alpha', compareWithOpportunityId: 'opp-beta' }],
    ['get_recent_timeline', { since: '2026-09-10T00:00:00+08:00' }],
  ] satisfies Array<[ReadToolName, unknown]>)('runs %s against the validated snapshot source', async (name, args) => {
    const result = await invokeReadTool(source, name, args)
    expect(result.isError).not.toBe(true)
    const data = jsonFrom(result)
    expect(data.meta).toMatchObject({ source: 'pjsdas', workspaceVersion: 'demo-v1', timezone: 'Asia/Shanghai' })
  })

  it('returns component weight policy through get_decision_rules', async () => {
    const result = await invokeReadTool(source, 'get_decision_rules', {})
    expect(result.isError).not.toBe(true)
    const data = jsonFrom(result)
    expect(data.fitComponentWeights).toMatchObject({ roleDirection: 24, location: 18 })
    expect(data.opportunityValueComponentWeights).toMatchObject({ companyQuality: 18, roleGrowth: 18 })
  })

  it('returns a stable non-retryable tool error for invalid input', async () => {
    const result = await invokeReadTool(source, 'list_opportunities', { limit: 1000 })
    expect(result.isError).toBe(true)
    expect(jsonFrom(result)).toMatchObject({ code: 'INVALID_ARGUMENT', retryable: false })
  })
})
