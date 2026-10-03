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
      if (new URL(url).pathname === '/rest/v1/rpc/pjsdas_commit_workspace_v2') {
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
      reuseReadPreimage: true,
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
      if (new URL(url).pathname === '/rest/v1/rpc/pjsdas_commit_workspace_v2') {
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

describe('one-shot revision-bound read preimage', () => {
  async function fixture() {
    const { unknownDeadlineWorkspace } = await import('./fixtures/unknownDeadlineWorkspace.js')
    let current = unknownDeadlineWorkspace(2), revision = 7
    const reads: string[] = [], writes: any[] = []
    let afterIdentity: (() => void) | undefined, workspaceId = 'synthetic-ws', storedSchema = current.version
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname === '/rest/v1/pjsdas_workspaces') {
        reads.push(String(input))
        const row = { id: workspaceId, user_id: 'user-a', revision, schema_version: storedSchema }
        const identityOnly = !url.searchParams.get('select')?.includes('snapshot')
        const result = json([{ ...row, ...(identityOnly ? {} : { snapshot: current }) }])
        if (identityOnly) { const hook = afterIdentity; afterIdentity = undefined; hook?.() }
        return result
      }
      if (url.pathname === '/rest/v1/rpc/pjsdas_commit_workspace_v2') {
        const body = JSON.parse(String(init?.body)); writes.push(body)
        if (body.target_expected_revision !== revision) return json([{ outcome: 'CONFLICT', workspace_id: 'synthetic-ws', revision, snapshot: current, receipt: {} }])
        current = body.target_snapshot; revision++
        return json([{ outcome: 'COMMITTED', workspace_id: 'synthetic-ws', revision, receipt: body.target_receipt_context }])
      }
      throw new Error(`Unexpected synthetic URL ${url.pathname}`)
    })
    const options = { userId: 'user-a', supabaseUrl: 'https://fixture.invalid', serviceRoleKey: 'fixture-only', principalKind: 'automation' as const, reuseReadPreimage: true, fetchImpl }
    return { source: createTransactionalWorkspaceSource(options), options, reads, writes, current: () => structuredClone(current), replaceIdentity: () => { workspaceId = 'replacement-ws' }, changeSchema: () => { storedSchema = 1 }, afterIdentity: (fn: () => void) => { afterIdentity = fn }, advance: () => { current.data.opportunities[1].early = true; revision++ } }
  }
  it('uses one full GET and preserves receipt diff even when caller mutates the read result', async () => {
    const f = await fixture(), read = await f.source.read()
    read.snapshot.data.opportunities[0].early = true
    const written = await f.source.write!({ snapshot: read.snapshot, expectedWorkspaceVersion: read.context.workspaceVersion })
    expect(written.context.workspaceVersion).toBe('txn:8')
    expect(f.reads.filter(url => new URL(url).searchParams.get('select')?.includes('snapshot'))).toHaveLength(1)
    expect(f.writes[0].target_expected_revision).toBe(7)
    expect(f.writes[0].target_receipt_context.affectedObjects).toContainEqual({ type: 'opportunity', id: 'unknown-0' })
    expect(f.current().data.opportunities[0].early).toBe(true)
  })
  it('keeps changed remote revision as a CAS conflict without overwriting newer data', async () => {
    const f = await fixture(), read = await f.source.read()
    f.advance(); const newer = f.current()
    read.snapshot.data.opportunities[0].early = true
    await expect(f.source.write!({ snapshot: read.snapshot, expectedWorkspaceVersion: read.context.workspaceVersion })).rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' })
    expect(f.current()).toEqual(newer)
    expect(f.writes).toHaveLength(0)
    expect(f.reads.filter(url => new URL(url).searchParams.get('select')?.includes('snapshot'))).toHaveLength(1)
  })
  it('still relies on atomic CAS if another writer commits after the small identity read', async () => {
    const f = await fixture(), read = await f.source.read()
    f.afterIdentity(f.advance)
    await expect(f.source.write!({ snapshot: read.snapshot, expectedWorkspaceVersion: read.context.workspaceVersion })).rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' })
    expect(f.writes).toHaveLength(1)
    expect(f.writes[0].target_expected_revision).toBe(7)
    expect(f.current().data.opportunities[1].early).toBe(true)
  })
  it('refuses a replaced workspace identity even when its revision number was reused', async () => {
    const f = await fixture(), read = await f.source.read()
    f.replaceIdentity()
    await expect(f.source.write!({ snapshot: read.snapshot, expectedWorkspaceVersion: read.context.workspaceVersion })).rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' })
    expect(f.writes).toHaveLength(0)
  })
  it('refuses changed storage schema even when workspace ID and revision were reused', async () => {
    const f = await fixture(), read = await f.source.read()
    f.changeSchema()
    await expect(f.source.write!({ snapshot: read.snapshot, expectedWorkspaceVersion: read.context.workspaceVersion })).rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' })
    expect(f.writes).toHaveLength(0)
  })
  it('cannot reuse another account preimage', async () => {
    const f = await fixture(), read = await f.source.read()
    f.options.userId = 'other-account'
    await expect(f.source.write!({ snapshot: read.snapshot, expectedWorkspaceVersion: read.context.workspaceVersion })).rejects.toMatchObject({ code: 'WORKSPACE_INVALID' })
    expect(f.writes).toHaveLength(0)
    expect(f.reads).toHaveLength(2)
  })
  it('does a fresh read without a matching source-instance revision', async () => {
    const f = await fixture(), read = await f.source.read()
    f.advance()
    const second = createTransactionalWorkspaceSource(f.options)
    await second.write!({ snapshot: f.current(), expectedWorkspaceVersion: 'txn:8' })
    expect(f.reads).toHaveLength(2)
    await expect(f.source.write!({ snapshot: f.current(), expectedWorkspaceVersion: 'txn:9' })).resolves.toMatchObject({ context: { workspaceVersion: 'txn:10' } })
    expect(f.reads).toHaveLength(3)
  })
  it('consumes the preimage once when two writes race from the same read', async () => {
    const f = await fixture(), read = await f.source.read()
    const input = { snapshot: read.snapshot, expectedWorkspaceVersion: read.context.workspaceVersion }
    const results = await Promise.allSettled([f.source.write!(input), f.source.write!(input)])
    expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(row => row.status === 'rejected')).toHaveLength(1)
    expect(f.reads.filter(url => new URL(url).searchParams.get('select')?.includes('snapshot'))).toHaveLength(2)
    expect(f.writes).toHaveLength(2)
    expect(f.writes.every(row => row.target_expected_revision === 7)).toBe(true)
  })
})
