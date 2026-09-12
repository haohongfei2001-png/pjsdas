import { describe, expect, it } from 'vitest'
import { invokeReadTool } from '../gateway/readTools.js'
import { createFileWorkspaceSource, type WorkspaceSource } from '../gateway/workspaceSource.js'

const base = createFileWorkspaceSource({
  file: new URL('../gateway/fixtures/demo-workspace.json', import.meta.url),
  now: new Date('2026-09-12T08:00:00+08:00'),
  timezone: 'Asia/Shanghai',
  workspaceVersion: 'drive:20',
})

const source: WorkspaceSource = {
  async read() {
    const workspace = await base.read()
    const alpha = workspace.snapshot.data.opportunities[0]
    return {
      ...workspace,
      snapshot: {
        ...workspace.snapshot,
        data: {
          ...workspace.snapshot.data,
          opportunities: [
            { ...alpha, id: 'opp-one', applicationGroupId: 'GROUP-TEST', role: 'AI 产品经理', fitScore: 90, opportunityValue: 92 },
            { ...alpha, id: 'opp-two', applicationGroupId: 'GROUP-TEST', role: '战略规划', fitScore: 82, opportunityValue: 87, roleType: 'reach' },
            { ...alpha, id: 'opp-three', applicationGroupId: 'GROUP-TEST', role: '产品运营', fitScore: 42, opportunityValue: 50, roleType: 'practice' },
          ],
          processes: [],
          processEvents: [],
          actions: [],
          applicationGroups: [{ id: 'GROUP-TEST', company: '示例科技', total: 2, used: 0, remaining: 2 }],
          timeline: [],
        },
      },
    }
  },
}

function jsonFrom(result: Awaited<ReturnType<typeof invokeReadTool>>) {
  const item = result.content[0]
  if (!item || item.type !== 'text') throw new Error('Expected text tool result')
  return JSON.parse(item.text) as Record<string, any>
}

describe('v1.6 Round 1 application portfolio read tool', () => {
  it('returns a deterministic bounded recommendation without auto-filling weak roles', async () => {
    const result = await invokeReadTool(source, 'get_application_portfolio', { groupId: 'GROUP-TEST' })
    expect(result.isError).not.toBe(true)
    const data = jsonFrom(result)
    expect(data.meta).toMatchObject({ source: 'pjsdas', workspaceVersion: 'drive:20', timezone: 'Asia/Shanghai' })
    expect(data.decisions).toHaveLength(1)
    expect(data.decisions[0]).toMatchObject({ groupId: 'GROUP-TEST', status: 'ready', capacity: 2 })
    expect(data.decisions[0].recommended.map((item: any) => item.opportunityId)).not.toContain('opp-three')
    expect(data.policy).toMatchObject({ capacityIsMaximum: true, autoFillSlots: false, automaticApplication: false })
  })

  it('returns NOT_FOUND for an exact unknown application group', async () => {
    const result = await invokeReadTool(source, 'get_application_portfolio', { groupId: 'MISSING' })
    expect(result.isError).toBe(true)
    expect(jsonFrom(result)).toMatchObject({ code: 'NOT_FOUND', retryable: false })
  })
})
