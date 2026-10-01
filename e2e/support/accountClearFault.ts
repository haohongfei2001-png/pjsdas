/** Browser-serialized fixture: fault only the account-cache clear transaction. */
export function installAccountClearFault(input: {
  expectedStores: string[]
  failure: 'partial-clear-throw' | 'transaction-abort'
  authKey: string
}) {
  const clear = IDBObjectStore.prototype.clear
  const expected = [...input.expectedStores].sort().join('|')
  const calls = new WeakMap<IDBTransaction, number>()
  const witness = { activated: false, boundaryClears: 0, ignoredClears: 0,
    scope: [] as string[], authPresentAtFault: undefined as boolean | undefined }
  ;(window as any).__pcrClearWitness = witness
  ;(window as any).__restorePcrClear = () => { IDBObjectStore.prototype.clear = clear }
  IDBObjectStore.prototype.clear = function () {
    const request = clear.call(this)
    const scope = Array.from(this.transaction.objectStoreNames).sort()
    if (this.transaction.mode !== 'readwrite' || scope.join('|') !== expected) {
      witness.ignoredClears += 1
      return request
    }
    const count = (calls.get(this.transaction) ?? 0) + 1
    calls.set(this.transaction, count)
    witness.boundaryClears += 1
    if (count === 3 && !witness.activated) {
      witness.activated = true
      witness.scope = scope
      witness.authPresentAtFault = Boolean(localStorage.getItem(input.authKey))
      if (input.failure === 'transaction-abort') this.transaction.abort()
      else throw new Error('Injected account-cache clear failure')
    }
    return request
  }
}
