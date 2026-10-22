import { describe, expect, it, vi } from 'vitest'
import { createAiRequestIdentity } from '../src/capture/aiRequestIdentity.js'

describe('AI preview retry identity across composer views', () => {
  it('reuses unchanged input after a view closes or switches mode without dispatching', () => {
    const identity = createAiRequestIdentity(), id = vi.fn(() => 'request-1')
    const first = identity.forInput('same draft', 'account-a', id)
    expect(identity.forInput('same draft', 'account-a', id)).toEqual(first)
    expect(id).toHaveBeenCalledTimes(1)
  })
  it('isolates changed text and account and never mutates an earlier envelope', () => {
    const identity = createAiRequestIdentity(); let n = 0
    const id = () => `request-${++n}`
    const first = identity.forInput('draft', 'a', id)
    expect(identity.forInput('changed', 'a', id).requestId).toBe('request-2')
    expect(identity.forInput('changed', 'b', id).requestId).toBe('request-3')
    expect(first).toEqual({ text: 'draft', accountKey: 'a', requestId: 'request-1' })
  })
  it('only a matching known expired/stale response releases an identity', () => {
    const identity = createAiRequestIdentity(); let n = 0
    const id = () => `request-${++n}`
    const first = identity.forInput('draft', 'a', id)
    identity.expire('older-request')
    expect(identity.forInput('draft', 'a', id)).toEqual(first)
    identity.expire(first.requestId)
    expect(identity.forInput('draft', 'a', id).requestId).toBe('request-2')
  })
})
