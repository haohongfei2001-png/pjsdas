import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('../src/cloud/cloudClient.js', () => ({ getAccountAccessToken: vi.fn(async () => 'synthetic-token') }))
vi.mock('../src/backendEndpoints.js', () => ({ fetchBackend: vi.fn() }))
vi.mock('../src/db.js', () => ({
  isRecordedAccountProjection: vi.fn(async () => false),
  assertLocalSnapshotCurrent: vi.fn(async () => undefined),
  exportLocalSnapshot: vi.fn(),
  replaceLocalSnapshotFromCloud: vi.fn(),
}))
import { fetchBackend } from '../src/backendEndpoints.js'
import { exportLocalSnapshot, replaceLocalSnapshotFromCloud } from '../src/db.js'
import { AccountCacheChangedError, setAccountCacheSession } from '../src/cloud/accountCacheLease.js'
import { executeConnectedBusinessCommand, journalConnectedInteraction, listAccountPendingOperations, lookupConnectedCommandReceipt } from '../src/cloud/authoritativeCommandClient.js'
import { refreshConnectedAuthoritativeCache } from '../src/cloud/authoritativeReadModelClient.js'
import { markInteractionActivity } from '../src/cloud/interactionActivity.js'
import { bindLocalWorkspaceToUser, getAccountCheckpoint, getCloudDeviceState } from '../src/cloud/syncState.js'
import { canMountMockAccountCache, MOCK_CACHE_PROVENANCE_KEY, rememberInitialMockBinding } from '../src/cloud/mockCacheBoundary.js'
import { MOCK_AUTH_STORAGE_KEY } from '../src/cloud/runtimeCloudMode.js'
import { createSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'
import { opportunity } from '../e2e/fixtures/todayWorkspace.js'

let sequence = 0, account: string, local: PJSDASSnapshot, remote: PJSDASSnapshot
const command = { type: 'semantic_intake' as const, value: {
  contractVersion: 1 as const, inputId: 'first-capture',
  source: { kind: 'web' as const, sourceId: 'todayaction-web', sourceRecordId: 'first-capture', observedAt: '2026-10-17T00:00:00Z', timezone: 'UTC' },
  statementMode: 'assertion' as const, originalText: 'Synthetic first job', contextRefs: [], candidates: [],
} }
function reply(snapshot = remote, revision = 2, extra = {}) {
  return new Response(JSON.stringify({ workspaceId: 'synthetic-workspace', revision, workspaceVersion: `txn:${revision}`, schemaVersion: snapshot.version, snapshot, ...extra }), { headers: { 'content-type': 'application/json' } })
}
function committed() { return reply(remote, 2, { outcome: 'COMMITTED', result: { status: 'APPLIED' }, receipt: { commandId: 'first-capture', revision: 2 } }) }
beforeEach(() => {
  account = `command-first-${++sequence}`
  const values = new Map<string, string>()
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) }, dispatchEvent: vi.fn() })
  vi.stubEnv('VITE_PJSDAS_CLOUD_MODE', 'mock')
  setAccountCacheSession(undefined); setAccountCacheSession(account)
  window.localStorage.setItem(MOCK_AUTH_STORAGE_KEY, JSON.stringify({ access_token: 'synthetic-token', expires_at: 4102444800, user: { id: account } }))
  local = createSnapshot({ opportunities: [], actions: [], processes: [], processEvents: [], prep: [], applicationGroups: [], timeline: [] })
  remote = createSnapshot({ ...local.data, opportunities: [opportunity('first-job', 'Synthetic company', 'Synthetic first job')] })
  vi.mocked(exportLocalSnapshot).mockReset().mockImplementation(async () => structuredClone(local))
  vi.mocked(replaceLocalSnapshotFromCloud).mockReset().mockImplementation(async (snapshot, guard) => {
    guard!.assertCurrent(); local = structuredClone(snapshot); return structuredClone(local)
  })
  vi.mocked(fetchBackend).mockReset().mockImplementation(async (_path, init) => {
    const body = JSON.parse(String(init?.body))
    return body.action === 'read' ? reply(local, 1) : committed()
  })
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

it('finishes command-first binding before immediate offline admission when an overlapping passive bootstrap is deferred', async () => {
  const entered = Promise.withResolvers<void>(), held = Promise.withResolvers<Response>()
  vi.mocked(fetchBackend).mockImplementationOnce(async () => { entered.resolve(); return held.promise })
  const bootstrap = refreshConnectedAuthoritativeCache(account, { passive: true })
  await entered.promise
  markInteractionActivity(account)
  held.resolve(reply(local, 1))
  expect(await bootstrap).toMatchObject({ state: 'pending_operations' })
  expect(getCloudDeviceState().workspaceOwnerUserId).toBeUndefined()
  expect(getAccountCheckpoint(account).lastSyncedVersion).toBeUndefined()
  expect(await executeConnectedBusinessCommand(account, command, { commandId: 'first-capture' })).toMatchObject({ outcome: 'COMMITTED', localProjection: 'applied' })
  expect(vi.mocked(fetchBackend).mock.calls.map(([, init]) => JSON.parse(String(init?.body)).action)).toEqual(['read', 'read', 'command'])
  expect(getCloudDeviceState().workspaceOwnerUserId).toBe(account)
  expect(getAccountCheckpoint(account)).toMatchObject({ lastSyncedVersion: 'txn:2', lastSyncedFingerprint: expect.any(String) })
  expect(window.localStorage.getItem(MOCK_CACHE_PROVENANCE_KEY)).not.toBeNull()
  expect(await canMountMockAccountCache(window.localStorage, getCloudDeviceState)).toBe(true)
  vi.stubGlobal('navigator', { onLine: false })
  vi.mocked(fetchBackend).mockRejectedValue(new Error('offline'))
  journalConnectedInteraction(account, { commandId: 'offline-submit', baseRevision: 2,
    command: { type: 'domain', value: { commandId: 'offline-submit', kind: 'record_application_submission', opportunityId: 'first-job' } } })
  expect(listAccountPendingOperations(account)).toMatchObject([{ commandId: 'offline-submit', interaction: true, status: 'pending' }])
  expect(fetchBackend).toHaveBeenCalledTimes(3)
})

it.each(['unbound', 'remembered bootstrap', 'unknown old binding'] as const)('receipt projection preserves provenance rules for %s', async scenario => {
  if (scenario === 'remembered bootstrap') rememberInitialMockBinding(window.localStorage, getCloudDeviceState(), account)
  if (scenario !== 'unbound') bindLocalWorkspaceToUser(account)
  vi.mocked(fetchBackend).mockResolvedValue(reply(remote, 2, { outcome: 'COMMITTED', found: true, receipt: { commandId: 'recovered-first', revision: 2 } }))
  expect(await lookupConnectedCommandReceipt(account, 'recovered-first')).toMatchObject({ localProjection: 'applied' })
  expect(getCloudDeviceState().workspaceOwnerUserId).toBe(account)
  expect(Boolean(window.localStorage.getItem(MOCK_CACHE_PROVENANCE_KEY))).toBe(scenario !== 'unknown old binding')
  expect(await canMountMockAccountCache(window.localStorage, getCloudDeviceState)).toBe(scenario !== 'unknown old binding')
})

it.each(['projection failure', 'account change', 'device change', 'other owner'] as const)('does not bind or claim applied when projection encounters %s', async scenario => {
  vi.mocked(replaceLocalSnapshotFromCloud).mockImplementation(async snapshot => {
    if (scenario === 'projection failure') throw new AccountCacheChangedError()
    if (scenario === 'account change') setAccountCacheSession('another-account')
    if (scenario === 'device change') window.localStorage.setItem('pjsdas-google-drive-sync-state-v2', JSON.stringify({ ...getCloudDeviceState(), deviceId: 'another-device' }))
    if (scenario === 'other owner') bindLocalWorkspaceToUser('another-owner')
    return snapshot
  })
  vi.mocked(fetchBackend).mockResolvedValue(reply(remote, 2, { outcome: 'COMMITTED', found: true, receipt: { commandId: 'recovered-first', revision: 2 } }))
  expect(await lookupConnectedCommandReceipt(account, 'recovered-first')).toMatchObject({ localProjection: 'pending' })
  expect(getCloudDeviceState().workspaceOwnerUserId).toBe(scenario === 'other owner' ? 'another-owner' : undefined)
  expect(getAccountCheckpoint(account).lastSyncedVersion).toBeUndefined()
  expect(window.localStorage.getItem(MOCK_CACHE_PROVENANCE_KEY)).toBeNull()
})

it('refuses a receipt projection onto an already different owner before replacement', async () => {
  bindLocalWorkspaceToUser('another-owner')
  vi.mocked(fetchBackend).mockResolvedValue(reply(remote, 2, { outcome: 'COMMITTED', found: true, receipt: { commandId: 'recovered-first', revision: 2 } }))
  expect(await lookupConnectedCommandReceipt(account, 'recovered-first')).toMatchObject({ localProjection: 'pending' })
  expect(replaceLocalSnapshotFromCloud).not.toHaveBeenCalled()
  expect(getCloudDeviceState().workspaceOwnerUserId).toBe('another-owner')
  expect(window.localStorage.getItem(MOCK_CACHE_PROVENANCE_KEY)).toBeNull()
})

it.each(['changed token', 'reloaded storage view'] as const)('does not mint first-binding mock provenance after %s during projection', async scenario => {
  vi.mocked(replaceLocalSnapshotFromCloud).mockImplementation(async snapshot => {
    if (scenario === 'changed token') window.localStorage.setItem(MOCK_AUTH_STORAGE_KEY, JSON.stringify({ access_token: 'replacement-token', expires_at: 4102444800, user: { id: account } }))
    else {
      const prior = window.localStorage
      vi.stubGlobal('window', { localStorage: { getItem: prior.getItem, setItem: prior.setItem, removeItem: prior.removeItem }, dispatchEvent: vi.fn() })
    }
    return snapshot
  })
  await executeConnectedBusinessCommand(account, command, { commandId: 'first-capture', baseRevision: 1 })
  expect(getCloudDeviceState().workspaceOwnerUserId).toBe(account)
  expect(window.localStorage.getItem(MOCK_CACHE_PROVENANCE_KEY)).toBeNull()
  expect(await canMountMockAccountCache(window.localStorage, getCloudDeviceState)).toBe(false)
})

it.each(['unchanged', 'account change', 'device change', 'other owner', 'changed token', 'hash rejection', 'pending interaction'] as const)('does not expose an applied receipt before first mock proof settles: %s', async scenario => {
  const digest = crypto.subtle.digest.bind(crypto.subtle)
  const entered = Promise.withResolvers<void>(), held = Promise.withResolvers<void>()
  vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
    if (new TextDecoder().decode(data) === 'synthetic-token') { entered.resolve(); await held.promise }
    return digest(algorithm, data)
  })
  vi.mocked(fetchBackend).mockResolvedValue(reply(remote, 2, { outcome: 'COMMITTED', found: true, receipt: { commandId: 'recovered-first', revision: 2 } }))
  let settled = false
  const projection = lookupConnectedCommandReceipt(account, 'recovered-first').finally(() => { settled = true })
  await entered.promise
  expect(settled).toBe(false)
  expect(window.localStorage.getItem(MOCK_CACHE_PROVENANCE_KEY)).toBeNull()
  if (scenario === 'account change') setAccountCacheSession('another-account')
  if (scenario === 'device change') window.localStorage.setItem('pjsdas-google-drive-sync-state-v2', JSON.stringify({ ...getCloudDeviceState(), deviceId: 'another-device' }))
  if (scenario === 'other owner') bindLocalWorkspaceToUser('another-owner')
  if (scenario === 'changed token') window.localStorage.setItem(MOCK_AUTH_STORAGE_KEY, JSON.stringify({ access_token: 'replacement-token', expires_at: 4102444800, user: { id: account } }))
  if (scenario === 'pending interaction') journalConnectedInteraction(account, { commandId: 'overlapping-interaction', baseRevision: 2 })
  if (scenario === 'hash rejection') held.reject(new Error('synthetic hash failure'))
  else held.resolve()
  const result = await projection
  expect(result?.localProjection).toBe(['unchanged', 'changed token'].includes(scenario) ? 'applied' : 'pending')
  expect(Boolean(window.localStorage.getItem(MOCK_CACHE_PROVENANCE_KEY))).toBe(scenario === 'unchanged')
  if (scenario === 'changed token') expect(await canMountMockAccountCache(window.localStorage, getCloudDeviceState)).toBe(false)
})
