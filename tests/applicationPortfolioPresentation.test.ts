import { describe, expect, it } from 'vitest'
import { portfolioReasonText, portfolioWarningText } from '../src/applicationPortfolioPresentation.js'

describe('application portfolio presentation', () => {
  it('renders decision reasons in both interface languages', () => {
    expect(portfolioReasonText({ code: 'high_opportunity_value' }, true)).toBe('机会价值高')
    expect(portfolioReasonText({ code: 'high_opportunity_value' }, false)).toBe('High opportunity value')
    expect(portfolioReasonText({ code: 'high_overlap', similarityPercent: 87 }, false)).toContain('87%')
  })

  it('renders structured capacity warnings without language in the decision engine', () => {
    const warning = { code: 'capacity_fields_inconsistent' as const, total: 3, used: 1, derived: 2, remaining: 1 }
    expect(portfolioWarningText(warning, true)).toContain('总名额 3')
    expect(portfolioWarningText(warning, false)).toContain('total 3')
    expect(portfolioWarningText({ code: 'capacity_unknown' }, false)).toContain('does not guess')
  })
})
