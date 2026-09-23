import { describe, expect, it } from 'vitest'
import { buildOpportunityDecisionList, getOpportunityDecisionRead } from '../src/opportunityDecisionRead.js'
import { rankActions } from '../src/decisionV3.js'
import { createSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'
import type { Action, Opportunity, ProcessEvent, ProcessRecord } from '../src/model.js'

const NOW = new Date('2026-09-21T00:00:00.000Z')

function opportunity(id: string, stage: Opportunity['processStage'], overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    id,
    company: 'Example Co',
    role: id,
    currentStageLabel: stage,
    processStage: stage,
    roleType: 'core',
    participationStatus: 'active',
    early: false,
    opportunityValue: 88,
    fitScore: 84,
    importedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

function action(id: string, opportunityId: string, overrides: Partial<Action> = {}): Action {
  return {
    id,
    kind: 'apply',
    title: id,
    opportunityId,
    processStage: 'not_applied',
    estimatedMinutes: 30,
    leverage: 82,
    delayCost: 80,
    status: 'todo',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    ...overrides,
  }
}

function snapshot(data: Partial<PJSDASSnapshot['data']>): PJSDASSnapshot {
  return createSnapshot({
    opportunities: data.opportunities ?? [],
    processes: data.processes ?? [],
    processEvents: data.processEvents ?? [],
    actions: data.actions ?? [],
    prep: data.prep ?? [],
    applicationGroups: data.applicationGroups ?? [],
    decisionRules: data.decisionRules,
    timeline: data.timeline ?? [],
    decisionRequests: data.decisionRequests ?? [],
    semanticReceipts: data.semanticReceipts ?? [],
  }, '2026-09-20T23:59:00.000Z')
}

describe('UU-05 Opportunity decision read model', () => {
  it('groups only active recruiting processes under In Progress and active pre-application roles under Worth Pursuing', () => {
    const inProgress = opportunity('interview-role', 'interview')
    const worth = opportunity('apply-role', 'not_applied')
    const abandoned = opportunity('abandoned-role', 'not_applied', { participationStatus: 'abandoned' })
    const closed = opportunity('closed-role', 'closed')
    const expired = opportunity('expired-role', 'not_applied', { deadline: '2026-09-20T00:00:00.000Z' })

    const read = buildOpportunityDecisionList(snapshot({
      opportunities: [inProgress, worth, abandoned, closed, expired],
      actions: [action('apply:apply-role', worth.id)],
    }), { now: NOW, timezone: 'Asia/Shanghai', workspaceVersion: 'txn:22' })

    expect(read.inProgress.map((item) => item.opportunityId)).toEqual(['interview-role'])
    expect(read.worthPursuing.map((item) => item.opportunityId)).toEqual(['apply-role'])
    expect(read.endedCount).toBe(3)
    expect(read.workspaceRevision).toBe('txn:22')
  })

  it('uses the same ranked opportunity action semantics as Today and keeps internals out of the public read contract', () => {
    const opp = opportunity('role-1', 'not_applied', { early: true })
    const read = getOpportunityDecisionRead(snapshot({
      opportunities: [opp],
      actions: [
        action('later', opp.id, { title: 'Later', leverage: 20, delayCost: 20 }),
        action('best', opp.id, { title: 'Best action', leverage: 98, delayCost: 96 }),
      ],
    }), opp.id, { now: NOW, timezone: 'Asia/Shanghai' })

    expect(read?.nextAction?.actionId).toBe('best')
    expect(read?.nextAction?.rankingReasons.length).toBeGreaterThan(0)
    expect(read?.conclusion).toBe('worth_pursuing')
    expect(JSON.stringify(read)).not.toContain('fitScore')
    expect(JSON.stringify(read)).not.toContain('opportunityValue')
    expect(JSON.stringify(read)).not.toContain('offerProbability')
  })

  it('surfaces the nearest canonical ScheduleNode and preserves elapsed-unresolved recovery', () => {
    const opp = opportunity('role-node', 'interview')
    const process: ProcessRecord = {
      id: 'process-role-node',
      opportunityId: opp.id,
      company: opp.company,
      role: opp.role,
      stage: 'interview',
      stageLabel: '面试',
      progress: 'scheduled',
      result: 'pending',
      participationState: 'active',
      lastProgressAt: '2026-09-19T00:00:00.000Z',
    }
    const event: ProcessEvent = {
      id: 'interview-past',
      opportunityId: opp.id,
      company: opp.company,
      role: opp.role,
      type: 'interview_invite',
      occurredAt: '2026-09-18T00:00:00.000Z',
      dueAt: '2026-09-20T02:00:00.000Z',
      duePrecision: 'datetime',
      timingMode: 'fixed',
      estimatedMinutes: 60,
      source: 'manual',
      createdAt: '2026-09-18T00:00:00.000Z',
      updatedAt: '2026-09-18T00:00:00.000Z',
    }

    const read = getOpportunityDecisionRead(snapshot({
      opportunities: [opp],
      processes: [process],
      processEvents: [event],
    }), opp.id, { now: NOW, timezone: 'Asia/Shanghai' })

    expect(read?.nearestNode).toMatchObject({
      occurrenceId: 'process-event:interview-past',
      kind: 'interview',
      state: 'elapsed_unresolved',
      requiresResolution: true,
    })
    expect(read?.reasons).toContainEqual({ code: 'elapsed_node_unresolved', tone: 'risk' })
  })

  it('makes offer, abandoned, and closed conclusions explicit without conflating them', () => {
    const offer = opportunity('offer-role', 'offer')
    const abandoned = opportunity('abandoned-role', 'interview', { participationStatus: 'abandoned' })
    const closed = opportunity('closed-role', 'closed')
    const source = snapshot({ opportunities: [offer, abandoned, closed] })

    expect(getOpportunityDecisionRead(source, offer.id, { now: NOW })?.conclusion).toBe('review_offer')
    expect(getOpportunityDecisionRead(source, abandoned.id, { now: NOW })?.conclusion).toBe('not_pursuing')
    expect(getOpportunityDecisionRead(source, closed.id, { now: NOW })?.conclusion).toBe('process_ended')
  })

  it('keeps a stale action on an ended opportunity out of Today and opportunity detail without deleting its record', () => {
    const closed = opportunity('closed-stale-role', 'closed')
    const stale = action('stale-apply', closed.id)
    const source = snapshot({ opportunities: [closed], actions: [stale] })
    expect(rankActions(source.data.actions, source.data.opportunities, NOW)).toEqual([])
    expect(getOpportunityDecisionRead(source, closed.id, { now: NOW })?.nextAction).toBeUndefined()
    expect(source.data.actions).toContainEqual(stale)
  })

  it('is deterministic for the same revision, clock and timezone', () => {
    const opp = opportunity('stable-role', 'not_applied')
    const source = snapshot({ opportunities: [opp], actions: [action('apply-stable', opp.id)] })
    const context = { now: NOW, timezone: 'Asia/Shanghai', workspaceVersion: 'txn:9' }
    expect(buildOpportunityDecisionList(source, context)).toEqual(buildOpportunityDecisionList(source, context))
  })
})

describe('UU-05 deadline precision regression', () => {
  it.each([
    ['2026-09-20', '2026-09-21T04:00:00Z', 'Asia/Shanghai', true],
    ['2026-09-21', '2026-09-21T04:00:00Z', 'Asia/Shanghai', false],
    ['2026-09-22', '2026-09-21T04:00:00Z', 'Asia/Shanghai', false],
    ['2026-09-21', '2026-09-21T23:30:00Z', 'America/Los_Angeles', false],
    ['2026-09-21', '2026-09-22T00:30:00Z', 'America/Los_Angeles', false],
    ['2026-09-21', '2026-09-22T07:00:00Z', 'America/Los_Angeles', true],
    ['2026-09-21', '2026-09-21T15:59:59Z', 'Asia/Shanghai', false],
    ['2026-09-21', '2026-09-21T16:00:00Z', 'Asia/Shanghai', true],
  ])('date-only %s at %s in %s preserves the whole calendar day', (deadline, instant, timezone, expired) => {
    const opp = opportunity('date-role', 'not_applied', { deadline, deadlinePrecision: 'date' })
    const source = snapshot({ opportunities: [opp] })
    const ctx = { now: new Date(instant), timezone }
    const detail = getOpportunityDecisionRead(source, opp.id, ctx)!
    const list = buildOpportunityDecisionList(source, ctx)
    expect(detail.bucket).toBe(expired ? 'ended' : 'worth_pursuing')
    expect(detail.conclusion).toBe(expired ? 'application_window_closed' : 'worth_pursuing')
    expect(detail.nearestNode?.state).toBe(expired ? 'elapsed_unresolved' : 'scheduled')
    expect(list.all[0]).toEqual(detail)
    expect(list.worthPursuing).toHaveLength(expired ? 0 : 1)
    expect(detail.reasons.some((reason) => reason.code === 'deadline_near')).toBe(!expired)
  })

  it.each([
    ['2026-09-21T03:59:59Z', false],
    ['2026-09-21T04:00:00Z', false],
    ['2026-09-21T04:00:01Z', true],
  ])('datetime expiry retains its exact instant at %s', (instant, expired) => {
    const opp = opportunity('timed-role', 'not_applied', {
      deadline: '2026-09-21T12:00:00+08:00', deadlinePrecision: 'datetime',
    })
    const source = snapshot({ opportunities: [opp] })
    for (const timezone of ['Asia/Shanghai', 'America/Los_Angeles']) {
      const ctx = { now: new Date(instant), timezone }
      const detail = getOpportunityDecisionRead(source, opp.id, ctx)!
      expect(detail.bucket).toBe(expired ? 'ended' : 'worth_pursuing')
      expect(buildOpportunityDecisionList(source, ctx).all[0]).toEqual(detail)
      expect(detail.reasons.some((reason) => reason.code === 'deadline_near')).toBe(!expired)
    }
  })
})
