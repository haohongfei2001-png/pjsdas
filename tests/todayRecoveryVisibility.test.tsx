import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Action, Opportunity, ProcessEvent, ScheduleNode } from '../src/model.js'
import { actionForProcessEvent } from '../src/processEvents.js'
import { createSnapshot } from '../src/snapshot.js'
import { readModelSnapshot } from '../src/readModelSnapshot.js'
import { actionNodesById } from '../src/deadlineOrder.js'
import * as deadlineOrder from '../src/deadlineOrder.js'
import { processRecoveryItems } from '../src/fixedEventGuardLogic.js'
import { buildConsumerTimePlan } from '../src/today/consumerTimePlan.js'
import { selectTodayWeb, selectTodayWebNormalized } from '../src/today/todayWebSelector.js'
import { actionView, buildTodayBrief, latestByOccurrence } from '../src/todayBrief.js'
import { rankActions } from '../src/decisionV3.js'
import { unknownDeadlineWorkspace } from './fixtures/unknownDeadlineWorkspace.js'
import { getTodayPlan } from '../src/ai/readLayer.js'
import TodayFeature from '../src/today/TodayFeature.js'
import { createCapacityAutosaver } from '../src/today/capacityAutosave.js'
import { buildScheduleStream } from '../src/schedule/scheduleStream.js'

const language = vi.hoisted(() => ({ lang: 'en' }))
vi.mock('../src/uiLanguage.js', () => ({ useUiLanguage: () => language }))
const CREATED = '2026-09-01T00:00:00Z'
const NOW = new Date('2026-10-11T08:00:00Z')
const context = { now: NOW, timezone: 'UTC' }

function action(id: string, extra: Partial<Action> = {}): Action {
  return { id, kind: 'manual', title: `Task ${id}`, status: 'todo', estimatedMinutes: 30,
    leverage: 0, delayCost: 0, createdAt: CREATED, updatedAt: CREATED, ...extra }
}
function process(id: string, dueAt = '2026-09-27T15:00:00Z', minutes = 45, fixed = false) {
  const opportunity: Opportunity = { id: `job-${id}`, company: `Company ${id}`, role: 'Engineer',
    currentStageLabel: fixed ? 'Interview' : 'Assessment', processStage: fixed ? 'interview' : 'assessment',
    participationStatus: 'active', early: false, opportunityValue: 0, fitScore: 0, importedAt: CREATED }
  const event: ProcessEvent = { id, opportunityId: opportunity.id, company: opportunity.company, role: opportunity.role,
    type: fixed ? 'interview_invite' : 'assessment_invite', dueAt, duePrecision: 'datetime', timingMode: fixed ? 'fixed' : 'deadline',
    estimatedMinutes: minutes, occurredAt: CREATED, source: 'email', createdAt: CREATED, updatedAt: CREATED }
  return { opportunity, event, action: actionForProcessEvent(event)! }
}
function source(items = [process('old')], extras: Action[] = []) {
  return createSnapshot({ opportunities: items.map(item => item.opportunity), processEvents: items.map(item => item.event),
    actions: [...items.map(item => item.action), ...extras], processes: [], prep: [], applicationGroups: [] }, NOW.toISOString())
}

function owner(snapshot: ReturnType<typeof source>): ScheduleNode {
  const action = snapshot.data.actions[0]
  const existing = actionNodesById(snapshot.data.scheduleNodes!, snapshot.data.actions).get(action.id)
  if (existing) return existing
  const node: ScheduleNode = { id: 'canonical-owner', occurrenceId: 'canonical-owner', version: 1,
    kind: 'assessment', state: 'scheduled', constraintKind: 'employer_hard', opportunityId: action.opportunityId, processEventId: action.processEventId,
    temporal: { shape: 'deadline', precision: 'datetime', timezone: 'UTC', deadlineAt: action.dueAt, resolutionBasis: 'source_explicit' },
    evidenceRefs: [], sourceVersionRefs: [], relatedActionIds: [action.id], relatedPrepIds: [], createdAt: CREATED, updatedAt: CREATED }
  snapshot.data.scheduleNodes!.push(node)
  return node
}

function invalidate(snapshot: ReturnType<typeof source>) {
    snapshot.data.semanticReceipts!.push({ id: 'receipt', inputId: 'review', sourceKind: 'user', sourceId: 'review', sourceRecordId: 'review',
      status: 'committed', summary: 'Reviewed event', affectedObjects: [], decisionRequestIds: [], undoAvailable: false, createdAt: CREATED, updatedAt: CREATED })
    snapshot.data.processEvents[0].invalidation = { commandId: 'withdraw', receiptId: 'receipt',
      legacyReview: { expectedEventFingerprint: '0'.repeat(64), sourceRefs: ['source:event'] },
      invalidatedAt: NOW.toISOString(), reason: 'withdrawn', evidenceRefs: ['source:event'] }
}

function recovery(snapshot: ReturnType<typeof source>, at = context) {
  return processRecoveryItems({ ...snapshot.data, nodes: snapshot.data.scheduleNodes ?? [], ...at })
}
function render(snapshot: ReturnType<typeof source>, availableMinutes: number, at = context) {
  const selection = selectTodayWeb(snapshot, { availableMinutes }, at)
  return renderToStaticMarkup(<TodayFeature selection={selection}
    stream={buildScheduleStream(snapshot, { ...at, accountKey: 'test', workspaceRevision: '1' })}
    opportunities={snapshot.data.opportunities} now={at.now} workspaceEmpty={false} freshness={{ state: 'current' }}
    onStart={() => {}} capacityScope="test" capacityAutosaver={createCapacityAutosaver(async () => {}, () => {})}
    capacitySaveState={{ pending: false }} onRetry={() => {}} onOpenDecision={() => {}} onOpenAgenda={() => {}}
    onExecute={async () => {}} onMark={async () => {}} onOpenOpportunity={() => {}} />)
}

const oldItems = () => [process('interview', '2026-09-21T08:00:00Z', 90, true),
  process('assessment22', '2026-09-22T08:00:00Z', 45), process('written27', '2026-09-27T08:00:00Z', 30),
  process('assessment28', '2026-09-28T08:00:00Z', 45), process('assessment30', '2026-09-30T08:00:00Z', 40)]

describe('read-only overdue process recovery', () => {
  it('does not project timing owners for ordinary work or resolved process history', () => {
    const item = process('resolved'); item.action.status = 'done'
    const snapshot = source([item], [action('ordinary', { plannedDate: '2026-10-11' })])
    const before = structuredClone(snapshot)
    const owners = vi.spyOn(deadlineOrder, 'actionNodesById')
    try {
      expect(recovery(snapshot)).toEqual([])
      expect(owners).not.toHaveBeenCalled()
      expect(snapshot).toEqual(before)
    } finally { owners.mockRestore() }
  })
  it('still recovers a retained process action when its source event is absent', () => {
    const snapshot = source(); snapshot.data.processEvents = []
    const before = structuredClone(snapshot)
    expect(recovery(snapshot).map(item => item.actionId)).toEqual(['event-action:old'])
    expect(snapshot).toEqual(before)
  })
  it.each([
    ['2026-10-11T00:00:00Z', 1440], ['2026-10-11T08:00:00Z', 480], ['2026-10-11T23:04:00Z', 56],
  ])('keeps four overdue obligations visible beside one past fixed record at %s / %i minutes', (instant, availableMinutes) => {
    const snapshot = source(oldItems()), before = structuredClone(snapshot)
    const at = { ...context, now: new Date(instant) }
    const web = selectTodayWeb(snapshot, { availableMinutes }, at)
    const mcp = getTodayPlan(snapshot, { availableMinutes }, at)
    const brief = buildTodayBrief(snapshot, { availableMinutes }, at)
    const ids = snapshot.data.actions.map(item => item.id)
    expect(web.recoveryItems.map(item => item.actionId)).toEqual(ids)
    const obligations = ids.slice(1)
    expect(web.actions).toEqual([])
    expect(web.visibleActions.map(item => item.actionId)).toEqual(obligations)
    expect(web.businessConflicts).toEqual([])
    expect(web.notSelectedHardActions).toEqual([])
    expect(mcp.capacityConflict).toBe(false); expect(mcp.startableActions).toEqual([])
    expect(mcp.capacityLimitedActions.map(item => item.actionId)).toEqual(obligations)
    expect(brief.capacityLimitedActions).toEqual(mcp.capacityLimitedActions)
    expect(mcp.blockedOrRecoveryItems).toEqual([])
    expect(mcp.capacityLimitedActions.every(item => item.reason === 'deadline_passed')).toBe(true)
    expect(mcp.blockedOrRecoveryItems.every(item => !item.reason.includes('确认'))).toBe(true)
    expect(brief.recoveryItems).toEqual(web.recoveryItems)
    expect(selectTodayWebNormalized(readModelSnapshot(snapshot), { availableMinutes }, at)).toEqual(web)
    expect(getTodayPlan(readModelSnapshot(snapshot), { availableMinutes }, at)).toEqual(mcp)
    expect(snapshot).toEqual(before)
  })

  it.each([56, 480, 1440])('does not let historical deadlines block a planned 30-minute task with %i minutes', availableMinutes => {
    const snapshot = source(oldItems(), [action('fresh', { plannedDate: '2026-10-11' })])
    const before = structuredClone(snapshot)
    const plan = buildConsumerTimePlan({ ranked: snapshot.data.actions.map(action => ({ action, reasons: [] })),
      ...snapshot.data, nodes: snapshot.data.scheduleNodes!, availableMinutes, useRemainingDayDefault: true, ...context })
    expect(plan.planned.map(item => item.action.id)).toEqual(['fresh'])
    expect(plan.plannedMinutes).toBe(30); expect(plan.deferredHard).toEqual([])
    expect(plan.deadlinePassedActionIds).toEqual(snapshot.data.actions.slice(1, 5).map(item => item.id))
    expect(plan.recoveryItems).toHaveLength(5)
    expect(snapshot).toEqual(before)
  })

  it.each(['todo', 'doing'] as const)('retains unresolved %s fixed events as read-only history', status => {
    const item = process('fixed', undefined, 90, true); item.action.status = status
    expect(recovery(source([item]))).toHaveLength(1)
  })
  it.each(['done', 'skipped'] as const)('does not recover %s actions', status => {
    const item = process('resolved'); item.action.status = status
    const snapshot = source([item])
    expect(recovery(snapshot)).toEqual([])
    expect(selectTodayWeb(snapshot, {}, context).recoveryItems).toEqual([])
    expect(getTodayPlan(snapshot, {}, context).blockedOrRecoveryItems).toEqual([])
  })
  it.each(['closed', 'abandoned'] as const)('does not recover %s process state', state => {
    const item = process('inactive')
    if (state === 'closed') item.opportunity.processStage = 'closed'
    if (state === 'abandoned') item.opportunity.participationStatus = 'abandoned'
    const snapshot = source([item])
    expect(recovery(snapshot)).toEqual([])
    expect(selectTodayWeb(snapshot, {}, context).recoveryItems).toEqual([])
    expect(getTodayPlan(snapshot, {}, context).blockedOrRecoveryItems).toEqual([])
  })
  it.each(['closed', 'abandoned'] as const)('does not revive explicitly planned %s work when job identity lives only on the event', state => {
    const item = process('event-linked-job')
    item.action.opportunityId = undefined; item.action.plannedDate = '2026-10-11'
    if (state === 'closed') item.opportunity.processStage = 'closed'
    else item.opportunity.participationStatus = 'abandoned'
    const snapshot = source([item]), before = structuredClone(snapshot)
    const web = selectTodayWeb(snapshot, {}, context)
    expect(web.visibleActions).toEqual([]); expect(web.businessConflicts).toEqual([])
    expect(web.protectedActionIds).toEqual([]); expect(web.recoveryItems).toEqual([])
    expect(getTodayPlan(snapshot, {}, context).startableActions).toEqual([])
    expect(buildTodayBrief(snapshot, {}, context).internalDiagnostics.protectedActionIds).toEqual([])
    expect(snapshot).toEqual(before)
  })
  it('excludes invalidated evidence without modifying retained action or event state', () => {
    const snapshot = source()
    invalidate(snapshot)
    const before = structuredClone(snapshot)
    expect(recovery(snapshot)).toEqual([])
    expect(selectTodayWeb(snapshot, {}, context).recoveryItems).toEqual([])
    expect(getTodayPlan(snapshot, {}, context).blockedOrRecoveryItems).toEqual([])
    expect(snapshot).toEqual(before)
  })
  it('excludes invalidated future fixed events from every Today surface', () => {
    const snapshot = source([process('withdrawn-fixed', '2026-10-11T10:00:00Z', 90, true)])
    owner(snapshot).temporal.resolutionBasis = 'source_explicit'
    invalidate(snapshot)
    const before = structuredClone(snapshot)
    const web = selectTodayWeb(snapshot, {}, context)
    expect(web.visibleActions).toEqual([]); expect(web.recoveryItems).toEqual([]); expect(web.businessConflicts).toEqual([])
    const mcp = getTodayPlan(snapshot, {}, context)
    expect(mcp.fixedEvents).toEqual([]); expect(mcp.startableActions).toEqual([]); expect(mcp.blockedOrRecoveryItems).toEqual([])
    expect(buildTodayBrief(snapshot, {}, context).agendaGroups).toEqual([])
    expect(snapshot).toEqual(before)
  })
  it('keeps elapsed_unresolved canonical events in recovery', () => {
    const snapshot = source([process('elapsed', undefined, 90, true)])
    owner(snapshot).state = 'elapsed_unresolved'
    expect(recovery(snapshot)).toHaveLength(1)
    expect(selectTodayWeb(snapshot, {}, context).recoveryItems).toHaveLength(1)
    expect(getTodayPlan(snapshot, {}, context).blockedOrRecoveryItems).toEqual([])
  })
  it.each(['completed', 'cancelled', 'superseded'] as const)('does not revive %s canonical owners', state => {
    const snapshot = source()
    const node = owner(snapshot)
    node.state = state
    const before = structuredClone(snapshot)
    expect(recovery(snapshot)).toEqual([])
    expect(selectTodayWeb(snapshot, {}, context).recoveryItems).toEqual([])
    expect(getTodayPlan(snapshot, {}, context).blockedOrRecoveryItems.filter(item => item.reason.includes('确认'))).toEqual([])
    expect(snapshot).toEqual(before)
  })
  it.each(['completed', 'cancelled', 'superseded'] as const)('keeps %s recruiting history outside Today unless explicitly planned, with no revived deadline', state => {
    const snapshot = source()
    owner(snapshot).state = state
    const unplanned = structuredClone(snapshot)
    const empty = selectTodayWeb(snapshot, { availableMinutes: 60 }, context)
    expect(empty.visibleActions).toEqual([]); expect(empty.businessConflicts).toEqual([])
    expect(empty.protectedActionIds).toEqual([])
    expect(getTodayPlan(snapshot, { availableMinutes: 60 }, context).startableActions).toEqual([])
    expect(snapshot).toEqual(unplanned)
    snapshot.data.actions[0].plannedDate = '2026-10-11'
    const before = structuredClone(snapshot)
    const web = selectTodayWeb(snapshot, { availableMinutes: 60 }, context)
    expect(web.actions).toHaveLength(1); expect(web.visibleActions).toHaveLength(1)
    expect(web.actions[0].timing).toBeUndefined(); expect(web.actions[0].protectedByLatestStart).toBe(false)
    expect(web.businessConflicts).toEqual([]); expect(web.recoveryItems).toEqual([]); expect(web.protectedActionIds).toEqual([])
    const mcp = getTodayPlan(snapshot, { availableMinutes: 60 }, context)
    expect(mcp.startableActions).toHaveLength(1); expect(mcp.startableActions[0].dueAt).toBeUndefined()
    expect(mcp.capacityConflict).toBe(false); expect(mcp.blockedOrRecoveryItems).toEqual([])
    const brief = buildTodayBrief(snapshot, { availableMinutes: 60 }, context)
    expect(brief.nextAction?.timing).toBeUndefined(); expect(brief.internalDiagnostics.protectedActionIds).toEqual([])
    const zero = selectTodayWeb(snapshot, { availableMinutes: 0 }, context)
    expect(zero.visibleActions).toHaveLength(1); expect(zero.insufficientTimeActionIds).toEqual([snapshot.data.actions[0].id])
    expect(zero.businessConflicts).toEqual([])
    expect(snapshot).toEqual(before)
  })
  it('keeps source-zone date-only deadlines valid for their whole calendar day', () => {
    const item = process('date', '2026-10-11')
    item.event.duePrecision = item.action.duePrecision = 'date'
    item.event.temporal = { shape: 'date_only', precision: 'date', date: '2026-10-11', timezone: 'America/Los_Angeles', resolutionBasis: 'source_explicit' }
    const snapshot = source([item])
    const before = structuredClone(snapshot)
    for (const timezone of ['UTC', 'Asia/Shanghai', 'America/Los_Angeles']) {
      for (const [instant, count] of [['2026-10-12T06:59:59.999Z', 0], ['2026-10-12T07:00:00Z', 1]] as const) {
        const at = { now: new Date(instant), timezone }
        expect(recovery(snapshot, at)).toHaveLength(count)
        expect(selectTodayWeb(snapshot, {}, at).recoveryItems).toHaveLength(count)
        expect(getTodayPlan(snapshot, {}, at).blockedOrRecoveryItems.filter(item => item.reason.includes('确认'))).toEqual([])
      }
    }
    expect(snapshot).toEqual(before)
  })
  it('does not invent a midnight time for a retained bare-date recovery item', () => {
    const item = process('bare-date', '2026-09-27')
    item.action.duePrecision = undefined; item.event.duePrecision = undefined
    const snapshot = source([item])
    const html = render(snapshot, 480)
    expect(recovery(snapshot)[0].deadline.deadline).toBe('2026-09-27')
    expect(html).not.toContain('data-recovery-action-id')
    expect(html).not.toContain('00:00')
  })
  it('uses an exact deadline boundary, not latest-start expiry, for recovery', () => {
    const snapshot = source([process('later', '2026-10-11T09:00:00Z', 90)])
    const node = owner(snapshot)
    node.temporal.latestStartAt = '2026-10-11T07:00:00Z'
    const web = selectTodayWeb(snapshot, { availableMinutes: 480 }, context)
    expect(web.recoveryItems).toEqual([])
    expect(web.businessConflicts[0]?.kind).toBe('hard_deadline_capacity')
    const deadline = new Date('2026-10-11T09:00:00Z')
    expect(recovery(snapshot, { ...context, now: deadline })).toEqual([])
    expect(recovery(snapshot, { ...context, now: new Date(deadline.getTime() + 1) })).toHaveLength(1)
  })
  it('does not broaden expired application or unplanned ordinary task membership', () => {
    const snapshot = source([], [action('expired-application', { kind: 'apply', dueAt: '2026-09-30', duePrecision: 'date', plannedDate: '2026-10-11' }),
      action('unplanned', { dueAt: '2026-10-11T15:00:00Z' }), action('future-plan', { plannedDate: '2026-10-12' })])
    const web = selectTodayWeb(snapshot, {}, context)
    expect(web.visibleActions).toEqual([]); expect(web.recoveryItems).toEqual([])
    expect(getTodayPlan(snapshot, {}, context).capacityLimitedActions).toEqual([])
  })
})

describe('time advice never hides existing Today tasks', () => {
  it.each([100, 101, 500])('retains every card and control when the dense rendering hint applies to %i tasks', count => {
    const snapshot = source([], Array.from({ length: count }, (_, index) => action(`dense-${index}`, { plannedDate: '2026-10-11' })))
    const before = structuredClone(snapshot)
    const html = render(snapshot, 0)
    expect(html).toContain(count > 100 ? 'class="tsui-task-list is-dense"' : 'class="tsui-task-list"')
    expect(html.match(/data-action-id=/g)).toHaveLength(count)
    expect(html).not.toContain('data-capacity-limited-action-id')
    expect(html.match(/>Start<\/button>/g)).toHaveLength(count)
    expect(html.match(/>Done<\/button>/g)).toHaveLength(count)
    const cards = html.match(/<article\b[\s\S]*?<\/article>/g) ?? []
    expect(cards).toHaveLength(count)
    expect(cards.some(card => card.includes('aria-hidden="true"'))).toBe(false)
    expect(snapshot).toEqual(before)
  })
  it('shares an owner index without resolving ownerless visible cards again', () => {
    const snapshot = source([], Array.from({ length: 80 }, (_, index) => action(`ordinary-${index}`, { plannedDate: '2026-10-11' })))
    const before = structuredClone(snapshot)
    const resolve = vi.spyOn(deadlineOrder, 'latestActionNode')
    try {
      const web = selectTodayWeb(snapshot, { availableMinutes: 0 }, context)
      expect(web.visibleActions).toHaveLength(80)
      expect(web.insufficientTimeActionIds).toHaveLength(80)
      expect(resolve).not.toHaveBeenCalled()
      expect(snapshot).toEqual(before)
    } finally { resolve.mockRestore() }
  })
  it('keeps bulk ranked owners and indexed views equivalent to per-action projection', () => {
    const terminal = process('terminal', '2026-10-11T09:00:00Z')
    terminal.action.plannedDate = '2026-10-11'
    const projected = process('projected', '2026-10-11T10:00:00Z')
    projected.event.temporal = { shape: 'deadline', precision: 'datetime', timezone: 'UTC',
      deadlineAt: projected.event.dueAt, resolutionBasis: 'source_explicit' }
    const natural = process('natural', new Date(2026, 9, 11, 23, 59).toISOString())
    natural.event.id = 'progress-event:nl3:event:natural'
    natural.action.processEventId = natural.event.id
    natural.action.processStage = 'assessment'
    const processSnapshot = source([terminal, projected, natural], [action('ownerless', { plannedDate: '2026-10-11' })])
    owner(processSnapshot).state = 'completed'
    processSnapshot.data.scheduleNodes = processSnapshot.data.scheduleNodes!.filter(node => node.processEventId !== projected.event.id)
    const applicationSnapshot = unknownDeadlineWorkspace(2, true)
    applicationSnapshot.data.opportunities[0].detail!.deadlineCorrections![0].acknowledgedNodeFacts = []
    const shared = action('shared', { opportunityId: 'real-deadline', plannedDate: '2026-10-02' })
    applicationSnapshot.data.actions.push(shared)
    const applicationNode = applicationSnapshot.data.scheduleNodes!.find(node => node.opportunityId === 'real-deadline')!
    applicationNode.relatedActionIds.push(shared.id)
    applicationSnapshot.data.scheduleNodes!.push({ ...structuredClone(applicationNode), id: 'conflicting-application',
      occurrenceId: 'conflicting-application', temporal: { ...applicationNode.temporal, deadlineAt: '2026-10-03T15:59:59Z' } })
    for (const snapshot of [processSnapshot, applicationSnapshot]) {
      const before = structuredClone(snapshot)
      const nodes = latestByOccurrence(snapshot.data.scheduleNodes!)
      const ranked = rankActions(snapshot.data.actions, snapshot.data.opportunities, NOW, undefined, 'UTC', nodes)
      const owners = actionNodesById(nodes, ranked.map(item => item.action), snapshot.data.opportunities, snapshot.data.processEvents)
      const opportunities = new Map(snapshot.data.opportunities.map(item => [item.id, item]))
      if (snapshot === processSnapshot) {
        const naturalRanked = ranked.find(item => item.action.id === natural.action.id)
        expect(naturalRanked).toBeDefined()
        expect(naturalRanked!.action.processEventId).toBeUndefined()
        expect(owners.get(terminal.action.id)?.state).toBe('completed')
        expect(owners.get(projected.action.id)?.projectionOnly).toBe(true)
      }
      for (const item of ranked) {
        expect(owners.get(item.action.id)).toEqual(deadlineOrder.latestActionNode(item.action, nodes, snapshot.data.opportunities, snapshot.data.processEvents))
        expect(actionView(item, nodes, opportunities, NOW, 'UTC', 48, snapshot.data.processEvents, owners))
          .toEqual(actionView(item, nodes, opportunities, NOW, 'UTC', 48, snapshot.data.processEvents))
      }
      expect(snapshot).toEqual(before)
    }
  })
  it('reuses recommended views without dropping capacity-limited work', () => {
    const snapshot = source([], [action('first', { plannedDate: '2026-10-11' }), action('second', { plannedDate: '2026-10-11' })])
    const before = structuredClone(snapshot)
    const fits = selectTodayWeb(snapshot, { availableMinutes: 60 }, context)
    expect(fits.visibleActions).toBe(fits.actions)
    const limited = selectTodayWeb(snapshot, { availableMinutes: 30 }, context)
    expect(limited.actions.map(item => item.actionId)).toEqual(['first'])
    expect(limited.visibleActions.map(item => item.actionId)).toEqual(['first', 'second'])
    expect(limited.visibleActions[0]).toBe(limited.actions[0])
    expect(limited.insufficientTimeActionIds).toEqual(['second'])
    expect(snapshot).toEqual(before)
  })
  it.each([0, 56])('keeps hard and flexible tasks accessible at %i minutes without pretending they fit', availableMinutes => {
    const snapshot = source([process('today', '2026-10-11T09:00:00Z', 90)], [action('manual', { plannedDate: '2026-10-11', estimatedMinutes: 60 })])
    const before = structuredClone(snapshot)
    const web = selectTodayWeb(snapshot, { availableMinutes }, context)
    const ids = ['event-action:today', 'manual']
    expect(web.actions).toEqual([])
    expect(web.visibleActions.map(item => item.actionId)).toEqual(ids)
    expect(web.visibleActionCount).toBe(2)
    expect(web.insufficientTimeActionIds).toEqual(ids)
    expect(web.notSelectedHardActions.map(item => item.actionId)).toEqual(['event-action:today'])
    expect(web.businessConflicts[0]?.kind).toBe('hard_deadline_capacity')
    const mcp = getTodayPlan(snapshot, { availableMinutes }, context)
    expect(mcp.startableActions).toEqual([])
    expect(mcp.capacityLimitedActions.map(item => item.actionId)).toEqual(ids)
    expect(buildTodayBrief(snapshot, { availableMinutes }, context).capacityLimitedActions).toEqual(mcp.capacityLimitedActions)
    const html = render(snapshot, availableMinutes)
    for (const id of ids) {
      expect(html).toContain(`data-action-id="${id}"`)
      expect(html).not.toContain('data-capacity-limited-action-id')
    }
    expect(html).not.toContain('Estimated 90 min'); expect(html).not.toContain('Estimated 60 min')
    expect(html).toContain('View process'); expect(html).toContain('>Start</button>')
    expect(html.match(/>Done<\/button>/g)).toHaveLength(2)
    expect(html).not.toContain('disabled=""')
    expect(html).not.toContain('Nothing requires action right now')
    expect(snapshot).toEqual(before)
  })
  it.each(['en', 'zh'])('keeps original task row design at every capacity in %s', lang => {
    language.lang = lang
    try {
      const snapshot = source([], [action('normal', { plannedDate: '2026-10-11', estimatedMinutes: 30 })])
      const normal = render(snapshot, 60)
      expect(normal).toContain('data-action-id="normal"')
      expect(normal).not.toContain(lang === 'zh' ? '预计 30 分钟' : 'Estimated 30 min')
      expect(normal).not.toContain('data-capacity-limited-action-id=')
      const limited = render(snapshot, 0)
      expect(limited).not.toContain(lang === 'zh' ? '预计 30 分钟' : 'Estimated 30 min')
      expect(limited).not.toContain('data-capacity-limited-action-id')
      expect(limited).not.toContain(lang === 'zh' ? '当前可用时间不足' : 'Insufficient available time')
    } finally { language.lang = 'en' }
  })
  it('does not duplicate mixed feasible, capacity-limited, or recovery cards', () => {
    const snapshot = source([process('today', '2026-10-11T09:00:00Z', 40), process('old')],
      [action('small', { plannedDate: '2026-10-11', estimatedMinutes: 10 }), action('large', { plannedDate: '2026-10-11', estimatedMinutes: 60 })])
    const web = selectTodayWeb(snapshot, { availableMinutes: 56 }, context)
    expect(web.actions.map(item => item.actionId)).toEqual(['event-action:today', 'small'])
    expect(web.visibleActions.map(item => item.actionId)).toEqual(['event-action:old', 'event-action:today', 'large', 'small'])
    expect(web.insufficientTimeActionIds).toEqual(['event-action:old', 'large'])
    const html = render(snapshot, 56)
    expect(html).not.toContain('Estimated 60 min')
    expect(html).not.toContain('Estimated 40 min'); expect(html).not.toContain('Estimated 10 min')
    expect(html.match(/data-action-id=/g)).toHaveLength(4)
    expect(html).not.toContain('data-recovery-action-id')
    expect(web.recoveryItems[0].deepLink).toBe('/opportunities/job-old')
  })
  it.each(['en', 'zh'])('does not turn elapsed history into homepage confirmation work in %s', lang => {
    language.lang = lang
    const html = render(source([process('past-fixed', undefined, 90, true)]), 1440)
    expect(html).not.toContain('data-recovery-action-id')
    expect(html).not.toContain('tsui-recovery-history')
    expect(html).toContain(lang === 'zh' ? '当前没有今日任务' : 'No tasks for today')
    expect(html).toContain(lang === 'zh' ? '暂无近期节点' : 'No upcoming nodes')
    expect(html).not.toContain(lang === 'zh' ? '查看并确认' : 'Review and confirm')
    expect(html).not.toContain('Nothing requires action right now')
    expect(html).not.toContain('现在没有必须处理的任务')
    language.lang = 'en'
  })
  it('does not show an all-clear empty state while fixed conflicts remain', () => {
    const snapshot = source([], [])
    const base: ScheduleNode = { id: 'one', occurrenceId: 'one', version: 1, kind: 'interview', state: 'scheduled', constraintKind: 'employer_hard',
      temporal: { shape: 'fixed_range', precision: 'datetime', timezone: 'UTC', startAt: '2026-10-11T10:00:00Z', endAt: '2026-10-11T11:00:00Z', resolutionBasis: 'source_explicit' },
      evidenceRefs: [], sourceVersionRefs: [], relatedActionIds: [], relatedPrepIds: [], createdAt: CREATED, updatedAt: CREATED }
    snapshot.data.scheduleNodes = [base, { ...base, id: 'two', occurrenceId: 'two' }]
    const html = render(snapshot, 480)
    expect(html).toContain('Two fixed commitments overlap.')
    expect(html).not.toContain('Nothing requires action right now')
  })
})

describe('explicit chosen work survives historical classification', () => {
  it.each(['todo', 'doing'] as const)('keeps an active non-fixed %s process task explicitly planned today', status => {
    const item = process('explicit-past')
    item.action.plannedDate = '2026-10-11'; item.action.status = status
    const snapshot = source([item]); const before = structuredClone(snapshot)
    const web = selectTodayWeb(snapshot, { availableMinutes: 480 }, context)
    expect(web.visibleActions.map(item => item.actionId)).toEqual([item.action.id])
    expect(web.businessConflicts).toEqual([])
    expect(getTodayPlan(snapshot, { availableMinutes: 480 }, context).startableActions.map(item => item.actionId)).toEqual([item.action.id])
    expect(snapshot).toEqual(before)
  })
  it.each(['fixed', 'done', 'skipped', 'closed', 'abandoned', 'invalidated', 'tomorrow'] as const)('does not reopen %s history from an old chosen date', state => {
    const item = process('excluded', undefined, 45, state === 'fixed')
    item.action.plannedDate = state === 'tomorrow' ? '2026-10-12' : '2026-10-11'
    if (state === 'done' || state === 'skipped') item.action.status = state
    if (state === 'closed') item.opportunity.processStage = 'closed'
    if (state === 'abandoned') item.opportunity.participationStatus = 'abandoned'
    const snapshot = source([item])
    if (state === 'invalidated') invalidate(snapshot)
    const before = structuredClone(snapshot)
    expect(selectTodayWeb(snapshot, { availableMinutes: 480 }, context).visibleActions).toEqual([])
    expect(getTodayPlan(snapshot, { availableMinutes: 480 }, context).startableActions).toEqual([])
    expect(snapshot).toEqual(before)
  })
})

describe('approved overdue obligation membership', () => {
  it.each(['todo', 'doing'] as const)('preserves five real deadline %s obligations beside four past fixed occurrences without planning writes', status => {
    const items = Array.from({ length: 9 }, (_, index) => process(`obligation-${index}`, '2026-09-27T09:00:00Z', 30, index < 4))
    for (const item of items) item.action.status = status
    // A later recruitment stage alone is not a completion receipt for this task.
    items[4].opportunity.processStage = 'written_test'
    const snapshot = source(items)
    const later = process('later-written-test', '2026-10-01T09:00:00Z', 30, true)
    later.event.opportunityId = items[4].opportunity.id
    later.event.type = 'written_test_invite'; later.event.occurredAt = '2026-09-28T10:00:00Z'
    snapshot.data.processEvents.push(later.event)
    snapshot.data.actions.push(actionForProcessEvent(later.event)!)
    const before = structuredClone(snapshot)
    const ids = items.slice(4).map(item => item.action.id)
    for (const availableMinutes of [0, 56, 480, 1440]) {
      const web = selectTodayWeb(snapshot, { availableMinutes }, context)
      const plan = getTodayPlan(snapshot, { availableMinutes }, context)
      const brief = buildTodayBrief(snapshot, { availableMinutes }, context)
      expect(web.visibleActions.map(item => item.actionId)).toEqual(ids)
      expect(web.actions).toEqual([]) // A missed deadline cannot become feasible retroactively.
      expect(plan.startableActions).toEqual([])
      expect(plan.capacityLimitedActions.map(item => item.actionId)).toEqual(ids)
      expect(brief.capacityLimitedActions).toEqual(plan.capacityLimitedActions)
      expect(plan.blockedOrRecoveryItems).toEqual([])
      expect(plan.capacityConflict).toBe(false)
      expect(web.businessConflicts).toEqual([])
      expect(plan.capacityLimitedActions.every(item => item.reason === 'deadline_passed')).toBe(true)
      expect(plan.blockedOrRecoveryItems.every(item => !item.reason.includes('确认'))).toBe(true)
      const html = render(snapshot, availableMinutes)
      expect(html.match(/data-action-id=/g)).toHaveLength(5)
      expect(html).not.toContain('No tasks for today')
      expect(html).not.toContain('data-recovery-action-id')
      expect(html).not.toContain('tsui-inline-notice')
    }
    expect(snapshot).toEqual(before)
    const completed = structuredClone(snapshot)
    completed.data.actions.find(action => action.id === ids[0])!.status = 'done'
    const remaining = ids.slice(1)
    expect(selectTodayWeb(completed, { availableMinutes: 0 }, context).visibleActions.map(item => item.actionId)).toEqual(remaining)
    expect(getTodayPlan(completed, { availableMinutes: 0 }, context).capacityLimitedActions.map(item => item.actionId)).toEqual(remaining)
    expect(buildTodayBrief(completed, { availableMinutes: 0 }, context).capacityLimitedActions.map(item => item.actionId)).toEqual(remaining)
  })
  it.each(['missing_source', 'invalidated', 'done', 'skipped', 'closed', 'abandoned', 'fixed', 'completed_owner', 'cancelled_owner', 'superseded_owner', 'estimated_owner', 'future'] as const)('does not restore %s as an overdue obligation', state => {
    const item = process(`excluded-${state}`, state === 'future' ? '2026-12-01T12:00:00Z' : undefined, 30, state === 'fixed')
    if (state === 'done' || state === 'skipped') item.action.status = state
    if (state === 'closed') item.opportunity.processStage = 'closed'
    if (state === 'abandoned') item.opportunity.participationStatus = 'abandoned'
    const snapshot = source([item])
    if (state === 'missing_source') snapshot.data.processEvents = []
    if (state === 'invalidated') invalidate(snapshot)
    if (state.endsWith('_owner')) {
      const node = owner(snapshot)
      if (state === 'estimated_owner') { node.temporal.shape = 'estimated_date'; node.temporal.resolutionBasis = 'system_estimate' }
      else node.state = state.slice(0, -6) as 'completed' | 'cancelled' | 'superseded'
    }
    const before = structuredClone(snapshot)
    if (state === 'missing_source') {
      expect(selectTodayWebNormalized(snapshot, { availableMinutes: 1440 }, context).visibleActions).toEqual([])
      expect(() => selectTodayWeb(snapshot, { availableMinutes: 1440 }, context)).toThrow('不存在的流程事件')
    } else {
      expect(selectTodayWeb(snapshot, { availableMinutes: 1440 }, context).visibleActions).toEqual([])
      expect(getTodayPlan(snapshot, { availableMinutes: 1440 }, context).capacityLimitedActions).toEqual([])
    }
    expect(snapshot).toEqual(before)
  })
})

describe('canonical overdue deadline forms', () => {
  it.each(['date_only', 'availability_window', 'default_mode', 'missing_action_mode', 'missing_both_modes', 'window_without_raw_due'] as const)('keeps %s source obligations without fabricated timing', form => {
    const item = process(`shape-${form}`, form === 'date_only' ? '2026-09-27' : '2026-09-27T15:00:00Z')
    if (form === 'date_only') {
      item.event.duePrecision = item.action.duePrecision = 'date'
      item.event.temporal = { shape: 'date_only', precision: 'date', timezone: 'America/Los_Angeles', date: '2026-09-27', resolutionBasis: 'source_explicit' }
    } else if (form === 'availability_window' || form === 'window_without_raw_due') {
      item.event.temporal = { shape: 'availability_window', precision: 'datetime', timezone: 'UTC', startAt: '2026-09-26T09:00:00Z', endAt: '2026-09-27T15:00:00Z', resolutionBasis: 'source_explicit' }
      if (form === 'window_without_raw_due') { item.event.dueAt = undefined; item.action.dueAt = undefined }
    } else {
      if (form !== 'missing_action_mode') item.event.timingMode = undefined
      if (form !== 'default_mode') item.action.timingMode = undefined
    }
    const snapshot = source([item]), before = structuredClone(snapshot)
    for (const timezone of ['UTC', 'Asia/Shanghai', 'America/Los_Angeles']) {
      const at = { ...context, timezone }
      expect(selectTodayWeb(snapshot, { availableMinutes: 0 }, at).visibleActions.map(x => x.actionId)).toEqual([item.action.id])
      expect(getTodayPlan(snapshot, { availableMinutes: 0 }, at).capacityLimitedActions.map(x => x.actionId)).toEqual([item.action.id])
      expect(buildTodayBrief(snapshot, { availableMinutes: 0 }, at).capacityLimitedActions.map(x => x.actionId)).toEqual([item.action.id])
    }
    expect(snapshot).toEqual(before)
  })
})


describe('truthful overdue and capacity reasons', () => {
  it.each([0, 480])('keeps explicitly chosen past work classified by actual capacity at %i minutes', availableMinutes => {
    const item = process('explicit-reason'); item.action.plannedDate = '2026-10-11'
    const snapshot = source([item]), before = structuredClone(snapshot)
    const web = selectTodayWeb(snapshot, { availableMinutes }, context)
    const plan = getTodayPlan(snapshot, { availableMinutes }, context)
    const brief = buildTodayBrief(snapshot, { availableMinutes }, context)
    expect(web.visibleActions.map(x => x.actionId)).toEqual([item.action.id])
    expect(web.businessConflicts).toEqual([])
    expect(plan.capacityLimitedActions.map(x => x.reason)).toEqual(availableMinutes ? [] : ['insufficient_time'])
    expect(brief.capacityLimitedActions).toEqual(plan.capacityLimitedActions)
    expect(plan.startableActions.map(x => x.actionId)).toEqual(availableMinutes ? [item.action.id] : [])
    expect(snapshot).toEqual(before)
  })
  it('keeps a future hard capacity conflict separate from an already missed deadline', () => {
    const old = process('missed'), future = process('future-hard', '2026-10-11T09:00:00Z', 90)
    const snapshot = source([old, future]), before = structuredClone(snapshot)
    const web = selectTodayWeb(snapshot, { availableMinutes: 480 }, context)
    const plan = getTodayPlan(snapshot, { availableMinutes: 480 }, context)
    expect(web.visibleActions.map(x => x.actionId)).toEqual([old.action.id, future.action.id])
    expect(web.businessConflicts).toHaveLength(1)
    expect(web.businessConflicts[0].relatedIds).toEqual([future.action.id])
    expect(plan.startableActions).toEqual([])
    expect(plan.capacityLimitedActions.map(x => x.reason)).toEqual(['deadline_passed', 'insufficient_time'])
    expect(buildTodayBrief(snapshot, { availableMinutes: 480 }, context).capacityLimitedActions).toEqual(plan.capacityLimitedActions)
    expect(snapshot).toEqual(before)
  })
  it.each(['interview_invite', 'written_test_invite'] as const)('does not restore default fixed %s when modes are absent', type => {
    const item = process('default-fixed'); item.event.type = type
    item.event.timingMode = undefined; item.action.timingMode = undefined
    const snapshot = source([item]), before = structuredClone(snapshot)
    expect(selectTodayWeb(snapshot, { availableMinutes: 480 }, context).visibleActions).toEqual([])
    expect(getTodayPlan(snapshot, { availableMinutes: 480 }, context).capacityLimitedActions).toEqual([])
    expect(snapshot).toEqual(before)
  })
  it('does not override an explicitly fixed action with a deadline event', () => {
    const item = process('explicit-fixed'); item.action.timingMode = 'fixed'
    const snapshot = source([item]), before = structuredClone(snapshot)
    expect(selectTodayWeb(snapshot, { availableMinutes: 480 }, context).visibleActions).toEqual([])
    expect(getTodayPlan(snapshot, { availableMinutes: 480 }, context).capacityLimitedActions).toEqual([])
    expect(snapshot).toEqual(before)
  })
})
