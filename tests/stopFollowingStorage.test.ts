import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { isStopFollowingReadTimestampOnly } from '../src/jobs/stopFollowingStorage.js'

const account = 'synthetic-owner', key = 'pjsdas-google-drive-sync-state-v2'
const storage = {} as Storage
const before = () => ({ version: 2, deviceId: 'synthetic-device', autoSync: false, workspaceOwnerUserId: account,
  accounts: { [account]: { lastSyncedVersion: 'txn:1', lastSyncedFingerprint: 'fp', lastReadProjectionFingerprint: 'projection', lastReadProjectionSourceFingerprint: 'fp', lastSyncedAt: '2030-01-01T00:00:00.000Z' },
    other: { lastSyncedVersion: 'txn:0', lastSyncedAt: '2030-01-01T00:00:00.000Z' } } })
function pair() { const a = before(), b = structuredClone(a); b.accounts[account]!.lastSyncedAt = '2030-01-01T00:00:01.000Z'; return [a, b] as [any, any] }
function event(a: unknown, b: unknown) { return { key, oldValue: JSON.stringify(a), newValue: JSON.stringify(b), storageArea: storage } }
function ignores(a: unknown, b: unknown) { return isStopFollowingReadTimestampOnly(event(a, b), account, storage) }

describe('stop-following storage notification filter, default refresh', () => {
  it('ignores only a valid current-owner lastSyncedAt-only change without mutating event bytes', () => {
    const [a, b] = pair(), notification = event(a, b), original = structuredClone(notification)
    expect(isStopFollowingReadTimestampOnly(notification, account, storage)).toBe(true)
    expect(notification.oldValue).toBe(original.oldValue); expect(notification.newValue).toBe(original.newValue)
    expect(a.accounts[account].lastSyncedAt).toBe('2030-01-01T00:00:00.000Z')
  })
  it('compares object content rather than serialization key order', () => {
    const [a, b] = pair(); b.accounts[account] = Object.fromEntries(Object.entries(b.accounts[account]).reverse())
    expect(ignores(a, Object.fromEntries(Object.entries(b).reverse()))).toBe(true)
  })
  it.each([null, 'other', 'pjsdas-cgr01-pending:synthetic-owner', 'pjsdas-cgr01-draft:synthetic-owner:stop-following', 'todayaction-mock-auth-v1'])('refreshes notification key %s', changedKey => {
    const [a, b] = pair(); expect(isStopFollowingReadTimestampOnly({ ...event(a, b), key: changedKey }, account, storage)).toBe(false)
  })
  it.each(['oldValue', 'newValue'] as const)('refreshes clear/removal/malformed %s', field => {
    const [a, b] = pair()
    for (const raw of [null, '', '{', 'null', '[]', '42', '"value"']) expect(isStopFollowingReadTimestampOnly({ ...event(a, b), [field]: raw }, account, storage)).toBe(false)
  })
  it('refreshes missing/current-foreign account and nonlocal or missing storage area', () => {
    const [a, b] = pair(), notification = event(a, b)
    for (const current of [undefined, '', 'other', 'unknown', '__proto__', 'constructor']) expect(isStopFollowingReadTimestampOnly(notification, current, storage)).toBe(false)
    for (const area of [null, {} as Storage]) expect(isStopFollowingReadTimestampOnly({ ...notification, storageArea: area }, account, storage)).toBe(false)
  })
  it.each([
    ['version', 3], ['version', '2'], ['deviceId', 'new-device'], ['deviceId', ''], ['deviceId', null],
    ['autoSync', true], ['autoSync', 'false'], ['workspaceOwnerUserId', 'other'], ['workspaceOwnerUserId', null],
    ['accounts', null], ['accounts', []], ['accounts', {}], ['futureField', 'unchanged-unknown'],
  ])('refreshes changed or invalid root %s=%s', (field, value) => {
    const [a, b] = pair(); b[field as string] = value; expect(ignores(a, b)).toBe(false)
  })
  it.each(['clearedCacheFingerprint', 'lastSyncedVersion', 'lastSyncedFingerprint', 'lastReadProjectionFingerprint', 'lastReadProjectionSourceFingerprint', 'localPendingFingerprint', 'lastError', 'futureCheckpointField'])('refreshes material checkpoint %s', field => {
    const [a, b] = pair(); b.accounts[account][field] = 'material-change'; expect(ignores(a, b)).toBe(false)
  })
  it('refreshes any other account change, including its read timestamp', () => {
    const [a, b] = pair(); b.accounts.other.lastSyncedAt = '2030-01-01T00:00:02.000Z'; expect(ignores(a, b)).toBe(false)
    delete b.accounts.other; expect(ignores(a, b)).toBe(false)
  })
  it.each([null, [], 'invalid', { lastSyncedAt: 123 }, { lastSyncedAt: null }])('refreshes malformed current checkpoint %s', value => {
    const [a, b] = pair(); b.accounts[account] = value; expect(ignores(a, b)).toBe(false)
  })
  it.each(['', 'not-a-date', '2030-99-01T00:00:00.000Z', '2030-02-30T00:00:00.000Z', '2030-01-01', '2030-01-01T00:00:01+00:00', 123, null])('refreshes invalid read timestamp %s', value => {
    const [a, b] = pair(); b.accounts[account].lastSyncedAt = value; expect(ignores(a, b)).toBe(false)
  })
  it('refreshes added/removed/unchanged timestamps rather than treating them as read-only churn', () => {
    const [a, b] = pair(); delete a.accounts[account].lastSyncedAt; expect(ignores(a, b)).toBe(false)
    const [c, d] = pair(); delete d.accounts[account].lastSyncedAt; expect(ignores(c, d)).toBe(false)
    expect(ignores(before(), before())).toBe(false)
  })
  it('refreshes unknown or malformed fields even when unchanged on both sides', () => {
    for (const patch of [(x: any) => { x.future = true }, (x: any) => { x.accounts[account].future = true }, (x: any) => { x.accounts.other = [] }, (x: any) => { x.accounts.other.lastSyncedAt = 'invalid-date' }, (x: any) => { x.accounts[account].lastError = 42 }]) {
      const [a, b] = pair(); patch(a); patch(b); expect(ignores(a, b)).toBe(false)
    }
  })
  it('retains all conflict notifications except a well-formed unchanged conflict alongside read time only', () => {
    const conflict = { remoteVersion: 'v2', remoteFingerprint: 'remote-fp', remoteUpdatedAt: '2030-01-01T00:00:00.000Z', remoteDeviceId: 'remote-device', remoteFileId: 'file' }
    const [a, b] = pair(); a.accounts[account].conflict = conflict; b.accounts[account].conflict = structuredClone(conflict)
    expect(ignores(a, b)).toBe(true)
    for (const field of Object.keys(conflict)) { const c = structuredClone(b); c.accounts[account].conflict[field] = 'changed'; expect(ignores(a, c)).toBe(false) }
    for (const invalid of [null, [], {}, { ...conflict, future: true }, { ...conflict, remoteVersion: 1 }]) { const c = structuredClone(b); c.accounts[account].conflict = invalid; expect(ignores(a, c)).toBe(false) }
  })
  it('falls back to refresh for unexpected event property failures', () => {
    expect(isStopFollowingReadTimestampOnly({ get key() { throw Error('unreadable') } } as any, account, storage)).toBe(false)
  })
})

describe('deterministic two-listener feedback-chain model (not a browser)', () => {
  type Notification = Pick<StorageEvent, 'key' | 'oldValue' | 'newValue' | 'storageArea'>
  function chain(initial: Notification, filter = isStopFollowingReadTimestampOnly) {
    const localAreas = [{} as Storage, {} as Storage]
    const queue = [{ target: 0, notification: initial }]
    let current = before(), reads = 0, ignored = 0
    while (queue.length && reads < 8) {
      const { target, notification } = queue.shift()!
      // Same filter and fail-open-to-refresh choice as the actual listener.
      if (filter({ ...notification, storageArea: localAreas[target]! }, account, localAreas[target]!)) { ignored += 1; continue }
      reads += 1
      const old = structuredClone(current), next = structuredClone(current)
      next.accounts[account]!.lastSyncedAt = new Date(Date.parse(old.accounts[account]!.lastSyncedAt) + 1000).toISOString()
      current = next
      queue.push({ target: 1 - target, notification: event(old, next) })
    }
    return { reads, ignored, queued: queue.length }
  }
  it('detects the old reciprocal read chain and terminates timestamp-only feedback with the actual classifier', () => {
    const [a, b] = pair(), timestamp = event(a, b)
    expect(chain(timestamp, () => false)).toEqual({ reads: 8, ignored: 0, queued: 1 })
    expect(chain(timestamp)).toEqual({ reads: 0, ignored: 1, queued: 0 })
  })
  it.each(['original', 'undo'])('preserves %s locator refresh, then stops only the consequent read-time echo', operation => {
    const [a, b] = pair()
    const locator = { ...event(a, b), key: 'pjsdas-cgr01-draft:synthetic-owner:stop-following:job',
      oldValue: operation === 'undo' ? '{"version":1,"commandId":"original"}' : null,
      newValue: JSON.stringify({ version: 1, commandId: 'original', ...(operation === 'undo' ? { undoCommandId: 'undo' } : {}) }) }
    expect(chain(locator)).toEqual({ reads: 1, ignored: 1, queued: 0 })
  })
  it('preserves a substantive checkpoint refresh, then stops only its read-time echo', () => {
    const [a, b] = pair(); b.accounts[account].lastSyncedVersion = 'txn:2'
    expect(chain(event(a, b))).toEqual({ reads: 1, ignored: 1, queued: 0 })
  })
})

describe('actual control listener integration (source wiring; not browser acceptance)', () => {
  it('filters storage only, preserves mount/recovered refresh, original lease/receipt and symmetric cleanup', () => {
    const text = readFileSync(new URL('../src/jobs/StopFollowingAction.tsx', import.meta.url), 'utf8')
    const effect = text.slice(text.indexOf('  useEffect('), text.indexOf('  async function run'))
    expect(text).toContain("import { isStopFollowingReadTimestampOnly } from './stopFollowingStorage.js'")
    expect(effect).toContain('isStopFollowingReadTimestampOnly(event, accountKey, window.localStorage)')
    expect(effect).toContain("window.addEventListener('storage', refreshFromStorage)")
    expect(effect).toContain("window.removeEventListener('storage', refreshFromStorage)")
    expect(effect).toContain("window.addEventListener('pjsdas:command-recovered', refresh)")
    expect(effect).toContain("window.removeEventListener('pjsdas:command-recovered', refresh)")
    expect(effect).toContain('captureWorkspaceWriteLease(accountKey)')
    expect(effect).toContain('lease.assertCurrent(); return client.inspectStopFollowing(accountKey, opportunity.id)')
    expect(effect).toMatch(/const refreshFromStorage[\s\S]*?refresh\(\)/)
    expect(effect).toContain('    refresh()\n')
    expect(effect).not.toContain('stopFollowing('); expect(effect).not.toContain('setTimeout'); expect(effect).not.toContain('dispatchEvent')
  })
})
