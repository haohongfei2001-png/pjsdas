import { describe, expect, it } from 'vitest'
import {
  buildMcpProposalReviewUrl,
  createMcpProposalEnvelope,
  decodeMcpProposal,
  encodeMcpProposal,
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
  it('round-trips a validated ChangeSet envelope with a 24-hour expiry', () => {
    const now = new Date('2026-09-11T02:00:00.000Z')
    const envelope = createMcpProposalEnvelope(changeSet, 'drive:6', now)
    const encoded = encodeMcpProposal(envelope)
    expect(decodeMcpProposal(encoded)).toEqual({
      version: 1,
      workspaceVersion: 'drive:6',
      expiresAt: '2026-09-12T02:00:00.000Z',
      changeSet,
    })
  })

  it('round-trips signed discovery screening diagnostics', () => {
    const now = new Date('2026-09-11T02:00:00.000Z')
    const discoveryReview = {
      received: 3, accepted: 1, duplicateCount: 1, rejectedCount: 1, deferredCount: 0,
      skippedDuplicates: [{ company: '甲公司', role: 'AI 产品经理', reason: '重复' }],
      rejectedCandidates: [{ company: '乙公司', role: '销售', reasons: ['命中排除'] }],
      deferredCandidates: [],
    }
    const encoded = encodeMcpProposal(createMcpProposalEnvelope(changeSet, 'drive:6', now, discoveryReview))
    expect(decodeMcpProposal(encoded).discoveryReview).toEqual(discoveryReview)
  })

  it('puts an opaque signed token only in the URL fragment', () => {
    const reviewUrl = buildMcpProposalReviewUrl('payload.signature')
    const url = new URL(reviewUrl)
    expect(url.search).toBe('')
    expect(encodedProposalFromHash(url.hash)).toBe('payload.signature')
  })

  it('removes only the proposal fragment entry after the browser consumes it', () => {
    const url = new URL(`${buildMcpProposalReviewUrl('payload.signature')}&keep=1`)
    const cleaned = removeProposalFromUrl(url)
    expect(encodedProposalFromHash(cleaned.hash)).toBeNull()
    expect(new URLSearchParams(cleaned.hash.replace(/^#/, '')).get('keep')).toBe('1')
  })

  it('rejects malformed payloads', () => {
    expect(() => decodeMcpProposal('not-a-valid-payload')).toThrow()
  })
})
