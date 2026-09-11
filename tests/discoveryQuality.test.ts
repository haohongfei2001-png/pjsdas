import { describe, expect, it } from 'vitest'
import { DEFAULT_DECISION_RULES } from '../src/decisionRules.js'
import { createDefaultDiscoveryProfile } from '../src/discoveryProfile.js'
import {
  discoveryRoleSimilarity,
  evaluateDiscoveryCandidate,
  screenDiscoveryCandidates,
  type DiscoveryCandidateForQuality,
} from '../src/discoveryQuality.js'
import type { Opportunity } from '../src/model.js'

const weights = DEFAULT_DECISION_RULES.weights
const now = new Date('2026-09-11T12:00:00+08:00')

function candidate(patch: Partial<DiscoveryCandidateForQuality> = {}): DiscoveryCandidateForQuality {
  return {
    company: '候选科技',
    role: 'AI 产品经理',
    sourceTitle: '候选科技 2027 届校园招聘 AI 产品经理',
    sourceEvidenceText: '2027 届校园招聘，工作地点北京，负责 AI 产品规划与跨团队协作。',
    postingStatus: 'open',
    location: '北京',
    deadline: '2026-09-30T23:59:00+08:00',
    compensationText: '年薪 25-30 万',
    annualCompensationMinWan: 25,
    roleType: 'core',
    opportunityValue: 86,
    fitScore: 78,
    fitConfidence: 'medium',
    opportunityValueConfidence: 'medium',
    ...patch,
  }
}

function profile() {
  return {
    ...createDefaultDiscoveryProfile('2026-09-11T03:00:00.000Z'),
    targetRoleQueries: ['AI 产品经理'],
    preferredLocations: ['北京'],
    mustHave: ['2027 届校园招聘'],
    mustNotHave: ['纯销售'],
    minimumAnnualCompensationWan: 20,
  }
}

function existing(role = '产品经理（AI方向）'): Opportunity {
  return {
    id: 'existing-1',
    company: '候选科技',
    role,
    currentStageLabel: '待投',
    processStage: 'not_applied',
    roleType: 'core',
    early: false,
    opportunityValue: 80,
    fitScore: 70,
    importedAt: '2026-09-01T00:00:00.000Z',
  }
}

describe('v1.3 discovery quality gate', () => {
  it('detects semantically reordered AI product-manager titles as similar', () => {
    expect(discoveryRoleSimilarity('产品经理（AI方向）', 'AI 产品经理')).toBeGreaterThanOrEqual(0.72)
    expect(discoveryRoleSimilarity('商业分析', 'AI 产品经理')).toBeLessThan(0.72)
  })

  it('hard-rejects expired, closed, explicitly excluded and below-threshold candidates', () => {
    const configured = {
      ...profile(),
      minimumFitScore: 70,
      minimumOpportunityValue: 80,
    }
    const expired = evaluateDiscoveryCandidate(configured, candidate({ deadline: '2026-09-10T23:59:00+08:00' }), weights, now)
    expect(expired.accepted).toBe(false)
    expect(expired.hardRejectReasons.join(' ')).toContain('已过去')

    const closed = evaluateDiscoveryCandidate(configured, candidate({ postingStatus: 'closed' }), weights, now)
    expect(closed.hardRejectReasons.join(' ')).toContain('已关闭')

    const excluded = evaluateDiscoveryCandidate(configured, candidate({ sourceEvidenceText: '这是纯销售岗位，需要承担销售指标。' }), weights, now)
    expect(excluded.hardRejectReasons.join(' ')).toContain('纯销售')

    const lowScore = evaluateDiscoveryCandidate(configured, candidate({ fitScore: 60, opportunityValue: 70 }), weights, now)
    expect(lowScore.hardRejectReasons.join(' ')).toContain('匹配度')
    expect(lowScore.hardRejectReasons.join(' ')).toContain('机会价值')
  })

  it('keeps unknown evidence visible instead of fabricating salary or must-have facts', () => {
    const result = evaluateDiscoveryCandidate(
      profile(),
      candidate({
        sourceTitle: '候选科技 AI 产品经理',
        compensationText: undefined,
        annualCompensationMinWan: undefined,
        sourceEvidenceText: '工作地点北京。',
        postingStatus: 'unknown',
      }),
      weights,
      now,
    )
    expect(result.accepted).toBe(true)
    expect(result.warnings.join(' ')).toContain('最低年薪')
    expect(result.warnings.join(' ')).toContain('2027 届校园招聘')
    expect(result.warnings.join(' ')).toContain('仍开放')
  })

  it('supports strict location mode as a fail-closed gate', () => {
    const strict = { ...profile(), locationPolicy: 'strict' as const }
    expect(evaluateDiscoveryCandidate(strict, candidate({ location: '广州' }), weights, now).accepted).toBe(false)
    expect(evaluateDiscoveryCandidate(strict, candidate({ location: undefined }), weights, now).accepted).toBe(false)
  })

  it('rejects explicitly verified compensation below the user floor', () => {
    const result = evaluateDiscoveryCandidate(profile(), candidate({ annualCompensationMinWan: 18 }), weights, now)
    expect(result.accepted).toBe(false)
    expect(result.hardRejectReasons.join(' ')).toContain('18')
  })

  it('deduplicates against existing similar roles and keeps only the strongest bounded review batch', () => {
    const configured = { ...profile(), maxReviewCandidates: 2 }
    const result = screenDiscoveryCandidates(configured, [
      candidate({ company: '候选科技', role: 'AI 产品经理' }),
      candidate({ company: '甲公司', role: 'AI 产品经理', fitScore: 92, opportunityValue: 94, sourceTitle: '甲公司 AI PM', sourceEvidenceText: '2027 届校园招聘，北京。' }),
      candidate({ company: '乙公司', role: 'AI 产品经理', fitScore: 84, opportunityValue: 88, sourceTitle: '乙公司 AI PM', sourceEvidenceText: '2027 届校园招聘，北京。' }),
      candidate({ company: '丙公司', role: 'AI 产品经理', fitScore: 68, opportunityValue: 70, sourceTitle: '丙公司 AI PM', sourceEvidenceText: '2027 届校园招聘，北京。' }),
    ], [existing()], weights, now)

    expect(result.skippedDuplicates).toHaveLength(1)
    expect(result.accepted.map((item) => item.candidate.company)).toEqual(['甲公司', '乙公司'])
    expect(result.deferredCandidates).toHaveLength(1)
    expect(result.deferredCandidates[0].company).toBe('丙公司')
  })
})
