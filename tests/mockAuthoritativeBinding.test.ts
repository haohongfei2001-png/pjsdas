import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('../src/db.js', () => ({
  isRecordedAccountProjection: vi.fn(async () => false),
  assertLocalSnapshotCurrent: vi.fn(async () => undefined),
  exportLocalSnapshot: vi.fn(),
  replaceLocalSnapshotFromCloud: vi.fn(async (value) => value),
}))
vi.mock('../src/cloud/connectedWorkspaceRepository.js', () => ({ fetchConnectedRemoteWorkspace: vi.fn(), connectedWorkspaceAuthorityEnabled: () => true }))
vi.mock('../src/cloud/cloudRepository.js', () => ({ fetchRemoteWorkspace: vi.fn(), createRemoteWorkspace: vi.fn(), updateRemoteWorkspace: vi.fn() }))
vi.mock('../src/cloud/authoritativeCommandClient.js', () => ({ pendingCommandSummary: () => ({ count: 0, conflict: 0 }) }))
import { assertLocalSnapshotCurrent, exportLocalSnapshot, replaceLocalSnapshotFromCloud } from '../src/db.js'
import { fetchConnectedRemoteWorkspace } from '../src/cloud/connectedWorkspaceRepository.js'
import { AccountCacheChangedError, setAccountCacheSession } from '../src/cloud/accountCacheLease.js'
import { runCloudSync } from '../src/cloud/cloudSync.js'
import { createRemoteWorkspace, fetchRemoteWorkspace, updateRemoteWorkspace } from '../src/cloud/cloudRepository.js'
import { refreshConnectedAuthoritativeCache } from '../src/cloud/authoritativeReadModelClient.js'
import { bindLocalWorkspaceToUser, getCloudDeviceState, setCloudAutoSync } from '../src/cloud/syncState.js'
import { canMountMockAccountCache, MOCK_CACHE_PROVENANCE_KEY } from '../src/cloud/mockCacheBoundary.js'
import { MOCK_AUTH_STORAGE_KEY } from '../src/cloud/runtimeCloudMode.js'
import { createSnapshot } from '../src/snapshot.js'
import { fingerprintWorkspace } from '../src/cloud/workspaceFingerprint.js'
import { opportunity } from '../e2e/fixtures/todayWorkspace.js'
beforeEach(() => {
  vi.mocked(assertLocalSnapshotCurrent).mockReset().mockResolvedValue(undefined)
  vi.mocked(replaceLocalSnapshotFromCloud).mockReset().mockImplementation(async value => value)
  vi.mocked(exportLocalSnapshot).mockReset()
  vi.mocked(fetchConnectedRemoteWorkspace).mockReset()
  vi.mocked(fetchRemoteWorkspace).mockReset()
  vi.mocked(createRemoteWorkspace).mockReset()
  vi.mocked(updateRemoteWorkspace).mockReset()
  const values = new Map<string, string>()
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) }, dispatchEvent: vi.fn() })
  vi.stubEnv('VITE_PJSDAS_CLOUD_MODE', 'mock')
  setAccountCacheSession(undefined); setAccountCacheSession('mock-account')
})

it.each(['new binding', 'unknown old binding', 'changed token', 'new account generation', 'new device', 'reloaded storage view'] as const)('a verified consumer can finish only its original mock bootstrap when old sync cancels: %s', async scenario => {
  const account = 'mock-account'
  const session = { access_token: 'synthetic-mock-token', expires_at: 4102444800, user: { id: account } }
  window.localStorage.setItem(MOCK_AUTH_STORAGE_KEY, JSON.stringify(session))
  let local = createSnapshot({ opportunities: [], actions: [], processes: [], processEvents: [], prep: [], applicationGroups: [], timeline: [] })
  const remote = createSnapshot({ ...local.data, opportunities: [opportunity('new-job', 'Synthetic company', 'Engineer')] })
  const row = { fileId: 'mock-workspace', version: 'txn:1204', schemaVersion: remote.version, snapshot: remote,
    fingerprint: await fingerprintWorkspace(remote), updatedByDevice: 'synthetic-server', updatedAt: '2026-10-08T00:00:00Z' }
  const entered = Promise.withResolvers<void>(), held = Promise.withResolvers<typeof row>()
  vi.mocked(exportLocalSnapshot).mockImplementation(async () => structuredClone(local))
  vi.mocked(assertLocalSnapshotCurrent).mockImplementation(async (expected, assertCurrent) => {
    assertCurrent?.()
    if (JSON.stringify(expected.data) !== JSON.stringify(local.data)) throw new AccountCacheChangedError()
  })
  vi.mocked(replaceLocalSnapshotFromCloud).mockImplementation(async (value, guard) => {
    await assertLocalSnapshotCurrent(guard!.expectedLocal, guard!.assertCurrent)
    local = structuredClone(value); return structuredClone(local)
  })
  vi.mocked(fetchRemoteWorkspace).mockImplementation(async () => { entered.resolve(); return held.promise })
  vi.mocked(fetchConnectedRemoteWorkspace).mockResolvedValue(row)
  if (scenario === 'unknown old binding') bindLocalWorkspaceToUser(account)
  const oldSync = runCloudSync(account).then(value => ({ value }), error => ({ error }))
  await entered.promise // The real sync has bound the owner and read its empty preimage.
  expect(getCloudDeviceState().workspaceOwnerUserId).toBe(account)
  expect(window.localStorage.getItem(MOCK_CACHE_PROVENANCE_KEY)).toBeNull()
  if (scenario === 'changed token') window.localStorage.setItem(MOCK_AUTH_STORAGE_KEY, JSON.stringify({ ...session, access_token: 'another-session' }))
  if (scenario === 'new account generation') { setAccountCacheSession(undefined); setAccountCacheSession(account) }
  if (scenario === 'new device') window.localStorage.setItem('pjsdas-google-drive-sync-state-v2', JSON.stringify({ ...getCloudDeviceState(), deviceId: 'another-device' }))
  if (scenario === 'reloaded storage view') {
    const prior = window.localStorage
    vi.stubGlobal('window', { localStorage: { getItem: prior.getItem, setItem: prior.setItem, removeItem: prior.removeItem }, dispatchEvent: vi.fn() })
  }
  const currentRead = await refreshConnectedAuthoritativeCache(account)
  expect(currentRead).toMatchObject({ state: 'updated', workspaceVersion: 'txn:1204' })
  const proof = window.localStorage.getItem(MOCK_CACHE_PROVENANCE_KEY)
  expect(Boolean(proof)).toBe(scenario === 'new binding')
  held.resolve(row)
  expect(await oldSync).toMatchObject({ error: expect.any(AccountCacheChangedError) })
  // The losing old callback must not erase or replace the winner's proof/data.
  expect(window.localStorage.getItem(MOCK_CACHE_PROVENANCE_KEY)).toBe(proof)
  expect(local.data.opportunities.map(item => item.id)).toEqual(['new-job'])
  expect(await canMountMockAccountCache(window.localStorage, getCloudDeviceState)).toBe(scenario === 'new binding')
  expect(createRemoteWorkspace).not.toHaveBeenCalled()
  expect(updateRemoteWorkspace).not.toHaveBeenCalled()
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })
it.each(['current', 'updated', 'unknown-binding'] as const)('verified first Today read is reloadable without relabelling old caches: %s', async scenario => {
  const snapshot = createSnapshot({ opportunities: [], actions: [], processes: [], processEvents: [], prep: [], applicationGroups: [], timeline: [] })
  window.localStorage.setItem(MOCK_AUTH_STORAGE_KEY, JSON.stringify({ access_token: 'synthetic-mock-token', expires_at: 4102444800, user: { id: 'mock-account' } }))
  setCloudAutoSync(false)
  const local = structuredClone(snapshot)
  if (scenario === 'updated') snapshot.data.opportunities.push({ id: 'mock-opportunity', company: 'Synthetic company', title: 'Synthetic position', source: 'user' } as any)
  if (scenario === 'unknown-binding') bindLocalWorkspaceToUser('mock-account')
  vi.mocked(exportLocalSnapshot).mockResolvedValue(local)
  vi.mocked(fetchConnectedRemoteWorkspace).mockResolvedValue({ fileId: 'mock-workspace', version: 'txn:1', schemaVersion: snapshot.version, snapshot, fingerprint: await fingerprintWorkspace(snapshot), updatedByDevice: 'synthetic-server', updatedAt: '2026-10-08T00:00:00Z' })
  expect(await canMountMockAccountCache(window.localStorage, getCloudDeviceState)).toBe(scenario !== 'unknown-binding')
  const result = await refreshConnectedAuthoritativeCache('mock-account', { passive: true })
  expect(result.state).toBe(scenario === 'updated' ? 'updated' : 'current')
  expect(getCloudDeviceState().workspaceOwnerUserId).toBe('mock-account')
  expect(getCloudDeviceState().autoSync).toBe(false)
  expect(Boolean(window.localStorage.getItem(MOCK_CACHE_PROVENANCE_KEY))).toBe(scenario !== 'unknown-binding')
  expect(await canMountMockAccountCache(window.localStorage, getCloudDeviceState)).toBe(scenario !== 'unknown-binding')
})
