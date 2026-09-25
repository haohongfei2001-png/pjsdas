import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { assertCloudSignOutAllowed, assertConnectedSignOutDataSafe } from '../src/cloud/cloudOperationGuard.js'

const contextSource = readFileSync(new URL('../src/cloud/CloudContext.tsx', import.meta.url), 'utf8')
const settingsSource = readFileSync(new URL('../src/cloud/CloudSettingsCardHeavy.tsx', import.meta.url), 'utf8')

describe('cloud sign-out guard', () => {
  it('allows sign-out only when no cloud mutation, account link, or startup restore is in flight', () => {
    expect(() => assertCloudSignOutAllowed({ busy: false, linking: false, loading: false })).not.toThrow()
    expect(() => assertCloudSignOutAllowed({ busy: true, linking: false, loading: false })).toThrow(/cloud operation is still in progress/i)
    expect(() => assertCloudSignOutAllowed({ busy: false, linking: true, loading: false })).toThrow(/cloud operation is still in progress/i)
    expect(() => assertCloudSignOutAllowed({ busy: false, linking: false, loading: true })).toThrow(/cloud operation is still in progress/i)
  })

  it('blocks sign-out immediately when the latest connected state already proves local data is unsafe to clear', () => {
    expect(() => assertConnectedSignOutDataSafe({ outcomeKind: 'local_pending', hasConflict: false, accountMismatch: false }))
      .toThrow(/为避免退出时清除这些资料/)
    expect(() => assertConnectedSignOutDataSafe({ outcomeKind: 'conflict', hasConflict: false, accountMismatch: false }))
      .toThrow(/为避免退出时清除这些资料/)
    expect(() => assertConnectedSignOutDataSafe({ outcomeKind: 'account_mismatch', hasConflict: false, accountMismatch: false }))
      .toThrow(/为避免退出时清除这些资料/)
    expect(() => assertConnectedSignOutDataSafe({ outcomeKind: 'synced', hasConflict: true, accountMismatch: false }))
      .toThrow(/为避免退出时清除这些资料/)
    expect(() => assertConnectedSignOutDataSafe({ outcomeKind: 'synced', hasConflict: false, accountMismatch: true }))
      .toThrow(/为避免退出时清除这些资料/)
    expect(() => assertConnectedSignOutDataSafe({ outcomeKind: 'synced', hasConflict: false, accountMismatch: false })).not.toThrow()
  })

  it('enforces the guard in CloudContext instead of relying only on a disabled button', () => {
    expect(contextSource).toContain('assertCloudSignOutAllowed({')
    expect(contextSource).toContain('busy: busyRef.current')
    expect(contextSource).toContain('linking: linkingRef.current')
    expect(contextSource).toContain('loading,')
    expect(contextSource).toContain('assertConnectedSignOutDataSafe({')
    expect(contextSource).toContain('outcomeKind: outcome?.kind')
    expect(contextSource).toContain('await hasUnsyncedLocalWorkspace(session.user.id)')
    expect(contextSource).toContain("outcomeKind: 'local_pending'")
    expect(contextSource.match(/assertCloudSignOutAllowed\(\{/g)?.length).toBeGreaterThanOrEqual(2)
    const signOutStart = contextSource.indexOf('const signOut = useCallback')
    const localDirtyCheck = contextSource.indexOf('await hasUnsyncedLocalWorkspace(session.user.id)', signOutStart)
    const criticalSection = contextSource.indexOf('busyRef.current = true', signOutStart)
    expect(signOutStart).toBeGreaterThanOrEqual(0)
    expect(localDirtyCheck).toBeGreaterThan(signOutStart)
    expect(criticalSection).toBeGreaterThan(localDirtyCheck)
  })

  it('disables the visible sign-out action while sync or startup restoration is active', () => {
    expect(settingsSource).toContain('disabled={cloud.syncing || cloud.loading}')
    expect(settingsSource).toContain('void run(cloud.signOut)')
  })
})
