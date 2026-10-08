import { afterEach, describe, expect, it, vi } from 'vitest'
import { canMountMockAccountCache, clearVerifiedMockAccountCache, forgetMockCacheProvenance, hasPendingMockCacheClear, markVerifiedMockCache, advanceExistingMockCacheProof, MOCK_CACHE_PROVENANCE_KEY } from '../src/cloud/mockCacheBoundary.js'
import { AccountCacheChangedError, setAccountCacheSession } from '../src/cloud/accountCacheLease.js'
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
  it('continues a verified session logout after a failed clear without accepting an anonymous reload', async () => {
    const store = storage(), current = state(), data = ['private mock row']
    setAccountCacheSession('account-a'); store.setItem(MOCK_AUTH_STORAGE_KEY, JSON.stringify(session))
    await markVerifiedMockCache(store, () => current, 'account-a', () => {})
    setAccountCacheSession(undefined); store.removeItem(MOCK_AUTH_STORAGE_KEY)
    await expect(clearVerifiedMockAccountCache(store, () => current, async assertCurrent => { assertCurrent(); throw Error('transaction aborted') })).rejects.toThrow('transaction aborted')
    expect(data).toEqual(['private mock row'])
    expect(hasPendingMockCacheClear(store, current)).toBe(true)
    expect(await canMountMockAccountCache(store, current)).toBe(false)
    // A copied/reloaded storage view cannot inherit page-lifetime recovery.
    const reload = storage(); for (const [key, value] of store.map) reload.setItem(key, value)
    expect(hasPendingMockCacheClear(reload, current)).toBe(false)
    const unknownClear = vi.fn()
    await expect(clearVerifiedMockAccountCache(reload, () => current, unknownClear)).rejects.toThrow('origin is unconfirmed')
    expect(unknownClear).not.toHaveBeenCalled()
    await clearVerifiedMockAccountCache(store, () => current, async assertCurrent => {
      assertCurrent(); data.length = 0; delete current.workspaceOwnerUserId; forgetMockCacheProvenance(store)
    })
    expect(data).toEqual([]); expect(hasPendingMockCacheClear(store, current)).toBe(false)
  })
  it.each(['new session', 'same account relogin', 'new token', 'new binding', 'new device', 'changed proof'] as const)('never applies a delayed clear after %s', async change => {
    const store = storage(), current = state(), data = ['new local edit']
    setAccountCacheSession('account-a'); store.setItem(MOCK_AUTH_STORAGE_KEY, JSON.stringify(session))
    await markVerifiedMockCache(store, () => current, 'account-a', () => {})
    setAccountCacheSession(undefined); store.removeItem(MOCK_AUTH_STORAGE_KEY)
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    const clear = clearVerifiedMockAccountCache(store, () => current, async assertCurrent => {
      entered.resolve(); await gate.promise; assertCurrent(); data.length = 0
    })
    await entered.promise
    if (change === 'new session') setAccountCacheSession('account-b')
    if (change === 'same account relogin') { setAccountCacheSession('account-a'); setAccountCacheSession(undefined) }
    if (change === 'new token') store.setItem(MOCK_AUTH_STORAGE_KEY, JSON.stringify({ ...session, access_token: 'new-session' }))
    if (change === 'new binding') current.workspaceOwnerUserId = 'account-b'
    if (change === 'new device') current.deviceId = 'new-device'
    if (change === 'changed proof') store.removeItem(MOCK_CACHE_PROVENANCE_KEY)
    gate.resolve(); await expect(clear).rejects.toBeInstanceOf(AccountCacheChangedError)
    expect(hasPendingMockCacheClear(store, current)).toBe(false); expect(data).toEqual(['new local edit'])
  })
  it('coalesces two recovery attempts for the same verified clear intent', async () => {
    const store = storage(), current = state(); store.setItem(MOCK_AUTH_STORAGE_KEY, JSON.stringify(session))
    await markVerifiedMockCache(store, () => current, 'account-a', () => {})
    setAccountCacheSession(undefined); store.removeItem(MOCK_AUTH_STORAGE_KEY)
    const gate = Promise.withResolvers<void>(), clearing = vi.fn(async assertCurrent => { await gate.promise; assertCurrent() })
    const first = clearVerifiedMockAccountCache(store, () => current, clearing)
    const second = clearVerifiedMockAccountCache(store, () => current, clearing)
    gate.resolve(); await Promise.all([first, second]); expect(clearing).toHaveBeenCalledTimes(1)
    expect(hasPendingMockCacheClear(store, current)).toBe(false)
  })
  it('an old account clear rejection cannot erase the new account pending clear', async () => {
    const store = storage(); let current = state()
    setAccountCacheSession('account-a'); store.setItem(MOCK_AUTH_STORAGE_KEY, JSON.stringify(session))
    await markVerifiedMockCache(store, () => current, 'account-a', () => {})
    setAccountCacheSession(undefined); store.removeItem(MOCK_AUTH_STORAGE_KEY)
    const oldGate = Promise.withResolvers<void>(), oldEntered = Promise.withResolvers<void>()
    const oldClear = clearVerifiedMockAccountCache(store, () => current, async assertCurrent => {
      oldEntered.resolve(); await oldGate.promise; assertCurrent()
    })
    await oldEntered.promise
    setAccountCacheSession('account-b')
    expect(hasPendingMockCacheClear(store, current)).toBe(false)
    current = { ...current, workspaceOwnerUserId: 'account-b', accounts: { 'account-b': { lastSyncedVersion: 'txn:2', lastSyncedFingerprint: 'new-account-fingerprint' } } }
    store.setItem(MOCK_AUTH_STORAGE_KEY, JSON.stringify({ ...session, access_token: 'new-account-token', user: { id: 'account-b' } }))
    await markVerifiedMockCache(store, () => current, 'account-b', () => {})
    setAccountCacheSession(undefined); store.removeItem(MOCK_AUTH_STORAGE_KEY)
    const newGate = Promise.withResolvers<void>()
    const clearNew = vi.fn(async assertCurrent => { await newGate.promise; assertCurrent() })
    const next = clearVerifiedMockAccountCache(store, () => current, clearNew)
    oldGate.resolve(); await expect(oldClear).rejects.toBeInstanceOf(AccountCacheChangedError)
    expect(hasPendingMockCacheClear(store, current)).toBe(true)
    const repeat = clearVerifiedMockAccountCache(store, () => current, clearNew)
    newGate.resolve(); await Promise.all([next, repeat])
    expect(clearNew).toHaveBeenCalledTimes(1); expect(hasPendingMockCacheClear(store, current)).toBe(false)
  })
})
