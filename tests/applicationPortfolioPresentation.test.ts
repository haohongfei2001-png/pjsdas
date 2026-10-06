import { describe, expect, it } from 'vitest'
import { portfolioWarningText } from '../src/applicationPortfolioPresentation.js'

describe('application portfolio presentation', () => {

  it('renders structured capacity warnings without language in the decision engine', () => {
    const warning = { code: 'capacity_fields_inconsistent' as const, total: 3, used: 1, derived: 2, remaining: 1 }
    expect(portfolioWarningText(warning, true)).toContain('总名额 3')
    expect(portfolioWarningText(warning, false)).toContain('total 3')
    expect(portfolioWarningText({ code: 'capacity_unknown' }, false)).toContain('does not guess')
  })
})
