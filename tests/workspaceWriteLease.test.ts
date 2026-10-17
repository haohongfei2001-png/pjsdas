import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AccountCacheChangedError,
  beginAccountCacheSessionResolution,
  isAccountCacheSessionResolved,
  setAccountCacheSession,
} from '../src/cloud/accountCacheLease.js'
import { captureWorkspaceWriteLease, WorkspaceWriteAuthError } from '../src/cloud/workspaceWriteLease.js'
import { bindLocalWorkspaceToUser, clearLocalWorkspaceBinding, getCloudDeviceState } from '../src/cloud/syncState.js'

// Persisted binding is deliberately real: only the browser storage boundary is synthetic.
function localStorageFixture() {
  const entries = new Map<string, string>()
  return {
    getItem: vi.fn((key: string) => entries.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { entries.set(key, value) }),
    removeItem: (key: string) => { entries.delete(key) },
  }
}

beforeEach(() => {
  vi.stubGlobal('window', { localStorage: localStorageFixture() })
  setAccountCacheSession(undefined)
  beginAccountCacheSessionResolution()
})
afterEach(() => vi.unstubAllGlobals())

describe('workspace write admission uses resolved Auth and persisted cache ownership', () => {
  it('requires an explicit anonymous resolution even for a fresh unbound workspace', () => {
    expect(isAccountCacheSessionResolved()).toBe(false)
    expect(() => captureWorkspaceWriteLease()).toThrow(WorkspaceWriteAuthError)
    setAccountCacheSession(undefined)
    expect(() => captureWorkspaceWriteLease().assertCurrent()).not.toThrow()
  })

  it('rejects unresolved Auth before initializing or reading persisted device state', () => {
    expect(() => captureWorkspaceWriteLease()).toThrow(WorkspaceWriteAuthError)
    expect(window.localStorage.getItem).not.toHaveBeenCalled()
    expect(window.localStorage.setItem).not.toHaveBeenCalled()
  })

  it.each([undefined, 'account-a'])('rejects bound cache A while Auth is unresolved, with key %s', key => {
    bindLocalWorkspaceToUser('account-a')
    expect(() => captureWorkspaceWriteLease(key)).toThrow(WorkspaceWriteAuthError)
    expect(getCloudDeviceState().workspaceOwnerUserId).toBe('account-a')
  })

  it.each([true, false])('rejects an omitted key with active account A (bound: %s)', bound => {
    setAccountCacheSession('account-a')
    if (bound) bindLocalWorkspaceToUser('account-a')
    expect(() => captureWorkspaceWriteLease()).toThrow(WorkspaceWriteAuthError)
  })

  it.each([
    { active: 'account-a', owner: 'account-a', key: 'account-b' },
    { active: 'account-b', owner: 'account-a', key: 'account-b' },
    { active: undefined, owner: 'account-a', key: 'account-a' },
    { active: undefined, owner: 'account-a', key: undefined },
    { active: undefined, owner: undefined, key: 'account-a' },
  ])('rejects mismatched authority: $active / $owner / $key', ({ active, owner, key }) => {
    setAccountCacheSession(active)
    if (owner) bindLocalWorkspaceToUser(owner)
    expect(() => captureWorkspaceWriteLease(key)).toThrow(WorkspaceWriteAuthError)
  })

  it('admits an explicitly supplied resolved account matching its bound cache', () => {
    setAccountCacheSession('account-a')
    bindLocalWorkspaceToUser('account-a')
    const lease = captureWorkspaceWriteLease('account-a')
    setAccountCacheSession('account-a')
    expect(lease.assertCurrent).not.toThrow()
  })

  it('rejects an old account A lease after A → B → A', () => {
    setAccountCacheSession('account-a')
    bindLocalWorkspaceToUser('account-a')
    const lease = captureWorkspaceWriteLease('account-a')
    setAccountCacheSession('account-b')
    setAccountCacheSession('account-a')
    expect(lease.assertCurrent).toThrow(AccountCacheChangedError)
  })

  it('invalidates a lease when Auth restarts, even when the same account resolves again', () => {
    setAccountCacheSession('account-a')
    bindLocalWorkspaceToUser('account-a')
    const lease = captureWorkspaceWriteLease('account-a')
    beginAccountCacheSessionResolution()
    setAccountCacheSession('account-a')
    expect(lease.assertCurrent).toThrow(AccountCacheChangedError)
  })

  it.each([undefined, 'account-a'])('invalidates a changed device with unchanged account %s', account => {
    setAccountCacheSession(account)
    if (account) bindLocalWorkspaceToUser(account)
    const lease = captureWorkspaceWriteLease(account)
    window.localStorage.setItem('pjsdas-google-drive-sync-state-v2', JSON.stringify({
      ...getCloudDeviceState(), deviceId: 'replacement-device',
    }))
    expect(lease.assertCurrent).toThrow(AccountCacheChangedError)
  })

  it('rejects a different persisted owner even if the active account has not changed', () => {
    setAccountCacheSession('account-a')
    bindLocalWorkspaceToUser('account-a')
    const lease = captureWorkspaceWriteLease('account-a')
    bindLocalWorkspaceToUser('account-b')
    expect(lease.assertCurrent).toThrow(WorkspaceWriteAuthError)
  })

  it('rejects an anonymous lease as soon as the workspace is bound', () => {
    setAccountCacheSession(undefined)
    const lease = captureWorkspaceWriteLease()
    bindLocalWorkspaceToUser('account-a')
    expect(lease.assertCurrent).toThrow(WorkspaceWriteAuthError)
  })

  it('does not revive an anonymous lease after login followed by logout', () => {
    setAccountCacheSession(undefined)
    const lease = captureWorkspaceWriteLease()
    setAccountCacheSession('account-a')
    bindLocalWorkspaceToUser('account-a')
    setAccountCacheSession(undefined)
    clearLocalWorkspaceBinding()
    expect(lease.assertCurrent).toThrow(AccountCacheChangedError)
  })
})
