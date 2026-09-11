import { describe, expect, it } from 'vitest'
import {
  buildMcpProposalReviewUrl,
  decodeMcpProposal,
  encodedProposalFromHash,
  removeProposalFromUrl,
} from '../src/ai/mcpProposal.js'
import type { ChangeSetRecord } from '../src/changeSet.js'

const changeSet: ChangeSetRecord = {
  id: 'CS-MCP-20260911020000-ABC123',
  version: 1,
  source: 'mcp',
  status: 'pending',
  title: 'ChatGPT 提议 · 完成任务',
  createdAt: '2026-09-11T02:00:00.000Z',
  updatedAt: '2026-09-11T02:00:00.000Z',
  operations: [{
    id: 'action:apply:test:done',
    kind: 'set_action_status',
    summary: '完成｜测试投递',
    actionId: 'apply:test',
    expectedStatus: 'todo',
    status: 'done',
  }],
}

describe('MCP proposal review links', () => {
  it('round-trips a validated ChangeSet through a URL fragment', () => {
    const reviewUrl = buildMcpProposalReviewUrl(changeSet, 'drive:6')
    const url = new URL(reviewUrl)
    const encoded = encodedProposalFromHash(url.hash)
    expect(encoded).toBeTruthy()
    expect(decodeMcpProposal(encoded!)).toEqual({
      version: 1,
      workspaceVersion: 'drive:6',
      changeSet,
    })
  })

  it('removes only the proposal fragment entry after the browser consumes it', () => {
    const url = new URL(`${buildMcpProposalReviewUrl(changeSet)}&keep=1`)
    const cleaned = removeProposalFromUrl(url)
    expect(encodedProposalFromHash(cleaned.hash)).toBeNull()
    expect(new URLSearchParams(cleaned.hash.replace(/^#/, '')).get('keep')).toBe('1')
  })

  it('rejects malformed payloads', () => {
    expect(() => decodeMcpProposal('not-a-valid-payload')).toThrow()
  })
})
