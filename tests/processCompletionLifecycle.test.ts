import { describe, expect, it } from 'vitest'
import { parseProgressUpdate } from '../src/progressUpdate.js'
import { createCanonicalProgressChangeSet } from '../src/progressCompletion.js'
import { actionForProcessEvent } from '../src/processEvents.js'
import type { Action, Opportunity, ProcessEvent } from '../src/model.js'

function opportunity(
  id: string,
  company: string,
  role: string,
  stage: Opportunity['processStage'] = 'assessment',
): Opportunity {
  return {
    id,
    company,
    role,
    currentStageLabel: stage === 'assessment' ? '测评' : stage === 'written_test' ? '笔试' : stage === 'interview' ? '面试' : '筛选中',
    processStage: stage,
    roleType: 'core',
    early: false,
    opportunityValue: 90,
    fitScore: 70,
    importedAt: '2026-09-10T00:00:00.000Z',
  }
}

function event(
  id: string,
  opportunityValue: Opportunity,
  type: ProcessEvent['type'],
): ProcessEvent {
  return {
    id,
    opportunityId: opportunityValue.id,
    company: opportunityValue.company,
    role: opportunityValue.role,
    type,
    occurredAt: '2026-09-11T02:00:00.000Z',
    dueAt: '2026-09-12T15:59:59.000Z',
    timingMode: type === 'assessment_invite' ? 'deadline' : 'fixed',
    estimatedMinutes: type === 'assessment_invite' ? 45 : 90,
    source: 'manual',
    createdAt: '2026-09-11T02:00:00.000Z',
    updatedAt: '2026-09-11T02:00:00.000Z',
  }
}

const now = new Date(2026, 8, 12, 22, 0, 0)

describe('explicit process-task completion', () => {
  it('recognizes a same-day JD/JDS assessment completion without requiring another deadline', () => {
    const jd = opportunity('JD-PM', '京东', '技术产品经理', 'assessment')
    const plan = parseProgressUpdate('JDS技术产品经理测评已完成。', [jd], now)
    const completed = plan.operations.find((item) => item.kind === 'process_event')

    expect(plan.unresolved).toHaveLength(0)
    expect(completed).toMatchObject({
      kind: 'process_event',
      opportunityId: 'JD-PM',
      eventType: 'assessment_invite',
      completed: true,
      confidence: 'high',
    })
  })

  it('recognizes explicit completion phrasing for written tests and interviews', () => {
    const written = opportunity('A-W', '甲公司', '产品经理', 'written_test')
    const interview = opportunity('B-I', '乙公司', '产品经理', 'interview')

    const writtenPlan = parseProgressUpdate('甲公司产品经理笔试做完了。', [written], now)
    const interviewPlan = parseProgressUpdate('乙公司产品经理面试已经结束。', [interview], now)

    expect(writtenPlan.operations.find((item) => item.kind === 'process_event')).toMatchObject({
      kind: 'process_event', eventType: 'written_test_invite', completed: true,
    })
    expect(interviewPlan.operations.find((item) => item.kind === 'process_event')).toMatchObject({
      kind: 'process_event', eventType: 'interview_invite', completed: true,
    })
  })

  it('does not mistake a completion instruction for an already completed task', () => {
    const jd = opportunity('JD-PM', '京东', '技术产品经理', 'assessment')
    const plan = parseProgressUpdate('JDS技术产品经理测评请在48小时内完成。', [jd], now)
    const assessment = plan.operations.find((item) => item.kind === 'process_event')

    expect(assessment?.kind).toBe('process_event')
    if (assessment?.kind === 'process_event') expect(assessment.completed).not.toBe(true)
  })
})

describe('completion ChangeSet canonicalization', () => {
  it('completes the existing assessment action instead of creating a duplicate assessment event', () => {
    const jd = opportunity('JD-PM', '京东', '技术产品经理', 'assessment')
    const existingEvent = event('jd-assessment', jd, 'assessment_invite')
    const existingAction = actionForProcessEvent(existingEvent)!
    const plan = parseProgressUpdate('JDS技术产品经理测评完成了。', [jd], now)

    const changeSet = createCanonicalProgressChangeSet(
      plan.executable,
      [existingEvent],
      [existingAction],
      now,
    )

    expect(changeSet.operations).toHaveLength(1)
    expect(changeSet.operations[0]).toMatchObject({
      kind: 'set_action_status',
      actionId: 'event-action:jd-assessment',
      expectedStatus: 'todo',
      status: 'done',
    })
    expect(changeSet.operations.some((item) => item.kind === 'progress_update')).toBe(false)
  })

  it('keeps historical completed-event backfill when no prior event exists', () => {
    const jd = opportunity('JD-PM', '京东', '技术产品经理', 'assessment')
    const plan = parseProgressUpdate('JDS技术产品经理测评完成了。', [jd], now)
    const changeSet = createCanonicalProgressChangeSet(plan.executable, [], [], now)

    expect(changeSet.operations[0]).toMatchObject({ kind: 'progress_update' })
  })

  it('is idempotent when the existing event action is already done', () => {
    const jd = opportunity('JD-PM', '京东', '技术产品经理', 'assessment')
    const existingEvent = event('jd-assessment', jd, 'assessment_invite')
    const existingAction: Action = { ...actionForProcessEvent(existingEvent)!, status: 'done' }
    const plan = parseProgressUpdate('JDS技术产品经理测评已完成。', [jd], now)
    const changeSet = createCanonicalProgressChangeSet(plan.executable, [existingEvent], [existingAction], now)

    expect(changeSet.operations[0]).toMatchObject({
      kind: 'set_action_status',
      actionId: 'event-action:jd-assessment',
      expectedStatus: 'done',
      status: 'done',
    })
  })
})
