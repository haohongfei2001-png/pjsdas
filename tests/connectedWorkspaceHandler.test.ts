import { describe, expect, it, vi } from 'vitest'
import { createConnectedWorkspaceHandler } from '../gateway/connectedWorkspaceHandler.js'
import { upgradeSnapshotToLatest, type PJSDASSnapshot } from '../src/snapshot.js'

const ORIGIN = 'https://haohongfei2001-png.github.io'

function snapshot(): PJSDASSnapshot {
  return {
    schema: 'pjsdas-local-snapshot',
    version: 1,
    exportedAt: '2026-09-19T00:00:00.000Z',
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

function request(method: string, token: string, body?: unknown, origin = ORIGIN) {
  return new Request('https://api.example/api/workspace', {
    method,
    headers: {
      origin,
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
}

describe('first-party connected workspace endpoint', () => {
  it('rejects delegated OAuth clients before touching server-owned workspace state', async () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const token = `${encode({ alg: 'RS256' })}.${encode({ client_id: '1af5d928-7c67-4330-9521-e8886794fd14' })}.sig`
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/auth/v1/user')) return json({ id: 'user-a', email: 'a@gmail.com' })
      return json({ error: 'workspace must not be touched' }, 500)
    }) as unknown as typeof fetch
    const handler = createConnectedWorkspaceHandler({
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'publishable',
      serviceRoleKey: 'service-role',
      allowedOrigins: [ORIGIN],
      fetchImpl,
    })

    const response = await handler(request('GET', token))
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ code: 'AUTH_FORBIDDEN' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not create a connected workspace without explicit migration confirmation', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/auth/v1/user')) return json({ id: 'user-a' })
      return json({ error: 'workspace must not be touched' }, 500)
    }) as unknown as typeof fetch
    const handler = createConnectedWorkspaceHandler({
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'publishable',
      serviceRoleKey: 'service-role',
      allowedOrigins: [ORIGIN],
      fetchImpl,
    })

    const response = await handler(request('POST', 'ordinary-token', {
      action: 'bootstrap',
      confirmMigration: false,
      snapshot: snapshot(),
    }))
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ code: 'CONFIRMATION_REQUIRED' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('keeps origin-less reads fail closed before touching auth services', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const handler = createConnectedWorkspaceHandler({
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'publishable',
      serviceRoleKey: 'service-role',
      allowedOrigins: [ORIGIN],
      fetchImpl,
    })

    const response = await handler(new Request('https://api.example/api/workspace', {
      method: 'GET',
      headers: { authorization: 'Bearer ordinary-token' },
    }))
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ code: 'ORIGIN_NOT_ALLOWED' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reads an existing transactional workspace for a first-party browser', async () => {
    const current = snapshot()
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/auth/v1/user')) return json({ id: 'user-a' })
      if (url.includes('/rest/v1/pjsdas_workspaces?')) {
        return json([{ id: 'ws-1', user_id: 'user-a', snapshot: current, revision: 5, schema_version: 1 }])
      }
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch
    const handler = createConnectedWorkspaceHandler({
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'publishable',
      serviceRoleKey: 'service-role',
      allowedOrigins: [ORIGIN],
      fetchImpl,
    })

    const response = await handler(request('POST', 'ordinary-token', { action: 'read' }))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      workspaceId: 'ws-1',
      workspaceVersion: 'txn:5',
      revision: 5,
      schemaVersion: 4,
      snapshot: upgradeSnapshotToLatest(current),
    })
  })

  it('executes a covered first-party Web action as a server command without receiving a client snapshot', async () => {
    const current = upgradeSnapshotToLatest(snapshot())
    current.data.actions.push({
      id: 'action-1',
      kind: 'manual',
      title: 'Internal task',
      estimatedMinutes: 10,
      leverage: 50,
      delayCost: 50,
      status: 'todo',
      createdAt: '2026-09-23T00:00:00.000Z',
      updatedAt: '2026-09-23T00:00:00.000Z',
    })
    const rpcBodies: any[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/auth/v1/user')) return json({ id: 'user-a' })
      if (url.includes('/rest/v1/pjsdas_workspaces?')) {
        return json([{ id: 'ws-1', user_id: 'user-a', snapshot: current, revision: 7, schema_version: current.version }])
      }
      if (url.includes('/rest/v1/pjsdas_command_ledger?')) return json([])
      if (url.endsWith('/rest/v1/rpc/pjsdas_commit_workspace_v2')) {
        const body = JSON.parse(String(init?.body))
        rpcBodies.push(body)
        return json([{
          outcome: 'COMMITTED',
          workspace_id: 'ws-1',
          revision: 8,
          snapshot: body.target_snapshot,
          receipt: {
            ...body.target_receipt_context,
            commandId: body.target_command_id,
            receiptId: `command-receipt:${body.target_command_id}`,
            status: 'COMMITTED',
            revision: 8,
            undoAvailable: true,
          },
        }])
      }
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch
    const handler = createConnectedWorkspaceHandler({
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'publishable',
      serviceRoleKey: 'service-role',
      allowedOrigins: [ORIGIN],
      fetchImpl,
    })

    const commandId = 'web-action:test-0001'
    const response = await handler(request('POST', 'ordinary-token', {
      action: 'command',
      commandId,
      baseRevision: 7,
      command: {
        type: 'domain',
        value: { commandId, kind: 'set_action_status', actionId: 'action-1', status: 'done' },
      },
    }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'COMMITTED',
      revision: 8,
      receipt: {
        receiptId: 'command-receipt:web-action:test-0001',
        affectedObjects: [{ type: 'action', id: 'action-1' }],
      },
      snapshot: { data: { actions: [{ id: 'action-1', status: 'done' }] } },
    })
    expect(rpcBodies).toHaveLength(1)
    expect(rpcBodies[0]).toMatchObject({
      target_command_id: commandId,
      target_operation: 'domain:set_action_status',
      target_expected_revision: 7,
      target_principal_kind: 'first_party_web',
    })
  })

  it('rejects whole-snapshot Web writes that do not declare a bounded compatibility purpose', async () => {
    const current = upgradeSnapshotToLatest(snapshot())
    let rpcCalled = false
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/auth/v1/user')) return json({ id: 'user-a' })
      if (url.includes('/rest/v1/rpc/')) {
        rpcCalled = true
        return json({ error: 'must not commit' }, 500)
      }
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch
    const handler = createConnectedWorkspaceHandler({
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'publishable',
      serviceRoleKey: 'service-role',
      allowedOrigins: [ORIGIN],
      fetchImpl,
    })

    const response = await handler(request('POST', 'ordinary-token', {
      action: 'commit',
      commandId: 'legacy-snapshot-no-purpose',
      expectedRevision: 1,
      snapshot: current,
    }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'SNAPSHOT_COMPATIBILITY_REQUIRED' })
    expect(rpcCalled).toBe(false)
  })

  it('rejects a stale legacy snapshot before it can overwrite newer authoritative fields', async () => {
    const authoritative = upgradeSnapshotToLatest(snapshot())
    authoritative.data.opportunities.push({
      id: 'opp-new',
      company: 'Newer Co',
      role: 'Authoritative Role',
      stage: '准备申请',
      source: 'Server',
      sourceType: 'Other',
      nextStep: 'Keep',
      urgency: 80,
      opportunityValue: 80,
      fitScore: 80,
      assessmentStatus: 'unassessed',
      locallyManaged: true,
      importedAt: '2026-09-23T00:00:00.000Z',
    })
    let rpcBody: any
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/auth/v1/user')) return json({ id: 'user-a' })
      if (url.includes('/rest/v1/pjsdas_workspaces?')) {
        return json([{ id: 'ws-1', user_id: 'user-a', snapshot: authoritative, revision: 9, schema_version: authoritative.version }])
      }
      if (url.endsWith('/rest/v1/rpc/pjsdas_commit_workspace_v2')) {
        rpcBody = JSON.parse(String(init?.body))
        return json([{
          outcome: 'CONFLICT',
          workspace_id: 'ws-1',
          revision: 9,
          snapshot: authoritative,
          receipt: {
            commandId: rpcBody.target_command_id,
            status: 'CONFLICT',
            expectedRevision: 8,
            actualRevision: 9,
          },
        }])
      }
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch
    const handler = createConnectedWorkspaceHandler({
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'publishable',
      serviceRoleKey: 'service-role',
      allowedOrigins: [ORIGIN],
      fetchImpl,
    })

    const staleClient = upgradeSnapshotToLatest(snapshot())
    const response = await handler(request('POST', 'ordinary-token', {
      action: 'commit',
      commandId: 'legacy-snapshot-0001',
      expectedRevision: 8,
      snapshotPurpose: 'compatibility',
      snapshot: staleClient,
    }))

    expect(response.status).toBe(409)
    const payload = await response.json()
    expect(payload).toMatchObject({
      outcome: 'CONFLICT',
      revision: 9,
      snapshot: { data: { opportunities: [{ id: 'opp-new', role: 'Authoritative Role' }] } },
    })
    expect(rpcBody).toMatchObject({
      target_command_id: 'legacy-snapshot-0001',
      target_expected_revision: 8,
      target_operation: 'SyncLocalSnapshot',
      target_receipt_context: {
        contractVersion: 2,
        commandType: 'snapshot_compatibility',
        snapshotPurpose: 'compatibility',
      },
    })
    expect(rpcBody.target_snapshot).not.toEqual(authoritative)
  })

})
