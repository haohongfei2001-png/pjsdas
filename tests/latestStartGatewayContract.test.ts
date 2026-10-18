import { describe, expect, it, vi } from 'vitest'
import * as z from 'zod/v4'
import { semanticIntakeSchema, paiaIntakeSchema, invokeSemanticIntake, invokePaiaIntake } from '../gateway/semanticIntake.js'
import { applyUserCommandSchema, invokeApplyUserCommand } from '../gateway/userCommands.js'
import { authoritativeBusinessCommandSchema } from '../gateway/authoritativeCommands.js'
import type { WorkspaceSource, WorkspaceWriteInput } from '../gateway/workspaceSource.js'
import { applySemanticIntake } from '../src/semanticIntake.js'
import { applyUserDomainCommand } from '../src/domainCommands.js'
import { createSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'
import { resolveSourceTemporal } from '../src/sourceTemporal.js'
import { scheduleNodeEligible, isRecruitingAppointment } from '../src/scheduleEligibility.js'
import { buildTodayBrief } from '../src/todayBrief.js'
import { opportunity } from '../e2e/fixtures/todayWorkspace.js'
import type { ScheduleNodeTemporal, SemanticIntakeObservation } from '../src/model.js'

const NOW = new Date('2026-09-21T12:28:00Z')
const TZ = 'Asia/Shanghai'
const window = resolveSourceTemporal('请于2026年9月23日18:00-20:00参加在线笔试，最晚18:20进入考试。',
  { receivedAt: NOW.toISOString(), timezone: TZ, mode: 'fixed' })!
function baseline() { return createSnapshot({ opportunities: [opportunity('job', 'Example Co', 'Product Manager')],
  processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [] }) }
function observation(temporal = window): SemanticIntakeObservation {
  return { contractVersion: 1, inputId: 'latest-start-window-input', source: { kind: 'mcp', sourceId: 'synthetic-mcp',
    sourceRecordId: 'synthetic-notice', observedAt: NOW.toISOString(), assertedAt: NOW.toISOString(), timezone: TZ },
  statementMode: 'assertion', candidates: [{ id: 'window-candidate', kind: 'process_event', eventType: 'written_test_invite',
    target: { opportunityId: 'job' }, objectConfidence: 'high', eventConfidence: 'high', temporalConfidence: 'high',
    temporal, evidenceRefs: ['synthetic-notice'], sourceVersionRefs: [] }] }
}
function workspace(state = baseline()) {
  const writes: WorkspaceWriteInput[] = []
  const source: WorkspaceSource = { read: async () => ({ snapshot: state, context: { workspaceVersion: 'txn:1', now: NOW, timezone: TZ } }),
    write: async input => { writes.push(input); state = input.snapshot
      return { snapshot: state, context: { workspaceVersion: 'txn:2', now: NOW, timezone: TZ } } } }
  return { source, writes, current: () => state }
}
function seed() { return applySemanticIntake(baseline(), observation({ shape: 'fixed_range', precision: 'datetime', timezone: TZ, startAt: window.startAt, resolutionBasis: 'source_explicit' }), { authorized: true, workspaceRevision: 'txn:1', now: NOW }).snapshot }
function reschedule(state: PJSDASSnapshot, temporal = window) {
  return { commandId: 'latest-start-reschedule', kind: 'reschedule_occurrence' as const,
    occurrenceId: state.data.scheduleNodes![0]!.occurrenceId, temporal }
}

describe('A18 existing latest-start public contract', () => {
  it('preserves the source window through the real schema and domain write without making a fixed appointment', async () => {
    const expected = applySemanticIntake(baseline(), observation(), { authorized: true, workspaceRevision: 'txn:1', now: NOW })
    expect(expected.status).toBe('APPLIED')
    const w = workspace(), authorize = vi.fn(async () => undefined)
    const result = await invokeSemanticIntake(w.source, observation(), { authorize })
    expect(result.isError).not.toBe(true)
    expect(authorize).toHaveBeenCalledOnce()
    expect(w.writes).toHaveLength(1)
    expect(w.current().data).toEqual(expected.snapshot.data)
    const state = w.current(), event = state.data.processEvents[0]!
    expect(event).toMatchObject({ temporal: window, dueAt: window.endAt, timingMode: 'deadline' })
    expect(state.data.scheduleNodes).toEqual([])
    expect(isRecruitingAppointment(event)).toBe(false)
    const brief = buildTodayBrief(state, {}, { now: new Date('2026-09-23T09:30:00Z'), timezone: TZ })
    const action = state.data.actions.find(a => a.processEventId === event.id)!
    const next = [brief.nextAction, ...brief.nextActions].find(a => a?.actionId === action.id)
    expect(next?.timing).toMatchObject({ shape: 'availability_window', latestStartAt: window.latestStartAt })
  })

  it('preserves the field in PAIA, authoritative HTTP and the published MCP JSON schemas', async () => {
    const input = observation(); input.source = { ...input.source, kind: 'paia', sourceId: 'paia:synthetic-input' }
    expect(paiaIntakeSchema.safeParse(input).success).toBe(true)
    expect(authoritativeBusinessCommandSchema.safeParse({ commandId: 'window-envelope', baseRevision: 1,
      command: { type: 'semantic_intake', value: input } }).success).toBe(true)
    for (const schema of [semanticIntakeSchema, paiaIntakeSchema, applyUserCommandSchema]) {
      expect(JSON.stringify(z.toJSONSchema(schema, { io: 'input' }))).toContain('"latestStartAt"')
    }
    const w = workspace()
    expect((await invokePaiaIntake(w.source, input, { authorize: async () => undefined })).isError).not.toBe(true)
    expect(w.current().data.processEvents[0]?.temporal?.latestStartAt).toBe(window.latestStartAt)
  })

  it('accepts explicit interval endpoints and equivalent offset representations', async () => {
    for (const latestStartAt of [window.startAt, window.endAt, '2026-09-23T10:20:00Z']) {
      const temporal = { ...window, latestStartAt }, w = workspace()
      expect((await invokeSemanticIntake(w.source, observation(temporal))).isError).not.toBe(true)
      expect(w.current().data.processEvents[0]?.temporal?.latestStartAt).toBe(latestStartAt)
    }
  })

  it.each(['UTC', 'source-offset'])('retains explicit instant-based timezone %s without guessing a local zone', async timezone => {
    const w = workspace(), input = observation({ ...window, timezone })
    expect((await invokeSemanticIntake(w.source, input)).isError).not.toBe(true)
    expect(w.current().data.processEvents[0]?.temporal).toMatchObject({ timezone, latestStartAt: window.latestStartAt })
  })

  it('passes the existing user reschedule DTO to the same guarded domain and keeps the window meaning', async () => {
    const state = seed(), temporal = { ...window, latestStartAt: '2026-09-23T18:30:00+08:00' }
    const input = reschedule(state, temporal), expected = applyUserDomainCommand(state, input, NOW)
    expect(expected.status).toBe('APPLIED')
    expect(authoritativeBusinessCommandSchema.safeParse({ commandId: input.commandId, baseRevision: 1,
      command: { type: 'domain', value: input } }).success).toBe(true)
    const w = workspace(state)
    expect((await invokeApplyUserCommand(w.source, input)).isError).not.toBe(true)
    expect(w.writes).toHaveLength(1)
    expect(w.current().data).toEqual(expected.snapshot.data)
    const node = w.current().data.scheduleNodes!.find(n => n.state === 'scheduled')!
    expect(node.temporal).toEqual(temporal)
    expect(scheduleNodeEligible(node, w.current().data)).toBe(false)
  })

  it.each([
    { latestStartAt: '2026-09-23T17:59:59+08:00' },
    { latestStartAt: '2026-09-23T20:00:01+08:00' },
    { latestStartAt: '2026-09-23T18:20:00' },
    { latestStartAt: '2026-02-30T18:20:00+08:00' },
    { latestStartAt: 'not-a-time' },
    { timezone: 'Unknown/Timezone' },
    { timezone: 'floating-date' },
    { shape: 'deadline', deadlineAt: window.endAt },
    { shape: 'fixed_range' },
    { shape: 'estimated_date', startAt: undefined, endAt: undefined },
    { startAt: undefined },
    { endAt: undefined },
    { endAt: window.startAt, latestStartAt: window.startAt },
    { startAt: window.endAt, endAt: window.startAt },
    { precision: 'date', date: '2026-09-23' },
  ])('rejects an invalid latest-start window before any workspace write: %j', async patch => {
    const temporal = { ...window, ...patch } as ScheduleNodeTemporal
    const w = workspace(), before = structuredClone(w.current()), read = vi.spyOn(w.source, 'read')
    expect((await invokeSemanticIntake(w.source, observation(temporal))).isError).toBe(true)
    expect(read).not.toHaveBeenCalled()
    const lowConfidence = observation(temporal); lowConfidence.candidates[0]!.objectConfidence = 'low'
    expect((await invokeSemanticIntake(w.source, lowConfidence)).isError).toBe(true)
    expect(read).not.toHaveBeenCalled()
    expect(w.writes).toEqual([]); expect(w.current()).toEqual(before)
    const state = seed(), user = workspace(state), old = structuredClone(state), userRead = vi.spyOn(user.source, 'read')
    expect((await invokeApplyUserCommand(user.source, reschedule(state, temporal))).isError).toBe(true)
    expect(userRead).not.toHaveBeenCalled()
    expect(user.writes).toEqual([]); expect(user.current()).toEqual(old)
  })

  it('retains source authorization and rejects unknown fields without reads or writes', async () => {
    const w = workspace(), read = vi.spyOn(w.source, 'read')
    const result = await invokeSemanticIntake(w.source, observation(), { authorize: async () => { throw new Error('source denied') } })
    expect(result.isError).toBe(true); expect(read).not.toHaveBeenCalled(); expect(w.writes).toEqual([])
    expect(semanticIntakeSchema.safeParse(observation({ ...window, guessedStart: window.startAt } as ScheduleNodeTemporal)).success).toBe(false)
  })
})
