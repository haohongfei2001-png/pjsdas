import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyDomainCompensation, applyUserDomainCommand } from '../src/domainCommands.js'
import { applyProcessEventDeleteCommand } from '../src/processEventDeleteCommand.js'
import { createSnapshot } from '../src/snapshot.js'
import { authoritativeBusinessCommandSchema, createAuthoritativeCommandExecutor } from '../gateway/authoritativeCommands.js'
import { applyUserCommandSchema } from '../gateway/userCommands.js'

const at = new Date('2026-09-24T04:00:00.000Z')
const base = () => createSnapshot({
  opportunities: [{ id: 'opp-1', company: 'Example', role: 'Engineer', currentStageLabel: '待投',
    processStage: 'not_applied', roleType: 'core', early: false, opportunityValue: 70,
    fitScore: 75, assessmentStatus: 'unassessed', locallyManaged: true,
    importedAt: at.toISOString() }],
  processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [],
}, at.toISOString())

function withEvent() {
  const created = applyUserDomainCommand(base(), {
    commandId: 'process-create:test-1', kind: 'record_process_event', opportunityId: 'opp-1',
    eventType: 'interview_invite', occurredAt: at.toISOString(),
    dueAt: '2026-09-25T04:00:00.000Z', timingMode: 'fixed', source: 'manual',
  }, at)
  if (created.status !== 'APPLIED') throw new Error('fixture did not create an event')
  return created.snapshot
}

afterEach(() => vi.useRealTimers())

describe('CGR-05 first-party process event deletion', () => {
  it('removes only the selected event, cancels its schedule, and restores it with Undo', () => {
    const before = withEvent()
    const event = before.data.processEvents[0]!
    const action = before.data.actions.find((item) => item.processEventId === event.id)!
    const priorNodes = (before.data.scheduleNodes ?? []).filter((item) => item.processEventId === event.id)
    expect(priorNodes.length).toBeGreaterThan(0)
    const deleted = applyProcessEventDeleteCommand(before, event.id, new Date('2026-09-24T04:01:00.000Z'))
    expect(deleted.snapshot.data.processEvents).toHaveLength(0)
    expect(deleted.snapshot.data.actions.some((item) => item.id === action.id)).toBe(false)
    expect(deleted.snapshot.data.scheduleNodes?.filter((item) => item.processEventId === event.id && item.state !== 'cancelled')).toHaveLength(0)
    expect(deleted.snapshot.data.timeline?.at(-1)?.kind).toBe('process_event_deleted')
    expect(before.data.processEvents).toHaveLength(1)
    const restored = applyDomainCompensation(deleted.snapshot, deleted.compensation, new Date('2026-09-24T04:02:00.000Z'))
    expect(restored.data.processEvents).toMatchObject([event])
    expect(restored.data.actions.find((item) => item.id === action.id)).toMatchObject(action)
    expect(restored.data.scheduleNodes?.filter((item) => item.processEventId === event.id)).toMatchObject(priorNodes)
    expect(() => applyProcessEventDeleteCommand(deleted.snapshot, event.id)).toThrow('no longer exists')
  })

  for (const state of ['completed', 'elapsed_unresolved', 'scheduled'] as const) it(`retains ${state} historical references with an explicit refusal`, () => {
    const before = withEvent()
    const node = before.data.scheduleNodes![0]
    node.state = state
    node.temporal = { shape: 'deadline', precision: 'datetime', timezone: 'UTC', deadlineAt: '2026-09-20T00:00:00.000Z', resolutionBasis: 'legacy_projection' }
    const unchanged = structuredClone(before)
    const result = applyProcessEventDeleteCommand(before, before.data.processEvents[0].id, at)
    expect(result).toMatchObject({ status: 'NEEDS_CONFIRMATION', changed: false, reason: 'HISTORICAL_OCCURRENCES_RETAINED' })
    expect(result.snapshot).toEqual(unchanged)
    expect(before).toEqual(unchanged)
  })

  it('delete Undo touches only its cancelled node and refuses an edited affected occurrence', () => {
    const before = withEvent()
    const node = before.data.scheduleNodes![0]
    before.data.scheduleNodes!.push({ ...structuredClone(node), id: 'retained-superseded', occurrenceId: 'retained-superseded', state: 'superseded' })
    const deleted = applyProcessEventDeleteCommand(before, before.data.processEvents[0].id, at)
    if (!deleted.compensation) throw Error('Expected deletion compensation')
    const later = structuredClone(deleted.snapshot)
    later.data.scheduleNodes!.find((item) => item.id === 'retained-superseded')!.sourceVersionRefs.push('later:retained-source')
    const restored = applyDomainCompensation(later, JSON.parse(JSON.stringify(deleted.compensation)), at)
    expect(restored.data.scheduleNodes!.find((item) => item.id === 'retained-superseded')!.sourceVersionRefs).toContain('later:retained-source')
    later.data.scheduleNodes!.find((item) => item.id === node.id)!.updatedAt = '2026-09-24T05:00:00.000Z'
    expect(() => applyDomainCompensation(later, deleted.compensation!, at)).toThrow(/changed/)
  })

  it('restores every action removed by one scoped event deletion', () => {
    const before = withEvent()
    const original = before.data.actions.find((item) => item.processEventId === before.data.processEvents[0].id)!
    before.data.actions.push({ ...structuredClone(original), id: 'second-event-action', title: 'Second linked preparation' })
    const deleted = applyProcessEventDeleteCommand(before, before.data.processEvents[0].id, at)
    if (!deleted.compensation) throw Error('Expected deletion compensation')
    const restored = applyDomainCompensation(deleted.snapshot, JSON.parse(JSON.stringify(deleted.compensation)), at)
    for (const action of before.data.actions) expect(restored.data.actions).toContainEqual(action)
    expect(deleted.snapshot.data.actions.some((item) => item.processEventId === original.processEventId)).toBe(false)
  })

  it('keeps deletion outside delegated MCP while committing one scoped receipt', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(at)
    let current = withEvent()
    let revision = 1
    let commits = 0
    const eventId = current.data.processEvents[0]!.id
    const command = { commandId: 'process-delete:test-1', baseRevision: 1,
      command: { type: 'process_event_delete', value: { eventId } } }
    expect(authoritativeBusinessCommandSchema.safeParse(command).success).toBe(true)
    expect(applyUserCommandSchema.safeParse({ kind: 'process_event_delete', eventId }).success).toBe(false)
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/rest/v1/pjsdas_workspaces') {
        return Response.json([{ id: 'ws-1', user_id: 'account-a', snapshot: current, revision,
          schema_version: current.version }])
      }
      if (url.pathname === '/rest/v1/pjsdas_command_ledger') return Response.json([])
      if (url.pathname === '/rest/v1/rpc/pjsdas_commit_workspace_v2') {
        const body = JSON.parse(String(init?.body))
        commits += 1
        expect(body.target_operation).toBe('process_event_delete')
        expect(body.target_receipt_context.affectedObjects).toEqual(expect.arrayContaining([
          { type: 'process_event', id: eventId },
          { type: 'action', id: `event-action:${eventId}` },
        ]))
        expect(body.target_compensation).toMatchObject({ operation: 'restore_deleted_process_event' })
        current = body.target_snapshot
        revision += 1
        return Response.json([{ outcome: 'COMMITTED', workspace_id: 'ws-1', revision,
          snapshot: current, receipt: { status: 'COMMITTED', commandId: body.target_command_id } }])
      }
      return Response.json({ message: `Unexpected ${url.pathname}` }, { status: 500 })
    }) as unknown as typeof fetch
    const executor = createAuthoritativeCommandExecutor({
      supabaseUrl: 'https://example.supabase.co', serviceRoleKey: 'test-service-role', fetchImpl,
    })
    await expect(executor.execute({ kind: 'delegated_mcp', userId: 'account-a' }, command))
      .rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' })
    expect(commits).toBe(0)
    const result = await executor.execute({ kind: 'first_party_web', userId: 'account-a' }, command)
    expect(result.outcome).toBe('COMMITTED')
    expect(current.data.processEvents).toHaveLength(0)
    expect(commits).toBe(1)
  })
})
