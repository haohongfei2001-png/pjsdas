import { describe, expect, it } from 'vitest'
import { createCaptureDraftOwnership } from '../src/capture/draftOwnership.js'

describe('memory-only capture draft ownership', () => {
  it('allows a late original completion to consume its unchanged closed draft', () => {
    const owner = createCaptureDraftOwnership()
    owner.view(true, 'account-a', 'job-a'); const submitted = owner.capture()
    owner.view(false, 'account-a', ''); expect(owner.owns(submitted)).toBe(true)
    owner.view(true, 'account-a', 'job-a'); expect(owner.owns(submitted)).toBe(true)
  })
  it('a newly opened B owns even identical raw text and returning to A cannot revive an old token', () => {
    const owner = createCaptureDraftOwnership()
    owner.view(true, 'account-a', 'job-a'); const submitted = owner.capture()
    owner.view(false, 'account-a', ''); owner.view(true, 'account-a', 'job-b')
    expect(owner.owns(submitted)).toBe(false)
    owner.view(true, 'account-a', 'job-a'); expect(owner.owns(submitted)).toBe(false)
  })
  it('edits and account changes revoke old draft consumption', () => {
    const owner = createCaptureDraftOwnership()
    owner.view(true, 'account-a', 'job-a'); const first = owner.capture()
    owner.edit(); expect(owner.owns(first)).toBe(false)
    const second = owner.capture(); owner.view(false, 'account-b', '')
    expect(owner.owns(second)).toBe(false)
  })
  it('capturing B at retry time cannot acquire ownership of the original A command', () => {
    const owner = createCaptureDraftOwnership()
    owner.view(true, 'account-a', 'job-a'); owner.view(false, 'account-a', '')
    owner.view(true, 'account-a', 'job-b'); const retryToken = owner.capture()
    expect(owner.owns(retryToken, 'job-a')).toBe(false)
    expect(owner.owns(retryToken, 'job-b')).toBe(true)
  })

})
