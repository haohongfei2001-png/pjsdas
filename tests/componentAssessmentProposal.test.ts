import { describe, expect, it } from 'vitest'
import { invokeProposeChanges } from '../gateway/proposeChanges.js'
import { verifySignedProposalToken } from '../gateway/proposalToken.js'
import { createFileWorkspaceSource, type WorkspaceSource } from '../gateway/workspaceSource.js'
import { createDefaultDiscoveryProfile } from '../src/discoveryProfile.js'
import { encodedProposalFromHash } from '../src/ai/mcpProposal.js'

const signingKey = 'test-only-component-assessment-key'
const base = createFileWorkspaceSource({
  file: new URL('../gateway/fixtures/demo-workspace.json', import.meta.url),
  now: new Date('2026-09-12T10:00:00+08:00'),
  timezone: 'Asia/Shanghai',
  workspaceVersion: 'drive:16',
})

function source(minimumFitScore?: number): WorkspaceSource {
  return {
    async read() {
      const workspace = await base.read()
      return {
        ...workspace,
        snapshot: {
          ...workspace.snapshot,
          data: {
            ...workspace.snapshot.data,
            discoveryProfile: {
              ...createDefaultDiscoveryProfile('2026-09-12T01:00:00.000Z'),
              targetRoleQueries: ['AI 产品经理'],
              preferredLocations: ['北京'],
              minimumFitScore,
            },
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

function candidate() {
  return {
    company: '组件科技',
    role: 'AI 产品经理',
    sourceUrl: 'https://careers.example.com/component-ai-pm',
    sourceTitle: '组件科技 2027 校招 AI 产品经理',
    sourceEvidenceText: '北京岗位，负责 AI 产品规划和数据分析。',
    postingStatus: 'open' as const,
    location: '北京',
    rationale: '使用分项模型评估岗位，而不是直接提交总分。',
    roleType: 'core' as const,
    assessment: {
      fit: {
        roleDirection: { score: 92, confidence: 'high' as const, rationale: '岗位方向直接匹配 AI 产品。' },
        skills: { score: 72, confidence: 'medium' as const, rationale: '分析技能匹配，产品经验仍有限。' },
      },
      opportunityValue: {
        companyQuality: { score: 88, confidence: 'high' as const, rationale: '公司平台较强。' },
        roleGrowth: { score: 84, confidence: 'medium' as const, rationale: '岗位成长空间较好。' },
      },
    },
    // Deliberately misleading legacy values. Component mode must ignore them.
    fitScore: 5,
    opportunityValue: 5,
    fitConfidence: 'low' as const,
    opportunityValueConfidence: 'low' as const,
    discoveredAt: '2026-09-12T09:55:00+08:00',
  }
}

describe('retired component proposal inputs', () => {
  it('rejects component and aggregate ratings explicitly', async () => {
    const result = await invokeProposeChanges(source(), { discoveredOpportunities: [candidate()] }, { signingKey })
    expect(result.isError).toBe(true)
    expect(resultJson(result)).toMatchObject({ code: 'SCORING_RETIRED', retryable: false })
  })
  it('accepts factual candidates without scores even when the stored profile has old score thresholds', async () => {
    const { assessment, fitScore, opportunityValue, fitConfidence, opportunityValueConfidence, ...facts } = candidate()
    const result = await invokeProposeChanges(source(100), { discoveredOpportunities: [facts] }, { signingKey })
    expect(result.isError).not.toBe(true)
    const data = resultJson(result)
    expect(data.discoveryScreening).toMatchObject({ accepted: 1, rejectedCount: 0 })
    const token = encodedProposalFromHash(new URL(String(data.reviewUrl)).hash)!
    const envelope = await verifySignedProposalToken(token, signingKey, new Date('2026-09-12T10:01:00+08:00'))
    const operation = envelope.changeSet.operations[0]
    if (operation.kind !== 'add_discovered_opportunity') throw new Error('Expected factual opportunity')
    expect(operation.opportunity).toMatchObject({ fitScore: 0, opportunityValue: 0 })
    expect(operation.opportunity.detail?.assessment).toBeUndefined()
  })
  it('rejects score-policy writes before reading the workspace', async () => {
    const result = await invokeProposeChanges({ read: async () => { throw new Error('unexpected read') } }, { decisionRulesPatch: { weights: { fit: 100 } } }, { signingKey })
    expect(resultJson(result)).toMatchObject({ code: 'SCORING_RETIRED' })
  })
})
