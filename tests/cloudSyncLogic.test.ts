import { describe, expect, it } from 'vitest'
import { decideSyncAction } from '../src/cloud/syncLogic'

describe('local-first cloud sync decisions', () => {
  it('creates cloud workspace when no remote row exists', () => {
    expect(decideSyncAction({ checkpoint: {}, localFingerprint: 'local', localEmpty: false, remote: null })).toBe('create_remote')
  })

  it('pulls an existing cloud workspace into a new empty device', () => {
    expect(decideSyncAction({ checkpoint: {}, localFingerprint: 'empty', localEmpty: true, remote: { revision: 4, fingerprint: 'remote' } })).toBe('pull_remote')
  })

  it('fails closed on first sync when both local and remote already contain different data', () => {
    expect(decideSyncAction({ checkpoint: {}, localFingerprint: 'local', localEmpty: false, remote: { revision: 4, fingerprint: 'remote' } })).toBe('conflict')
  })

  it('pushes when only local changed since the common revision', () => {
    expect(decideSyncAction({
      checkpoint: { lastSyncedRevision: 4, lastSyncedFingerprint: 'base' },
      localFingerprint: 'local-new',
      localEmpty: false,
      remote: { revision: 4, fingerprint: 'base' },
    })).toBe('push_local')
  })

  it('pulls when only remote changed since the common revision', () => {
    expect(decideSyncAction({
      checkpoint: { lastSyncedRevision: 4, lastSyncedFingerprint: 'base' },
      localFingerprint: 'base',
      localEmpty: false,
      remote: { revision: 5, fingerprint: 'remote-new' },
    })).toBe('pull_remote')
  })

  it('stops on concurrent local and remote changes', () => {
    expect(decideSyncAction({
      checkpoint: { lastSyncedRevision: 4, lastSyncedFingerprint: 'base' },
      localFingerprint: 'local-new',
      localEmpty: false,
      remote: { revision: 5, fingerprint: 'remote-new' },
    })).toBe('conflict')
  })

  it('adopts an equal remote fingerprint without rewriting either side', () => {
    expect(decideSyncAction({ checkpoint: {}, localFingerprint: 'same', localEmpty: false, remote: { revision: 8, fingerprint: 'same' } })).toBe('adopt_equal')
  })
})
