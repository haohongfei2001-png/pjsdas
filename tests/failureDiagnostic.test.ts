import { describe, expect, it, vi } from 'vitest'
import { withFailureDiagnostic } from '../e2e/fixtures/failureDiagnostic.js'

describe('failure-only E2E diagnostics', () => {
  it('does no diagnostic work on a passing assertion', async () => {
    const attach = vi.fn()
    await withFailureDiagnostic(async () => undefined, attach)
    expect(attach).not.toHaveBeenCalled()
  })
  it.each([false, true])('preserves the exact original failure when attachment fails: %s', async unavailable => {
    const original = new Error('original assertion')
    const attach = vi.fn(async () => { if (unavailable) throw new Error('diagnostic unavailable') })
    await expect(withFailureDiagnostic(async () => { throw original }, attach)).rejects.toBe(original)
    expect(attach).toHaveBeenCalledTimes(1)
  })
})
