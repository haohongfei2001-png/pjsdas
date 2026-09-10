import { describe, expect, it } from 'vitest'
import { buildTimePlan, selectTodayActions } from '../src/decisionCoreV3'
import { createSnapshot, parseSnapshotText } from '../src/snapshot'
import { timeRisk } from '../src/timeRisk'
import {
  cloneDecisionRules,
  DEFAULT_DECISION_RULES,
  validateDecisionRules,
} from '../src/decisionRules'
import type { Action, RankedAction } from '../src/model'

function ranked(id: string, kind: Action['kind'], minutes = 10, dueAt?: string): RankedAction {
  return {
    action: {
      id,
      kind,
      title: id,
      dueAt,
      estimatedMinutes: minutes,
      leverage: 50,
      delayCost: 50,
      status: 'todo',
      createdAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:00:00.000Z',
    },
    score: 80,
    breakdown: { opportunity: 50, fit: 50, urgency: 50, stage: 50, leverage: 50, delayCost: 50, timeEfficiency: 50 },
    reasons: [],
  }
}

describe('Decision Rules', () => {
  it('keeps the shipped defaults valid', () => {
    expect(validateDecisionRules(DEFAULT_DECISION_RULES)).toEqual([])
  })

  it('rejects risk thresholds that are out of order', () => {
    const rules = cloneDecisionRules()
    rules.riskCriticalHours = 30
    rules.riskHighHours = 24
    expect(validateDecisionRules(rules).join(' ')).toMatch(/风险阈值/)
  })

  it('respects editable daily follow-up and prep caps', () => {
    const rules = cloneDecisionRules()
    rules.followUpDailyCap = 1
    rules.prepDailyCap = 1
    const selected = selectTodayActions([
      ranked('f1', 'follow_up'), ranked('f2', 'follow_up'), ranked('p1', 'prep'), ranked('p2', 'prep'), ranked('m1', 'manual'),
    ], new Date('2026-09-10T09:00:00.000Z'), 10, rules)
    expect(selected.filter((x) => x.action.kind === 'follow_up')).toHaveLength(1)
    expect(selected.filter((x) => x.action.kind === 'prep')).toHaveLength(1)
  })

  it('changes hard-deadline protection without changing the task data', () => {
    const now = new Date('2026-09-10T00:00:00.000Z')
    const due36h = '2026-09-11T12:00:00.000Z'
    const hard = ranked('hard', 'apply', 90, due36h)
    const quick = ranked('quick', 'manual', 20)

    const protect48 = cloneDecisionRules()
    protect48.nearDeadlineStretchMinutes = 0
    const protectedPlan = buildTimePlan([quick, hard], 20, now, protect48)
    expect(protectedPlan.planned).toHaveLength(0)
    expect(protectedPlan.nearDeadlineUnplanned.map((x) => x.action.id)).toContain('hard')

    const protect24 = cloneDecisionRules()
    protect24.hardDeadlineHorizonHours = 24
    protect24.nearDeadlineStretchMinutes = 0
    const relaxedPlan = buildTimePlan([quick, hard], 20, now, protect24)
    expect(relaxedPlan.planned.map((x) => x.action.id)).toContain('quick')
  })

  it('uses editable countdown risk thresholds', () => {
    const now = new Date('2026-09-10T00:00:00.000Z')
    const due18h = '2026-09-10T18:00:00.000Z'
    expect(timeRisk(due18h, now).level).toBe('high')
    const rules = cloneDecisionRules()
    rules.riskHighHours = 12
    rules.riskNearHours = 36
    expect(timeRisk(due18h, now, rules).level).toBe('near')
  })

  it('round-trips rules in a local snapshot while remaining optional for old snapshots', () => {
    const rules = cloneDecisionRules()
    rules.followUpDailyCap = 1
    const snapshot = createSnapshot({ opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], decisionRules: rules }, '2026-09-10T00:00:00.000Z')
    expect(parseSnapshotText(JSON.stringify(snapshot)).data.decisionRules?.followUpDailyCap).toBe(1)

    const legacy = { ...snapshot, data: { ...snapshot.data } }
    delete legacy.data.decisionRules
    expect(parseSnapshotText(JSON.stringify(legacy)).data.decisionRules).toBeUndefined()
  })
})
