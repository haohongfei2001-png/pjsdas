import { describe, expect, it, vi } from 'vitest'
import { ensureAuthoritativePersistence } from '../src/cloud/authoritativePersistence.js'

describe('UU-04 authoritative persistence receipts', () => {
  it('does nothing in local-only mode', async () => {
    const sync = vi.fn()
    await expect(ensureAuthoritativePersistence(false, sync)).resolves.toBeUndefined()
    expect(sync).not.toHaveBeenCalled()
  })

  it('waits through an in-flight sync and accepts only authoritative push/synced outcomes', async () => {
    const sync = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ kind: 'pushed', version: 'txn:9' })
    await expect(ensureAuthoritativePersistence(true, sync, { attempts: 2, intervalMs: 0 }))
      .resolves.toMatchObject({ kind: 'pushed', version: 'txn:9' })
    expect(sync).toHaveBeenCalledTimes(2)
  })

  it('fails closed on conflict instead of rendering a saved receipt', async () => {
    const sync = vi.fn().mockResolvedValue({ kind: 'conflict', version: 'txn:10' })
    await expect(ensureAuthoritativePersistence(true, sync, { intervalMs: 0 }))
      .rejects.toThrow(/同步冲突/)
  })

  it('fails closed when remote state pulls over the local mutation', async () => {
    const sync = vi.fn().mockResolvedValue({ kind: 'pulled', version: 'txn:11' })
    await expect(ensureAuthoritativePersistence(true, sync, { intervalMs: 0 }))
      .rejects.toThrow(/覆盖了本地状态/)
  })
})
