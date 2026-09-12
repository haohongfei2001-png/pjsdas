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

function discoveryChangeSet(now: Date): ChangeSetRecord {
  return {
    id: 'CS-MCP-20260911020000-DISC01',
    version: 1,
    source: 'mcp',
    status: 'pending',
    title: 'ChatGPT 岗位发现',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    operations: [{
      id: 'discovery:add:discovery:test',
      kind: 'add_discovered_opportunity',
      summary: '新增发现岗位｜甲公司｜AI 产品经理',
      opportunity: {
        id: 'discovery:test',
        company: '甲公司',
        role: 'AI 产品经理',
        currentStageLabel: '待投',
        processStage: 'not_applied',
        roleType: 'core',
        early: false,
        opportunityValue: 90,
        fitScore: 82,
        locallyManaged: true,
        importedAt: now.toISOString(),
        detail: {
          discovery: {
            sourceUrl: 'https://jobs.example.com/role/123?utm_source=test',
            sourceTitle: '甲公司 AI 产品经理',
            rationale: '岗位方向与显式发现偏好一致。',
            discoveredAt: now.toISOString(),
            fitConfidence: 'high',
            opportunityValueConfidence: 'high',
          },
        },
      },
    }],
  }
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

  it('signs a bounded Discovery Run into a source-backed discovery proposal', () => {
    const now = new Date('2026-09-11T02:00:00.000Z')
    const discoveryReview = {
      received: 2, accepted: 1, duplicateCount: 1, rejectedCount: 0, deferredCount: 0,
      skippedDuplicates: [{ company: '甲公司', role: '产品经理', reason: '重复' }],
      rejectedCandidates: [],
      deferredCandidates: [],
    }
    const envelope = createMcpProposalEnvelope(discoveryChangeSet(now), 'drive:9', now, discoveryReview)
    expect(envelope.changeSet.discoveryRun).toMatchObject({
      version: 1,
      mode: 'ad_hoc',
      completedAt: now.toISOString(),
      baselineWorkspaceVersion: 'drive:9',
      receivedCount: 2,
      reviewCandidateCount: 1,
      duplicateCount: 1,
      candidateSourceHosts: ['jobs.example.com'],
    })
    expect(decodeMcpProposal(encodeMcpProposal(envelope)).changeSet.discoveryRun).toEqual(envelope.changeSet.discoveryRun)
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
