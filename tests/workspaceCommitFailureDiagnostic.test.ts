import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTransactionalWorkspaceStore, type TransactionalWorkspaceStoreOptions } from '../gateway/transactionalWorkspaceStore.js'
import { commitFailureClass } from '../gateway/workspaceCommitFailureDiagnostic.js'
import { upgradeSnapshotToLatest, type PJSDASSnapshot } from '../src/snapshot.js'
const snapshot = upgradeSnapshotToLatest({ schema: 'pjsdas-local-snapshot', version: 1, exportedAt: '2026-10-01T01:00:00Z',
  data: { opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [] } } as PJSDASSnapshot)
const input = { userId: 'PRIVATE_USER', commandId: 'PRIVATE_COMMAND', operation: 'PRIVATE_OPERATION', payloadHash: 'PRIVATE_HASH', expectedRevision: 1,
  snapshot, schemaVersion: snapshot.version, principalKind: 'first_party_web' as const, receiptContext: { secret: '敏感内容_PRIVATE_RECEIPT' }, provenance: { secret: 'PRIVATE_PROVENANCE' } }
function store(fetchImpl: typeof fetch, extra: Partial<TransactionalWorkspaceStoreOptions> = {}) {
  return createTransactionalWorkspaceStore({ supabaseUrl: 'https://private-host.invalid', serviceRoleKey: 'PRIVATE_CREDENTIAL', fetchImpl,
    metadataOnlyCommits: false, rawJsonCommits: false, ...extra })
}
afterEach(() => vi.restoreAllMocks())
describe('ordinary authoritative commit failure diagnostics', () => {
  it.each([2, 3, 4])('logs only bounded metadata for RPC v%s and preserves its failure', async version => {
    const sink = vi.fn(), fetchImpl = vi.fn(async () => Response.json({ code: '57014', message: 'PRIVATE_PROVIDER_MESSAGE', details: 'PRIVATE_DETAILS', stack: 'PRIVATE_STACK' }, { status: 500 }))
    const h = store(fetchImpl, { metadataOnlyCommits: version >= 3, rawJsonCommits: version === 4, commitFailureSink: sink })
    await expect(h.commitAuthoritativeForUser(input)).rejects.toMatchObject({ code: 'WORKSPACE_COMMIT_FAILED', retryable: true })
    expect(fetchImpl).toHaveBeenCalledOnce(); expect(sink).toHaveBeenCalledOnce()
    const body = fetchImpl.mock.calls[0][1]?.body as string, diagnostic = sink.mock.calls[0][0]
    expect(diagnostic).toEqual({ event: 'workspace_commit_failed', rpcVersion: `v${version}`, requestBytes: new TextEncoder().encode(body).byteLength,
      durationMs: expect.any(Number), httpStatus: 500, errorClass: 'query_canceled' })
    expect(diagnostic.durationMs).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(diagnostic)).not.toMatch(/PRIVATE|private-host|敏感|snapshot|receipt|Bearer|57014/)
  })
  it('logs no response content for network failures and never retries', async () => {
    const sink = vi.fn(), fetchImpl = vi.fn(async () => { throw new Error('PRIVATE_NETWORK_STACK') })
    await expect(store(fetchImpl, { commitFailureSink: sink }).commitAuthoritativeForUser(input)).rejects.toMatchObject({ code: 'WORKSPACE_UNAVAILABLE', retryable: true })
    expect(fetchImpl).toHaveBeenCalledOnce(); expect(sink).toHaveBeenCalledOnce()
    expect(sink.mock.calls[0][0]).toMatchObject({ httpStatus: null, errorClass: 'network_error' })
    expect(JSON.stringify(sink.mock.calls)).not.toContain('PRIVATE')
  })
  it.each([409, 403, 429, 503])('keeps original HTTP %s error and retry classification with a throwing sink', async status => {
    const fetchImpl = vi.fn(async () => Response.json({ code: '42501' }, { status }))
    await expect(store(fetchImpl, { commitFailureSink: () => { throw new Error('logging failed') } }).commitAuthoritativeForUser(input)).rejects.toMatchObject({
      code: status === 409 ? 'COMMAND_ID_REUSED' : 'WORKSPACE_COMMIT_FAILED', retryable: status === 429 || status >= 500 })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
  it('isolates asynchronous sink rejection and supports the existing console sink', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchImpl = vi.fn(async () => new Response('PRIVATE_INVALID_JSON', { status: 502 }))
    await expect(store(fetchImpl).commitAuthoritativeForUser(input)).rejects.toMatchObject({ code: 'WORKSPACE_COMMIT_FAILED' })
    expect(warn).toHaveBeenCalledOnce(); expect(warn.mock.calls[0][0]).toMatchObject({ errorClass: 'http_error' })
    await expect(store(fetchImpl, { commitFailureSink: async () => { throw new Error('async sink failed') } }).commitAuthoritativeForUser(input)).rejects.toMatchObject({ code: 'WORKSPACE_COMMIT_FAILED' })
    await Promise.resolve()
  })
  it('never logs success, reads, or guarded management failures', async () => {
    const sink = vi.fn()
    const success = vi.fn(async () => Response.json([{ outcome: 'COMMITTED', workspace_id: 'ws-1', revision: 2, receipt: {} }]))
    await store(success, { metadataOnlyCommits: true, commitFailureSink: sink }).commitAuthoritativeForUser(input)
    const failed = vi.fn(async () => Response.json({ code: '57014' }, { status: 500 }))
    await expect(store(failed, { commitFailureSink: sink }).readIdentityForUser('PRIVATE_USER')).rejects.toThrow()
    await expect(store(failed, { commitFailureSink: sink }).commitAuthoritativeForUser({ ...input, operation: 'business_management', principalKind: 'delegated_mcp', clientId: 'PRIVATE_CLIENT',
      managementAuthorization: { grantId: 'PRIVATE_GRANT', grantRevision: 1, consentVersion: 2 } })).rejects.toThrow()
    expect(sink).not.toHaveBeenCalled()
  })
  it('skips diagnostics if the starting clock is unavailable without changing the request', async () => {
    const sink = vi.fn(), fetchImpl = vi.fn(async () => Response.json({ code: '57014' }, { status: 500 }))
    vi.spyOn(performance, 'now').mockImplementationOnce(() => { throw new Error('synthetic clock unavailable') })
    await expect(store(fetchImpl, { commitFailureSink: sink }).commitAuthoritativeForUser(input)).rejects.toMatchObject({ code: 'WORKSPACE_COMMIT_FAILED', retryable: true })
    expect(fetchImpl).toHaveBeenCalledOnce(); expect(sink).not.toHaveBeenCalled()
  })
  it('maps only fixed error classes, never error text', () => {
    expect(['57014','42501','23505','40001','40P01','55P03','22023','PRIVATE','PGRST202',undefined,{}].map(commitFailureClass))
      .toEqual(['query_canceled','permission_denied','unique_violation','serialization_failure','deadlock','lock_unavailable','database_other','http_error','http_error','http_error','http_error'])
  })
})
