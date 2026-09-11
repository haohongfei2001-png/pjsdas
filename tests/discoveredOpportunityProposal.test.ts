import { describe, expect, it } from 'vitest'
import { invokeProposeChanges } from '../gateway/proposeChanges.js'
import { verifySignedProposalToken } from '../gateway/proposalToken.js'
import { createFileWorkspaceSource, type WorkspaceSource } from '../gateway/workspaceSource.js'
import { createDefaultDiscoveryProfile } from '../src/discoveryProfile.js'
import { encodedProposalFromHash } from '../src/ai/mcpProposal.js'

const signingKey = 'test-only-discovery-signing-key'
const base = createFileWorkspaceSource({
  file: new URL('../gateway/fixtures/demo-workspace.json', import.meta.url),
  now: new Date('2026-09-11T11:30:00+08:00'),
  timezone: 'Asia/Shanghai',
  workspaceVersion: 'drive:9',
})

function source(configured = true, maxReviewCandidates = 6): WorkspaceSource {
  return {
    async read() {
      const workspace = await base.read()
      return {
        ...workspace,
        snapshot: {
          ...workspace.snapshot,
          data: {
            ...workspace.snapshot.data,
            discoveryProfile: configured ? {
              ...createDefaultDiscoveryProfile('2026-09-11T03:20:00.000Z'),
              targetRoleQueries: ['AI 产品经理', '商业分析'],
              preferredLocations: ['北京', '上海'],
              mustHave: ['2027 届校招'],
              mustNotHave: ['纯销售'],
              strengths: ['理工科硕士'],
              maxReviewCandidates,
            } : undefined,
          },
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

const candidate = {
  company: '候选科技',
  role: 'AI 产品经理校招生',
  sourceUrl: 'https://careers.example.com/jobs/ai-pm-2027',
  sourceTitle: '候选科技 2027 校招｜AI 产品经理',
  sourceEvidenceText: '2027 届校招，工作地点北京，负责 AI 产品规划与跨团队协作。',
  postingStatus: 'open' as const,
  location: '北京',
  deadline: '2026-09-30T23:59:00+08:00',
  compensationText: '招聘页面未披露明确薪资',
  rationale: '岗位职责包含 AI 产品规划与跨团队协作，符合显式目标岗位；来源页面标注 2027 届校园招聘。',
  roleType: 'core' as const,
  opportunityValue: 87,
  fitScore: 78,
  fitConfidence: 'medium' as const,
  opportunityValueConfidence: 'medium' as const,
  discoveredAt: '2026-09-11T11:25:00+08:00',
}

describe('v1.3 discovered opportunity proposals', () => {
  it('creates a signed review-only ChangeSet with durable source evidence', async () => {
    const result = await invokeProposeChanges(source(), {
      title: 'ChatGPT 岗位发现测试',
      discoveredOpportunities: [candidate],
    }, { signingKey })

    expect(result.isError).not.toBe(true)
    const data = resultJson(result)
    expect(data).toMatchObject({
      status: 'proposal_created',
      applied: false,
      workspaceVersion: 'drive:9',
      operationCount: 1,
      skippedDuplicates: [],
      discoveryScreening: { received: 1, accepted: 1, duplicateCount: 0, rejectedCount: 0, deferredCount: 0 },
    })

    const url = new URL(String(data.reviewUrl))
    const token = encodedProposalFromHash(url.hash)
    expect(token).toBeTruthy()
    const envelope = await verifySignedProposalToken(token!, signingKey, new Date('2026-09-11T11:31:00+08:00'))
    expect(envelope.changeSet.operations[0]).toMatchObject({
      kind: 'add_discovered_opportunity',
      opportunity: {
        company: candidate.company,
        role: candidate.role,
        processStage: 'not_applied',
        opportunityValue: 87,
        fitScore: 78,
        detail: {
          discovery: {
            sourceUrl: candidate.sourceUrl,
            sourceTitle: candidate.sourceTitle,
            location: '北京',
          },
        },
      },
    })
    expect(envelope.changeSet.expectedWorkspaceFingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  it('requires an explicit durable Discovery Profile instead of using hidden chat inference', async () => {
    const result = await invokeProposeChanges(source(false), {
      discoveredOpportunities: [candidate],
    }, { signingKey })
    expect(result.isError).toBe(true)
    expect(resultJson(result)).toMatchObject({ code: 'DISCOVERY_PROFILE_REQUIRED', retryable: false })
  })

  it('drops an exact or highly similar company+role duplicate already present in PJSDAS', async () => {
    const result = await invokeProposeChanges(source(), {
      discoveredOpportunities: [{
        ...candidate,
        company: '示例科技',
        role: '产品经理（AI方向）',
        sourceUrl: 'https://careers.example.com/jobs/duplicate',
      }],
    }, { signingKey })
    expect(result.isError).toBe(true)
    expect(resultJson(result)).toMatchObject({ code: 'NO_CHANGES', retryable: false })
  })

  it('keeps soft profile mismatches visible as review warnings', async () => {
    const result = await invokeProposeChanges(source(), {
      discoveredOpportunities: [{
        ...candidate,
        location: '广州',
        compensationText: undefined,
        sourceEvidenceText: '2027 届校招，工作地点广州。',
        rationale: '来源明确写明为产品岗位，但地点不在显式地点列表中。',
      }],
    }, { signingKey })
    expect(result.isError).not.toBe(true)
    const data = resultJson(result)
    const token = encodedProposalFromHash(new URL(String(data.reviewUrl)).hash)!
    const envelope = await verifySignedProposalToken(token, signingKey, new Date('2026-09-11T11:31:00+08:00'))
    const operation = envelope.changeSet.operations[0]
    expect(operation.kind).toBe('add_discovered_opportunity')
    if (operation.kind === 'add_discovered_opportunity') {
      expect(operation.opportunity.detail?.discovery?.profileWarnings?.join(' ')).toContain('广州')
    }
  })

  it('rejects expired and explicitly excluded discovered jobs before signing a ChangeSet', async () => {
    const expired = await invokeProposeChanges(source(), {
      discoveredOpportunities: [{ ...candidate, deadline: '2026-09-10T23:59:00+08:00' }],
    }, { signingKey })
    expect(expired.isError).toBe(true)
    expect(resultJson(expired)).toMatchObject({ code: 'DISCOVERY_NO_ELIGIBLE_CANDIDATES', retryable: false })

    const excluded = await invokeProposeChanges(source(), {
      discoveredOpportunities: [{ ...candidate, sourceEvidenceText: '2027 届校招，北京，纯销售岗位。' }],
    }, { signingKey })
    expect(excluded.isError).toBe(true)
    expect(String(resultJson(excluded).message)).toContain('纯销售')
  })

  it('caps the review batch after quality ranking instead of sending every search hit to the user', async () => {
    const result = await invokeProposeChanges(source(true, 2), {
      discoveredOpportunities: [
        { ...candidate, company: '甲公司', fitScore: 92, opportunityValue: 94, sourceUrl: 'https://careers.example.com/a' },
        { ...candidate, company: '乙公司', fitScore: 84, opportunityValue: 88, sourceUrl: 'https://careers.example.com/b' },
        { ...candidate, company: '丙公司', fitScore: 65, opportunityValue: 70, sourceUrl: 'https://careers.example.com/c' },
      ],
    }, { signingKey })
    expect(result.isError).not.toBe(true)
    const data = resultJson(result)
    expect(data.operationCount).toBe(2)
    expect(data.discoveryScreening).toMatchObject({ received: 3, accepted: 2, deferredCount: 1 })
    expect(data.deferredCandidates[0].company).toBe('丙公司')
  })

  it('rejects non-public source schemes before a ChangeSet can be signed', async () => {
    const result = await invokeProposeChanges(source(), {
      discoveredOpportunities: [{
        ...candidate,
        sourceUrl: 'javascript:alert(1)',
      }],
    }, { signingKey })
    expect(result.isError).toBe(true)
    expect(resultJson(result)).toMatchObject({ code: 'INVALID_ARGUMENT', retryable: false })
  })
})
