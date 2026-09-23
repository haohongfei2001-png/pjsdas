import { describe, expect, it, vi } from 'vitest'
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

  it('keeps deletion outside delegated MCP while committing one scoped receipt', async () => {
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
