import { describe, expect, it, vi } from 'vitest'
import { createAuthoritativeCommandExecutor } from '../gateway/authoritativeCommands.js'
import { upgradeSnapshotToLatest, type PJSDASSnapshot } from '../src/snapshot.js'

function snapshot(): PJSDASSnapshot {
  return {
    schema: 'pjsdas-local-snapshot',
    version: 1,
    exportedAt: '2026-09-23T00:00:00.000Z',
    data: {
      opportunities: [{
        id: 'opp-1',
        company: 'Alpha',
        role: 'Role A',
        stage: '准备申请',
        source: 'Manual',
        sourceType: 'Manual',
        nextStep: 'Apply',
        urgency: 50,
        opportunityValue: 50,
        fitScore: 50,
        assessmentStatus: 'unassessed',
        locallyManaged: true,
        importedAt: '2026-09-23T00:00:00.000Z',
      }, {
        id: 'opp-2',
        company: 'Beta',
        role: 'Role B',
        stage: '准备申请',
        source: 'Manual',
        sourceType: 'Manual',
        nextStep: 'Apply',
        urgency: 50,
        opportunityValue: 50,
        fitScore: 50,
        assessmentStatus: 'unassessed',
        locallyManaged: true,
        importedAt: '2026-09-23T00:00:00.000Z',
      }],
      processes: [],
      processEvents: [],
      actions: [{
        id: 'action-1',
        kind: 'manual',
        title: 'Alpha task',
        opportunityId: 'opp-1',
        estimatedMinutes: 15,
        leverage: 50,
        delayCost: 50,
        status: 'todo',
        createdAt: '2026-09-23T00:00:00.000Z',
        updatedAt: '2026-09-23T00:00:00.000Z',
      }, {
        id: 'action-2',
        kind: 'manual',
        title: 'Beta task',
        opportunityId: 'opp-2',
        estimatedMinutes: 15,
        leverage: 50,
        delayCost: 50,
        status: 'todo',
        createdAt: '2026-09-23T00:00:00.000Z',
        updatedAt: '2026-09-23T00:00:00.000Z',
      }],
      prep: [],
      applicationGroups: [],
      timeline: [],
    },
  }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}

function harness() {
  let current = upgradeSnapshotToLatest(snapshot())
  let revision = 1
  const ledger: Array<{
    command_id: string
    operation: string
    payload_hash: string
    resulting_revision: number
    status: 'COMMITTED'
    receipt: Record<string, unknown>
    compensation: Record<string, unknown> | null
  }> = []

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname === '/rest/v1/pjsdas_workspaces') {
      return json([{ id: 'ws-1', user_id: 'user-a', snapshot: current, revision, schema_version: current.version }])
    }
    if (url.pathname === '/rest/v1/pjsdas_command_ledger') {
      const commandId = url.searchParams.get('command_id')?.replace(/^eq\./, '')
      const after = Number(url.searchParams.get('resulting_revision')?.replace(/^gt\./, '') ?? '-1')
      const rows = ledger.filter((item) =>
        (commandId ? item.command_id === commandId : true)
        && (Number.isFinite(after) ? item.resulting_revision > after : true))
      return json(rows)
    }
    if (url.pathname === '/rest/v1/rpc/pjsdas_commit_workspace_v2') {
      const body = JSON.parse(String(init?.body))
      const existing = ledger.find((item) => item.command_id === body.target_command_id)
      if (existing) {
        if (existing.payload_hash !== body.target_payload_hash) return json({ message: 'different payload' }, 409)
        return json([{
          outcome: 'ALREADY_APPLIED',
          workspace_id: 'ws-1',
          revision,
          snapshot: current,
          receipt: existing.receipt,
        }])
      }
      if (body.target_expected_revision !== revision) {
        return json([{
          outcome: 'CONFLICT',
          workspace_id: 'ws-1',
          revision,
          snapshot: current,
          receipt: { status: 'CONFLICT', actualRevision: revision },
        }])
      }
      revision += 1
      current = body.target_snapshot
      const receipt = {
        ...body.target_receipt_context,
        commandId: body.target_command_id,
        receiptId: `command-receipt:${body.target_command_id}`,
        status: 'COMMITTED',
        operation: body.target_operation,
        revision,
        undoAvailable: Boolean(body.target_compensation),
      }
      ledger.push({
        command_id: body.target_command_id,
        operation: body.target_operation,
        payload_hash: body.target_payload_hash,
        resulting_revision: revision,
        status: 'COMMITTED',
        receipt,
        compensation: body.target_compensation,
      })
      return json([{ outcome: 'COMMITTED', workspace_id: 'ws-1', revision, snapshot: current, receipt }])
    }
    return json({ message: `unexpected ${url.pathname}` }, 500)
  }) as unknown as typeof fetch

  return {
    executor: createAuthoritativeCommandExecutor({
      supabaseUrl: 'https://example.supabase.co',
      serviceRoleKey: 'service-role',
      fetchImpl,
    }),
    principal: { kind: 'first_party_web' as const, userId: 'user-a' },
    ledger,
    state: () => ({ current, revision }),
  }
}

function statusCommand(commandId: string, actionId: string, status: 'todo' | 'in_progress' | 'done') {
  return {
    commandId,
    command: {
      type: 'domain' as const,
      value: { commandId, kind: 'set_action_status' as const, actionId, status },
    },
  }
}

describe('CGR-01 authoritative command executor', () => {
  it('recovers a committed command by stable identity and makes retry idempotent', async () => {
    const h = harness()
    const first = await h.executor.execute(h.principal, { ...statusCommand('cmd-action-0001', 'action-1', 'done'), baseRevision: 1 })
    expect(first).toMatchObject({
      outcome: 'COMMITTED',
      revision: 2,
      receipt: { receiptId: 'command-receipt:cmd-action-0001', undoAvailable: true },
    })
    const recovered = await h.executor.lookup(h.principal, 'cmd-action-0001')
    expect(recovered).toMatchObject({ found: true, resultingRevision: 2 })
    const retry = await h.executor.execute(h.principal, { ...statusCommand('cmd-action-0001', 'action-1', 'done'), baseRevision: 1 })
    expect(retry.outcome).toBe('ALREADY_APPLIED')
    expect(h.ledger).toHaveLength(1)
    expect(h.state().current.data.actions.find((item) => item.id === 'action-1')?.status).toBe('done')
  })

  it('rebases a stale command when only an unrelated business object changed', async () => {
    const h = harness()
    await h.executor.execute(h.principal, { ...statusCommand('cmd-action-0001', 'action-1', 'done'), baseRevision: 1 })
    const second = await h.executor.execute(h.principal, { ...statusCommand('cmd-action-0002', 'action-2', 'done'), baseRevision: 1 })
    expect(second).toMatchObject({
      outcome: 'COMMITTED',
      revision: 3,
      receipt: { lifecycle: { baseRevision: 1, authoritativeRevisionBeforeCommit: 2, rebased: true } },
    })
    expect(h.state().current.data.actions.map((item) => [item.id, item.status])).toEqual([
      ['action-1', 'done'],
      ['action-2', 'done'],
    ])
  })

  it('fails closed with concrete object conflict when the same object changed', async () => {
    const h = harness()
    await h.executor.execute(h.principal, { ...statusCommand('cmd-action-0001', 'action-1', 'done'), baseRevision: 1 })
    const conflict = await h.executor.execute(h.principal, { ...statusCommand('cmd-action-0002', 'action-1', 'in_progress'), baseRevision: 1 })
    expect(conflict).toMatchObject({
      outcome: 'CONFLICT',
      revision: 2,
      conflict: {
        kind: 'OBJECT_CONFLICT',
        objects: [{ type: 'action', id: 'action-1' }],
        interveningCommandIds: ['cmd-action-0001'],
      },
    })
    expect(h.state().current.data.actions.find((item) => item.id === 'action-1')?.status).toBe('done')
  })

  it('allows compensating Undo after an unrelated later mutation', async () => {
    const h = harness()
    await h.executor.execute(h.principal, { ...statusCommand('cmd-action-0001', 'action-1', 'done'), baseRevision: 1 })
    await h.executor.execute(h.principal, { ...statusCommand('cmd-action-0002', 'action-2', 'done'), baseRevision: 2 })
    const undone = await h.executor.undo(h.principal, {
      commandId: 'cmd-undo-0001',
      targetCommandId: 'cmd-action-0001',
    })
    expect(undone).toMatchObject({
      outcome: 'COMMITTED',
      revision: 4,
      receipt: { undoOf: 'cmd-action-0001' },
    })
    expect(h.state().current.data.actions.map((item) => [item.id, item.status])).toEqual([
      ['action-1', 'todo'],
      ['action-2', 'done'],
    ])
  })

  it('refuses Undo when a later mutation depends on the same object', async () => {
    const h = harness()
    await h.executor.execute(h.principal, { ...statusCommand('cmd-action-0001', 'action-1', 'done'), baseRevision: 1 })
    await h.executor.execute(h.principal, { ...statusCommand('cmd-action-0002', 'action-1', 'in_progress'), baseRevision: 2 })
    const undone = await h.executor.undo(h.principal, {
      commandId: 'cmd-undo-0001',
      targetCommandId: 'cmd-action-0001',
    })
    expect(undone).toMatchObject({
      outcome: 'CONFLICT',
      conflict: {
        kind: 'OBJECT_CONFLICT',
        objects: [{ type: 'action', id: 'action-1' }],
        interveningCommandIds: ['cmd-action-0002'],
      },
    })
    expect(h.ledger).toHaveLength(2)
    expect(h.state().current.data.actions.find((item) => item.id === 'action-1')?.status).toBe('in_progress')
  })
})
