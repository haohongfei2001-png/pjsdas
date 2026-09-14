import { describe, expect, it } from 'vitest'
import { presentTimeRemaining, presentTimeRiskLevel } from '../src/timeRiskPresentation.js'

const now = new Date('2026-09-14T04:00:00.000Z')

describe('active time-risk presentation', () => {
  it('keeps Chinese countdown semantics', () => {
    expect(presentTimeRemaining('2026-09-14T06:30:00.000Z', now, true)).toBe('剩 2 小时 30 分钟')
    expect(presentTimeRemaining('2026-09-15T08:00:00.000Z', now, true)).toBe('剩 1 天 4 小时')
  })

  it('renders the same remaining time in English', () => {
    expect(presentTimeRemaining('2026-09-14T06:30:00.000Z', now, false)).toBe('2 hr 30 min left')
    expect(presentTimeRemaining('2026-09-15T08:00:00.000Z', now, false)).toBe('1 d 4 hr left')
    expect(presentTimeRemaining('2026-09-14T03:59:00.000Z', now, false)).toBe('Reached')
  })

  it('localizes canonical risk levels without changing the level', () => {
    expect(presentTimeRiskLevel('critical', true)).toBe('极高风险')
    expect(presentTimeRiskLevel('critical', false)).toBe('Critical')
    expect(presentTimeRiskLevel('high', false)).toBe('High risk')
    expect(presentTimeRiskLevel('near', false)).toBe('Near')
    expect(presentTimeRiskLevel('watch', false)).toBe('Prepare')
    expect(presentTimeRiskLevel('upcoming', false)).toBe('Scheduled')
  })
})
