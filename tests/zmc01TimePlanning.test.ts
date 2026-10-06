import { describe, expect, it } from 'vitest'
import { createSnapshot } from '../src/snapshot.js'
import { validateSnapshot } from '../src/snapshot.js'
import { selectTodayWeb } from '../src/today/todayWebSelector.js'
import type { Action, ScheduleNode } from '../src/model.js'
import { applyUserDomainCommand } from '../src/domainCommands.js'
import { capacityForDate, validateTimePlanningPreferences } from '../src/timePlanningPreferences.js'
import { diffCommandObjects, domainIntentObjects } from '../gateway/commandObjects.js'
import { applyUserCommandSchema } from '../gateway/userCommands.js'
import { buildTodayBrief } from '../src/todayBrief.js'
import { getTodayPlan } from '../src/ai/readLayer.js'

const NOW = new Date('2026-09-25T04:00:00.000Z')
const ZONE = 'Asia/Shanghai'
const CREATED = '2026-09-20T00:00:00.000Z'

function flexible(id: string): Action {
  return { id, kind: 'manual', title: `Prepare ${id}`, status: 'todo',
    estimatedMinutes: 30, leverage: 75, delayCost: 50,
    dueAt: '2026-09-25', duePrecision: 'date', timingMode: 'deadline',
    createdAt: CREATED, updatedAt: CREATED }
}

function node(id: string, startAt: string, endAt: string): ScheduleNode {
  return { id, occurrenceId: id, version: 1, kind: 'interview', state: 'scheduled',
    constraintKind: 'employer_hard',
    temporal: { shape: 'fixed_range', precision: 'datetime', timezone: ZONE, startAt, endAt,
      resolutionBasis: 'source_explicit' },
    evidenceRefs: [], sourceVersionRefs: [], relatedActionIds: [], relatedPrepIds: [],
    createdAt: CREATED, updatedAt: CREATED }
}

function source(actions: Action[], nodes: ScheduleNode[] = []) {
  return createSnapshot({ opportunities: [], processes: [], processEvents: [], actions,
    scheduleNodes: nodes, prep: [], applicationGroups: [] }, NOW.toISOString())
}

describe('ZMC-01 owner time planning', () => {
  it.each([120, 360, 480])('keeps flexible work within %i minutes instead of adding every due-today action', availableMinutes => {
    const snapshot = source(Array.from({ length: 60 }, (_, i) => flexible(`task-${i}`)))
    const selected = selectTodayWeb(snapshot, { availableMinutes }, { now: NOW, timezone: ZONE })
    expect(selected.actions.reduce((sum, item) => sum + item.estimatedMinutes, 0)).toBeLessThanOrEqual(availableMinutes)
    expect(selected.actionCount).toBeGreaterThan(0)
    expect(selected.actionCount).toBeLessThanOrEqual(availableMinutes / 30)
    expect(selected.criticalWarnings).toEqual([])
    expect(selected.overBudgetMinutes).toBe(0)
    expect(snapshot.data.actions).toHaveLength(60)
  })

  it('does not invent a capacity conflict when flexible work can wait', () => {
    const snapshot = source(Array.from({ length: 30 }, (_, i) => flexible(`overflow-${i}`)))
    const selected = selectTodayWeb(snapshot, { availableMinutes: 120 }, { now: NOW, timezone: ZONE })
    expect(selected.criticalWarnings).toEqual([])
    expect(selected.overBudgetMinutes).toBe(0)
    expect(selected.actionCount).toBeLessThanOrEqual(4)
  })

  it('names two genuinely overlapping fixed interviews instead of a generic planning warning', () => {
    const snapshot = source([], [
      node('interview-a', '2026-09-25T07:00:00.000Z', '2026-09-25T08:00:00.000Z'),
      node('interview-b', '2026-09-25T07:30:00.000Z', '2026-09-25T08:30:00.000Z'),
    ])
    const selected = selectTodayWeb(snapshot, { availableMinutes: 480 }, { now: NOW, timezone: ZONE })
    expect(selected.criticalWarnings).toHaveLength(1)
    expect(selected.criticalWarnings[0]?.relatedIds).toEqual(expect.arrayContaining(['interview-a', 'interview-b']))
  })

  it('clips a cross-midnight fixed appointment to the current day', () => {
    const snapshot = source(Array.from({ length: 12 }, (_, i) => flexible(`task-${i}`)), [
      node('overnight', '2026-09-24T15:00:00.000Z', '2026-09-24T17:00:00.000Z'),
    ])
    const selected = selectTodayWeb(snapshot, { availableMinutes: 360 }, { now: NOW, timezone: ZONE })
    expect(selected.actionCount).toBe(8)
    expect(selected.criticalWarnings).toEqual([])
  })

  it('warns about physical hard deadline conflicts but never flexible overflow', () => {
    const hard = { ...flexible('submit'), kind: 'apply' as const, estimatedMinutes: 120,
      dueAt: '2026-09-25T04:30:00.000Z', duePrecision: 'datetime' as const }
    const snapshot = source([hard, ...Array.from({ length: 30 }, (_, i) => flexible(`optional-${i}`))])
    const selected = selectTodayWeb(snapshot, { availableMinutes: 480 }, { now: NOW, timezone: ZONE })
    expect(selected.criticalWarnings).toHaveLength(1)
    expect(selected.criticalWarnings[0]?.relatedIds).toEqual(['submit'])
    expect(selected.actions.map(item => item.actionId)).not.toContain('submit')
    expect(selected.notSelectedHardActions.map(item => item.actionId)).toEqual(['submit'])
    expect(selected.actions.reduce((sum, item) => sum + item.estimatedMinutes, 0)).toBeLessThanOrEqual(480)
  })

  it('uses actual work windows and reserves only fixed commitments inside them', () => {
    const snapshot = source(Array.from({ length: 20 }, (_, i) => flexible(`window-task-${i}`)), [
      node('inside', '2026-09-25T02:00:00.000Z', '2026-09-25T03:00:00.000Z'),
      node('outside', '2026-09-25T06:00:00.000Z', '2026-09-25T07:00:00.000Z'),
    ])
    snapshot.data.timePlanning = { version: 1, updatedAt: NOW.toISOString(), defaultDailyMinutes: 480,
      weeklyWindows: [{ weekday: 5, startMinute: 540, endMinute: 720 }] }
    const selected = selectTodayWeb(snapshot, {}, { now: new Date('2026-09-25T01:00:00.000Z'), timezone: ZONE })
    expect(selected.capacityMinutes).toBe(900)
    expect(selected.actionCount).toBe(4)
    expect(selected.criticalWarnings).toEqual([])
  })

  it('does not put work into a remaining window occupied by a fixed meeting', () => {
    const snapshot = source(Array.from({ length: 4 }, (_, i) => flexible(`late-window-${i}`)), [
      node('meeting', '2026-09-25T02:00:00.000Z', '2026-09-25T03:00:00.000Z'),
    ])
    snapshot.data.timePlanning = { version: 1, updatedAt: NOW.toISOString(), defaultDailyMinutes: 120,
      weeklyWindows: [{ weekday: 5, startMinute: 540, endMinute: 660 }] }
    const selected = selectTodayWeb(snapshot, {}, { now: new Date('2026-09-25T02:00:00.000Z'), timezone: ZONE })
    expect(selected.actions).toEqual([])
    expect(selected.criticalWarnings).toEqual([])
  })

  it('protects a shared application choice deadline even with a legacy user-plan node', () => {
    const group = { ...flexible('shared-choice'), kind: 'group_decision' as const, estimatedMinutes: 60,
      dueAt: '2026-09-25T08:00:00.000Z', duePrecision: 'datetime' as const }
    const snapshot = source([group])
    const selected = selectTodayWeb(snapshot, { availableMinutes: 0 }, { now: NOW, timezone: ZONE })
    expect(selected.actions).toEqual([])
    expect(selected.notSelectedHardActions.map(item => item.actionId)).toEqual(['shared-choice'])
    expect(selected.criticalWarnings[0]?.relatedIds).toEqual(['shared-choice'])
    const brief = buildTodayBrief(snapshot, { availableMinutes: 0 }, { now: NOW, timezone: ZONE })
    expect(brief.nextAction?.actionId).toBe('shared-choice')
  })

  it('marks next-day hard work as not selected when it exceeds today capacity', () => {
    const apply = { ...flexible('tomorrow-deadline'), kind: 'apply' as const, estimatedMinutes: 240,
      dueAt: '2026-09-25T17:00:00.000Z', duePrecision: 'datetime' as const }
    const selected = selectTodayWeb(source([apply]), { availableMinutes: 60 }, { now: NOW, timezone: ZONE })
    expect(selected.actions).toEqual([])
    expect(selected.notSelectedHardActions.map(item => item.actionId)).toEqual(['tomorrow-deadline'])
    expect(selected.criticalWarnings[0]?.relatedIds).toEqual(['tomorrow-deadline'])
  })

  it('persists default, today override and windows through snapshot and account commands', () => {
    const base = source([])
    const initial = applyUserDomainCommand(base, { commandId: 'capacity-default-1', kind: 'set_daily_capacity', minutes: 480 }, NOW)
    const today = applyUserDomainCommand(initial.snapshot, { commandId: 'capacity-today-1', kind: 'set_date_capacity', date: '2026-09-25', minutes: 120 }, NOW)
    const windows = applyUserDomainCommand(today.snapshot, { commandId: 'capacity-windows-1', kind: 'set_work_windows',
      windows: [{ weekday: 5, startMinute: 540, endMinute: 720 }] }, NOW)
    const reloaded = JSON.parse(JSON.stringify(windows.snapshot))
    validateSnapshot(reloaded)
    expect(reloaded.data.timePlanning.defaultDailyMinutes).toBe(480)
    expect(capacityForDate(reloaded.data.timePlanning, '2026-09-25', 5)).toBe(120)
    expect(capacityForDate(reloaded.data.timePlanning, '2026-09-26', 6)).toBe(480)
    expect(domainIntentObjects({ commandId: 'capacity-today-2', kind: 'set_date_capacity', date: '2026-09-26', minutes: 360 }, reloaded))
      .toContainEqual({ type: 'time_planning', id: '2026-09-26' })
    expect(diffCommandObjects(base, reloaded)).toContainEqual({ type: 'time_planning', id: '2026-09-25' })
    expect(applyUserCommandSchema.safeParse({ commandId: 'capacity-today-2', kind: 'set_date_capacity', date: '2026-09-26', minutes: 360 }).success).toBe(true)
  })

  it('rejects invalid and overlapping preferences without changing a snapshot', () => {
    const base = source([])
    expect(validateTimePlanningPreferences({ version: 1, updatedAt: NOW.toISOString(), dateOverrides: { '2026-02-30': 60 } })).not.toEqual([])
    expect(() => applyUserDomainCommand(base, { commandId: 'capacity-windows-2', kind: 'set_work_windows',
      windows: [{ weekday: 1, startMinute: 540, endMinute: 600 }, { weekday: 1, startMinute: 570, endMinute: 630 }] }, NOW)).toThrow(/overlap/)
    expect(base.data.timePlanning).toBeUndefined()
  })

  it('uses the live day remainder for Web and preserves external unknown-availability contracts', () => {
    const snapshot = source([flexible('one'), flexible('two')])
    expect(selectTodayWeb(snapshot, {}, { now: NOW, timezone: ZONE }).capacityMinutes).toBe(720)
    expect(buildTodayBrief(snapshot, {}, { now: NOW, timezone: ZONE }).availableMinutes).toBeNull()
    expect(getTodayPlan(snapshot, {}, { now: NOW, timezone: ZONE }).availableMinutes).toBeNull()
    expect(getTodayPlan(snapshot, {}, { now: NOW, timezone: ZONE }).startableActions).toHaveLength(1)
  })

  it('honors zero and sub-30-minute capacity in the external brief', () => {
    const briefSource = source([{ ...flexible('short'), estimatedMinutes: 20 }])
    const zero = buildTodayBrief(briefSource, { availableMinutes: 0 }, { now: NOW, timezone: ZONE })
    expect(zero.availableMinutes).toBe(0)
    expect(zero.nextAction).toBeUndefined()
    expect(zero.plannedMinutes).toBe(0)
    expect(zero.materialCoverageWarnings.filter(item => item.code === 'capacity_conflict')).toEqual([])
    const short = buildTodayBrief(briefSource, { availableMinutes: 20 }, { now: NOW, timezone: ZONE })
    expect(short.nextAction?.actionId).toBe('short')
    expect(short.plannedMinutes).toBe(20)
  })

  it('resolves a requested AI plan date in the requested timezone', () => {
    const snapshot = source([flexible('future')])
    snapshot.data.timePlanning = { version: 1, updatedAt: NOW.toISOString(), defaultDailyMinutes: 480,
      dateOverrides: { '2026-09-25': 120 } }
    const result = getTodayPlan(snapshot, { date: '2026-09-25' }, {
      now: new Date('2026-09-20T12:00:00.000Z'), timezone: 'America/Los_Angeles',
    })
    expect(result.date).toBe('2026-09-25')
    expect(result.availableMinutes).toBe(120)
  })
})
