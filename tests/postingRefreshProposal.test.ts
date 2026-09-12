import { describe, expect, it } from 'vitest'
import { invokeProposeChanges } from '../gateway/proposeChanges.js'
import { verifySignedProposalToken } from '../gateway/proposalToken.js'
import { createFileWorkspaceSource, type WorkspaceSource } from '../gateway/workspaceSource.js'
import { encodedProposalFromHash } from '../src/ai/mcpProposal.js'
import { createJobPostingEvidence } from '../src/jobPosting.js'

const signingKey = 'test-only-posting-refresh-key'
const now = new Date('2026-09-12T10:00:00+08:00')
const base = createFileWorkspaceSource({
  file: new URL('../gateway/fixtures/demo-workspace.json', import.meta.url),
  now,
  timezone: 'Asia/Shanghai',
  workspaceVersion: 'drive:30',
})

const sourceUrl = 'https://careers.example.com/jobs/alpha?utm_source=old'
const canonicalSourceUrl = 'https://careers.example.com/jobs/alpha'

function source(): WorkspaceSource {
  return {
    async read() {
      const workspace = await base.read()
      const opportunities = workspace.snapshot.data.opportunities.map((item) => {
        if (item.id !== 'opp-alpha') return item
        const posting = createJobPostingEvidence({
          company: item.company,
          role: item.role,
          sourceUrl,
          sourceTitle: '示例科技 AI 产品经理',
          postingStatus: 'open',
          observedAt: '2026-08-01T00:00:00.000Z',
        })
        return {
          ...item,
          detail: {
            discovery: {
              sourceUrl,
              sourceTitle: posting.sourceTitle,
              rationale: '旧招聘来源。',
              discoveredAt: posting.firstSeenAt,
              fitConfidence: 'medium' as const,
              opportunityValueConfidence: 'medium' as const,
              posting,
            },
          },
        }
      })
      return {
        ...workspace,
        snapshot: {
          ...workspace.snapshot,
          data: { ...workspace.snapshot.data, opportunities },
        },
      }
    },
  }
}

function resultJson(result: Awaited<ReturnType<typeof invokeProposeChanges>>) {
  const item = result.content[0]
  if (!item || item.type !== 'text') throw new Error('Expected text result')
  return JSON.parse(item.text) as Record<string, any>
}

async function envelopeFrom(result: Awaited<ReturnType<typeof invokeProposeChanges>>) {
  const data = resultJson(result)
  const token = encodedProposalFromHash(new URL(String(data.reviewUrl)).hash)
  if (!token) throw new Error('Expected signed proposal token')
  return verifySignedProposalToken(token, signingKey, new Date('2026-09-12T10:01:00+08:00'))
}

describe('v1.7 Round 2 review-only posting refresh proposals', () => {
  it('signs an exact refresh target and preserves explicit refresh run context', async () => {
    const workspace = await source().read()
    const posting = workspace.snapshot.data.opportunities.find((item) => item.id === 'opp-alpha')!.detail!.discovery!.posting!
    const result = await invokeProposeChanges(source(), {
      postingRefreshes: [{
        ownerKind: 'opportunity',
        ownerId: 'opp-alpha',
        postingId: posting.id,
        canonicalSourceUrl,
        sourceUrl: 'https://careers.example.com/jobs/alpha?utm_source=refresh',
        sourceTitle: '示例科技 AI 产品经理｜招聘官网',
        postingStatus: 'open',
        observedAt: '2026-09-12T09:58:00+08:00',
      }],
      discoveryRunContext: {
        mode: 'refresh',
        queries: ['复核示例科技 AI 产品经理'],
        searchedSourceHosts: ['careers.example.com'],
      },
    }, { signingKey })

    expect(result.isError).not.toBe(true)
    const envelope = await envelopeFrom(result)
    expect(envelope.changeSet.operations[0]).toMatchObject({
      kind: 'refresh_job_posting',
      ownerKind: 'opportunity',
      ownerId: 'opp-alpha',
      expectedPostingId: posting.id,
      expectedCanonicalSourceUrl: canonicalSourceUrl,
      postingStatus: 'open',
    })
    expect(envelope.changeSet.discoveryRun).toMatchObject({
      mode: 'refresh',
      queries: ['复核示例科技 AI 产品经理'],
      searchedSourceHosts: ['careers.example.com'],
      receivedCount: 1,
      reviewCandidateCount: 1,
    })
  })

  it('fails closed when the posting baseline is stale', async () => {
    const result = await invokeProposeChanges(source(), {
      postingRefreshes: [{
        ownerKind: 'opportunity',
        ownerId: 'opp-alpha',
        postingId: 'posting:stale',
        canonicalSourceUrl,
        sourceUrl,
        sourceTitle: '示例科技 AI 产品经理',
        postingStatus: 'open',
      }],
    }, { signingKey })
    expect(result.isError).toBe(true)
    expect(resultJson(result)).toMatchObject({ code: 'PROPOSAL_NEEDS_REFRESH', retryable: false })
  })

  it('rejects a different canonical URL from the bound refresh target', async () => {
    const workspace = await source().read()
    const posting = workspace.snapshot.data.opportunities.find((item) => item.id === 'opp-alpha')!.detail!.discovery!.posting!
    const result = await invokeProposeChanges(source(), {
      postingRefreshes: [{
        ownerKind: 'opportunity',
        ownerId: 'opp-alpha',
        postingId: posting.id,
        canonicalSourceUrl,
        sourceUrl: 'https://careers.example.com/jobs/different',
        sourceTitle: '另一个招聘来源',
        postingStatus: 'open',
      }],
    }, { signingKey })
    expect(result.isError).toBe(true)
    expect(resultJson(result)).toMatchObject({ code: 'INVALID_ARGUMENT', retryable: false })
  })
})