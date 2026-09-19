import { describe, expect, it, vi } from 'vitest'
import { createMutationKernel, hashMutationPayload } from '../gateway/mutationKernel.js'
import type { PJSDASSnapshot } from '../src/snapshot.js'

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

describe('AI-operated mutation kernel foundation', () => {
  it('hashes semantically identical payload objects deterministically', async () => {
    const a = await hashMutationPayload('test', { b: 2, a: { y: 2, x: 1 } })
    const b = await hashMutationPayload('test', { a: { x: 1, y: 2 }, b: 2 })
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('commits through the atomic workspace RPC with revision and command identity', async () => {
    const calls: Array<{ url: string; body?: any; auth?: string | null }> = []
    const initial = snapshot()
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ url, body, auth: headers.get('authorization') })
      if (url.includes('/rest/v1/pjsdas_workspaces?')) {
        return json([{ id: 'ws-1', user_id: 'user-a', snapshot: initial, revision: 3, schema_version: 1 }])
      }
      if (url.endsWith('/rest/v1/rpc/pjsdas_commit_workspace')) {
        return json([{
          outcome: 'COMMITTED',
          workspace_id: 'ws-1',
          revision: 4,
          snapshot: body.target_snapshot,
          receipt: { commandId: body.target_command_id, status: 'COMMITTED', revision: 4 },
        }])
      }
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch

    const kernel = createMutationKernel({
      supabaseUrl: 'https://example.supabase.co',
      serviceRoleKey: 'service-role-secret',
      fetchImpl,
    })
    const result = await kernel.execute(
      { kind: 'first_party_web', userId: 'user-a' },
      {
        commandId: 'cmd-1',
        operation: 'SyncLocalSnapshot',
        payload: { exportedAt: '2026-09-19T00:05:00.000Z' },
        expectedRevision: 3,
      },
      (current, payload) => ({ ...current, exportedAt: payload.exportedAt }),
    )

    expect(result.outcome).toBe('COMMITTED')
    expect(result.revision).toBe(4)
    expect(result.snapshot.exportedAt).toBe('2026-09-19T00:05:00.000Z')
    expect(calls).toHaveLength(2)
    expect(calls[1]?.auth).toBe('Bearer service-role-secret')
    expect(calls[1]?.body).toMatchObject({
      target_user_id: 'user-a',
      target_command_id: 'cmd-1',
      target_operation: 'SyncLocalSnapshot',
      target_expected_revision: 3,
      target_principal_kind: 'first_party_web',
    })
    expect(calls[1]?.body.target_payload_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('returns ALREADY_APPLIED when a lost-response retry carries the old revision', async () => {
    const initial = snapshot()
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/rest/v1/pjsdas_workspaces?')) {
        return json([{ id: 'ws-1', user_id: 'user-a', snapshot: initial, revision: 4, schema_version: 1 }])
      }
      if (url.includes('/rest/v1/pjsdas_command_ledger?')) {
        const payloadHash = await hashMutationPayload('Test', { value: 1 })
        return json([{
          command_id: 'cmd-retry',
          operation: 'Test',
          payload_hash: payloadHash,
          resulting_revision: 4,
          status: 'COMMITTED',
          receipt: { commandId: 'cmd-retry', status: 'COMMITTED', revision: 4 },
          compensation: null,
        }])
      }
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch
    const kernel = createMutationKernel({
      supabaseUrl: 'https://example.supabase.co',
      serviceRoleKey: 'service-role-secret',
      fetchImpl,
    })

    const result = await kernel.execute(
      { kind: 'first_party_web', userId: 'user-a' },
      { commandId: 'cmd-retry', operation: 'Test', payload: { value: 1 }, expectedRevision: 3 },
      (current) => current,
    )

    expect(result).toMatchObject({ outcome: 'ALREADY_APPLIED', revision: 4 })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('returns conflict before mutation when the requested revision is stale', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/rest/v1/pjsdas_workspaces?')) {
        return json([{
          id: 'ws-1',
          user_id: 'user-a',
          snapshot: snapshot(),
          revision: 8,
          schema_version: 1,
        }])
      }
      if (url.includes('/rest/v1/pjsdas_command_ledger?')) return json([])
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch
    const kernel = createMutationKernel({
      supabaseUrl: 'https://example.supabase.co',
      serviceRoleKey: 'service-role-secret',
      fetchImpl,
    })

    const result = await kernel.execute(
      { kind: 'first_party_web', userId: 'user-a' },
      { commandId: 'cmd-stale', operation: 'Test', payload: {}, expectedRevision: 7 },
      (current) => current,
    )

    expect(result).toMatchObject({
      outcome: 'CONFLICT',
      revision: 8,
      receipt: { expectedRevision: 7, actualRevision: 8 },
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('prepares automatic undo only when the target command is still the latest revision', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/rest/v1/pjsdas_workspaces?')) {
        return json([{ id: 'ws-1', user_id: 'user-a', snapshot: snapshot(), revision: 4, schema_version: 1 }])
      }
      if (url.includes('/rest/v1/pjsdas_command_ledger?')) {
        return json([{
          command_id: 'cmd-4',
          operation: 'CompleteAction',
          payload_hash: 'abc',
          resulting_revision: 4,
          status: 'COMMITTED',
          receipt: { commandId: 'cmd-4', status: 'COMMITTED' },
          compensation: { operation: 'SetActionStatus', payload: { actionId: 'a-1', status: 'todo' } },
        }])
      }
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch
    const kernel = createMutationKernel({
      supabaseUrl: 'https://example.supabase.co',
      serviceRoleKey: 'service-role-secret',
      fetchImpl,
    })

    await expect(kernel.prepareUndo({ kind: 'first_party_web', userId: 'user-a' }, 'cmd-4')).resolves.toMatchObject({
      outcome: 'READY',
      expectedRevision: 4,
      compensation: { operation: 'SetActionStatus' },
    })
  })

  it('refuses automatic undo after later dependent revisions exist', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/rest/v1/pjsdas_workspaces?')) {
        return json([{ id: 'ws-1', user_id: 'user-a', snapshot: snapshot(), revision: 6, schema_version: 1 }])
      }
      if (url.includes('/rest/v1/pjsdas_command_ledger?')) {
        return json([{
          command_id: 'cmd-4',
          operation: 'CompleteAction',
          payload_hash: 'abc',
          resulting_revision: 4,
          status: 'COMMITTED',
          receipt: {},
          compensation: { operation: 'SetActionStatus', payload: { actionId: 'a-1', status: 'todo' } },
        }])
      }
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch
    const kernel = createMutationKernel({
      supabaseUrl: 'https://example.supabase.co',
      serviceRoleKey: 'service-role-secret',
      fetchImpl,
    })

    await expect(kernel.prepareUndo({ kind: 'first_party_web', userId: 'user-a' }, 'cmd-4')).resolves.toMatchObject({
      outcome: 'NEEDS_CONFIRMATION',
      reason: 'DEPENDENT_CHANGES',
      targetRevision: 4,
      currentRevision: 6,
    })
  })

  it('requires delegated commands to carry a concrete client identity', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const kernel = createMutationKernel({
      supabaseUrl: 'https://example.supabase.co',
      serviceRoleKey: 'service-role-secret',
      fetchImpl,
    })

    await expect(kernel.execute(
      { kind: 'delegated_mcp', userId: 'user-a' },
      { commandId: 'cmd-x', operation: 'Test', payload: {}, expectedRevision: 0 },
      (current) => current,
    )).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
