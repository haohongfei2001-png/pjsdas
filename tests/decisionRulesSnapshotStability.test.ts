import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DECISION_RULES,
  createDefaultDecisionRules,
  decisionRulesForSnapshot,
} from '../src/decisionRules.js'

describe('decision rules snapshot stability', () => {
  it('uses a stable default rule record when no rules have been persisted', () => {
    const first = decisionRulesForSnapshot()
    const second = decisionRulesForSnapshot()

    expect(first).toEqual(second)
    expect(first.updatedAt).toBe(DEFAULT_DECISION_RULES.updatedAt)
    expect(first).not.toBe(second)
    expect(first.weights).not.toBe(second.weights)
  })

  it('preserves an explicitly persisted rule record', () => {
    const stored = createDefaultDecisionRules('2026-09-11T05:00:00.000Z')
    stored.hardDeadlineHorizonHours = 72

    const snapshotRules = decisionRulesForSnapshot(stored)
    expect(snapshotRules).toEqual(stored)
    expect(snapshotRules).not.toBe(stored)
    expect(snapshotRules.weights).not.toBe(stored.weights)
  })
})
