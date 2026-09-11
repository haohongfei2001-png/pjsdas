import { describe, expect, it } from 'vitest'
import { createSignedProposalToken, verifySignedProposalToken } from '../gateway/proposalToken.js'
import type { ChangeSetRecord } from '../src/changeSet.js'

const SECRET = 'test-pjsdas-proposal-token-secret'
const NOW = new Date('2026-09-11T02:00:00.000Z')

const changeSet: ChangeSetRecord = {
  id: 'CS-MCP-20260911020000-TOKEN1',
  version: 1,
  source: 'mcp',
  status: 'pending',
  title: '签名提议测试',
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  operations: [{
    id: 'action:test:done',
    kind: 'set_action_status',
    summary: '完成｜测试任务',
    actionId: 'test-action',
    expectedStatus: 'todo',
    status: 'done',
  }],
}

describe('signed PJSDAS proposal tokens', () => {
  it('verifies an intact token and preserves the proposal baseline', async () => {
    const token = await createSignedProposalToken(changeSet, 'drive:6', SECRET, NOW)
    const proposal = await verifySignedProposalToken(
      token,
      SECRET,
      new Date('2026-09-11T03:00:00.000Z'),
    )
    expect(proposal).toMatchObject({
      version: 1,
      workspaceVersion: 'drive:6',
      expiresAt: '2026-09-12T02:00:00.000Z',
      changeSet,
    })
  })

  it('rejects a tampered payload', async () => {
    const token = await createSignedProposalToken(changeSet, 'drive:6', SECRET, NOW)
    const separator = token.lastIndexOf('.')
    const payload = token.slice(0, separator)
    const signature = token.slice(separator + 1)
    const replacement = payload.endsWith('A') ? 'B' : 'A'
    const tampered = `${payload.slice(0, -1)}${replacement}.${signature}`
    await expect(verifySignedProposalToken(tampered, SECRET, NOW)).rejects.toThrow('signature')
  })

  it('rejects a validly signed token after its 24-hour expiry', async () => {
    const token = await createSignedProposalToken(changeSet, 'drive:6', SECRET, NOW)
    await expect(verifySignedProposalToken(
      token,
      SECRET,
      new Date('2026-09-12T02:00:00.001Z'),
    )).rejects.toThrow('expired')
  })
})
