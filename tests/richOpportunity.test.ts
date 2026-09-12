import { describe, expect, it } from 'vitest'
import {
  createOpportunityFacts,
  mergeOpportunityFacts,
  opportunityFactsCompleteness,
  validateOpportunityFacts,
} from '../src/richOpportunity.js'

const base = {
  sourceUrl: 'https://careers.example.com/jobs/ai-pm',
  sourceTitle: '示例科技｜AI 产品经理',
  verifiedAt: '2026-09-12T08:00:00.000Z',
  location: '北京',
  deadline: '2026-09-30T23:59:59+08:00',
  compensationText: '25-35 万/年',
  annualCompensationMinWan: 25,
}

describe('v1.5 Round 1 Rich Opportunity facts', () => {
  it('keeps source facts separate and marks missing decision facts explicitly unknown', () => {
    const facts = createOpportunityFacts({
      ...base,
      facts: {
        department: 'AI 产品部',
        responsibilities: ['负责 AI 产品规划', '推动跨团队交付'],
        educationRequirement: '硕士及以上',
        skills: ['产品规划', '数据分析'],
        annualCompensationMaxWan: 35,
        evidenceSummary: '招聘页明确写明岗位职责、学历、地点和薪资区间。',
      },
    })

    expect(validateOpportunityFacts(facts)).toEqual([])
    expect(facts.identity.locations).toEqual(['北京'])
    expect(facts.application.deadline).toBe(base.deadline)
    expect(facts.compensation).toMatchObject({ raw: '25-35 万/年', annualMinWan: 25, annualMaxWan: 35 })
    expect(facts.unknownFields).toContain('experience')
    expect(facts.unknownFields).not.toContain('locations')
    expect(facts.unknownFields).not.toContain('responsibilities')
  })

  it('calculates completeness only from explicit source-backed fact fields', () => {
    const sparse = createOpportunityFacts(base)
    const rich = createOpportunityFacts({
      ...base,
      facts: {
        department: 'AI 产品部',
        businessUnit: '智能平台',
        recruitmentBatch: '2027 校园招聘',
        responsibilities: ['负责 AI 产品规划'],
        requirements: ['具备结构化分析能力'],
        educationRequirement: '硕士优先',
        majorRequirements: ['理工科'],
        experienceRequirement: '应届生',
        skills: ['数据分析'],
        languageRequirements: ['英语六级优先'],
        applicationMethod: '官网投递',
        annualCompensationMaxWan: 35,
      },
    })
    expect(opportunityFactsCompleteness(rich).percent).toBeGreaterThan(opportunityFactsCompleteness(sparse).percent)
  })

  it('merges later verified facts without erasing earlier known facts', () => {
    const previous = createOpportunityFacts({
      ...base,
      facts: {
        department: '产品部',
        requirements: ['具备数据分析能力'],
        skills: ['SQL'],
      },
    })
    const incoming = createOpportunityFacts({
      ...base,
      verifiedAt: '2026-09-13T08:00:00.000Z',
      facts: {
        businessUnit: 'AI 平台',
        responsibilities: ['负责 AI 产品规划'],
        skills: ['Python'],
      },
    })
    const merged = mergeOpportunityFacts(previous, incoming)!
    expect(merged.identity.department).toBe('产品部')
    expect(merged.identity.businessUnit).toBe('AI 平台')
    expect(merged.role.skills).toEqual(['Python', 'SQL'])
    expect(merged.role.requirements).toEqual(['具备数据分析能力'])
    expect(merged.evidence.verifiedAt).toBe('2026-09-13T08:00:00.000Z')
  })

  it('rejects inconsistent compensation ranges and unknown-field bookkeeping', () => {
    const facts = createOpportunityFacts({
      ...base,
      annualCompensationMinWan: 40,
      facts: { annualCompensationMaxWan: 30 },
    })
    expect(validateOpportunityFacts(facts).join(' ')).toContain('最低年薪')

    const tampered = { ...createOpportunityFacts(base), unknownFields: [] }
    expect(validateOpportunityFacts(tampered).join(' ')).toContain('unknownFields')
  })
})
