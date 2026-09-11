import { describe, expect, it } from 'vitest'
import { createDefaultDecisionRules } from '../src/decisionRules.js'
import {
  buildTimelineBackfill,
  decisionRuleChanges,
  timelineFromImportedHistory,
  timelineFromProgressOperation,
} from '../src/timeline.js'
import type { Opportunity, ProcessEvent } from '../src/model.js'

const opportunity: Opportunity = {
  id: 'J27-001', company: '测试公司', role: '产品经理', currentStageLabel: '待投', processStage: 'not_applied',
  roleType: 'core', early: false, opportunityValue: 90, fitScore: 76, importedAt: '2026-09-01T00:00:00.000Z',
}

describe('Timeline domain', () => {
  it('turns a submitted natural-language update into a durable application event', () => {
    const record = timelineFromProgressOperation({
      id: 'apply-1', kind: 'upsert_opportunity', mode: 'submitted', opportunityId: opportunity.id,
      company: opportunity.company, role: opportunity.role, sourceText: '9月10日投递测试公司产品经理',
      confidence: 'high', occurredAt: '2026-09-10T00:00:00.000Z',
    }, opportunity)
    expect(record).toMatchObject({ kind: 'application_submitted', category: 'opportunity', source: 'natural_language' })
    expect(record?.changes?.stage.after).toBe('screening')
  })

  it('stores imported history as history instead of executable work', () => {
    const record = timelineFromImportedHistory({
      occurredAt: '2026-08-14T00:00:00.000Z', importedAt: '2026-09-10T00:00:00.000Z',
      type: '投递', relation: 'J27-001｜测试公司｜产品经理', event: '完成投递。', result: '已投。', opportunity,
    })
    expect(record.kind).toBe('history_imported')
    expect(record.category).toBe('opportunity')
    expect(record.opportunityId).toBe('J27-001')
  })

  it('captures rule diffs structurally', () => {
    const before = createDefaultDecisionRules('2026-09-10T00:00:00.000Z')
    const after = { ...before, hardDeadlineHorizonHours: 72, weights: { ...before.weights, urgency: 30 } }
    const changes = decisionRuleChanges(before, after)
    expect(changes.hardDeadlineHorizonHours).toEqual({ before: 48, after: 72 })
    expect(changes['weights.urgency']).toEqual({ before: 23, after: 30 })
  })

  it('backfills only facts that can be recovered from the old database', () => {
    const event: ProcessEvent = {
      id: 'evt-1', opportunityId: opportunity.id, company: opportunity.company, role: opportunity.role,
      type: 'assessment_invite', occurredAt: '2026-09-10T01:00:00.000Z', source: 'manual',
      createdAt: '2026-09-10T01:00:00.000Z', updatedAt: '2026-09-10T01:00:00.000Z',
    }
    const records = buildTimelineBackfill({ processEvents: [event], actions: [], now: '2026-09-11T00:00:00.000Z' })
    expect(records.some((item) => item.processEventId === 'evt-1')).toBe(true)
    expect(records.some((item) => item.kind === 'baseline_backfill')).toBe(true)
  })
})
