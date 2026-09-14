import { describe, expect, it } from 'vitest'
import { presentRankingReason, presentRankingReasons } from '../src/rankingReasonPresentation.js'

describe('Today ranking reason presentation', () => {
  it('preserves engine reasons verbatim in Chinese UI', () => {
    expect(presentRankingReasons(['核心机会', '完成成本低'], true)).toEqual(['核心机会', '完成成本低'])
  })

  it('localizes stable engine reasons in English', () => {
    expect(presentRankingReasons(['核心机会', '真实流程通知', '完成成本低'], false)).toEqual([
      'Core opportunity',
      'Recruiter-confirmed process event',
      'Low effort',
    ])
  })

  it('localizes dynamic deadline and Prep Graph reasons', () => {
    expect(presentRankingReason('流程节点48小时内', false)).toBe('Recruiting step within 48 hours')
    expect(presentRankingReason('72小时内硬截止', false)).toBe('Hard deadline within 72 hours')
    expect(presentRankingReason('覆盖3岗 · 5个需求', false)).toBe('Covers 3 roles · 5 needs')
  })

  it('fails open for unknown reason text instead of inventing a translation', () => {
    expect(presentRankingReason('来源自定义原因', false)).toBe('来源自定义原因')
  })
})
