import { describe, expect, it } from 'vitest'
import { decideSyncAction } from '../src/cloud/syncLogic.js'

describe('local-first Google Drive sync decisions', () => {
  it('creates Drive workspace when no remote file exists', () => {
    expect(decideSyncAction({ checkpoint: {}, localFingerprint: 'local', localEmpty: false, remote: null })).toBe('create_remote')
  })

  it('pulls an existing Drive workspace into a new empty device', () => {
    expect(decideSyncAction({ checkpoint: {}, localFingerprint: 'empty', localEmpty: true, remote: { version: '4', fingerprint: 'remote' } })).toBe('pull_remote')
  })

  it('fails closed on first sync when both local and Drive already contain different data', () => {
    expect(decideSyncAction({ checkpoint: {}, localFingerprint: 'local', localEmpty: false, remote: { version: '4', fingerprint: 'remote' } })).toBe('conflict')
  })

  it('pushes when only local changed since the common Drive version', () => {
    expect(decideSyncAction({
      checkpoint: { lastSyncedVersion: '4', lastSyncedFingerprint: 'base' },
      localFingerprint: 'local-new',
      localEmpty: false,
      remote: { version: '4', fingerprint: 'base' },
    })).toBe('push_local')
  })

  it('pulls when only Drive changed since the common version', () => {
    expect(decideSyncAction({
      checkpoint: { lastSyncedVersion: '4', lastSyncedFingerprint: 'base' },
      localFingerprint: 'base',
      localEmpty: false,
      remote: { version: '5', fingerprint: 'remote-new' },
    })).toBe('pull_remote')
  })

  it('stops on concurrent local and Drive changes', () => {
    expect(decideSyncAction({
      checkpoint: { lastSyncedVersion: '4', lastSyncedFingerprint: 'base' },
      localFingerprint: 'local-new',
      localEmpty: false,
      remote: { version: '5', fingerprint: 'remote-new' },
    })).toBe('conflict')
  })

  it('pulls a newer remote command after a verified local read projection', () => {
    expect(decideSyncAction({
      checkpoint: { lastSyncedVersion: '8', lastSyncedFingerprint: 'remote-8' },
      localFingerprint: 'projected-8',
      localProjectionBaselineFingerprint: 'projected-8',
      localEmpty: false,
      remote: { version: '9', fingerprint: 'remote-9' },
    })).toBe('pull_remote')
  })

  it('still rejects a local edit plus newer remote command after projection', () => {
    expect(decideSyncAction({
      checkpoint: { lastSyncedVersion: '8', lastSyncedFingerprint: 'remote-8' },
      localFingerprint: 'local-edited-after-projection',
      localProjectionBaselineFingerprint: 'projected-8',
      localEmpty: false,
      remote: { version: '9', fingerprint: 'remote-9' },
    })).toBe('conflict')
  })

  it('adopts an equal Drive fingerprint without rewriting either side', () => {
    expect(decideSyncAction({ checkpoint: {}, localFingerprint: 'same', localEmpty: false, remote: { version: '8', fingerprint: 'same' } })).toBe('adopt_equal')
  })
})
