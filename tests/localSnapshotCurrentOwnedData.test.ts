import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PJSDASSnapshot } from '../src/snapshot.js'
const state = vi.hoisted(() => ({
  clone: globalThis.structuredClone,
  data: undefined as undefined | PJSDASSnapshot['data'],
  scopes: [] as { stores: string[]; mode: string }[],
  returned: [] as any[], aborts: 0, writes: 0,
}))
vi.mock('idb', () => ({ openDB: async () => ({
  transaction: (stores: string[], mode: string) => {
    state.scopes.push({ stores: [...stores], mode })
    // Model IndexedDB's transaction snapshot and request-result copy boundary.
    const locked = state.clone(state.data!)
    const result = (value: unknown) => { const owned = state.clone(value); state.returned.push(owned); return Promise.resolve(owned) }
    return { objectStore: (name: string) => ({
      getAll: () => result((locked as any)[name] ?? []),
      get: (key: string) => result(name === 'decisionRules' ? locked.decisionRules
        : name === 'discoveryProfiles' ? locked.discoveryProfile
        : key === 'timePlanning' && locked.timePlanning ? { ...locked.timePlanning, key }
        : key === 'lastImport' ? locked.meta : undefined),
      put: () => { state.writes++; throw new Error('Currentness checks must never write.') },
    }), done: Promise.resolve(), abort: () => { state.aborts++ } }
  },
}) }))
import { assertLocalSnapshotCurrent, exportLocalSnapshot } from '../src/db.js'
import { AccountCacheChangedError } from '../src/cloud/accountCacheLease.js'
import { instantDenseWorkspace } from './fixtures/instantDenseWorkspace.js'

beforeEach(() => {
  state.data = instantDenseWorkspace(3940).data
  state.scopes = []; state.returned = []; state.aborts = 0; state.writes = 0
})
const scope = ['opportunities', 'opportunityAliases', 'processes', 'processEvents', 'scheduleNodes', 'decisionRequests',
  'semanticReceipts', 'reminderIntents', 'reminderOutbox', 'actions', 'prep', 'applicationGroups', 'decisionRules',
  'discoveryProfiles', 'discoveryInbox', 'timeline', 'changeSets', 'meta']

describe('currentness check consumes only fresh transaction-owned data', () => {
  it('keeps all-store readwrite locking, every lease guard, validation and exact equality', async () => {
    const expected = await exportLocalSnapshot()
    const before = state.clone(state.data)
    state.scopes = []
    const guard = vi.fn()
    await expect(assertLocalSnapshotCurrent(expected, guard)).resolves.toBeUndefined()
    expect(state.scopes).toEqual([{ stores: scope, mode: 'readwrite' }])
    expect(guard).toHaveBeenCalledTimes(4)
    expect(state.data).toEqual(before)
    expect(state.writes).toBe(0)
  })

  it('does not clone the entire newly read history a second time', async () => {
    const expected = await exportLocalSnapshot()
    const clone = vi.spyOn(globalThis, 'structuredClone')
    try {
      await assertLocalSnapshotCurrent(expected, () => {})
      expect(clone.mock.calls.some(([value]) => Array.isArray(value) && value.length >= 3940
        || value && typeof value === 'object' && 'timeline' in value)).toBe(false)
    } finally { clone.mockRestore() }
  })

  it('never adopts an externally mutated expected snapshot', async () => {
    const expected = await exportLocalSnapshot()
    expected.data.timeline![0].detail = 'external mutation after export'
    await expect(assertLocalSnapshotCurrent(expected, () => {})).rejects.toBeInstanceOf(AccountCacheChangedError)
    expect(state.aborts).toBe(1)
    expect(state.data!.timeline![0].detail).not.toBe('external mutation after export')
  })

  it('detects a later local audit edit and preserves the captured caller value', async () => {
    const expected = await exportLocalSnapshot()
    const captured = state.clone(expected)
    state.data!.timeline![3939].detail = 'later persisted evidence'
    await expect(assertLocalSnapshotCurrent(expected, () => {})).rejects.toBeInstanceOf(AccountCacheChangedError)
    expect(expected).toEqual(captured)
    expect(state.aborts).toBe(1)
    expect(state.writes).toBe(0)
  })

  it('does not alias returned request data into caller snapshots or persistent records', async () => {
    const expected = await exportLocalSnapshot()
    const captured = state.clone(expected), persisted = state.clone(state.data)
    state.returned = []
    await assertLocalSnapshotCurrent(expected, () => {})
    const audit = state.returned.find(value => Array.isArray(value) && value.length >= 3940)
    audit[0].detail = 'mutation of discarded request result'
    expect(expected).toEqual(captured)
    expect(state.data).toEqual(persisted)
  })

  it('aborts if the lease changes while the IndexedDB reads are pending', async () => {
    const expected = await exportLocalSnapshot()
    let count = 0
    await expect(assertLocalSnapshotCurrent(expected, () => {
      if (++count === 3) throw new AccountCacheChangedError()
    })).rejects.toBeInstanceOf(AccountCacheChangedError)
    expect(state.aborts).toBe(1)
    expect(state.writes).toBe(0)
  })

  it('still rejects invalid stored history rather than comparing unvalidated facts', async () => {
    const expected = await exportLocalSnapshot()
    state.data!.timeline![3939].recordedAt = 'not a timestamp'
    await expect(assertLocalSnapshotCurrent(expected, () => {})).rejects.toThrow(/recordedAt/)
    expect(state.aborts).toBe(1)
    expect(state.writes).toBe(0)
  })
})
