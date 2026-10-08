import { afterEach, describe, expect, it, vi } from 'vitest'
import { canMountMockAccountCache, markVerifiedMockCache, advanceExistingMockCacheProof, MOCK_CACHE_PROVENANCE_KEY } from '../src/cloud/mockCacheBoundary.js'
import { resolveCloudMode, MOCK_AUTH_STORAGE_KEY, passiveCloudReadAllowed } from '../src/cloud/runtimeCloudMode.js'
import type { CloudDeviceState } from '../src/cloud/syncState.js'
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })
function storage() { const map = new Map<string, string>(); return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value) }, removeItem: (key: string) => { map.delete(key) }, map } }
const state = (): CloudDeviceState => ({ version: 2, deviceId: 'device-a', autoSync: true, workspaceOwnerUserId: 'account-a', accounts: { 'account-a': { lastSyncedVersion: 'txn:1', lastSyncedFingerprint: 'original-fingerprint' } } })
const session = { access_token: 'synthetic-mock-token', expires_at: 4102444800, user: { id: 'account-a' } }
describe('development cloud isolation without production behavior changes', () => {
  it.each([{ MODE: 'test' }, { MODE: 'development' }, { MODE: 'development', PROD: true }, { MODE: 'production', VITE_PJSDAS_CLOUD_MODE: 'mock' }, { MODE: 'development', VITE_PJSDAS_CLOUD_MODE: 'unknown' }])('defaults local/test cases to mock: %j', env => expect(resolveCloudMode(env)).toBe('mock'))
  it.each([{ MODE: 'production' }, { MODE: 'development', VITE_PJSDAS_CLOUD_MODE: 'live' }])('retains production or explicit live behavior: %j', env => expect(resolveCloudMode(env)).toBe('live'))
  it('suspends passive reads while hidden/offline and resumes when both recover', () => {
    const nav = { onLine: true }, doc = { visibilityState: 'visible' }; vi.stubGlobal('navigator', nav); vi.stubGlobal('document', doc)
    expect(passiveCloudReadAllowed()).toBe(true); doc.visibilityState = 'hidden'; expect(passiveCloudReadAllowed()).toBe(false)
    nav.onLine = false; doc.visibilityState = 'visible'; expect(passiveCloudReadAllowed()).toBe(false)
    nav.onLine = true; expect(passiveCloudReadAllowed()).toBe(true)
  })
  it('preserves an unmarked real account binding even when its ID matches a mock session', async () => {
    const store = storage(), current = state(), saved = structuredClone(current)
    store.setItem('sb-real-production-auth-token', JSON.stringify({ ...session, access_token: 'real-shaped-session' }))
    store.setItem(MOCK_AUTH_STORAGE_KEY, JSON.stringify(session))
    expect(await canMountMockAccountCache(store, current)).toBe(false)
    advanceExistingMockCacheProof(store, current, { ...current, accounts: { 'account-a': { lastSyncedVersion: 'txn:2', lastSyncedFingerprint: 'another' } } })
    expect(store.getItem(MOCK_CACHE_PROVENANCE_KEY)).toBeNull(); expect(current).toEqual(saved)
    expect(store.getItem('sb-real-production-auth-token')).toContain('real-shaped-session')
  })
  it('allows a newly verified mock binding, its reload and later verified command checkpoints', async () => {
    const store = storage(), current = state(); store.setItem(MOCK_AUTH_STORAGE_KEY, JSON.stringify(session))
    await markVerifiedMockCache(store, () => current, 'account-a', () => {})
    expect(await canMountMockAccountCache(store, current)).toBe(true)
    const next = structuredClone(current); next.accounts['account-a'].lastSyncedFingerprint = 'verified-new-command'; next.accounts['account-a'].lastSyncedVersion = 'txn:2'
    advanceExistingMockCacheProof(store, current, next)
    expect(await canMountMockAccountCache(store, next)).toBe(true)
    expect(store.getItem(MOCK_CACHE_PROVENANCE_KEY)).not.toContain(session.access_token)
  })
  it.each(['missing token', 'expired token', 'changed token', 'other owner', 'other device', 'other fingerprint', 'other origin', 'copied real JWT'] as const)('stops contradictory mock proof: %s', async corruption => {
    const store = storage(), current = state(); store.setItem(MOCK_AUTH_STORAGE_KEY, JSON.stringify(session)); await markVerifiedMockCache(store, () => current, 'account-a', () => {})
    if (corruption === 'missing token') store.removeItem(MOCK_AUTH_STORAGE_KEY)
    if (corruption === 'expired token') store.setItem(MOCK_AUTH_STORAGE_KEY, JSON.stringify({ ...session, expires_at: 1 }))
    if (corruption === 'changed token') store.setItem(MOCK_AUTH_STORAGE_KEY, JSON.stringify({ ...session, access_token: 'different-session' }))
    if (corruption === 'other owner') current.workspaceOwnerUserId = 'account-b'
    if (corruption === 'other device') current.deviceId = 'device-b'
    if (corruption === 'other fingerprint') current.accounts['account-a'].lastSyncedFingerprint = 'real-cache-replaced-it'
    if (corruption === 'other origin') { const proof = JSON.parse(store.getItem(MOCK_CACHE_PROVENANCE_KEY)!); proof.authOrigin = 'https://real-project.supabase.co'; store.setItem(MOCK_CACHE_PROVENANCE_KEY, JSON.stringify(proof)) }
    if (corruption === 'copied real JWT') store.setItem(MOCK_AUTH_STORAGE_KEY, JSON.stringify({ ...session, access_token: `e30.${btoa(JSON.stringify({ iss: 'https://real-project.supabase.co/auth/v1' }))}.synthetic` }))
    const saved = structuredClone(current), entries = [...store.map]
    expect(await canMountMockAccountCache(store, current)).toBe(false)
    expect(current).toEqual(saved); expect([...store.map]).toEqual(entries)
  })
  it('rechecks account metadata and token after asynchronous proof validation', async () => {
    const store = storage(); let current = state(); store.setItem(MOCK_AUTH_STORAGE_KEY, JSON.stringify(session))
    await markVerifiedMockCache(store, () => current, 'account-a', () => {})
    const realDigest = crypto.subtle.digest.bind(crypto.subtle)
    const gate = Promise.withResolvers<void>()
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => { await gate.promise; return realDigest(...args) })
    const pending = canMountMockAccountCache(store, () => current)
    current = { ...current, workspaceOwnerUserId: 'account-b' }
    gate.resolve(); expect(await pending).toBe(false)
    vi.restoreAllMocks()
  })
  it('rejects a copied production JWT even if its digest matches the copied marker', async () => {
    const store = storage(), current = state(); store.setItem(MOCK_AUTH_STORAGE_KEY, JSON.stringify(session))
    await markVerifiedMockCache(store, () => current, 'account-a', () => {})
    const token = `e30.${btoa(JSON.stringify({ iss: 'https://real-project.supabase.co/auth/v1' }))}.synthetic`
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))].map(byte => byte.toString(16).padStart(2, '0')).join('')
    store.setItem(MOCK_AUTH_STORAGE_KEY, JSON.stringify({ ...session, access_token: token }))
    store.setItem(MOCK_CACHE_PROVENANCE_KEY, JSON.stringify({ ...JSON.parse(store.getItem(MOCK_CACHE_PROVENANCE_KEY)!), tokenSha256: digest }))
    const entries = [...store.map]
    expect(await canMountMockAccountCache(store, current)).toBe(false); expect([...store.map]).toEqual(entries)
  })
  it('does not mark incomplete bindings or a lease that changed while hashing', async () => {
    const store = storage(), current = state(); store.setItem(MOCK_AUTH_STORAGE_KEY, JSON.stringify(session))
    delete current.accounts['account-a'].lastSyncedVersion
    await markVerifiedMockCache(store, () => current, 'account-a', () => {}); expect(store.getItem(MOCK_CACHE_PROVENANCE_KEY)).toBeNull()
    current.accounts['account-a'].lastSyncedVersion = 'txn:1'
    let checks = 0
    await expect(markVerifiedMockCache(store, () => current, 'account-a', () => { if (++checks === 2) throw new Error('old lease') })).rejects.toThrow('old lease')
    expect(store.getItem(MOCK_CACHE_PROVENANCE_KEY)).toBeNull()
  })
})
