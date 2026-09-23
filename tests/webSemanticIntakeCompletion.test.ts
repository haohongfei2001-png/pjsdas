import { describe, expect, it } from 'vitest'
import { applySemanticIntake } from '../src/semanticIntake.js'
import { buildWebSemanticInterpretation } from '../src/webSemanticInterpretation.js'
import { createSnapshot } from '../src/snapshot.js'
import type { Opportunity, ProcessEvent, SemanticIntakeObservation } from '../src/model.js'

const NOW = new Date('2026-09-20T12:00:00.000Z')

function fixture() {
  const opportunity: Opportunity = {
    id: 'elapsed-interview-opportunity',
    company: '节点测试科技',
    role: 'AI产品经理',
    currentStageLabel: '面试',
    processStage: 'interview',
    roleType: 'core',
    early: false,
    opportunityValue: 86,
    fitScore: 82,
    locallyManaged: true,
    importedAt: '2026-09-01T00:00:00.000Z',
  }
  const event: ProcessEvent = {
    id: 'elapsed-interview-event',
    opportunityId: opportunity.id,
    company: opportunity.company,
    role: opportunity.role,
    type: 'interview_invite',
    occurredAt: '2026-09-01T00:00:00.000Z',
    dueAt: '2026-09-02T10:00:00.000Z',
    duePrecision: 'datetime',
    timingMode: 'fixed',
    estimatedMinutes: 60,
    source: 'manual',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  }
  const snapshot = createSnapshot({
    opportunities: [opportunity],
    processes: [],
    processEvents: [event],
    actions: [],
    prep: [],
    applicationGroups: [],
    timeline: [],
  }, '2026-09-20T11:59:00.000Z')
  return { opportunity, snapshot }
}

describe('UU-04 Web Semantic Intake completion normalization', () => {
  it.each([
    '节点测试科技 AI产品经理 面试完成了。\n> 节点测试科技 AI产品经理 面试改到明天14:00',
    '节点测试科技 AI产品经理 面试完成了。\n引用：节点测试科技 AI产品经理 明天14:00面试',
    '节点测试科技 AI产品经理 面试完成了。 引用：节点测试科技 AI产品经理 明天14:00面试',
    '节点测试科技 AI产品经理 面试完成了。\nOn Tue, Sep 20, recruiter wrote:\n节点测试科技 AI产品经理 明天14:00面试',
    '节点测试科技 AI产品经理 面试完成了。\n-----Original Message-----\n节点测试科技 AI产品经理 明天14:00面试',
  ])('does not turn a quoted old thread into a second current event: %s', (text) => {
    const { opportunity, snapshot } = fixture()
    const interpretation = buildWebSemanticInterpretation(text, [opportunity], snapshot, [], NOW)
    expect(interpretation.mode).toBe('assertion')
    expect(interpretation.candidates).toHaveLength(1)
    expect(interpretation.candidates[0]).toMatchObject({
      kind: 'occurrence_completed', target: { opportunityId: opportunity.id, occurrenceKind: 'interview' },
    })
  })

  it('keeps a fully quoted recruiting event read-only without generating a write candidate', () => {
    const { opportunity, snapshot } = fixture()
    const interpretation = buildWebSemanticInterpretation('“节点测试科技 AI产品经理 明天14:00面试”', [opportunity], snapshot, [], NOW)
    expect(interpretation).toMatchObject({ mode: 'quote', candidates: [] })
  })

  it.each([
    'On Tue, Sep 20, recruiter wrote:',
    '-----Original Message-----',
  ])('keeps a current application separate from a quoted email thread beginning %s', (boundary) => {
    const { opportunity, snapshot } = fixture()
    const interpretation = buildWebSemanticInterpretation(
      `节点测试科技 AI产品经理 已投递成功。\n${boundary}\n节点测试科技 AI产品经理 明天14:00面试`,
      [opportunity], snapshot, [], NOW,
    )
    expect(interpretation.candidates.length).toBeGreaterThan(0)
    expect(interpretation.candidates.some((candidate) => candidate.kind === 'process_event' && candidate.eventType === 'interview_invite')).toBe(false)
  })

  it('preserves a quoted role name inside a current assertion', () => {
    const { opportunity, snapshot } = fixture()
    const interpretation = buildWebSemanticInterpretation('节点测试科技“AI产品经理”面试完成了', [opportunity], snapshot, [], NOW)
    expect(interpretation.candidates).toMatchObject([{ kind: 'occurrence_completed' }])
  })

  it('normalizes an explicit unique interview completion into occurrence_completed and closes the elapsed node', () => {
    const { opportunity, snapshot } = fixture()
    const text = '节点测试科技 AI产品经理 面试已经完成。'
    const interpretation = buildWebSemanticInterpretation(text, [opportunity], snapshot, [], NOW)

    expect(interpretation.mode).toBe('assertion')
    expect(interpretation.candidates).toHaveLength(1)
    expect(interpretation.candidates[0]).toMatchObject({
      kind: 'occurrence_completed',
      objectConfidence: 'high',
      eventConfidence: 'high',
      target: {
        opportunityId: opportunity.id,
        occurrenceKind: 'interview',
      },
    })
    expect(interpretation.candidates.some((item) => item.kind === 'process_event')).toBe(false)

    const observation: SemanticIntakeObservation = {
      contractVersion: 1,
      inputId: 'web-completion-regression',
      source: {
        kind: 'web',
        sourceId: 'todayaction-web',
        sourceRecordId: 'message-1',
        sourceVersion: '1',
        observedAt: NOW.toISOString(),
        assertedAt: NOW.toISOString(),
        timezone: 'Asia/Shanghai',
      },
      statementMode: interpretation.mode,
      originalText: text,
      candidates: interpretation.candidates,
    }
    const result = applySemanticIntake(snapshot, observation, {
      authorized: true,
      workspaceRevision: 'txn:7',
      now: NOW,
    })
    expect(result.status).toBe('APPLIED')
    expect(result.decisionRequests).toHaveLength(0)
    expect(result.snapshot.data.scheduleNodes?.find((item) => item.occurrenceId === 'process-event:elapsed-interview-event'))
      .toMatchObject({ state: 'completed' })
  })

  it('keeps completion questions read-only instead of converting them into facts', () => {
    const { opportunity, snapshot } = fixture()
    const text = '节点测试科技 AI产品经理 面试完成了吗？'
    const interpretation = buildWebSemanticInterpretation(text, [opportunity], snapshot, [], NOW)
    expect(interpretation.mode).toBe('question')

    const observation: SemanticIntakeObservation = {
      contractVersion: 1,
      inputId: 'web-completion-question',
      source: {
        kind: 'web',
        sourceId: 'todayaction-web',
        sourceRecordId: 'message-2',
        sourceVersion: '1',
        observedAt: NOW.toISOString(),
        timezone: 'Asia/Shanghai',
      },
      statementMode: interpretation.mode,
      originalText: text,
      candidates: interpretation.candidates,
    }
    const result = applySemanticIntake(snapshot, observation, {
      authorized: true,
      workspaceRevision: 'txn:7',
      now: NOW,
    })
    expect(result.status).toBe('NO_WRITE')
    expect(result.snapshot.data.scheduleNodes?.find((item) => item.occurrenceId === 'process-event:elapsed-interview-event'))
      .toMatchObject({ state: 'scheduled' })
  })
})
