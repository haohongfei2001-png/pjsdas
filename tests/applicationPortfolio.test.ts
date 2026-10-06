import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildApplicationPortfolioDecision } from '../src/applicationPortfolio.js'
import type { Opportunity, ApplicationGroup } from '../src/model.js'
const now = new Date('2026-10-06T12:00:00Z')
const group: ApplicationGroup = { id: 'g', company: 'Example', total: 2, used: 1, remaining: 1 }
function role(id: string, deadline?: string, score = 0): Opportunity { return { id, company: 'Example', role: id,
  applicationGroupId: 'g', roleType: 'core', processStage: 'not_applied', currentStageLabel: '待投', early: false,
  deadline, fitScore: score, opportunityValue: score, importedAt: now.toISOString() } }
describe('factual application quota contract', () => {
  it('orders only by deadline and stable ID while ignoring all legacy scores', () => {
    const values = [role('late', '2026-10-09', 100), role('early', '2026-10-07', 0), role('unknown', undefined, 100)]
    const before = structuredClone(values)
    const result = buildApplicationPortfolioDecision(group, values, undefined, now)
    expect(result.candidates.map(item => item.opportunityId)).toEqual(['early', 'late', 'unknown'])
    expect(result.capacity).toBe(1)
    expect(result).not.toHaveProperty('recommended')
    expect(result).not.toHaveProperty('objectiveScore')
    expect(JSON.stringify(result)).not.toMatch(/baseScore|minimumScore|fitScore|opportunityValue/)
    expect(values).toEqual(before)
  })
  it('reports unknown and exhausted real quotas without choosing candidates', () => {
    expect(buildApplicationPortfolioDecision({ id: 'g', company: 'Example' }, [role('a')]).status).toBe('needs_rule_confirmation')
    expect(buildApplicationPortfolioDecision({ ...group, remaining: 0 }, [role('a')]).status).toBe('capacity_exhausted')
  })
  it('preserves lock and recorded preference without inventing a selection', () => {
    const result = buildApplicationPortfolioDecision({ ...group, locked: true, currentOrder: 'Owner recorded preference' }, [role('a')])
    expect(result).toMatchObject({ status: 'locked', currentOrder: 'Owner recorded preference', capacity: 1 })
    expect(result.candidates).toHaveLength(1)
  })
  it('preserves inconsistent quota evidence and flags it', () => {
    const result = buildApplicationPortfolioDecision({ ...group, remaining: 2 }, [])
    expect(result.warnings).toContainEqual({ code: 'capacity_fields_inconsistent', total: 2, used: 1, derived: 1, remaining: 2 })
  })
  it('keeps expired/submitted facts visible without mislabeling them recommendations', () => {
    const result = buildApplicationPortfolioDecision(group, [{ ...role('submitted', '2026-10-05'), processStage: 'screening' }, role('current', '2026-10-07')], undefined, now)
    expect(result.candidates[0]).toMatchObject({ opportunityId: 'submitted', deadlineExpired: true, processStage: 'screening' })
    expect(result.candidates).toHaveLength(2)
  })
  it('keeps a date-only deadline valid through its local day', () => {
    const result = buildApplicationPortfolioDecision(group, [{ ...role('a', '2026-10-06'), deadlinePrecision: 'date' }], undefined, now, 'Asia/Shanghai')
    expect(result.candidates[0].deadlineExpired).toBe(false)
  })
  it('shares source-zone aware candidate ordering with the Web quota view', () => {
    const values = [['a-west', 'America/Los_Angeles'], ['z-east', 'Asia/Tokyo']].map(([id, timezone]) => ({ ...role(id, '2026-10-07'),
      deadlineResolution: { state: 'confirmed' as const, deadline: '2026-10-07', precision: 'date' as const, source: 'schedule_node' as const, timezone, nodeIds: [], postingStatus: 'unknown' as const } }))
    const result = buildApplicationPortfolioDecision(group, values, undefined, now, 'UTC')
    expect(result.candidates.map(item => item.opportunityId)).toEqual(['z-east', 'a-west'])
    const ui = readFileSync(new URL('../src/ApplicationPortfolioDockHeavy.tsx', import.meta.url), 'utf8')
    expect(ui).toContain('deadlineResolution: resolved')
    expect(ui).toContain('buildApplicationPortfolioDecision(group, opportunities')
    expect(ui).not.toContain('compareDeadlines(')
  })

})
