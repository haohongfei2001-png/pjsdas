import { describe, expect, it, vi } from 'vitest'
import { createTransactionalWorkspaceSource } from '../gateway/transactionalWorkspaceSource.js'
import { upgradeSnapshotToLatest, type PJSDASSnapshot } from '../src/snapshot.js'

function snapshot(exportedAt = '2026-09-19T00:00:00.000Z'): PJSDASSnapshot {
  return {
    schema: 'pjsdas-local-snapshot',
    version: 1,
    exportedAt,
    data: {
      opportunities: [],
      processes: [],
      processEvents: [],
      actions: [],
      prep: [],
      applicationGroups: [],
    },
  }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}

describe('transactional workspace source', () => {
  it('maps server revision to WorkspaceSource context and commits through the atomic RPC', async () => {
    const current = snapshot()
    const next = snapshot('2026-09-19T00:01:00.000Z')
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/rest/v1/pjsdas_workspaces?')) {
        return json([{ id: 'ws-1', user_id: 'user-a', snapshot: current, revision: 7, schema_version: 1 }])
      }
      if (url.endsWith('/rest/v1/rpc/pjsdas_commit_workspace_v2')) {
        const body = JSON.parse(String(init?.body))
        return json([{
          outcome: 'COMMITTED',
          workspace_id: 'ws-1',
          revision: 8,
          snapshot: body.target_snapshot,
          receipt: { status: 'COMMITTED', revision: 8 },
        }])
      }
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch

    const source = createTransactionalWorkspaceSource({
      userId: 'user-a',
      supabaseUrl: 'https://example.supabase.co',
      serviceRoleKey: 'service-role',
      principalKind: 'automation',
      sourceId: 'gmail:primary',
      fetchImpl,
      now: () => new Date('2026-09-19T00:02:00.000Z'),
    })

    await expect(source.read()).resolves.toMatchObject({
      context: { workspaceVersion: 'txn:7' },
    })
    await expect(source.write!({
      snapshot: next,
      expectedWorkspaceVersion: 'txn:7',
      updatedByDevice: 'gmail-ingestion:gmail:primary',
    })).resolves.toMatchObject({
      context: { workspaceVersion: 'txn:8' },
      snapshot: upgradeSnapshotToLatest(next),
    })
  })

  it('forwards semantic command identity and compensation to the atomic RPC', async () => {
    const current = snapshot()
    const next = snapshot('2026-09-19T00:01:00.000Z')
    const bodies: any[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/rest/v1/pjsdas_workspaces?')) {
        return json([{ id: 'ws-1', user_id: 'user-a', snapshot: current, revision: 7, schema_version: 1 }])
      }
      if (url.endsWith('/rest/v1/rpc/pjsdas_commit_workspace_v2')) {
        const body = JSON.parse(String(init?.body))
        bodies.push(body)
        return json([{
          outcome: 'COMMITTED',
          workspace_id: 'ws-1',
          revision: 8,
          snapshot: body.target_snapshot,
          receipt: { status: 'COMMITTED', revision: 8 },
        }])
      }
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch
    const source = createTransactionalWorkspaceSource({
      userId: 'user-a',
      supabaseUrl: 'https://example.supabase.co',
      serviceRoleKey: 'service-role',
      principalKind: 'delegated_mcp',
      clientId: 'client-a',
      fetchImpl,
    })
    await source.write!({
      snapshot: next,
      expectedWorkspaceVersion: 'txn:7',
      updatedByDevice: 'mcp-explicit-user-command',
      command: {
        commandId: 'cmd-semantic-1',
        operation: 'set_action_status',
        payload: { actionId: 'a-1', status: 'done' },
        compensation: { operation: 'set_action_status', payload: { actionId: 'a-1', status: 'todo' } },
      },
    })
    expect(bodies[0]).toMatchObject({
      target_command_id: 'cmd-semantic-1',
      target_operation: 'set_action_status',
      target_principal_kind: 'delegated_mcp',
      target_client_id: 'client-a',
      target_compensation: {
        operation: 'set_action_status',
        payload: { actionId: 'a-1', status: 'todo' },
      },
    })
  })

  it('fails closed before writing when no explicit connected migration exists', async () => {
    const fetchImpl = vi.fn(async () => json([])) as unknown as typeof fetch
    const source = createTransactionalWorkspaceSource({
      userId: 'user-a',
      supabaseUrl: 'https://example.supabase.co',
      serviceRoleKey: 'service-role',
      principalKind: 'delegated_mcp',
      clientId: 'client-a',
      fetchImpl,
    })
    await expect(source.read()).rejects.toMatchObject({ code: 'WORKSPACE_MIGRATION_REQUIRED' })
  })
})
