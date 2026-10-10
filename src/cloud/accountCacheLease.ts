/** Synchronous invalidation precedes all asynchronous account-boundary work. */
let account: string | undefined
let generation = 0
let sessionResolved = false
export class AccountCacheChangedError extends Error {
  constructor() { super('账号或本地数据已变化，已停止应用旧结果。请重试刷新。') }
}
export function setAccountCacheSession(next: string | undefined) {
  sessionResolved = true
  if (next !== account) { account = next; generation += 1 }
}
/** A missing session is anonymous only after Auth has actually resolved it. */
export function beginAccountCacheSessionResolution() { sessionResolved = false; generation += 1 }
export function isAccountCacheSessionResolved() { return sessionResolved }
export function currentAccountCacheSession() { return account }
export function currentAccountCacheGeneration() { return generation }
export function captureAccountCacheLease(expected: string) {
  const captured = generation
  const assertCurrent = () => {
    if (account !== expected || generation !== captured) throw new AccountCacheChangedError()
  }
  assertCurrent()
  return { assertCurrent }
}
