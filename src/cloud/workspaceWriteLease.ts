import { AccountCacheChangedError, captureAccountCacheLease, currentAccountCacheGeneration, currentAccountCacheSession, isAccountCacheSessionResolved } from './accountCacheLease.js'
import { getCloudDeviceState } from './syncState.js'

export class WorkspaceWriteAuthError extends Error {
  readonly code = 'ACCOUNT_WRITE_UNCONFIRMED'
  constructor() {
    super('账号尚未确认，修改尚未写入。请等待账号恢复，或到设置重新连接。 / Account not confirmed. No changes were saved. Wait for account recovery or reconnect in Settings.')
  }
}

/** Admission never derives authority from a retained cache owner. The caller
 * must supply its resolved account, or be a known anonymous, unbound user. */
export function captureWorkspaceWriteLease(accountKey?: string) {
  const readBinding = () => typeof window === 'undefined' ? undefined : getCloudDeviceState()
  const checkIdentity = () => {
    if (!isAccountCacheSessionResolved()) throw new WorkspaceWriteAuthError()
    const owner = readBinding()?.workspaceOwnerUserId
    const active = currentAccountCacheSession()
    if (accountKey ? active !== accountKey || Boolean(owner && owner !== accountKey) : Boolean(owner || active)) {
      throw new WorkspaceWriteAuthError()
    }
  }
  checkIdentity()
  const generation = currentAccountCacheGeneration(), deviceId = readBinding()?.deviceId
  const accountLease = accountKey ? captureAccountCacheLease(accountKey) : undefined
  return { assertCurrent: () => {
    if (generation !== currentAccountCacheGeneration() || deviceId !== readBinding()?.deviceId) throw new AccountCacheChangedError()
    checkIdentity()
    accountLease?.assertCurrent()
  } }
}
