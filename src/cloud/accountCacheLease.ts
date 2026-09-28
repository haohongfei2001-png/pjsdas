/** Synchronous invalidation precedes all asynchronous account-boundary work. */
let account: string | undefined
let generation = 0
export class AccountCacheChangedError extends Error {
  constructor() { super('账号或本地数据已变化，已停止应用旧结果。请重试刷新。') }
}
export function setAccountCacheSession(next: string | undefined) {
  if (next !== account) { account = next; generation += 1 }
}
export function captureAccountCacheLease(expected: string) {
  const captured = generation
  const assertCurrent = () => {
    if (account !== expected || generation !== captured) throw new AccountCacheChangedError()
  }
  assertCurrent()
  return { assertCurrent }
}
