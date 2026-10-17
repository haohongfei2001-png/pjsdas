import { verifiedPostingFixture } from './fixtures/verifiedDiscovery.js'
import { bindVerifiedPostingRefresh } from '../src/postingRefresh.js'
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
    sourceUrl: 'https://www.liepin.com/job/9402.shtml?utm_source=old',
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
    sourceUrl: 'https://www.liepin.com/job/9402.shtml?utm_source=new',
    sourceTitle: 'AI 产品经理｜招聘官网',
    postingStatus: 'open',
    observedAt: refreshedAt,
    ...overrides,
  }
}

describe('v1.7 Round 2 posting refresh semantics', () => {
  it('refreshes verified source fields while preserving an older raw status without re-certifying it', async () => {
    const owner = opportunity()
    const observation = await verifiedPostingFixture({ company: owner.company, role: owner.role, sourceUrl: 'https://www.liepin.com/job/9402.shtml?utm_source=new', location: '北京' }, refreshedAt)
    const operation = bindVerifiedPostingRefresh(refreshOperation(), observation)
    const target = resolvePostingRefreshTarget(operation, [owner], [])
    expect(target?.posting.lastVerifiedAt).toBe(oldObservedAt)

    const refreshed = applyPostingRefreshToOpportunity(owner, operation)
    expect(refreshed.detail?.discovery?.posting).toMatchObject({
      postingStatus: 'open',
      lastVerifiedAt: refreshedAt,
      firstSeenAt: oldObservedAt,
      canonicalSourceUrl: 'https://www.liepin.com/job/9402.shtml',
    })
    expect(refreshed.processStage).toBe('screening')
    expect(operation.postingStatus).toBe('unknown')
    expect(refreshed.detail?.discovery?.sourceProof?.fields.some(field => field.field === 'postingStatus')).toBe(false)
  })

  it('an explicitly evidenced internal closed-source fact never closes the personal application', async () => {
    const owner = opportunity()
    const observation = await verifiedPostingFixture({ company: owner.company, role: owner.role, sourceUrl: 'https://www.liepin.com/job/9402.shtml?utm_source=new', location: '北京' }, refreshedAt)
    // This reducer test supplies the trusted adapter precondition explicitly;
    // the current public HTML verifier itself conservatively returns unknown.
    observation.postingStatus = 'closed'
    observation.sourceProof!.fields.push({ field: 'postingStatus', value: 'closed', sourceUrl: observation.sourceUrl, selector: 'synthetic-status', quote: 'Applications closed' })
    const refreshed = applyPostingRefreshToOpportunity(owner, bindVerifiedPostingRefresh(refreshOperation({ postingStatus: 'closed' }), observation))
    expect(refreshed.detail?.discovery?.posting?.postingStatus).toBe('closed')
    expect(refreshed.processStage).toBe('screening')
    expect(refreshed.currentStageLabel).toBe('筛选中')
  })

  it('rejects a different canonical source instead of overwriting the old posting', () => {
    const owner = opportunity()
    expect(() => applyPostingRefreshToOpportunity(owner, refreshOperation({
      sourceUrl: 'https://www.liepin.com/job/9403.shtml',
    }))).toThrow('新来源')
  })

  it('fails to resolve when the caller uses a stale posting baseline', () => {
    const owner = opportunity()
    const operation = refreshOperation({ expectedPostingId: 'posting:stale' })
    expect(resolvePostingRefreshTarget(operation, [owner], [])).toBeUndefined()
  })
})

it('does not promote a caller-owned open/closed label into verified evidence', () => {
  for (const postingStatus of ['open', 'closed'] as const) {
    const before = opportunity(), original = structuredClone(before)
    expect(() => applyPostingRefreshToOpportunity(before, refreshOperation({ postingStatus }))).toThrow('DISCOVERY_VERIFICATION_REQUIRED')
    expect(before).toEqual(original)
  }
})
