import { expect, it, vi } from 'vitest'
import { createTransactionalWorkspaceStore } from '../gateway/transactionalWorkspaceStore.js'
import { upgradeSnapshotToLatest, type PJSDASSnapshot } from '../src/snapshot.js'

it('duplicate RPC fallback retains the freshly read authoritative snapshot/revision pair', async () => {
  const snapshot = upgradeSnapshotToLatest({ schema: 'pjsdas-local-snapshot', version: 1, exportedAt: '2026-10-01T01:00:00Z',
    data: { opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [] } } as PJSDASSnapshot)
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const rpc = new URL(String(input)).pathname.endsWith('/pjsdas_commit_workspace_v2')
    return new Response(JSON.stringify(rpc ? [{ outcome: 'ALREADY_APPLIED', workspace_id: 'ws-1', revision: 8, receipt: { commandId: 'duplicate', revision: 8 } }]
      : [{ id: 'ws-1', user_id: 'owner', revision: 9, schema_version: snapshot.version, snapshot }]), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const store = createTransactionalWorkspaceStore({ supabaseUrl: 'https://example.supabase.co', serviceRoleKey: 'synthetic', fetchImpl })
  const result = await store.commitAuthoritativeForUser({ userId: 'owner', commandId: 'duplicate', operation: 'domain', payloadHash: 'synthetic', expectedRevision: 7,
    snapshot, schemaVersion: snapshot.version, principalKind: 'first_party_web', receiptContext: {} })
  expect(result.outcome).toBe('ALREADY_APPLIED')
  expect(result.revision).toBe(9)
  expect(result.snapshot).toEqual(snapshot)
  expect(result.receipt.revision).toBe(8)
  expect(fetchImpl).toHaveBeenCalledTimes(2)
})
