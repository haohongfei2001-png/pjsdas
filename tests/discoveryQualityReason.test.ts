import { describe, expect, it } from 'vitest'
import { cloneDecisionRules, DEFAULT_DECISION_RULES } from '../src/decisionRules.js'
import { DEFAULT_DISCOVERY_PROFILE, cloneDiscoveryProfile } from '../src/discoveryProfile.js'
import {
  evaluateDiscoveryCandidate,
  screenDiscoveryCandidates,
  type DiscoveryCandidateForQuality,
} from '../src/discoveryQuality.js'
import {
  presentDiscoveryQualityReason,
  type DiscoveryQualityReasonDetail,
} from '../src/discoveryQualityReason.js'
import { createMcpProposalEnvelope, decodeMcpProposal, encodeMcpProposal } from '../src/ai/mcpProposal.js'
import type { ChangeSetRecord } from '../src/changeSet.js'
import type { Opportunity } from '../src/model.js'

function candidate(overrides: Partial<DiscoveryCandidateForQuality> = {}): DiscoveryCandidateForQuality {
  return {
    company: 'Example AI',
    role: 'AI Product Manager',
    sourceUrl: 'https://jobs.example.com/123',
    sourceTitle: 'Example AI - AI Product Manager',
    location: 'Beijing',
    postingStatus: 'open',
    roleType: 'core',
    opportunityValue: 88,
    fitScore: 82,
    fitConfidence: 'high',
    opportunityValueConfidence: 'high',
    ...overrides,
  }
}

function existingOpportunity(): Opportunity {
  return {
    id: 'existing-1',
    company: 'Example AI',
    role: 'AI Product Manager',
    currentStageLabel: '待投递',
    processStage: 'not_applied',
    roleType: 'core',
    early: false,
    opportunityValue: 88,
    fitScore: 82,
    importedAt: '2026-09-14T00:00:00.000Z',
    detail: {
      discovery: {
        sourceUrl: 'https://jobs.example.com/123',
        sourceTitle: 'Existing posting',
        fitConfidence: 'high',
        opportunityValueConfidence: 'high',
        discoveredAt: '2026-09-14T00:00:00.000Z',
      },
    },
  }
}

const emptyChangeSet: ChangeSetRecord = {
  id: 'CS-MCP-20260914040000-REASON',
  version: 1,
  source: 'mcp',
  status: 'pending',
  title: 'Discovery diagnostics',
  createdAt: '2026-09-14T04:00:00.000Z',
  updatedAt: '2026-09-14T04:00:00.000Z',
  operations: [{
    id: 'action:reason:test',
    kind: 'set_action_status',
    summary: 'No-op fixture',
    actionId: 'reason:test',
    expectedStatus: 'todo',
    status: 'done',
  }],
}

describe('structured discovery quality reasons', () => {
  it('keeps legacy Chinese text while adding bilingual structured hard-reject detail', () => {
    const profile = cloneDiscoveryProfile(DEFAULT_DISCOVERY_PROFILE)
    profile.locationPolicy = 'strict'
    profile.preferredLocations = ['Shanghai']
    profile.minimumFitScore = 90

    const evaluated = evaluateDiscoveryCandidate(
      profile,
      candidate({ location: 'Beijing', fitScore: 70 }),
      cloneDecisionRules(DEFAULT_DECISION_RULES).weights,
      new Date('2026-09-14T04:00:00.000Z'),
    )

    expect(evaluated.hardRejectReasons).toEqual([
      '匹配度 70 低于显式门槛 90。',
      '岗位地点“Beijing”不符合严格地点约束。',
    ])
    expect(evaluated.hardRejectDetails).toEqual([
      { code: 'fit_below_minimum', params: { score: 70, minimum: 90 } },
      { code: 'strict_location_mismatch', params: { location: 'Beijing' } },
    ])
    expect(evaluated.hardRejectDetails.map((detail) => presentDiscoveryQualityReason(detail, false))).toEqual([
      'Fit score 70 is below the explicit minimum 90.',
      'Job location “Beijing” does not satisfy the strict location constraint.',
    ])
  })

  it('adds structured duplicate detail without changing the legacy reason', () => {
    const result = screenDiscoveryCandidates(
      DEFAULT_DISCOVERY_PROFILE,
      [candidate()],
      [existingOpportunity()],
      cloneDecisionRules(DEFAULT_DECISION_RULES).weights,
      new Date('2026-09-14T04:00:00.000Z'),
    )

    expect(result.skippedDuplicates).toHaveLength(1)
    expect(result.skippedDuplicates[0].reason).toContain('PJSDAS 已存在相同或高度相似岗位')
    expect(result.skippedDuplicates[0].reasonDetail).toMatchObject({
      code: 'existing_opportunity_source_duplicate',
      params: { company: 'Example AI', role: 'AI Product Manager', sourceHost: 'jobs.example.com' },
    })
    expect(presentDiscoveryQualityReason(result.skippedDuplicates[0].reasonDetail!, false)).toContain('already belongs to a formal Opportunity')
  })

  it('round-trips optional structured reason metadata in signed proposal envelopes', () => {
    const detail: DiscoveryQualityReasonDetail = {
      code: 'exclusion_match',
      params: { rule: 'requires English interview' },
    }
    const review = {
      received: 1,
      accepted: 0,
      duplicateCount: 0,
      rejectedCount: 1,
      deferredCount: 0,
      skippedDuplicates: [],
      rejectedCandidates: [{
        company: 'Example AI',
        role: 'AI Product Manager',
        reasons: ['来源证据命中明确排除条件“requires English interview”。'],
        reasonDetails: [detail],
      }],
      deferredCandidates: [],
    }
    const envelope = createMcpProposalEnvelope(emptyChangeSet, 'drive:42', new Date('2026-09-14T04:00:00.000Z'), review)
    expect(decodeMcpProposal(encodeMcpProposal(envelope)).discoveryReview).toEqual(review)
  })
})
