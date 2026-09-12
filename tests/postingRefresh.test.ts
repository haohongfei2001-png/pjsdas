import { describe, expect, it } from 'vitest'
import { createJobPostingEvidence } from '../src/jobPosting.js'
import {
  applyPostingRefreshToOpportunity,
  resolvePostingRefreshTarget,
  type PostingRefreshOperation,
} from '../src/postingRefresh.js'
import type { Opportunity } from '../src/model.js'

const oldObservedAt = '2026-08-10T00:00:00.000Z'
const refreshedAt = '2026-09-12T01:30:00.000Z'

function opportunity(): Opportunity {
  const posting = createJobPostingEvidence({
    company: '示例科技',
    role: 'AI 产品经理',
    sourceUrl: 'https://careers.example.com/jobs/123?utm_source=old',
    sourceTitle: 'AI 产品经理',
    location: '北京',
    deadline: '2026-09-30T15:59:00.000Z',
    postingStatus: 'open',
    observedAt: oldObservedAt,
  })
  return {
    id: 'opp-refresh',
    company: '示例科技',
    role: 'AI 产品经理',
    currentStageLabel: '筛选中',
    processStage: 'screening',
    roleType: 'core',
    early: false,
    deadline: posting.deadline,
    opportunityValue: 90,
    fitScore: 82,
    locallyManaged: true,
    importedAt: oldObservedAt,
    detail: {
      discovery: {
        sourceUrl: posting.sourceUrl,
        sourceTitle: posting.sourceTitle,
        location: posting.location,
        rationale: '来源岗位。',
        discoveredAt: oldObservedAt,
        fitConfidence: 'high',
        opportunityValueConfidence: 'high',
        posting,
      },
    },
  }
}

function refreshOperation(overrides: Partial<PostingRefreshOperation> = {}): PostingRefreshOperation {
  const owner = opportunity()
  const posting = owner.detail!.discovery!.posting!
  return {
    id: 'posting:refresh:opp-refresh',
    kind: 'refresh_job_posting',
    summary: '复核来源',
    ownerKind: 'opportunity',
    ownerId: owner.id,
    expectedPostingId: posting.id,
    expectedCanonicalSourceUrl: posting.canonicalSourceUrl,
    sourceUrl: 'https://careers.example.com/jobs/123?utm_source=new',
    sourceTitle: 'AI 产品经理｜招聘官网',
    postingStatus: 'open',
    observedAt: refreshedAt,
    ...overrides,
  }
}

describe('v1.7 Round 2 posting refresh semantics', () => {
  it('refreshes the same canonical source and advances verification time', () => {
    const owner = opportunity()
    const operation = refreshOperation({ postingStatus: 'open' })
    const target = resolvePostingRefreshTarget(operation, [owner], [])
    expect(target?.posting.lastVerifiedAt).toBe(oldObservedAt)

    const refreshed = applyPostingRefreshToOpportunity(owner, operation)
    expect(refreshed.detail?.discovery?.posting).toMatchObject({
      postingStatus: 'open',
      lastVerifiedAt: refreshedAt,
      firstSeenAt: oldObservedAt,
      canonicalSourceUrl: 'https://careers.example.com/jobs/123',
    })
    expect(refreshed.processStage).toBe('screening')
  })

  it('records a closed source without automatically closing the Opportunity', () => {
    const owner = opportunity()
    const refreshed = applyPostingRefreshToOpportunity(owner, refreshOperation({ postingStatus: 'closed' }))
    expect(refreshed.detail?.discovery?.posting?.postingStatus).toBe('closed')
    expect(refreshed.processStage).toBe('screening')
    expect(refreshed.currentStageLabel).toBe('筛选中')
  })

  it('rejects a different canonical source instead of overwriting the old posting', () => {
    const owner = opportunity()
    expect(() => applyPostingRefreshToOpportunity(owner, refreshOperation({
      sourceUrl: 'https://careers.example.com/jobs/999',
    }))).toThrow('新来源')
  })

  it('fails to resolve when the caller uses a stale posting baseline', () => {
    const owner = opportunity()
    const operation = refreshOperation({ expectedPostingId: 'posting:stale' })
    expect(resolvePostingRefreshTarget(operation, [owner], [])).toBeUndefined()
  })
})