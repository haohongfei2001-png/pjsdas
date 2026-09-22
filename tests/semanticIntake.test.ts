import { describe, expect, it } from 'vitest'
import type {
  Action,
  Opportunity,
  ProcessEvent,
  ProcessRecord,
  SemanticCandidate,
  SemanticIntakeObservation,
} from '../src/model.js'
import {
  applySemanticCompensation,
  applySemanticIntake,
  resolveSemanticDecision,
} from '../src/semanticIntake.js'
import type { PJSDASSnapshot } from '../src/snapshot.js'

function opportunity(id: string, role: string, overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    id,
    company: 'Example Co',
    role,
    currentStageLabel: '笔试',
    processStage: 'written_test',
    roleType: 'core',
    participationStatus: 'active',
    early: false,
    opportunityValue: 80,
    fitScore: 80,
    locallyManaged: true,
    importedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

function process(opportunityId: string, role: string, stage: ProcessRecord['stage'] = 'written_test'): ProcessRecord {
  return {
    id: `process:${opportunityId}`,
    opportunityId,
    company: 'Example Co',
    role,
    stage,
    stageLabel: stage === 'written_test' ? '笔试' : stage === 'interview' ? '面试' : '筛选中',
    lastProgressAt: '2026-09-10T00:00:00.000Z',
    locallyManaged: true,
  }
}

function event(id: string, opportunityId: string, role: string, type: ProcessEvent['type'], dueAt: string): ProcessEvent {
  return {
    id,
    opportunityId,
    company: 'Example Co',
    role,
    type,
    occurredAt: '2026-09-10T00:00:00.000Z',
    dueAt,
    duePrecision: 'datetime',
    timingMode: type === 'assessment_invite' ? 'deadline' : 'fixed',
    estimatedMinutes: 90,
    source: 'manual',
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
  }
}

function actionFor(item: ProcessEvent): Action {
  return {
    id: `event-action:${item.id}`,
    kind: 'manual',
    title: `Complete ${item.type}`,
    opportunityId: item.opportunityId,
    processEventId: item.id,
    processStage: item.type === 'interview_invite' ? 'interview' : item.type === 'assessment_invite' ? 'assessment' : 'written_test',
    dueAt: item.dueAt,
    duePrecision: item.duePrecision,
    timingMode: item.timingMode,
    estimatedMinutes: item.estimatedMinutes ?? 90,
    leverage: 95,
    delayCost: 95,
    status: 'todo',
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }
}

function snapshot(input: {
  opportunities?: Opportunity[]
  processes?: ProcessRecord[]
  events?: ProcessEvent[]
  actions?: Action[]
  applicationGroups?: PJSDASSnapshot['data']['applicationGroups']
} = {}): PJSDASSnapshot {
  const opp = opportunity('opp-1', 'Product Manager')
  const evt = event('written-1', opp.id, opp.role, 'written_test_invite', '2026-09-22T02:00:00.000Z')
  return {
    schema: 'pjsdas-local-snapshot',
    version: 1,
    exportedAt: '2026-09-20T00:00:00.000Z',
    data: {
      opportunities: input.opportunities ?? [opp],
      processes: input.processes ?? [process(opp.id, opp.role)],
      processEvents: input.events ?? [evt],
      actions: input.actions ?? [actionFor(evt)],
      prep: [],
      applicationGroups: input.applicationGroups ?? [],
      timeline: [],
    },
  }
}

function candidate(kind: SemanticCandidate['kind'], overrides: Record<string, unknown> = {}): SemanticCandidate {
  return {
    id: `candidate-${kind}`,
    kind,
    target: { company: 'Example Co', role: 'Product Manager' },
    objectConfidence: 'high',
    eventConfidence: 'high',
    temporalConfidence: 'high',
    evidenceRefs: [],
    sourceVersionRefs: [],
    ...overrides,
  } as SemanticCandidate
}

function observation(candidates: SemanticCandidate[], overrides: Partial<SemanticIntakeObservation> = {}): SemanticIntakeObservation {
  return {
    contractVersion: 1,
    inputId: 'semantic-input-0001',
    source: {
      kind: 'mcp',
      sourceId: 'chatgpt-current',
      sourceRecordId: 'message-1',
      sourceVersion: 'v1',
      observedAt: '2026-09-20T10:00:00.000Z',
      assertedAt: '2026-09-20T10:00:00.000Z',
      timezone: 'Asia/Shanghai',
    },
    statementMode: 'assertion',
    originalText: 'Example Co 笔试做完了',
    candidates,
    ...overrides,
  }
}

describe('UU-02 source-neutral Semantic Intake', () => {
  it('atomically completes one unique written-test occurrence without completing the recruiting process', () => {
    const result = applySemanticIntake(
      snapshot(),
      observation([candidate('occurrence_completed', {
        target: { company: 'Example Co', role: 'Product Manager', occurrenceKind: 'written_test' },
        occurredAt: '2026-09-20T10:00:00.000Z',
      })]),
      { authorized: true, workspaceRevision: 'txn:4', now: new Date('2026-09-20T10:00:00.000Z') },
    )

    expect(result.status).toBe('APPLIED')
    const node = result.snapshot.data.scheduleNodes?.find((item) => item.kind === 'written_test' && item.state !== 'superseded')
    expect(node).toMatchObject({ state: 'completed', completedAt: '2026-09-20T10:00:00.000Z' })
    expect(result.snapshot.data.actions.find((item) => item.processEventId === 'written-1')).toMatchObject({ status: 'done' })
    expect(result.snapshot.data.processes[0]).toMatchObject({
      stage: 'written_test',
      progress: 'waiting_result',
      result: 'pending',
    })
    expect(result.receipt).toMatchObject({ status: 'committed', undoAvailable: true })
    expect(JSON.stringify(result.snapshot)).not.toContain('Example Co 笔试做完了')
  })

  it('creates a DecisionRequest instead of guessing between same-company roles', () => {
    const opportunities = [
      opportunity('opp-growth', 'Product Manager - Growth', { processStage: 'screening', currentStageLabel: '筛选中' }),
      opportunity('opp-platform', 'Product Manager - Platform', { processStage: 'screening', currentStageLabel: '筛选中' }),
    ]
    const base = snapshot({ opportunities, processes: [], events: [], actions: [] })
    const result = applySemanticIntake(
      base,
      observation([candidate('abandon_opportunity', {
        target: { company: 'Example Co' },
      })]),
      { authorized: true, now: new Date('2026-09-20T10:00:00.000Z') },
    )

    expect(result.status).toBe('DECISION_REQUIRED')
    expect(result.decisionRequests).toHaveLength(1)
    expect(result.decisionRequests[0]).toMatchObject({ reason: 'ambiguous_target', state: 'open' })
    expect(result.decisionRequests[0]?.choices).toHaveLength(2)
    expect(result.snapshot.data.opportunities.every((item) => item.participationStatus !== 'abandoned')).toBe(true)
  })

  it('keeps multiple interview rounds distinct and asks which occurrence was completed', () => {
    const opp = opportunity('opp-1', 'Product Manager', { processStage: 'interview', currentStageLabel: '面试' })
    const first = event('interview-1', opp.id, opp.role, 'interview_invite', '2026-09-22T02:00:00.000Z')
    const second = event('interview-2', opp.id, opp.role, 'interview_invite', '2026-09-25T02:00:00.000Z')
    second.occurredAt = '2026-09-21T00:00:00.000Z'
    second.createdAt = second.occurredAt
    second.updatedAt = second.occurredAt
    const result = applySemanticIntake(
      snapshot({
        opportunities: [opp],
        processes: [process(opp.id, opp.role, 'interview')],
        events: [first, second],
        actions: [actionFor(first), actionFor(second)],
      }),
      observation([candidate('occurrence_completed', {
        target: { opportunityId: opp.id, occurrenceKind: 'interview' },
      })]),
      { authorized: true, now: new Date('2026-09-20T10:00:00.000Z') },
    )
    expect(result.status).toBe('DECISION_REQUIRED')
    expect(result.decisionRequests[0]).toMatchObject({ reason: 'ambiguous_occurrence' })
    expect(result.decisionRequests[0]?.choices).toHaveLength(2)
  })

  it.each(['question', 'quote', 'example', 'hypothetical', 'rewrite_request'] as const)(
    'does not write %s text as a business fact',
    (statementMode) => {
      const result = applySemanticIntake(
        snapshot(),
        observation([candidate('abandon_opportunity')], { statementMode }),
        { authorized: true, now: new Date('2026-09-20T10:00:00.000Z') },
      )
      expect(result.status).toBe('NO_WRITE')
      expect(result.changed).toBe(false)
      expect(result.snapshot.data.opportunities[0]?.participationStatus).toBe('active')
    },
  )

  it('auto-commits explicit unique internal abandonment when no shared governance exists', () => {
    const result = applySemanticIntake(
      snapshot(),
      observation([candidate('abandon_opportunity')]),
      { authorized: true, now: new Date('2026-09-20T10:00:00.000Z') },
    )
    expect(result.status).toBe('APPLIED')
    expect(result.snapshot.data.opportunities[0]).toMatchObject({ participationStatus: 'abandoned' })
    expect(result.receipt?.undoAvailable).toBe(true)
  })

  it('routes abandonment through DecisionRequest when shared application governance exists', () => {
    const opp = opportunity('opp-1', 'Product Manager', { applicationGroupId: 'group-1' })
    const result = applySemanticIntake(
      snapshot({
        opportunities: [opp],
        applicationGroups: [{ id: 'group-1', company: 'Example Co', total: 2, remaining: 1, rule: 'Max two roles' }],
      }),
      observation([candidate('abandon_opportunity')]),
      { authorized: true, now: new Date('2026-09-20T10:00:00.000Z') },
    )
    expect(result.status).toBe('DECISION_REQUIRED')
    expect(result.decisionRequests[0]).toMatchObject({ reason: 'shared_governance' })
    expect(result.snapshot.data.opportunities[0]?.participationStatus).toBe('active')
  })

  it('never performs an external withdrawal automatically', () => {
    const result = applySemanticIntake(
      snapshot(),
      observation([candidate('external_withdrawal')]),
      { authorized: true, now: new Date('2026-09-20T10:00:00.000Z') },
    )
    expect(result.status).toBe('DECISION_REQUIRED')
    expect(result.decisionRequests[0]).toMatchObject({ reason: 'external_consequence' })
    expect(result.snapshot.data.opportunities[0]?.processStage).toBe('written_test')
  })

  it('reschedules one occurrence by versioning the same occurrence identity and preserving history', () => {
    const result = applySemanticIntake(
      snapshot(),
      observation([candidate('occurrence_rescheduled', {
        target: { opportunityId: 'opp-1', occurrenceKind: 'written_test' },
        temporal: {
          shape: 'fixed_range',
          precision: 'datetime',
          timezone: 'Asia/Shanghai',
          startAt: '2026-09-23T02:00:00.000Z',
          endAt: '2026-09-23T03:30:00.000Z',
          resolutionBasis: 'source_explicit',
        },
      })]),
      { authorized: true, now: new Date('2026-09-20T10:00:00.000Z') },
    )
    expect(result.status).toBe('APPLIED')
    const nodes = result.snapshot.data.scheduleNodes?.filter((item) => item.occurrenceId === 'process-event:written-1') ?? []
    expect(nodes).toHaveLength(2)
    expect(nodes.find((item) => item.version === 1)).toMatchObject({ state: 'superseded' })
    expect(nodes.find((item) => item.version === 2)).toMatchObject({
      state: 'scheduled',
      temporal: { startAt: '2026-09-23T02:00:00.000Z' },
    })
    expect(result.snapshot.data.processEvents[0]?.dueAt).toBe('2026-09-23T02:00:00.000Z')
  })

  it('deduplicates replay of the same source record/version even when the caller changes inputId', () => {
    const firstObservation = observation([candidate('abandon_opportunity')])
    const first = applySemanticIntake(snapshot(), firstObservation, {
      authorized: true,
      now: new Date('2026-09-20T10:00:00.000Z'),
    })
    const replay = applySemanticIntake(
      first.snapshot,
      { ...firstObservation, inputId: 'semantic-input-0002' },
      { authorized: true, now: new Date('2026-09-20T10:01:00.000Z') },
    )
    expect(replay.status).toBe('ALREADY_APPLIED')
    expect(replay.changed).toBe(false)
    expect(replay.snapshot.data.semanticReceipts).toHaveLength(1)
  })

  it('creates one ReminderIntent from a ScheduleNode and keeps PJSDAS as the single internal delivery owner', () => {
    const result = applySemanticIntake(
      snapshot(),
      observation([candidate('reminder_intent', {
        target: { opportunityId: 'opp-1', occurrenceKind: 'written_test' },
        purpose: 'upcoming',
        offsetMinutesBefore: 30,
        deliveryOwner: 'pjsdas',
        channel: 'in_product',
      })], {
        inputId: 'semantic-reminder-0001',
        statementMode: 'current_intent',
      }),
      { authorized: true, now: new Date('2026-09-20T10:00:00.000Z') },
    )
    expect(result.status).toBe('APPLIED')
    expect(result.snapshot.data.reminderIntents).toHaveLength(1)
    expect(result.snapshot.data.reminderIntents?.[0]).toMatchObject({
      purpose: 'upcoming',
      triggerAt: '2026-09-22T01:30:00.000Z',
      deliveryOwner: 'pjsdas',
      channel: 'in_product',
      state: 'active',
    })
    expect(result.snapshot.data.reminderOutbox).toEqual([])
    expect(result.receipt?.affectedObjects.some((item) => item.type === 'reminder_intent')).toBe(true)
  })

  it('records unsupported external reminder delivery truthfully instead of pretending a Task exists', () => {
    const result = applySemanticIntake(
      snapshot(),
      observation([candidate('reminder_intent', {
        target: { opportunityId: 'opp-1', occurrenceKind: 'written_test' },
        purpose: 'prep',
        offsetMinutesBefore: 120,
        deliveryOwner: 'external_task',
        channel: 'task',
      })], {
        inputId: 'semantic-reminder-0002',
        statementMode: 'current_intent',
      }),
      {
        authorized: true,
        now: new Date('2026-09-20T10:00:00.000Z'),
        externalCapabilities: { chatgpt_tasks: 'unsupported', google_calendar: 'unsupported' },
      },
    )
    expect(result.status).toBe('APPLIED')
    expect(result.snapshot.data.reminderIntents?.[0]).toMatchObject({
      deliveryOwner: 'external_task',
      capability: 'chatgpt_tasks',
      state: 'unsupported',
      externalLink: { capability: 'chatgpt_tasks', state: 'failed', lastErrorCode: 'CAPABILITY_UNSUPPORTED' },
    })
    expect(result.snapshot.data.reminderOutbox?.[0]).toMatchObject({
      capability: 'chatgpt_tasks',
      state: 'unsupported',
      receiptCode: 'CAPABILITY_UNSUPPORTED',
    })
  })

  it('deduplicates the same semantic fact across current-chat MCP and PAIA while retaining both source receipts', () => {
    const first = applySemanticIntake(
      snapshot(),
      observation([candidate('abandon_opportunity')], {
        inputId: 'semantic-cross-source-mcp',
        source: {
          kind: 'mcp',
          sourceId: 'chatgpt-current',
          sourceRecordId: 'message-cross-1',
          sourceVersion: 'v1',
          observedAt: '2026-09-20T10:00:00.000Z',
          assertedAt: '2026-09-20T10:00:00.000Z',
          timezone: 'Asia/Shanghai',
        },
      }),
      { authorized: true, now: new Date('2026-09-20T10:00:00.000Z') },
    )
    const second = applySemanticIntake(
      first.snapshot,
      observation([candidate('abandon_opportunity')], {
        inputId: 'semantic-cross-source-paia',
        source: {
          kind: 'paia',
          sourceId: 'paia:owner-input',
          sourceRecordId: 'input-cross-1',
          sourceVersion: 'v1',
          observedAt: '2026-09-20T10:01:00.000Z',
          assertedAt: '2026-09-20T10:00:00.000Z',
          timezone: 'Asia/Shanghai',
        },
      }),
      { authorized: true, now: new Date('2026-09-20T10:01:00.000Z') },
    )
    expect(second.status).toBe('APPLIED')
    expect(second.snapshot.data.semanticReceipts).toHaveLength(2)
    expect(second.snapshot.data.semanticReceipts?.every((receipt) => receipt.factKeys?.length === 1)).toBe(true)
    expect(second.snapshot.data.timeline?.filter((item) => item.commandOperation === 'abandon_opportunity')).toHaveLength(1)
    expect(second.snapshot.data.opportunities[0]).toMatchObject({ participationStatus: 'abandoned' })
    expect(second.receipt?.undoAvailable).toBe(false)
  })

  it('compensates a latest semantic completion at field/object level', () => {
    const applied = applySemanticIntake(
      snapshot(),
      observation([candidate('occurrence_completed', {
        target: { opportunityId: 'opp-1', occurrenceKind: 'written_test' },
      })]),
      { authorized: true, now: new Date('2026-09-20T10:00:00.000Z') },
    )
    expect(applied.compensation).toBeDefined()
    const undone = applySemanticCompensation(
      applied.snapshot,
      applied.compensation!,
      new Date('2026-09-20T10:02:00.000Z'),
    )
    expect(undone.data.actions.find((item) => item.processEventId === 'written-1')).toMatchObject({ status: 'todo' })
    expect(undone.data.scheduleNodes?.find((item) => item.occurrenceId === 'process-event:written-1')).toMatchObject({ state: 'scheduled' })
    expect(undone.data.semanticReceipts?.[0]).toMatchObject({ status: 'undone', undoAvailable: false })
  })

  it('resolves an ambiguous target through the exact offered DecisionRequest choice', () => {
    const opportunities = [
      opportunity('opp-growth', 'Product Manager - Growth', { processStage: 'screening', currentStageLabel: '筛选中' }),
      opportunity('opp-platform', 'Product Manager - Platform', { processStage: 'screening', currentStageLabel: '筛选中' }),
    ]
    const pending = applySemanticIntake(
      snapshot({ opportunities, processes: [], events: [], actions: [] }),
      observation([candidate('abandon_opportunity', { target: { company: 'Example Co' } })]),
      { authorized: true, now: new Date('2026-09-20T10:00:00.000Z') },
    )
    const request = pending.decisionRequests[0]!
    const choice = request.choices.find((item) => item.resolution?.opportunityId === 'opp-platform')!
    const resolved = resolveSemanticDecision(
      pending.snapshot,
      request.id,
      choice.id,
      new Date('2026-09-20T10:03:00.000Z'),
    )
    expect(resolved.status).toBe('APPLIED')
    expect(resolved.snapshot.data.opportunities.find((item) => item.id === 'opp-platform')).toMatchObject({ participationStatus: 'abandoned' })
    expect(resolved.snapshot.data.opportunities.find((item) => item.id === 'opp-growth')?.participationStatus).not.toBe('abandoned')
    expect(resolved.snapshot.data.decisionRequests?.find((item) => item.id === request.id)).toMatchObject({ state: 'answered' })
  })
})
