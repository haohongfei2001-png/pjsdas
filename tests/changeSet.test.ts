import { describe, expect, it } from 'vitest'
import {
  createActionStatusChangeSet,
  createProgressChangeSet,
  createRulesChangeSet,
  decisionRulesEquivalent,
  restoreProgressOperation,
  validateChangeSet,
} from '../src/changeSet'
import { createDefaultDecisionRules } from '../src/decisionRules'
import { timelineFromChangeSetApplied } from '../src/timeline'
import type { Action } from '../src/model'
import type { ExecutableProgressOperation } from '../src/progressUpdate'

describe('ChangeSet protocol', () => {
  it('persists normalized natural-language changes without raw input text', () => {
    const operation: ExecutableProgressOperation = {
      id: 'nl:test:manual',
      kind: 'manual_action',
      sourceText: '这是一整段不应该进入持久化 ChangeSet 的原始输入',
      confidence: 'high',
      occurredAt: '2026-09-11T01:00:00.000Z',
      title: '完成毕业生源信息校对',
      estimatedMinutes: 20,
    }
    const changeSet = createProgressChangeSet([operation], new Date('2026-09-11T01:10:00.000Z'))
    expect(validateChangeSet(changeSet)).toEqual([])
    expect(JSON.stringify(changeSet)).not.toContain(operation.sourceText)
    expect(changeSet.operations[0].summary).toContain('毕业生源信息校对')

    const restored = restoreProgressOperation(changeSet.operations[0] as Extract<typeof changeSet.operations[number], { kind: 'progress_update' }>, changeSet.id)
    expect(restored.kind).toBe('manual_action')
    expect(restored.sourceText).toContain(changeSet.id)
  })

  it('creates an optimistic-concurrency rule ChangeSet only when rules differ', () => {
    const before = createDefaultDecisionRules('2026-09-11T00:00:00.000Z')
    const after = { ...before, hardDeadlineHorizonHours: 72 }
    const changeSet = createRulesChangeSet(before, after, 'save', new Date('2026-09-11T01:00:00.000Z'))
    expect(changeSet).toBeTruthy()
    expect(changeSet!.operations[0]).toMatchObject({
      kind: 'replace_decision_rules',
      expectedUpdatedAt: before.updatedAt,
    })
    expect(createRulesChangeSet(before, before, 'save')).toBeUndefined()
    expect(decisionRulesEquivalent(before, { ...before, updatedAt: '2030-01-01T00:00:00.000Z' })).toBe(true)
  })

  it('represents explicit action completion with the same protocol', () => {
    const action: Action = {
      id: 'event-action:test',
      kind: 'manual',
      title: '完成在线测评',
      estimatedMinutes: 30,
      leverage: 80,
      delayCost: 90,
      status: 'todo',
      createdAt: '2026-09-11T00:00:00.000Z',
      updatedAt: '2026-09-11T00:00:00.000Z',
    }
    const changeSet = createActionStatusChangeSet(action, 'done', new Date('2026-09-11T01:00:00.000Z'))!
    expect(changeSet.source).toBe('user_action')
    expect(changeSet.operations[0]).toMatchObject({ kind: 'set_action_status', expectedStatus: 'todo', status: 'done' })
    expect(validateChangeSet(changeSet)).toEqual([])
  })

  it('creates a Timeline audit record for an applied ChangeSet', () => {
    const operation: ExecutableProgressOperation = {
      id: 'nl:test:task',
      kind: 'manual_action',
      sourceText: '原文',
      confidence: 'high',
      occurredAt: '2026-09-11T01:00:00.000Z',
      title: '测试任务',
      estimatedMinutes: 20,
    }
    const pending = createProgressChangeSet([operation], new Date('2026-09-11T01:10:00.000Z'))
    const applied = { ...pending, status: 'applied' as const, appliedAt: '2026-09-11T01:12:00.000Z', updatedAt: '2026-09-11T01:12:00.000Z' }
    const record = timelineFromChangeSetApplied(applied)
    expect(record.category).toBe('change')
    expect(record.changeSetId).toBe(applied.id)
    expect(record.detail).toContain('测试任务')
  })
})
