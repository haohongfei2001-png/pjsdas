import { describe, expect, it } from 'vitest'
import { computePriority } from '../src/decisionV3.js'
import type { Opportunity } from '../src/model.js'

function opportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    id: 'priority-test',
    company: '优先级测试科技',
    role: 'AI产品经理',
    currentStageLabel: '待投递',
    processStage: 'not_applied',
    roleType: 'core',
    early: false,
    opportunityValue: 85,
    fitScore: 80,
    locallyManaged: true,
    importedAt: '2026-09-14T00:00:00.000Z',
    ...overrides,
  }
}

describe('canonical priority state', () => {
  it('treats a canonical not_applied opportunity as pending regardless of localized stage label', () => {
    expect(computePriority(opportunity({ currentStageLabel: '待投递' }), new Date('2026-09-14T08:00:00Z'))).toBe('P2')
    expect(computePriority(opportunity({ currentStageLabel: 'Not applied' }), new Date('2026-09-14T08:00:00Z'))).toBe('P2')
  })

  it('does not let a stale pending-looking label override a canonical pipeline stage', () => {
    expect(computePriority(opportunity({ currentStageLabel: '待投', processStage: 'screening' }), new Date('2026-09-14T08:00:00Z'))).toBe('none')
  })

  it('still applies deadline and early-window priority once canonical state is pending', () => {
    expect(computePriority(opportunity({ deadline: '2026-09-16T08:00:00Z' }), new Date('2026-09-14T08:00:00Z'))).toBe('P0')
    expect(computePriority(opportunity({ early: true }), new Date('2026-09-14T08:00:00Z'))).toBe('P1')
  })
})
