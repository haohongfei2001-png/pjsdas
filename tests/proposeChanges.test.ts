import { describe, expect, it } from 'vitest'
import { createFileWorkspaceSource } from '../gateway/workspaceSource.js'
import { invokeProposeChanges } from '../gateway/proposeChanges.js'
import { verifySignedProposalToken } from '../gateway/proposalToken.js'
import { encodedProposalFromHash } from '../src/ai/mcpProposal.js'

const SIGNING_KEY = 'test-pjsdas-proposal-signing-key'
const source = createFileWorkspaceSource({
  file: new URL('../gateway/fixtures/demo-workspace.json', import.meta.url),
  now: new Date('2026-09-11T10:30:00+08:00'),
  timezone: 'Asia/Shanghai',
  workspaceVersion: 'drive:6',
})

function jsonFrom(result: Awaited<ReturnType<typeof invokeProposeChanges>>) {
  const item = result.content[0]
  if (!item || item.type !== 'text') throw new Error('Expected text result')
  return JSON.parse(item.text) as Record<string, any>
}

async function decodedFrom(result: Awaited<ReturnType<typeof invokeProposeChanges>>) {
  const data = jsonFrom(result)
  const url = new URL(String(data.reviewUrl))
  const token = encodedProposalFromHash(url.hash)
  if (!token) throw new Error('Expected signed proposal fragment')
  return verifySignedProposalToken(
    token,
    SIGNING_KEY,
    new Date('2026-09-11T10:31:00+08:00'),
  )
}

function propose(input: Parameters<typeof invokeProposeChanges>[1]) {
  return invokeProposeChanges(source, input, { signingKey: SIGNING_KEY })
}

describe('propose_changes', () => {
  it('turns a progress statement into a pending MCP ChangeSet without storing raw source text', async () => {
    const result = await propose({
      progressText: '9月11日，投递NOVA AI产品经理培训生。',
    })
    expect(result.isError).not.toBe(true)
    const data = jsonFrom(result)
    expect(data).toMatchObject({ status: 'proposal_created', applied: false, workspaceVersion: 'drive:6' })

    const proposal = await decodedFrom(result)
    expect(proposal.changeSet.source).toBe('mcp')
    expect(proposal.changeSet.status).toBe('pending')
    expect(proposal.changeSet.operations.some((item) => item.kind === 'progress_update')).toBe(true)
    expect(JSON.stringify(proposal.changeSet)).not.toContain('sourceText')
  })

  it('proposes an exact action completion with optimistic expected status', async () => {
    const result = await propose({
      title: '完成示例投递',
      actionStatusChanges: [{ actionId: 'apply:opp-alpha', status: 'done' }],
    })
    expect(result.isError).not.toBe(true)
    const proposal = await decodedFrom(result)
    expect(proposal.changeSet.operations).toContainEqual(expect.objectContaining({
      kind: 'set_action_status',
      actionId: 'apply:opp-alpha',
      expectedStatus: 'todo',
      status: 'done',
    }))
  })

  it('proposes a Decision Rules patch without applying it', async () => {
    const result = await propose({
      decisionRulesPatch: {
        weights: { urgency: 25, opportunity: 17 },
        upcomingHorizonDays: 10,
      },
    })
    expect(result.isError).not.toBe(true)
    const proposal = await decodedFrom(result)
    const operation = proposal.changeSet.operations.find((item) => item.kind === 'replace_decision_rules')
    expect(operation).toMatchObject({
      kind: 'replace_decision_rules',
      expectedUpdatedAt: '2026-09-10T08:00:00+08:00',
      rules: {
        upcomingHorizonDays: 10,
        weights: { urgency: 25, opportunity: 17 },
      },
    })
    expect(proposal.changeSet.status).toBe('pending')
  })

  it('fails closed when an action id is not in the current workspace', async () => {
    const result = await propose({
      actionStatusChanges: [{ actionId: 'missing-action', status: 'done' }],
    })
    expect(result.isError).toBe(true)
    expect(jsonFrom(result)).toMatchObject({ code: 'NOT_FOUND', retryable: false })
  })
})
