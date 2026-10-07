import { legacyDeadlineNode } from './fixtures/legacyDeadlineNodes.js'
import { localDateKey } from '../src/todayBrief.js'
import { describe, expect, it } from 'vitest'
import { formatScheduleTemporal } from '../src/scheduleDisplayTime.js'
import { actionDeadline, actionNodesById, compareDeadlines } from '../src/deadlineOrder.js'
import { rankActions } from '../src/decisionV3.js'
import { buildConsumerTimePlan } from '../src/today/consumerTimePlan.js'
import { selectTodayWeb } from '../src/today/todayWebSelector.js'
import { buildTodayBrief } from '../src/todayBrief.js'
import { getTodayPlan, listOpportunities } from '../src/ai/readLayer.js'
import { resolveApplicationDeadline, applicationDeadlineExpired } from '../src/applicationDeadline.js'
import { buildOpportunityDecisionList } from '../src/opportunityDecisionRead.js'
import { createSnapshot, parseSnapshotText, upgradeSnapshotToLatest } from '../src/snapshot.js'
import { cloneDecisionRules } from '../src/decisionRules.js'
import type { Action, Opportunity, ScheduleNode } from '../src/model.js'

const now = new Date('2026-10-07T08:00:00Z')
const context = { now, timezone: 'UTC', workspaceVersion: 'txn:deadline-only' }
const makeOpportunity = (id: string, deadline?: string, high = false): Opportunity => ({
  id, company: id, role: 'Role', roleType: high ? 'core' : 'practice',
  processStage: 'not_applied', currentStageLabel: '待投', deadline,
  deadlinePrecision: deadline && /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? 'date' : 'datetime',
  opportunityValue: high ? 100 : 0, fitScore: high ? 100 : 0, early: high,
  sourceStatus: 'active', createdAt: now.toISOString(), updatedAt: now.toISOString(),
} as Opportunity)
const makeAction = (opportunity: Opportunity, minutes = 10): Action => ({
  id: `apply:${opportunity.id}`, opportunityId: opportunity.id, kind: 'apply', title: opportunity.id,
  status: 'todo', plannedDate: '2026-10-07', dueAt: opportunity.deadline, duePrecision: opportunity.deadlinePrecision,
  timingMode: 'deadline', estimatedMinutes: minutes,
  leverage: opportunity.fitScore, delayCost: opportunity.opportunityValue,
  createdAt: now.toISOString(), updatedAt: now.toISOString(),
})
function snapshot(opportunities: Opportunity[], nodes: ScheduleNode[] = []) {
  return createSnapshot({ opportunities, actions: opportunities.map(item => makeAction(item)),
    processes: [], processEvents: [], prep: [], applicationGroups: [], scheduleNodes: nodes.length ? nodes : opportunities.filter(item => item.deadline).map(item => legacyDeadlineNode(item, opportunities.map(job => makeAction(job)))),
    decisionRules: cloneDecisionRules(), timePlanning: { version: 1, dateOverrides: { '2026-10-07': 120 }, updatedAt: now.toISOString() },
  }, now.toISOString())
}

describe('Deadline-only product policy', () => {
  it('uses actual dates only, unknown last, deterministic ties and no date-only invented timestamps', () => {
    const items = [ { id: 'unknown' }, { id: 'z', deadline: '2026-10-07', precision: 'date' as const },
      { id: 'a', deadline: '2026-10-07', precision: 'date' as const },
      { id: 'later', deadline: '2026-10-09' }, { id: 'invalid', deadline: 'invalid' } ]
    const original = structuredClone(items)
    expect([...items].sort((a, b) => compareDeadlines(a, b)).map(item => item.id)).toEqual(['a', 'z', 'later', 'invalid', 'unknown'])
    expect(items).toEqual(original)
  })
  it('gives Website, brief, plan and jobs the same chronological result despite extreme legacy scores', () => {
    const source = snapshot([makeOpportunity('unknown', undefined, true), makeOpportunity('later', '2026-10-09', true), makeOpportunity('sooner', '2026-10-08', false)])
    const before = JSON.stringify(source)
    const expected = ['apply:sooner', 'apply:later', 'apply:unknown']
    const web = selectTodayWeb(source, {}, context)
    const brief = buildTodayBrief(source, {}, context)
    const plan = getTodayPlan(source, {}, context)
    expect(web.actions.map(item => item.actionId)).toEqual(expected)
    expect([brief.nextAction, ...brief.nextActions].filter(Boolean).map(item => item!.actionId)).toEqual(expected)
    expect(plan.startableActions.map(item => item.actionId)).toEqual(expected)
    expect(buildOpportunityDecisionList(source, context).all.map(item => item.opportunityId)).toEqual(['sooner', 'later', 'unknown'])
    expect(listOpportunities(source, {}, context).opportunities.map(item => item.opportunityId)).toEqual(['sooner', 'later', 'unknown'])
    expect(JSON.stringify(brief)).not.toMatch(/"(?:score|fitScore|opportunityValue|weights|breakdown)"/)
    expect(brief).toMatchObject({ contractVersion: 2, ordering: 'deadline_ascending', availableMinutes: 120 })
    expect(JSON.stringify(source)).toBe(before)
  })
  it('does not re-enable ranking when old snapshots carry changed weights or high role tags', () => {
    const source = snapshot([makeOpportunity('b', '2026-10-08', true), makeOpportunity('a', '2026-10-08', false)])
    source.data.decisionRules!.weights = { fit: 100, opportunity: 100, urgency: 0, stage: 0, leverage: 100, delayCost: 100, timeEfficiency: 100 }
    const restored = parseSnapshotText(JSON.stringify(source))
    const ranked = rankActions(restored.data.actions, restored.data.opportunities, now, restored.data.decisionRules, 'UTC', restored.data.scheduleNodes)
    expect(ranked.map(item => item.action.id)).toEqual(['apply:a', 'apply:b'])
    expect(ranked.every(item => !('score' in item) && !('breakdown' in item))).toBe(true)
    expect(restored.data.opportunities.find(item => item.id === 'b')?.fitScore).toBe(100)
  })
  it('keeps earliest feasible deadline when capacity cannot hold everything; no score/doing bonus', () => {
    const source = snapshot([makeOpportunity('later-high', '2026-10-07T11:00:00Z', true), makeOpportunity('first-low', '2026-10-07T10:00:00Z', false)])
    source.data.actions.forEach(item => { item.estimatedMinutes = 60 })
    source.data.actions[0].status = 'doing'
    const selected = selectTodayWeb(source, { availableMinutes: 60 }, context)
    expect(selected.actions.map(item => item.actionId)).toEqual(['apply:first-low'])
    expect(selected.notSelectedHardActions.map(item => item.actionId)).toEqual(['apply:later-high'])
    expect(source.data.actions[0].status).toBe('doing')
  })
  it('retains expired unsubmitted and unknown jobs without closing or applying them', () => {
    const expired = makeOpportunity('expired', '2026-10-06', true)
    const source = snapshot([expired, makeOpportunity('unknown')])
    const before = JSON.stringify(source)
    expect(selectTodayWeb(source, {}, context).actions.map(item => item.actionId)).not.toContain('apply:expired')
    expect(buildOpportunityDecisionList(source, context).all.map(item => item.opportunityId)).toContain('expired')
    expect(source.data.opportunities.find(item => item.id === 'expired')?.processStage).toBe('not_applied')
    expect(JSON.stringify(source)).toBe(before)
  })
  it('never replaces a fixed appointment time with the old application deadline', () => {
    const opp = makeOpportunity('interview', '2026-10-01', true)
    opp.processStage = 'interview'
    const fixed: Action = { ...makeAction(opp), id: 'event-action:interview-event', kind: 'manual', processEventId: 'interview-event', duePrecision: 'datetime', timingMode: 'fixed', dueAt: '2026-10-07T12:00:00Z' }
    const source = snapshot([opp]); source.data.actions = [fixed]
    source.data.processEvents = [{ id: 'interview-event', opportunityId: opp.id, company: opp.company, role: opp.role, type: 'interview_invite', occurredAt: now.toISOString(), dueAt: fixed.dueAt, duePrecision: 'datetime', timingMode: 'fixed', estimatedMinutes: 60, source: 'manual', createdAt: now.toISOString(), updatedAt: now.toISOString() }]
    expect(selectTodayWeb(source, {}, context).actions).toEqual([])
    expect(rankActions([fixed], [opp], now, undefined, 'UTC')[0]?.action.dueAt).toBe('2026-10-07T12:00:00Z')
    expect(opp.deadline).toBe('2026-10-01')
  })
  it('never turns an estimated date into a real deadline or capacity conflict', () => {
    const action = makeAction(makeOpportunity('estimated', '2026-10-07'))
    const node: ScheduleNode = { id: 'estimate-node', occurrenceId: 'estimate', version: 1,
      kind: 'application_deadline', state: 'scheduled', constraintKind: 'employer_hard',
      temporal: { shape: 'estimated_date', precision: 'date', timezone: 'UTC', date: '2026-10-07', resolutionBasis: 'system_estimate' },
      evidenceRefs: [], sourceVersionRefs: [], relatedActionIds: [action.id], relatedPrepIds: [], createdAt: now.toISOString(), updatedAt: now.toISOString() }
    expect(actionDeadline(action, node).deadline).toBeUndefined()
    const ranked = rankActions([action], [], now, undefined, 'UTC', [node])
    const plan = buildConsumerTimePlan({ ranked, nodes: [node], availableMinutes: 0, useRemainingDayDefault: true, now, timezone: 'UTC' })
    expect(plan.planned).toEqual([])
    expect(plan.deferredHard).toEqual([])
    expect(plan.conflicts).toEqual([])
    expect(node.temporal.date).toBe('2026-10-07')
  })

  it('uses the display timezone when a date-only application has already expired locally', () => {
    const source = snapshot([makeOpportunity('local-yesterday', '2026-10-07')])
    const read = buildOpportunityDecisionList(source, { now: new Date('2026-10-07T17:00:00Z'), timezone: 'Asia/Shanghai' })
    expect(read.all[0]?.conclusion).toBe('application_window_closed')
    expect(read.all[0]?.nextAction).toBeUndefined()
    expect(source.data.opportunities[0].processStage).toBe('not_applied')
  })

  it.each([
    ['Asia/Shanghai', 'America/Los_Angeles', '2026-10-07T17:00:00Z', true],
    ['America/Los_Angeles', 'Asia/Shanghai', '2026-10-08T01:00:00Z', false],
  ])('honors date-only source timezone %s even when displayed in %s', (sourceZone, displayZone, instant, expired) => {
    const source = snapshot([makeOpportunity('zoned', '2026-10-07')])
    const node = source.data.scheduleNodes!.find(item => item.kind === 'application_deadline')!
    node.temporal.timezone = sourceZone; node.temporal.resolutionBasis = 'source_explicit'
    const at = new Date(instant)
    source.data.actions[0].plannedDate = localDateKey(at, displayZone)
    const resolved = resolveApplicationDeadline(source.data.opportunities[0], source.data)
    expect(applicationDeadlineExpired(resolved, at, displayZone)).toBe(expired)
    const selected = selectTodayWeb(source, { availableMinutes: 30 }, { now: at, timezone: displayZone })
    expect(selected.actions.map(item => item.actionId)).toEqual(expired ? [] : ['apply:zoned'])
    if (!expired) expect(selected.actions[0].timing).toMatchObject({ date: '2026-10-07', precision: 'date', timezone: sourceZone })
    expect(source.data.scheduleNodes![0].temporal.deadlineAt).toBeUndefined()
  })
  it('does not expose a predicted date or latest-start as an actual action deadline', () => {
    const source = snapshot([makeOpportunity('estimated-visible', '2026-10-07')])
    const node = source.data.scheduleNodes!.find(item => item.kind === 'application_deadline')!
    node.temporal.shape = 'estimated_date'; node.temporal.resolutionBasis = 'system_estimate'
    const selected = selectTodayWeb(source, { availableMinutes: 30 }, context)
    expect(selected.actions[0].timing).toBeUndefined()
    expect(selected.actions[0].whyNow).toEqual(['截止日期未明确，排在已知截止之后'])
    expect(selected.actions[0].protectedByLatestStart).toBe(false)
    expect(resolveApplicationDeadline(source.data.opportunities[0], source.data).state).toBe('unknown')
    expect(node.temporal.date).toBe('2026-10-07')
    expect(formatScheduleTemporal(node.temporal, true, 'UTC')).toBe('预计 2026-10-07（待确认）')
    node.temporal.date = '2026-10-06'
    const read = buildOpportunityDecisionList(source, context).all[0]
    expect(read.conclusion).toBe('worth_pursuing')
    expect(read.nextAction?.dueAt).toBeUndefined()
  })
  it('does not charge past fixed appointments against the remaining-day brief', () => {
    const source = snapshot([])
    source.data.actions = [{ ...makeAction(makeOpportunity('manual')), id: 'manual', opportunityId: undefined, kind: 'manual', estimatedMinutes: 30 }]
    source.data.scheduleNodes = [{ id: 'morning', occurrenceId: 'morning', version: 1, kind: 'interview', state: 'scheduled', constraintKind: 'employer_hard',
      temporal: { shape: 'fixed_range', precision: 'datetime', timezone: 'UTC', startAt: '2026-10-07T09:00:00Z', endAt: '2026-10-07T10:00:00Z', resolutionBasis: 'source_explicit' },
      evidenceRefs: [], sourceVersionRefs: [], relatedActionIds: [], relatedPrepIds: [], createdAt: now.toISOString(), updatedAt: now.toISOString() }]
    const at = { now: new Date('2026-10-07T12:00:00Z'), timezone: 'UTC' }
    const brief = buildTodayBrief(source, { availableMinutes: 30 }, at)
    expect(brief.plannedMinutes).toBe(30)
    expect(brief.nextAction?.actionId).toBe('manual')
    expect(brief.materialCoverageWarnings.filter(item => item.code === 'capacity_conflict')).toEqual([])
    expect(getTodayPlan(source, { availableMinutes: 30 }, at).plannedMinutes).toBe(30)
  })

  it.each(['cancelled', 'superseded'] as const)('never revives a %s canonical deadline for capacity, ordering or display', (state) => {
    const source = snapshot([])
    const withdrawn = { ...makeAction(makeOpportunity('withdrawn', '2026-10-07T09:00:00Z'), 30), id: 'withdrawn', kind: 'manual' as const, opportunityId: undefined }
    const real = { ...withdrawn, id: 'real', dueAt: '2026-10-07T10:00:00Z' }
    source.data.actions = [withdrawn, real]
    const tombstone: ScheduleNode = { id: 'withdrawn-v2', occurrenceId: 'withdrawn', version: 2, kind: 'assessment', state, constraintKind: 'employer_hard',
      temporal: { shape: 'deadline', precision: 'datetime', timezone: 'UTC', deadlineAt: withdrawn.dueAt, latestStartAt: '2026-10-07T08:30:00Z', resolutionBasis: 'source_explicit' },
      relatedActionIds: [withdrawn.id], relatedPrepIds: [], evidenceRefs: [], sourceVersionRefs: [], createdAt: now.toISOString(), updatedAt: now.toISOString() }
    source.data.scheduleNodes = [{ ...tombstone, id: 'withdrawn-v1', version: 1, state: 'scheduled' }, tombstone]
    const before = JSON.stringify(source)
    expect(actionNodesById(source.data.scheduleNodes).get('withdrawn')?.id).toBe('withdrawn-v2')
    expect(rankActions(source.data.actions, [], now, undefined, 'UTC', source.data.scheduleNodes).map(item => item.action.id)).toEqual(['real', 'withdrawn'])
    expect(selectTodayWeb(source, { availableMinutes: 30 }, context).actions.map(item => item.actionId)).toEqual(['real'])
    expect(buildTodayBrief(source, { availableMinutes: 30 }, context).nextAction?.actionId).toBe('real')
    expect(getTodayPlan(source, { availableMinutes: 30 }, context).startableActions.map(item => item.actionId)).toEqual(['real'])
    const web = selectTodayWeb(source, { availableMinutes: 60 }, context).actions.find(item => item.actionId === 'withdrawn')!
    const brief = buildTodayBrief(source, { availableMinutes: 60 }, context).nextActions.find(item => item.actionId === 'withdrawn')!
    const plan = getTodayPlan(source, { availableMinutes: 60 }, context).startableActions.find(item => item.actionId === 'withdrawn')!
    expect(web.timing).toBeUndefined(); expect(brief.timing).toBeUndefined(); expect(plan.dueAt).toBeUndefined()
    expect(web.protectedByLatestStart).toBe(false); expect(brief.protectedByLatestStart).toBe(false)
    expect(web.whyNow).toEqual(['截止日期未明确，排在已知截止之后'])
    expect(brief.whyNow).toEqual(web.whyNow); expect(plan.rationale).toEqual(web.whyNow)
    expect(JSON.stringify(source)).toBe(before)
    const live = { ...tombstone, id: 'independent-live', occurrenceId: 'independent', version: 1, state: 'scheduled' as const }
    expect(actionNodesById([...source.data.scheduleNodes, live]).get('withdrawn')?.id).toBe(live.id)
  })
  it.each(['estimated_date', 'cancelled', 'superseded'] as const)('does not filter or require recovery for a %s process date retained in raw history', (mode) => {
    const opp = makeOpportunity('assessment', '2026-10-06T10:00:00Z'); opp.processStage = 'assessment'
    const source = snapshot([opp])
    const action: Action = { ...makeAction(opp), id: 'event-action:event-assessment', kind: 'manual', opportunityId: undefined,
      processEventId: 'event-assessment', processStage: 'assessment' }
    source.data.actions = [action]
    source.data.processEvents = [{ id: 'event-assessment', opportunityId: opp.id, company: opp.company, role: opp.role, type: 'assessment_invite', occurredAt: now.toISOString(), dueAt: action.dueAt, duePrecision: 'datetime', timingMode: 'deadline', estimatedMinutes: 10, source: 'manual', createdAt: now.toISOString(), updatedAt: now.toISOString() }]
    source.data.scheduleNodes = [{ id: 'assessment-node', occurrenceId: 'assessment-node', version: 1, kind: 'assessment', processEventId: 'event-assessment', opportunityId: opp.id,
      state: mode === 'estimated_date' ? 'scheduled' : mode, constraintKind: 'employer_hard',
      temporal: { shape: mode === 'estimated_date' ? mode : 'deadline', precision: 'date', timezone: 'UTC', date: '2026-10-06', resolutionBasis: mode === 'estimated_date' ? 'system_estimate' : 'source_explicit' },
      relatedActionIds: [action.id], relatedPrepIds: [], evidenceRefs: [], sourceVersionRefs: [], createdAt: now.toISOString(), updatedAt: now.toISOString() }]
    const before = JSON.stringify(source)
    expect(rankActions([action], [], now, undefined, 'UTC', source.data.scheduleNodes).map(item => item.action.id)).toEqual(['event-action:event-assessment'])
    expect(selectTodayWeb(source, { availableMinutes: 30 }, context).actions[0]).toMatchObject({ actionId: 'event-action:event-assessment', protectedByLatestStart: false })
    expect(buildTodayBrief(source, { availableMinutes: 30 }, context).nextAction?.actionId).toBe('event-action:event-assessment')
    const plan = getTodayPlan(source, { availableMinutes: 30 }, context)
    expect(plan.startableActions.map(item => item.actionId)).toEqual(['event-action:event-assessment'])
    expect(plan.startableActions[0].dueAt).toBeUndefined()
    expect(plan.blockedOrRecoveryItems).toEqual([])
    expect(JSON.stringify(source)).toBe(before)
  })

  it.each([
    ['process', 'cancelled'], ['process', 'superseded'], ['process', 'estimated_date'],
    ['application', 'cancelled'], ['application', 'superseded'], ['application', 'estimated_date'],
  ] as const)('recognizes a %s owner with no action links when its time is %s', (owner, mode) => {
    const opp = makeOpportunity('owner', '2026-10-07T09:00:00Z')
    if (owner === 'process') opp.processStage = 'assessment'
    const source = snapshot([opp])
    const owned: Action = { ...makeAction(opp, 30), id: owner === 'process' ? 'event-action:owned-event' : 'apply:owner',
      kind: owner === 'process' ? 'manual' : 'apply', processEventId: owner === 'process' ? 'owned-event' : undefined }
    const real: Action = { ...makeAction(makeOpportunity('real', '2026-10-07T10:00:00Z'), 30), id: 'real', opportunityId: undefined, kind: 'manual' }
    source.data.actions = [owned, real]
    if (owner === 'process') source.data.processEvents = [{ id: 'owned-event', opportunityId: opp.id, company: opp.company, role: opp.role, type: 'assessment_invite',
      occurredAt: now.toISOString(), dueAt: owned.dueAt, duePrecision: 'datetime', timingMode: 'deadline', estimatedMinutes: 30, source: 'manual', createdAt: now.toISOString(), updatedAt: now.toISOString() }]
    const node: ScheduleNode = { id: 'canonical-owner', occurrenceId: 'custom-owner', version: 1,
      kind: owner === 'process' ? 'assessment' : 'application_deadline', opportunityId: opp.id, processEventId: owned.processEventId,
      state: mode === 'estimated_date' ? 'scheduled' : mode, constraintKind: 'employer_hard',
      temporal: { shape: mode === 'estimated_date' ? mode : 'deadline', precision: 'datetime', timezone: 'UTC', deadlineAt: owned.dueAt,
        resolutionBasis: mode === 'estimated_date' ? 'system_estimate' : 'source_explicit' },
      relatedActionIds: [], relatedPrepIds: [], evidenceRefs: [], sourceVersionRefs: [], createdAt: now.toISOString(), updatedAt: now.toISOString() }
    source.data.scheduleNodes = [node]
    const before = JSON.stringify(source)
    expect(actionNodesById([node], source.data.actions).get(owned.id)?.id).toBe(node.id)
    const normalized = upgradeSnapshotToLatest(source)
    expect(normalized.data.scheduleNodes!.filter(item => item.opportunityId === opp.id && (owner === 'application' ? item.kind === 'application_deadline' : item.processEventId === 'owned-event')).map(item => item.id)).toEqual(['canonical-owner'])
    if (owner === 'application') expect(resolveApplicationDeadline(normalized.data.opportunities[0], normalized.data).state).toBe('unknown')
    expect(selectTodayWeb(source, { availableMinutes: 30 }, context).actions.map(item => item.actionId)).toEqual(['real'])
    expect(buildTodayBrief(source, { availableMinutes: 30 }, context).nextAction?.actionId).toBe('real')
    expect(getTodayPlan(source, { availableMinutes: 30 }, context).startableActions.map(item => item.actionId)).toEqual(['real'])
    const web = selectTodayWeb(source, { availableMinutes: 60 }, context).actions.find(item => item.actionId === owned.id)!
    expect(web.timing).toBeUndefined(); expect(web.protectedByLatestStart).toBe(false)
    expect(getTodayPlan(source, { availableMinutes: 60 }, context).startableActions.find(item => item.actionId === owned.id)?.dueAt).toBeUndefined()
    expect(buildOpportunityDecisionList(source, context).all.find(item => item.opportunityId === opp.id)?.nextAction?.dueAt).toBeUndefined()
    expect(JSON.stringify(source)).toBe(before)
    const wrong = { ...node, opportunityId: 'different-owner' }
    expect(actionNodesById([wrong], [owned]).get(owned.id)).toBeUndefined()
  })

  it.each([false, true])('treats conflicting application owners as unknown while duplicate facts stay known (duplicate=%s)', (duplicate) => {
    const opp = makeOpportunity('conflicting', '2026-10-07T09:00:00Z')
    const source = snapshot([opp])
    const owned = makeAction(opp, 30)
    const real: Action = { ...makeAction(makeOpportunity('real', '2026-10-07T10:00:00Z'), 30), id: 'real', opportunityId: undefined, kind: 'manual' }
    source.data.actions = [owned, real]
    const first: ScheduleNode = { id: 'one', occurrenceId: 'one', version: 1, kind: 'application_deadline', opportunityId: opp.id, state: 'scheduled', constraintKind: 'employer_hard',
      temporal: { shape: 'deadline', precision: 'datetime', timezone: 'UTC', deadlineAt: owned.dueAt, resolutionBasis: 'source_explicit' },
      relatedActionIds: [owned.id], relatedPrepIds: [], evidenceRefs: [], sourceVersionRefs: [], createdAt: now.toISOString(), updatedAt: now.toISOString() }
    const second: ScheduleNode = { ...first, id: 'two', occurrenceId: 'two', temporal: { ...first.temporal, deadlineAt: duplicate ? first.temporal.deadlineAt : '2026-10-07T10:00:00Z' } }
    source.data.scheduleNodes = [first, second]
    const before = JSON.stringify(source)
    expect(resolveApplicationDeadline(opp, source.data).state).toBe(duplicate ? 'confirmed' : 'unknown')
    const expected = duplicate ? owned.id : 'real'
    expect(selectTodayWeb(source, { availableMinutes: 30 }, context).actions[0]?.actionId).toBe(expected)
    expect(buildTodayBrief(source, { availableMinutes: 30 }, context).nextAction?.actionId).toBe(expected)
    expect(getTodayPlan(source, { availableMinutes: 30 }, context).startableActions[0]?.actionId).toBe(expected)
    const web = selectTodayWeb(source, { availableMinutes: 60 }, context).actions.find(item => item.actionId === owned.id)!
    if (!duplicate) {
      expect(web.timing).toBeUndefined(); expect(web.protectedByLatestStart).toBe(false)
      expect(web.whyNow).toEqual(['截止日期未明确，排在已知截止之后'])
      expect(buildTodayBrief(source, { availableMinutes: 60 }, context).nextActions.find(item => item.actionId === owned.id)?.timing).toBeUndefined()
      expect(getTodayPlan(source, { availableMinutes: 60 }, context).startableActions.find(item => item.actionId === owned.id)?.dueAt).toBeUndefined()
    } else expect(web.timing?.deadlineAt).toBe(first.temporal.deadlineAt)
    expect(JSON.stringify(source)).toBe(before)
    if (duplicate) {
      second.temporal.deadlineAt = '2026-10-07T17:00:00+08:00'
      expect(resolveApplicationDeadline(opp, source.data).state).toBe('confirmed')
    }
    first.temporal = { ...first.temporal, shape: 'date_only', precision: 'date', date: '2026-10-07', deadlineAt: undefined, timezone: 'America/Los_Angeles' }
    second.temporal = { ...first.temporal, timezone: 'Asia/Tokyo' }
    expect(resolveApplicationDeadline(opp, source.data).state).toBe('unknown')
    expect(actionDeadline(owned, actionNodesById([first, second], [owned]).get(owned.id)).deadline).toBeUndefined()
  })

  it('also keeps conflicting deadlines for the same process event unknown', () => {
    const opp = makeOpportunity('process-conflict'); opp.processStage = 'assessment'
    const source = snapshot([opp])
    const owned: Action = { ...makeAction(opp, 30), id: 'event-action:conflict-event', kind: 'manual', processEventId: 'conflict-event', dueAt: '2026-10-07T09:00:00Z' }
    const real: Action = { ...makeAction(makeOpportunity('real', '2026-10-07T10:00:00Z'), 30), id: 'real', opportunityId: undefined, kind: 'manual' }
    source.data.actions = [owned, real]
    source.data.processEvents = [{ id: 'conflict-event', opportunityId: opp.id, company: opp.company, role: opp.role, type: 'assessment_invite', occurredAt: now.toISOString(), dueAt: owned.dueAt, duePrecision: 'datetime', timingMode: 'deadline', estimatedMinutes: 30, source: 'manual', createdAt: now.toISOString(), updatedAt: now.toISOString() }]
    source.data.scheduleNodes = ['09', '10'].map(hour => ({ id: hour, occurrenceId: hour, version: 1, kind: 'assessment', state: 'scheduled', constraintKind: 'employer_hard', opportunityId: opp.id, processEventId: 'conflict-event',
      temporal: { shape: 'deadline', precision: 'datetime', timezone: 'UTC', deadlineAt: `2026-10-07T${hour}:00:00Z`, resolutionBasis: 'source_explicit' },
      relatedActionIds: [], relatedPrepIds: [], evidenceRefs: [], sourceVersionRefs: [], createdAt: now.toISOString(), updatedAt: now.toISOString() }))
    const before = JSON.stringify(source)
    expect(selectTodayWeb(source, { availableMinutes: 30 }, context).actions.map(item => item.actionId)).toEqual(['real'])
    expect(buildTodayBrief(source, { availableMinutes: 30 }, context).nextAction?.actionId).toBe('real')
    expect(getTodayPlan(source, { availableMinutes: 30 }, context).startableActions.map(item => item.actionId)).toEqual(['real'])
    expect(selectTodayWeb(source, { availableMinutes: 60 }, context).actions.find(item => item.actionId === owned.id)?.timing).toBeUndefined()
    expect(JSON.stringify(source)).toBe(before)
  })

})
