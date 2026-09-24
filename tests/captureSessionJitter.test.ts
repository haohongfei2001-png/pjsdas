import { describe, expect, it } from 'vitest'
import { shouldInitializeCaptureForSession } from '../src/captureSession.js'

describe('Tell PJSDAS capture session initialization', () => {
  it('initializes once when the capture opens before auth settles', () => {
    expect(shouldInitializeCaptureForSession(undefined, undefined)).toBe(true)
    expect(shouldInitializeCaptureForSession(null, 'account-a')).toBe(true)
  })

  it('preserves in-progress text when an established session disappears transiently', () => {
    expect(shouldInitializeCaptureForSession('account-a', undefined)).toBe(false)
    expect(shouldInitializeCaptureForSession('account-a', 'account-a')).toBe(false)
  })

  it('reloads account-scoped draft only for a real account switch', () => {
    expect(shouldInitializeCaptureForSession('account-a', 'account-b')).toBe(true)
  })
})
