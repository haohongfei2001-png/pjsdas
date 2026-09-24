import { describe, expect, it } from 'vitest'
import { captureSessionTransition } from '../src/captureSession.js'

describe('Tell PJSDAS capture session transition', () => {
  it('initializes once when capture opens before auth settles', () => {
    expect(captureSessionTransition(undefined, undefined, false)).toBe('initialize')
  })

  it('adopts typed text when the same user session finishes restoring after capture opened', () => {
    expect(captureSessionTransition(null, 'account-a', true)).toBe('adopt')
  })

  it('loads the account draft when session settles and no text was typed yet', () => {
    expect(captureSessionTransition(null, 'account-a', false)).toBe('initialize')
  })

  it('preserves in-progress text when an established session disappears transiently', () => {
    expect(captureSessionTransition('account-a', undefined, true)).toBe('ignore')
    expect(captureSessionTransition('account-a', 'account-a', true)).toBe('ignore')
  })

  it('reloads account-scoped state only for a real account switch', () => {
    expect(captureSessionTransition('account-a', 'account-b', true)).toBe('initialize')
  })
})
