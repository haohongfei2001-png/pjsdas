import { describe, expect, it } from 'vitest'
import type {
  Action,
  DecisionRequest,
  Opportunity,
  ProcessEvent,
  ProcessRecord,
  SemanticIntakeReceipt,
} from '../src/model.js'
import { createDefaultDecisionRules } from '../src/decisionRules.js'
import { createSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'
import { buildTodayBrief } from '../src/todayBrief.js'

const NOW = new Date('2026-09-20T12:00:00.000Z')
const TZ = 'Asia/Shanghai'

function opportunity(id: string, role = 'Product Manager', overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    id,
    company: 'Example Co',
    role,
    currentStageLabel: '待投',
    processStage: 'not_applied',
    roleType: 'core',
    participationStatus: 'active',
    early: false,
    opportunityValue: 80,
    fitScore: 80,
    importedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

function process(opp: Opportunity, stage: ProcessRecord['stage']): ProcessRecord {
  return {
    id: `process:${opp.id}`,
    opportunityId: opp.id,
    company: opp.company,
    role: opp.role,
    stage,
    stageLabel: stage === 'interview' ? '面试' : stage === 'written_test' ? '笔试' : '筛选中',
    lastProgressAt: '2026-09-19T00:00:00.000Z',
  }
}

function applyAction(opp: Opportunity, dueAt?: string, estimatedMinutes = 45, duePrecision: Action['duePrecision'] = 'datetime'): Action {
  return {
    id: `apply:${opp.id}`,
    kind: 'apply',
    title: `投递 ${opp.company}｜${opp.role}`,
    opportunityId: opp.id,
    processStage: 'not_applied',
    dueAt,
    duePrecision,
    timingMode: dueAt ? 'deadline' : undefined,
    estimatedMinutes,
    leverage: 80,
    delayCost: 80,
    status: 'todo',
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
  }
}

function manualAction(id = 'manual-1', overrides: Partial<Action> = {}): Action {
  return {
    id,
    kind: 'manual',
    title: '整理面试材料',
    estimatedMinutes: 20,
    leverage: 98,
    delayCost: 90,
    status: 'todo',
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    ...overrides,
  }
}

function processEvent(
  opp: Opportunity,
  id: string,
  type: ProcessEvent['type'],
  dueAt: string,
  timingMode: ProcessEvent['timingMode'] = 'fixed',
): ProcessEvent {
  return {
    id,
    opportunityId: opp.id,
    company: opp.company,
    role: opp.role,
    type,
    occurredAt: '2026-09-19T00:00:00.000Z',
    dueAt,
    duePrecision: 'datetime',
    timingMode,
    estimatedMinutes: 60,
    source: 'manual',
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
  }
}

function snapshot(input: {
  opportunities?: Opportunity[]
  processes?: ProcessRecord[]
  events?: ProcessEvent[]
  actions?: Action[]
  decisions?: DecisionRequest[]
  receipts?: SemanticIntakeReceipt[]
} = {}): PJSDASSnapshot {
  return createSnapshot({
    opportunities: input.opportunities ?? [],
    processes: input.processes ?? [],
    processEvents: input.events ?? [],
    actions: input.actions ?? [],
    prep: [],
    applicationGroups: [],
    decisionRules: createDefaultDecisionRules('2026-09-19T12:00:00.000Z'),
    decisionRequests: input.decisions ?? [],
    semanticReceipts: input.receipts ?? [],
    timeline: [],
    changeSets: [],
  }, '2026-09-20T11:59:00.000Z')
}

function decision(opportunityId: string, expiresAt?: string): DecisionRequest {
  return {
    id: 'decision-1',
    reason: 'ambiguous_target',
    affectedObjects: [{ type: 'opportunity', id: opportunityId }],
    question: 'Which role did you mean?',
    choices: [
      {
        id: 'a',
        label: 'This role',
        consequence: 'Update this role only.',
        resolution: { opportunityId },
      },
      {
        id: 'b',
        label: 'Do nothing',
        consequence: 'Keep current state.',
        resolution: { dismiss: true },
      },
    ],
    evidenceRefs: ['mcp:chat:1'],
    payloadBinding: {
      contractVersion: 1,
      inputId: 'semantic-input-1',
      candidateId: 'candidate-1',
      source: {
        kind: 'mcp',
        sourceId: 'chatgpt-current',
        sourceRecordId: 'message-1',
        observedAt: '2026-09-20T11:00:00.000Z',
        timezone: TZ,
      },
      statementMode: 'assertion',
      candidate: {
        id: 'candidate-1',
        kind: 'abandon_opportunity',
        target: { opportunityId },
        objectConfidence: 'high',
        eventConfidence: 'high',
        evidenceRefs: [],
        sourceVersionRefs: [],
      },
    },
    expiresAt,
    state: 'open',
    createdAt: '2026-09-20T11:00:00.000Z',
    updatedAt: '2026-09-20T11:00:00.000Z',
  }
}

describe('UU-03 TodayBrief read model', () => {
  it('binds output to workspace revision, clock, timezone and rules version without mutating the snapshot', () => {
    const opp = opportunity('opp-1')
    const source = snapshot({ opportunities: [opp], actions: [applyAction(opp, '2026-09-21T12:00:00.000Z')] })
    const before = JSON.stringify(source)
    const brief = buildTodayBrief(source, { availableMinutes: 120 }, {
      now: NOW,
      timezone: TZ,
      workspaceVersion: 'txn:42',
    })

    expect(brief).toMatchObject({
      contractVersion: 1,
      workspaceRevision: 'txn:42',
      evaluatedAt: NOW.toISOString(),
      displayTimezone: TZ,
      availableMinutes: 120,
      rules: { version: 1, updatedAt: '2026-09-19T12:00:00.000Z' },
    })
    expect(JSON.stringify(source)).toBe(before)
  })

  it('keeps a future fixed interview out of nextAction while showing it in tomorrow agenda', () => {
    const opp = opportunity('opp-1', 'Product Manager', { processStage: 'interview', currentStageLabel: '面试' })
    const interview = processEvent(opp, 'interview-1', 'interview_invite', '2026-09-21T02:00:00.000Z')
    const brief = buildTodayBrief(
      snapshot({
        opportunities: [opp],
        processes: [process(opp, 'interview')],
        events: [interview],
        actions: [manualAction()],
      }),
      {},
      { now: NOW, timezone: TZ, workspaceVersion: 'txn:2' },
    )

    expect(brief.nextAction?.actionId).toBe('manual-1')
    expect(brief.nextAction?.actionId).not.toContain('interview-1')
    const tomorrow = brief.agendaGroups.find((group) => group.relation === 'tomorrow')
    expect(tomorrow?.nodes[0]).toMatchObject({
      occurrenceId: 'process-event:interview-1',
      kind: 'interview',
      within48Hours: true,
      state: 'scheduled',
    })
  })

  it('can stay quiet when the only work is a future fixed recruiting event', () => {
    const opp = opportunity('opp-1', 'Product Manager', { processStage: 'interview', currentStageLabel: '面试' })
    const interview = processEvent(opp, 'interview-1', 'interview_invite', '2026-09-21T02:00:00.000Z')
    const brief = buildTodayBrief(
      snapshot({
        opportunities: [opp],
        processes: [process(opp, 'interview')],
        events: [interview],
      }),
      {},
      { now: NOW, timezone: TZ },
    )
    expect(brief.nextAction).toBeUndefined()
    expect(brief.agendaGroups.flatMap((group) => group.nodes).some((node) => node.occurrenceId === 'process-event:interview-1')).toBe(true)
  })

  it('preserves date-only agenda precision and never fabricates a clock time', () => {
    const opp = opportunity('opp-date', 'Strategy', {
      deadline: '2026-09-22T23:59:59.000Z',
      deadlinePrecision: 'date',
    })
    const brief = buildTodayBrief(
      snapshot({
        opportunities: [opp],
        actions: [applyAction(opp, '2026-09-22T23:59:59.000Z', 45, 'date')],
      }),
      {},
      { now: NOW, timezone: TZ },
    )
    const node = brief.agendaGroups.flatMap((group) => group.nodes)
      .find((item) => item.kind === 'application_deadline')
    expect(node?.temporal).toMatchObject({
      shape: 'date_only',
      precision: 'date',
      date: '2026-09-22',
    })
    expect(node?.temporal.startAt).toBeUndefined()
    expect(node?.temporal.deadlineAt).toBeUndefined()
    expect(brief.nextAction?.timing).toMatchObject({ latestStartDate: '2026-09-22' })
    expect(brief.nextAction?.timing?.latestStartAt).toBeUndefined()
  })

  it('uses an employer explicit latest-start instead of deriving it from the window end', () => {
    const opp = opportunity('opp-written', 'Graduate Program', { processStage: 'written_test', currentStageLabel: '笔试' })
    const written = processEvent(opp, 'written-window', 'written_test_invite', '2026-09-23T10:00:00.000Z')
    written.temporal = {
      shape: 'availability_window',
      precision: 'datetime',
      timezone: TZ,
      startAt: '2026-09-23T18:00:00+08:00',
      endAt: '2026-09-23T20:00:00+08:00',
      latestStartAt: '2026-09-23T18:20:00+08:00',
      resolutionBasis: 'source_explicit',
    }
    const action: Action = {
      ...manualAction('written-window-action'),
      opportunityId: opp.id,
      processEventId: written.id,
      processStage: 'written_test',
      dueAt: written.dueAt,
      duePrecision: 'datetime',
      timingMode: 'fixed',
      estimatedMinutes: 90,
    }
    const brief = buildTodayBrief(snapshot({
      opportunities: [opp],
      processes: [process(opp, 'written_test')],
      events: [written],
      actions: [action],
    }), {}, { now: new Date('2026-09-23T09:30:00.000Z'), timezone: TZ })
    const timing = brief.nextAction?.actionId === action.id
      ? brief.nextAction.timing
      : brief.nextActions.find((item) => item.actionId === action.id)?.timing
    expect(timing).toMatchObject({
      shape: 'availability_window',
      startAt: '2026-09-23T18:00:00+08:00',
      endAt: '2026-09-23T20:00:00+08:00',
      latestStartAt: '2026-09-23T18:20:00+08:00',
    })
  })

  it('protects a long hard-deadline task when latest-start enters 48h even if the raw deadline is still outside 48h', () => {
    const opp = opportunity('opp-latest', 'Product Manager', {
      deadline: '2026-09-22T14:00:00.000Z',
      deadlinePrecision: 'datetime',
    })
    const apply = applyAction(opp, '2026-09-22T14:00:00.000Z', 180)
    const brief = buildTodayBrief(
      snapshot({
        opportunities: [opp],
        actions: [
          manualAction('manual-high', { title: '短任务', leverage: 100, delayCost: 100, estimatedMinutes: 10 }),
          apply,
        ],
      }),
      { availableMinutes: 60 },
      { now: NOW, timezone: TZ },
    )
    expect(new Date(opp.deadline!).getTime() - NOW.getTime()).toBe(50 * 60 * 60 * 1000)
    expect(brief.nextAction).toMatchObject({
      actionId: apply.id,
      protectedByLatestStart: true,
      timing: { latestStartAt: '2026-09-22T11:00:00.000Z' },
    })
    expect(brief.materialCoverageWarnings.find((item) => item.code === 'capacity_conflict')).toBeTruthy()
    expect(brief.materialCoverageWarnings.find((item) => item.code === 'hard_deadline_unplanned')?.relatedIds).toContain(apply.id)
  })

  it('projects elapsed recruiting nodes as unresolved recovery instead of completing them', () => {
    const opp = opportunity('opp-old', 'Product Manager', { processStage: 'written_test', currentStageLabel: '笔试' })
    const written = processEvent(opp, 'written-old', 'written_test_invite', '2026-09-20T10:00:00.000Z')
    const brief = buildTodayBrief(
      snapshot({
        opportunities: [opp],
        processes: [process(opp, 'written_test')],
        events: [written],
      }),
      {},
      { now: NOW, timezone: TZ },
    )
    const unresolved = brief.agendaGroups.find((group) => group.relation === 'unresolved')
    expect(unresolved?.nodes[0]).toMatchObject({
      occurrenceId: 'process-event:written-old',
      state: 'elapsed_unresolved',
      requiresResolution: true,
    })
    expect(brief.nextAction).toBeUndefined()
  })

  it('surfaces relevant open DecisionRequests and excludes expired ones', () => {
    const opp = opportunity('opp-decision')
    const source = snapshot({
      opportunities: [opp],
      actions: [applyAction(opp, '2026-09-21T12:00:00.000Z')],
      decisions: [
        decision(opp.id, '2026-09-21T00:00:00.000Z'),
        { ...decision(opp.id, '2026-09-20T11:00:00.000Z'), id: 'decision-expired' },
      ],
    })
    const brief = buildTodayBrief(source, {}, { now: NOW, timezone: TZ })
    expect(brief.relevantDecisionRequests.map((item) => item.id)).toContain('decision-1')
    expect(brief.relevantDecisionRequests.map((item) => item.id)).not.toContain('decision-expired')
  })

  it('projects at most three meaningful semantic receipts newest-first without exposing no-write noise', () => {
    const receipt = (id: string, status: SemanticIntakeReceipt['status'], updatedAt: string): SemanticIntakeReceipt => ({
      id,
      inputId: `input:${id}`,
      sourceKind: 'web',
      sourceId: 'todayaction-web',
      sourceRecordId: `record:${id}`,
      status,
      summary: `summary ${id}`,
      affectedObjects: status === 'no_write' ? [] : [{ type: 'action', id: `action:${id}` }],
      decisionRequestIds: status === 'decision_required' ? [`decision:${id}`] : [],
      undoAvailable: status === 'committed',
      createdAt: updatedAt,
      updatedAt,
    })
    const brief = buildTodayBrief(snapshot({
      receipts: [
        receipt('old', 'committed', '2026-09-20T08:00:00.000Z'),
        receipt('decision', 'decision_required', '2026-09-20T09:00:00.000Z'),
        receipt('noise', 'no_write', '2026-09-20T12:00:00.000Z'),
        receipt('undone', 'undone', '2026-09-20T10:00:00.000Z'),
        receipt('new', 'committed', '2026-09-20T11:00:00.000Z'),
      ],
    }), {}, { now: NOW, timezone: TZ })

    expect(brief.recentChanges.map((item) => item.id)).toEqual(['new', 'undone', 'decision'])
    expect(brief.recentChanges.find((item) => item.id === 'new')).toMatchObject({
      affectedObjectCount: 1,
      decisionRequestCount: 0,
      undoAvailable: true,
    })
    expect(brief.recentChanges.some((item) => item.id === 'noise')).toBe(false)
  })

  it('reports material source-coverage gaps without turning them into DecisionRequests', () => {
    const brief = buildTodayBrief(snapshot(), {}, { now: NOW, timezone: TZ })
    expect(brief.materialCoverageWarnings.some((item) => item.code === 'coverage_missing_sources')).toBe(true)
    expect(brief.relevantDecisionRequests).toHaveLength(0)
    expect(brief.internalDiagnostics.coverage.missingSourceCount).toBeGreaterThan(0)
  })

  it('uses a seven-calendar-day agenda window and stable deterministic ordering', () => {
    const inside = opportunity('opp-inside', 'Inside', {
      deadline: '2026-09-26T23:59:59.000Z',
      deadlinePrecision: 'date',
    })
    const outside = opportunity('opp-outside', 'Outside', {
      deadline: '2026-09-27T23:59:59.000Z',
      deadlinePrecision: 'date',
    })
    const source = snapshot({
      opportunities: [inside, outside],
      actions: [
        applyAction(inside, inside.deadline, 45, 'date'),
        applyAction(outside, outside.deadline, 45, 'date'),
      ],
    })
    const a = buildTodayBrief(source, {}, { now: NOW, timezone: TZ, workspaceVersion: 'txn:7' })
    const b = buildTodayBrief(source, {}, { now: NOW, timezone: TZ, workspaceVersion: 'txn:7' })
    const ids = a.agendaGroups.flatMap((group) => group.nodes.map((node) => node.opportunityId))
    expect(ids).toContain('opp-inside')
    expect(ids).not.toContain('opp-outside')
    expect(a).toEqual(b)
  })

  it('keeps nextActions sparse at no more than three after the primary action', () => {
    const actions = Array.from({ length: 8 }, (_, index) => manualAction(`manual-${index}`, {
      title: `Task ${index}`,
      leverage: 90 - index,
    }))
    const brief = buildTodayBrief(snapshot({ actions }), { availableMinutes: 300 }, { now: NOW, timezone: TZ })
    expect(brief.nextAction).toBeTruthy()
    expect(brief.nextActions.length).toBeLessThanOrEqual(3)
  })
})
