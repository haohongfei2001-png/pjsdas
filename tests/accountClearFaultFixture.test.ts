import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { installAccountClearFault } from '../e2e/support/accountClearFault.js'

const scope = ['actions', 'meta', 'opportunities', 'projectionDeltas']
let cleared: string[]
let Store: any
const witness = () => (window as any).__pcrClearWitness
function transaction(stores = scope, mode = 'readwrite') {
  return { objectStoreNames: stores, mode, abort: vi.fn(() => cleared.push('abort')) }
}
beforeEach(() => {
  cleared = []
  Store = class {
    constructor(public transaction: unknown, public name = 'actions') {}
    clear() { cleared.push(this.name); return { syntheticRequest: true } }
  }
  vi.stubGlobal('IDBObjectStore', Store)
  vi.stubGlobal('window', {})
  vi.stubGlobal('localStorage', { getItem: () => null })
})
afterEach(() => vi.unstubAllGlobals())

describe('account-clear fault fixture', () => {
  it('ignores snapshot replacement and faults the third clear only in the boundary scope', () => {
    installAccountClearFault({ expectedStores: scope, failure: 'partial-clear-throw', authKey: 'synthetic-auth' })
    const snapshot = new Store(transaction([...scope, 'commandInteractions']))
    for (let i = 0; i < 5; i++) snapshot.clear()
    expect(witness()).toMatchObject({ activated: false, ignoredClears: 5, boundaryClears: 0 })
    const boundary = new Store(transaction([...scope].reverse()))
    boundary.clear(); boundary.clear()
    expect(() => boundary.clear()).toThrow('Injected account-cache clear failure')
    expect(witness()).toMatchObject({ activated: true, scope: [...scope].sort(), authPresentAtFault: false })
    expect(cleared).toHaveLength(8) // The failing clear is enqueued before the throw.
  })
  it('counts separately per transaction and preserves one-shot failure semantics', () => {
    installAccountClearFault({ expectedStores: scope, failure: 'partial-clear-throw', authKey: 'synthetic-auth' })
    const one = new Store(transaction()), two = new Store(transaction())
    one.clear(); one.clear(); two.clear(); two.clear()
    expect(witness().activated).toBe(false)
    expect(() => two.clear()).toThrow()
    expect(() => one.clear()).not.toThrow()
    ;(window as any).__restorePcrClear()
    expect(() => two.clear()).not.toThrow()
  })
  it('aborts the intended transaction after queuing its third clear', () => {
    installAccountClearFault({ expectedStores: scope, failure: 'transaction-abort', authKey: 'synthetic-auth' })
    const tx = transaction(), store = new Store(tx)
    store.clear(); store.clear(); store.clear(); store.clear()
    expect(cleared).toEqual(['actions', 'actions', 'actions', 'abort', 'actions'])
    expect(tx.abort).toHaveBeenCalledTimes(1)
    expect(witness().activated).toBe(true)
  })
  it('does not target readonly, partial or unrelated store scopes', () => {
    installAccountClearFault({ expectedStores: scope, failure: 'partial-clear-throw', authKey: 'synthetic-auth' })
    for (const tx of [transaction(scope, 'readonly'), transaction(['actions']), transaction([...scope, 'other'])])
      for (let i = 0; i < 3; i++) new Store(tx).clear()
    expect(witness()).toMatchObject({ activated: false, ignoredClears: 9, boundaryClears: 0 })
  })
})

describe('browser evidence stage isolation', () => {
  it.each(['browser-e2e.yml', 'tsui05-browser-matrix.yml'])('preserves core evidence when later stages run: %s', file => {
    const yaml = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8')
    expect(yaml).toContain('PLAYWRIGHT_HTML_OUTPUT_DIR: playwright-report/core')
    expect(yaml).toContain('--output=test-results/core')
    expect(yaml).toContain('PLAYWRIGHT_HTML_OUTPUT_DIR: playwright-report/instant')
    if (file.includes('matrix')) {
      expect(yaml).toContain('PLAYWRIGHT_HTML_OUTPUT_DIR: playwright-report/performance')
      expect(yaml).toContain('--output=test-results/performance')
    }
    expect(yaml).toContain('playwright-report/\n            test-results/')
  })
})
