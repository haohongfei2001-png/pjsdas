import { describe, expect, it, vi } from 'vitest'
import { createConnectedWorkspaceHandler } from '../gateway/connectedWorkspaceHandler.js'
import type { PJSDASSnapshot } from '../src/snapshot.js'

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

    const response = await handler(request('GET', 'ordinary-token'))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      workspaceId: 'ws-1',
      workspaceVersion: 'txn:5',
      revision: 5,
      snapshot: current,
    })
  })
})
