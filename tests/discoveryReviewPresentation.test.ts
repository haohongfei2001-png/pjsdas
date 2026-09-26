import { describe, expect, it } from 'vitest'
import {
  presentDiscoveryReviewReason,
  presentDiscoveryReviewReasons,
} from '../src/aiAccess/discoveryReviewPresentation.js'
import type { McpDiscoveryReviewItem } from '../src/ai/mcpProposal.js'

describe('Discovery Review reason presentation', () => {
  it('prefers structured detail and follows the active language', () => {
    const item: McpDiscoveryReviewItem = {
      company: 'Example AI',
      role: 'AI Product Manager',
      reason: '旧中文原因',
      reasonDetail: {
        code: 'existing_opportunity_duplicate',
        params: { company: 'Example AI', role: 'AI Product Manager' },
      },
    }

    expect(presentDiscoveryReviewReason(item, true)).toContain('TodayAction 已存在相同或高度相似岗位')
    expect(presentDiscoveryReviewReason(item, false)).toContain('TodayAction already contains the same or a highly similar role')
    expect(presentDiscoveryReviewReason(item, false)).not.toContain('旧中文原因')
  })

  it('presents multiple structured rejection reasons in order', () => {
    const item: McpDiscoveryReviewItem = {
      company: 'Example AI',
      role: 'AI Product Manager',
      reasons: ['旧原因 1', '旧原因 2'],
      reasonDetails: [
        { code: 'fit_below_minimum', params: { score: 70, minimum: 80 } },
        { code: 'strict_location_mismatch', params: { location: 'Remote' } },
      ],
    }

    expect(presentDiscoveryReviewReasons(item, false)).toEqual([
      'Fit score 70 is below the explicit minimum 80.',
      'Job location “Remote” does not satisfy the strict location constraint.',
    ])
  })

  it('keeps legacy proposal text unchanged when structured details are absent', () => {
    const single: McpDiscoveryReviewItem = {
      company: 'Legacy Co',
      role: 'Legacy Role',
      reason: '历史提议中的原始原因',
    }
    const multiple: McpDiscoveryReviewItem = {
      company: 'Legacy Co',
      role: 'Legacy Role',
      reasons: ['历史原因 A', '历史原因 B'],
    }

    expect(presentDiscoveryReviewReason(single, false)).toBe('历史提议中的原始原因')
    expect(presentDiscoveryReviewReasons(multiple, false)).toEqual(['历史原因 A', '历史原因 B'])
  })
})
