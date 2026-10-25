import { expect, it, vi } from 'vitest'
import { createTransactionalWorkspaceStore } from '../gateway/transactionalWorkspaceStore.js'
import { upgradeSnapshotToLatest, type PJSDASSnapshot } from '../src/snapshot.js'

it.each([{ metadataOnlyCommits: false, rawJsonCommits: true, rpcVersion: 2 }, { metadataOnlyCommits: true, rawJsonCommits: false, rpcVersion: 3 }, { metadataOnlyCommits: true, rawJsonCommits: true, rpcVersion: 4 }])('duplicate RPC fallback retains the freshly read authoritative snapshot/revision pair', async ({ metadataOnlyCommits, rawJsonCommits, rpcVersion }) => {
  const snapshot = upgradeSnapshotToLatest({ schema: 'pjsdas-local-snapshot', version: 1, exportedAt: '2026-10-01T01:00:00Z',
    data: { opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [] } } as PJSDASSnapshot)
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const rpc = new URL(String(input)).pathname.endsWith(`/pjsdas_commit_workspace_v${rpcVersion}`)
    return new Response(JSON.stringify(rpc ? [{ outcome: 'ALREADY_APPLIED', workspace_id: 'ws-1', revision: 8, receipt: { commandId: 'duplicate', revision: 8 } }]
      : [{ id: 'ws-1', user_id: 'owner', revision: 9, schema_version: snapshot.version, snapshot }]), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const store = createTransactionalWorkspaceStore({ supabaseUrl: 'https://example.supabase.co', serviceRoleKey: 'synthetic', fetchImpl, metadataOnlyCommits, rawJsonCommits })
  const result = await store.commitAuthoritativeForUser({ userId: 'owner', commandId: 'duplicate', operation: 'domain', payloadHash: 'synthetic', expectedRevision: 7,
    snapshot, schemaVersion: snapshot.version, principalKind: 'first_party_web', receiptContext: {} })
  expect(result.outcome).toBe('ALREADY_APPLIED')
  expect(result.revision).toBe(9)
  expect(result.snapshot).toEqual(snapshot)
  expect(result.receipt.revision).toBe(8)
  expect(fetchImpl).toHaveBeenCalledTimes(2)
})

it.each([{ metadataOnlyCommits: false, rawJsonCommits: true, rpcVersion: 2 }, { metadataOnlyCommits: true, rawJsonCommits: false, rpcVersion: 3 }, { metadataOnlyCommits: true, rawJsonCommits: true, rpcVersion: 4 }])('rejects a fallback older than RPC current revision even when it includes the original receipt revision', async ({ metadataOnlyCommits, rawJsonCommits, rpcVersion }) => {
  const snapshot = upgradeSnapshotToLatest({ schema: 'pjsdas-local-snapshot', version: 1, exportedAt: '2026-10-01T01:00:00Z',
    data: { opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [] } } as PJSDASSnapshot)
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(new URL(String(input)).pathname.endsWith(`/pjsdas_commit_workspace_v${rpcVersion}`)
    ? [{ outcome: 'ALREADY_APPLIED', workspace_id: 'ws-1', revision: 3, receipt: { commandId: 'duplicate', revision: 2 } }]
    : [{ id: 'ws-1', user_id: 'owner', revision: 2, schema_version: snapshot.version, snapshot }]), { status: 200, headers: { 'content-type': 'application/json' } }))
  const store = createTransactionalWorkspaceStore({ supabaseUrl: 'https://offline.invalid', serviceRoleKey: 'synthetic', fetchImpl, metadataOnlyCommits, rawJsonCommits })
  await expect(store.commitAuthoritativeForUser({ userId: 'owner', commandId: 'duplicate', operation: 'domain', payloadHash: 'synthetic', expectedRevision: 1,
    snapshot, schemaVersion: snapshot.version, principalKind: 'first_party_web', receiptContext: {} })).rejects.toMatchObject({ code: 'WORKSPACE_INVALID' })
  expect(fetchImpl).toHaveBeenCalledTimes(2)
})

it.each([false, true])('metadata-only commits reuse their submitted snapshot without a second fetch (raw=%s)', async rawJsonCommits => {
  const snapshot = upgradeSnapshotToLatest({ schema: 'pjsdas-local-snapshot', version: 1, exportedAt: '2026-10-01T01:00:00Z',
    data: { opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [] } } as PJSDASSnapshot)
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    expect(new URL(String(input)).pathname).toBe(`/rest/v1/rpc/pjsdas_commit_workspace_v${rawJsonCommits ? 4 : 3}`)
    return Response.json([{ outcome: 'COMMITTED', workspace_id: 'ws-1', revision: 8, receipt: { commandId: 'new', revision: 8 } }])
  })
  const store = createTransactionalWorkspaceStore({ supabaseUrl: 'https://offline.invalid', serviceRoleKey: 'synthetic', fetchImpl, metadataOnlyCommits: true, rawJsonCommits })
  const result = await store.commitAuthoritativeForUser({ userId: 'owner', commandId: 'new', operation: 'domain', payloadHash: 'synthetic', expectedRevision: 7,
    snapshot, schemaVersion: snapshot.version, principalKind: 'first_party_web', receiptContext: {} })
  expect(result).toMatchObject({ outcome: 'COMMITTED', revision: 8, snapshot })
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})

it.each([403, 404, 503].flatMap(status => [false, true].map(rawJsonCommits => ({ status, rawJsonCommits }))))('does not fallback or repeat an unconfirmed metadata-only commit after HTTP $status (raw=$rawJsonCommits)', async ({ status, rawJsonCommits }) => {
  const snapshot = upgradeSnapshotToLatest({ schema: 'pjsdas-local-snapshot', version: 1, exportedAt: '2026-10-01T01:00:00Z',
    data: { opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [] } } as PJSDASSnapshot)
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    expect(new URL(String(input)).pathname).toBe(`/rest/v1/rpc/pjsdas_commit_workspace_v${rawJsonCommits ? 4 : 3}`)
    return Response.json({ code: status === 404 ? 'PGRST202' : 'synthetic' }, { status })
  })
  const store = createTransactionalWorkspaceStore({ supabaseUrl: 'https://offline.invalid', serviceRoleKey: 'synthetic', fetchImpl, metadataOnlyCommits: true, rawJsonCommits })
  await expect(store.commitAuthoritativeForUser({ userId: 'owner', commandId: 'new', operation: 'domain', payloadHash: 'synthetic', expectedRevision: 7,
    snapshot, schemaVersion: snapshot.version, principalKind: 'first_party_web', receiptContext: {} })).rejects.toMatchObject({ code: 'WORKSPACE_COMMIT_FAILED' })
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})

it.each([
  [2, 'business_management', 'management'], [3, 'opportunity_management', 'opportunity'],
  [4, 'planning_management', 'planning'], [5, 'discovery_profile_management', 'discovery_profile'],
  [6, 'private_reminder_management', 'private_reminder'], [7, 'business_management', 'consumer_business'],
] as const)('metadata-only rollout keeps consent v%i on its guarded RPC', async (consentVersion, operation, family) => {
  const snapshot = upgradeSnapshotToLatest({ schema: 'pjsdas-local-snapshot', version: 1, exportedAt: '2026-10-01T01:00:00Z',
    data: { opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [] } } as PJSDASSnapshot)
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    expect(new URL(String(input)).pathname).toBe(`/rest/v1/rpc/pjsdas_commit_${family}_workspace_v1`)
    return Response.json([{ outcome: 'COMMITTED', workspace_id: 'ws-1', revision: 8, receipt: { commandId: 'guarded', revision: 8 } }])
  })
  const store = createTransactionalWorkspaceStore({ supabaseUrl: 'https://offline.invalid', serviceRoleKey: 'synthetic', fetchImpl, metadataOnlyCommits: true, rawJsonCommits: true })
  await store.commitAuthoritativeForUser({ userId: 'owner', commandId: 'guarded', operation, payloadHash: 'synthetic', expectedRevision: 7,
    snapshot, schemaVersion: snapshot.version, principalKind: 'delegated_mcp', clientId: 'fixture-client',
    managementAuthorization: { grantId: 'fixture-grant', grantRevision: 1, consentVersion }, receiptContext: {} })
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})
