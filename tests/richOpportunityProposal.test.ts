import { describe, expect, it } from 'vitest'
import { invokeProposeChanges } from '../gateway/proposeChanges.js'
import { verifySignedProposalToken } from '../gateway/proposalToken.js'
import { createFileWorkspaceSource, type WorkspaceSource } from '../gateway/workspaceSource.js'
import { createDefaultDiscoveryProfile } from '../src/discoveryProfile.js'
import { encodedProposalFromHash } from '../src/ai/mcpProposal.js'
import { discoveryInboxItemsFromChangeSet, inboxOpportunity } from '../src/discoveryInbox.js'
import { opportunityFactsCompleteness } from '../src/richOpportunity.js'

const signingKey = 'test-only-rich-opportunity-signing-key'
const base = createFileWorkspaceSource({
  file: new URL('../gateway/fixtures/demo-workspace.json', import.meta.url),
  now: new Date('2026-09-12T10:00:00+08:00'),
  timezone: 'Asia/Shanghai',
  workspaceVersion: 'drive:15',
})

const source: WorkspaceSource = {
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
          },
        },
      },
    }
  },
}

function resultJson(result: Awaited<ReturnType<typeof invokeProposeChanges>>) {
  const item = result.content[0]
  if (!item || item.type !== 'text') throw new Error('Expected text result')
  return JSON.parse(item.text) as Record<string, any>
}

describe('v1.5 Round 1 signed Rich Opportunity proposal', () => {
  it('persists bounded source-backed role facts and explicit unknown fields', async () => {
    const result = await invokeProposeChanges(source, {
      discoveredOpportunities: [{
        company: '丰富科技',
        role: 'AI 产品经理',
        sourceUrl: 'https://careers.example.com/rich-ai-pm',
        sourceTitle: '丰富科技 2027 校招 AI 产品经理',
        sourceEvidenceText: '北京岗位，硕士优先，负责 AI 产品规划与跨团队交付。',
        postingStatus: 'open',
        location: '北京',
        deadline: '2026-10-10T23:59:59+08:00',
        compensationText: '25-35 万/年',
        annualCompensationMinWan: 25,
        facts: {
          department: 'AI 产品部',
          businessUnit: '智能平台',
          locations: ['北京'],
          recruitmentBatch: '2027 校园招聘',
          responsibilities: ['负责 AI 产品规划', '推动跨团队交付'],
          requirements: ['具备结构化分析能力'],
          educationRequirement: '硕士优先',
          majorRequirements: ['理工科'],
          skills: ['数据分析'],
          applicationMethod: '官网投递',
          applicationUrl: 'https://careers.example.com/apply/rich-ai-pm',
          annualCompensationMaxWan: 35,
          compensationBasis: '招聘页年薪区间',
          evidenceSummary: '招聘页明确披露了职责、学历、工作地点和薪资区间。',
        },
        rationale: '岗位方向符合 AI 产品目标；匹配度和机会价值仍是评估，不属于招聘事实。',
        roleType: 'core',
        opportunityValue: 90,
        fitScore: 86,
        fitConfidence: 'high',
        opportunityValueConfidence: 'medium',
        discoveredAt: '2026-09-12T09:55:00+08:00',
      }],
    }, { signingKey })

    expect(result.isError).not.toBe(true)
    const data = resultJson(result)
    const token = encodedProposalFromHash(new URL(String(data.reviewUrl)).hash)!
    const envelope = await verifySignedProposalToken(token, signingKey, new Date('2026-09-12T10:01:00+08:00'))
    const operation = envelope.changeSet.operations[0]
    expect(operation.kind).toBe('add_discovered_opportunity')
    if (operation.kind !== 'add_discovered_opportunity') throw new Error('Expected discovery operation')

    const facts = operation.opportunity.detail?.facts
    expect(facts).toBeTruthy()
    expect(facts?.identity).toMatchObject({ department: 'AI 产品部', businessUnit: '智能平台', recruitmentBatch: '2027 校园招聘' })
    expect(facts?.role.responsibilities).toContain('负责 AI 产品规划')
    expect(facts?.compensation).toMatchObject({ annualMinWan: 25, annualMaxWan: 35 })
    expect(facts?.unknownFields).toContain('experience')
    expect(facts?.unknownFields).not.toContain('education')
    expect(opportunityFactsCompleteness(facts).percent).toBeGreaterThan(50)

    const [inbox] = discoveryInboxItemsFromChangeSet(envelope.changeSet, new Date('2026-09-12T10:02:00+08:00'))
    expect(inbox.facts?.role.skills).toEqual(['数据分析'])
    const promoted = inboxOpportunity(inbox, new Date('2026-09-12T10:03:00+08:00'))
    expect(promoted.detail?.facts).toEqual(inbox.facts)
  })

  it('fails closed when Rich Opportunity compensation bounds contradict each other', async () => {
    const result = await invokeProposeChanges(source, {
      discoveredOpportunities: [{
        company: '矛盾科技',
        role: 'AI 产品经理',
        sourceUrl: 'https://careers.example.com/bad-rich-ai-pm',
        sourceTitle: '矛盾科技 AI 产品经理',
        sourceEvidenceText: '北京岗位。',
        postingStatus: 'open',
        location: '北京',
        compensationText: '40-30 万/年',
        annualCompensationMinWan: 40,
        facts: { annualCompensationMaxWan: 30 },
        rationale: '测试非法薪资边界。',
        roleType: 'core',
        opportunityValue: 80,
        fitScore: 80,
        fitConfidence: 'medium',
        opportunityValueConfidence: 'medium',
      }],
    }, { signingKey })
    expect(result.isError).toBe(true)
  })
})
