import { describe, expect, it, vi } from 'vitest'
import { enforceConnectedAccountCacheBoundary } from '../src/cloud/accountCacheBoundary.js'

describe('CGR-01 connected account cache boundary', () => {
  it('clears account A cache before exposing account B', async () => {
    const clearCache = vi.fn(async () => undefined)
    const clearBinding = vi.fn()
    await expect(enforceConnectedAccountCacheBoundary('account-a', 'account-b', clearCache, clearBinding)).resolves.toBe(true)
    expect(clearCache).toHaveBeenCalledTimes(1)
    expect(clearBinding).toHaveBeenCalledTimes(1)
    expect(clearCache.mock.invocationCallOrder[0]).toBeLessThan(clearBinding.mock.invocationCallOrder[0]!)
  })

  it('clears the connected cache on sign-out or session expiry', async () => {
    const clearCache = vi.fn(async () => undefined)
    const clearBinding = vi.fn()
    await expect(enforceConnectedAccountCacheBoundary('account-a', undefined, clearCache, clearBinding)).resolves.toBe(true)
    expect(clearCache).toHaveBeenCalledTimes(1)
    expect(clearBinding).toHaveBeenCalledTimes(1)
  })

  it('does not clear the same account or an unbound local workspace', async () => {
    const clearCache = vi.fn(async () => undefined)
    const clearBinding = vi.fn()
    await expect(enforceConnectedAccountCacheBoundary('account-a', 'account-a', clearCache, clearBinding)).resolves.toBe(false)
    await expect(enforceConnectedAccountCacheBoundary(undefined, 'account-b', clearCache, clearBinding)).resolves.toBe(false)
    expect(clearCache).not.toHaveBeenCalled()
    expect(clearBinding).not.toHaveBeenCalled()
  })
})
