import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('../src/db.js', () => ({
  isRecordedAccountProjection: vi.fn(async () => false),
  assertLocalSnapshotCurrent: vi.fn(async () => undefined),
  exportLocalSnapshot: vi.fn(),
  replaceLocalSnapshotFromCloud: vi.fn(async (value) => value),
}))
vi.mock('../src/cloud/connectedWorkspaceRepository.js', () => ({ fetchConnectedRemoteWorkspace: vi.fn() }))
vi.mock('../src/cloud/authoritativeCommandClient.js', () => ({ pendingCommandSummary: () => ({ count: 0, conflict: 0 }) }))
import { exportLocalSnapshot } from '../src/db.js'
import { fetchConnectedRemoteWorkspace } from '../src/cloud/connectedWorkspaceRepository.js'
import { setAccountCacheSession } from '../src/cloud/accountCacheLease.js'
import { refreshConnectedAuthoritativeCache } from '../src/cloud/authoritativeReadModelClient.js'
import { bindLocalWorkspaceToUser, getCloudDeviceState, setCloudAutoSync } from '../src/cloud/syncState.js'
import { canMountMockAccountCache, MOCK_CACHE_PROVENANCE_KEY } from '../src/cloud/mockCacheBoundary.js'
import { MOCK_AUTH_STORAGE_KEY } from '../src/cloud/runtimeCloudMode.js'
import { createSnapshot } from '../src/snapshot.js'
import { fingerprintWorkspace } from '../src/cloud/workspaceFingerprint.js'
beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) }, dispatchEvent: vi.fn() })
  vi.stubEnv('VITE_PJSDAS_CLOUD_MODE', 'mock')
  setAccountCacheSession(undefined); setAccountCacheSession('mock-account')
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
