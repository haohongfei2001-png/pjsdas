import { describe, expect, it, vi } from 'vitest'
import { createAuthorizationGrantStore, createDiscoveryGrantAdmission, type AuthorizationGrant } from '../gateway/authorizationGrantStore.js'
import { createTransactionalWorkspaceStore } from '../gateway/transactionalWorkspaceStore.js'
import { invokeTrustedIngestion } from '../gateway/ingestSources.js'
import { commitVerifiedDiscoveryRun } from '../gateway/verifiedDiscoveryCommit.js'
import { AT, AUTOMATION, CLIENT, DELEGATED, GRANT, LedgerHarness, SOURCE, USER, clone, command, json, snapshot } from './fixtures/b2Ledger.rebuilt.js'

const grant = (): AuthorizationGrant => ({ id: GRANT, revision: 7, grantedAt: '2026-10-07T19:00:00.000Z', userId: USER, clientId: CLIENT, sourceId: SOURCE, capability: 'ingest_discovery_run' })
const admission = () => createDiscoveryGrantAdmission(USER, CLIENT, () => Date.parse(AT))
const bodyOf = (result: Awaited<ReturnType<typeof invokeTrustedIngestion>>) => result.structuredContent ?? JSON.parse((result.content[0] as { text: string }).text)

describe('B2 rebuilt Discovery grant admission (offline, new coverage)', () => {
  it('binds one frozen proof to exact user/client/source, immutable ID and revision', () => {
    const current = grant(), admit = admission(), proof = admit([current], SOURCE)
    expect(proof).toEqual(DELEGATED); expect(Object.isFrozen(proof)).toBe(true)
    expect(admit([clone(current)], SOURCE)).toBe(proof)
    current.revision = 8
    expect(() => admit([current], SOURCE)).toThrowError(/changed|replaced|revoked/)
    expect(proof.grantRevision).toBe(7)
  })

  it.each([
    ['foreign user', { userId: 'foreign' }], ['foreign client', { clientId: 'foreign' }], ['foreign source', { sourceId: 'foreign' }],
    ['wrong capability', { capability: 'semantic_intake' }], ['missing immutable ID', { id: undefined }], ['invalid ID', { id: 'not-a-uuid' }],
    ['missing revision', { revision: undefined }], ['zero revision', { revision: 0 }], ['fractional revision', { revision: 1.5 }],
    ['unsafe revision', { revision: Number.MAX_SAFE_INTEGER + 1 }], ['missing timestamp', { grantedAt: undefined }],
    ['future timestamp', { grantedAt: '2099-01-01T00:00:00.000Z' }], ['invalid timestamp', { grantedAt: 'bad-date' }],
  ])('rejects %s before admission', (_name, change) => {
    expect(() => admission()([{ ...grant(), ...change } as AuthorizationGrant], SOURCE)).toThrowError(/exact current version/)
  })

  it('rejects no grant and ambiguous duplicate grants', () => {
    expect(() => admission()([], SOURCE)).toThrowError()
    expect(() => admission()([grant(), grant()], SOURCE)).toThrowError()
  })

  it.each(['replacement', 'regrant'] as const)('cannot revive an admitted invocation after %s', mode => {
    const admit = admission(), current = grant(); const proof = admit([current], SOURCE)
    expect(() => admit([], SOURCE)).toThrowError()
    if (mode === 'replacement') current.id = '33333333-3333-4333-8333-333333333333'
    else current.revision = 9
    expect(() => admit([current], SOURCE)).toThrowError(/changed|replaced|revoked/)
    expect(proof).toEqual(DELEGATED)
  })

  it('grant lookup requests immutable ID/revision and filters account, client and revocation', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json([
      { id: GRANT, revision: 7, user_id: USER, client_id: CLIENT, source_id: SOURCE, capability: 'ingest_discovery_run', granted_at: AT, revoked_at: null },
      { id: GRANT, revision: 8, user_id: USER, client_id: CLIENT, source_id: SOURCE, capability: 'ingest_discovery_run', granted_at: AT, revoked_at: AT },
      { id: GRANT, revision: 7, user_id: 'foreign', client_id: CLIENT, source_id: SOURCE, capability: 'ingest_discovery_run', granted_at: AT, revoked_at: null },
    ]))
    const store = createAuthorizationGrantStore({ supabaseUrl: 'https://offline.invalid', publishableKey: 'synthetic-publishable', fetchImpl: fetchImpl as typeof fetch })
    expect(await store.listActiveForClient(USER, CLIENT, 'synthetic-user-token')).toEqual([{ ...grant(), grantedAt: AT }])
    expect(Object.fromEntries(new URL(String(fetchImpl.mock.calls[0][0])).searchParams)).toEqual({ select: 'id,revision,user_id,client_id,source_id,capability,granted_at,revoked_at', user_id: `eq.${USER}`, client_id: `eq.${CLIENT}`, revoked_at: 'is.null' })
  })
})

describe('B2 rebuilt admission through authoritative store and ingestion', () => {
  it.each([
    ['missing guard', undefined], ['wrong owner', { ...DELEGATED, userId: 'foreign' }],
    ['wrong client', { ...DELEGATED, clientId: 'foreign' }], ['wrong source', { ...DELEGATED, sourceId: 'foreign' }],
    ['missing immutable ID', { ...DELEGATED, grantId: '' }], ['zero revision', { ...DELEGATED, grantRevision: 0 }],
    ['automation proof on delegated principal', AUTOMATION],
  ])('denies %s without calling either commit RPC', async (_name, proof) => {
    const db = new LedgerHarness(), value = await command(); db.liveAuthorization = clone(DELEGATED)
    await expect(commitVerifiedDiscoveryRun(db.source(DELEGATED), value, { discoveryAuthorization: proof as typeof DELEGATED })).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' })
    expect(db.attempts).toEqual([]); expect(db.writes).toEqual([]); expect(db.rows.size).toBe(0)
    expect(db.calls.filter(call => call.url.pathname.includes('/rpc/'))).toEqual([])
  })

  it('uses the protected RPC and never falls back after server admission denial', async () => {
    const db = new LedgerHarness(), value = await command(); db.liveAuthorization = { ...DELEGATED, grantRevision: 8 }
    await expect(commitVerifiedDiscoveryRun(db.source(DELEGATED), value, { discoveryAuthorization: DELEGATED })).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' })
    expect(db.attempts).toHaveLength(1); expect(db.writes).toEqual([]); expect(db.rows.size).toBe(0)
    expect(db.calls.filter(call => call.method === 'POST').map(call => call.url.pathname)).toEqual(['/rest/v1/rpc/pjsdas_commit_discovery_workspace_v1'])
  })

  it('the legacy generic store commit route denies Discovery before any network call', async () => {
    const fetchImpl = vi.fn(), value = await command()
    const store = createTransactionalWorkspaceStore({ supabaseUrl: 'https://offline.invalid', serviceRoleKey: 'synthetic-unused-key', fetchImpl: fetchImpl as typeof fetch })
    await expect(store.commitForUser({ userId: USER, commandId: value.commandId, operation: value.kind, payloadHash: value.inputFingerprint, expectedRevision: 1, snapshot: snapshot(), schemaVersion: snapshot().version, principalKind: 'delegated_mcp', clientId: CLIENT })).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each(['revoke during verification', 'replace during CAS retry', 'regrant during CAS retry'] as const)('rechecks the identical admission after %s and never retrieves again', async race => {
    const db = new LedgerHarness(), value = await command(); db.liveAuthorization = clone(DELEGATED)
    const current = grant(), admit = admission(); let grants = [current]
    const authorize = vi.fn(async () => admit(grants, SOURCE))
    const sourceVerifier = vi.fn(async () => {
      if (race === 'revoke during verification') grants = []
      return clone(value.run.observations[0])
    })
    if (race !== 'revoke during verification') db.beforeCommit = () => {
      db.beforeCommit = undefined; db.revision += 1
      // Preserve the live SQL proof through this first conflicted attempt. The
      // next application authorize must reject the replacement before writing.
      if (race === 'replace during CAS retry') current.id = '33333333-3333-4333-8333-333333333333'
      else current.revision = 8
    }
    const observation = value.run.observations[0]
    const result = await invokeTrustedIngestion(db.source(DELEGATED), 'ingest_discovery_run', {
      runId: value.run.runId, sourceId: SOURCE, startedAt: AT, completedAt: AT,
      observations: [{ sourceRecordId: 'source-1', company: observation.company, role: observation.role, sourceUrl: observation.sourceUrl, sourceTitle: observation.sourceTitle }],
    }, { authorize, sourceVerifier })
    expect(result.isError).toBe(true); expect(bodyOf(result).code).toBe('AUTH_FORBIDDEN')
    expect(sourceVerifier).toHaveBeenCalledTimes(1); expect(db.writes).toEqual([]); expect(db.rows.size).toBe(0)
    expect(db.attempts).toHaveLength(race === 'revoke during verification' ? 0 : 1)
    if (db.attempts.length) expect(db.attempts[0].target_discovery_authorization).toEqual(DELEGATED)
    expect(db.snapshot.data.opportunities).toEqual([])
  })

  it('scope changes during verification reject the stale facts before commit', async () => {
    const db = new LedgerHarness(), value = await command(); db.liveAuthorization = clone(DELEGATED)
    const admit = admission(), sourceVerifier = vi.fn(async () => {
      db.snapshot.data.discoveryProfile!.targetRoleQueries = ['Different Role']; db.revision += 1
      return clone(value.run.observations[0])
    })
    const observation = value.run.observations[0]
    const result = await invokeTrustedIngestion(db.source(DELEGATED), 'ingest_discovery_run', {
      runId: value.run.runId, sourceId: SOURCE, startedAt: AT, completedAt: AT,
      observations: [{ sourceRecordId: 'source-1', company: observation.company, role: observation.role, sourceUrl: observation.sourceUrl, sourceTitle: observation.sourceTitle }],
    }, { authorize: async () => admit([grant()], SOURCE), sourceVerifier })
    expect(bodyOf(result).code).toBe('DISCOVERY_SCOPE_CHANGED'); expect(sourceVerifier).toHaveBeenCalledTimes(1)
    expect(db.attempts).toEqual([]); expect(db.writes).toEqual([])
  })
})
