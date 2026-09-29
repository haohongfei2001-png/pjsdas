export interface CloudSignOutGuardState {
  busy: boolean
  linking: boolean
  loading: boolean
}

export function assertCloudSignOutAllowed(state: CloudSignOutGuardState) {
  if (!state.busy && !state.linking && !state.loading) return
  throw new Error('A TodayAction cloud operation is still in progress. Sign out after it finishes.')
}


export type CloudSignOutBlockingOutcome = 'local_pending' | 'conflict' | 'account_mismatch'

export function accountOutboxCanSurviveSignOut(input: {
  pendingCommands: number
  localDirty: boolean
  verifiedAccountCache: boolean
}) {
  return input.pendingCommands > 0 && !input.localDirty && input.verifiedAccountCache
}

export function assertConnectedSignOutDataSafe(input: {
  outcomeKind?: string
  hasConflict: boolean
  accountMismatch: boolean
  /** Durable commands stay account-scoped after the cache is cleared. */
  accountPendingOnly?: boolean
}) {
  if ((input.outcomeKind !== 'local_pending' || input.accountPendingOnly)
    && input.outcomeKind !== 'conflict'
    && input.outcomeKind !== 'account_mismatch'
    && !input.hasConflict
    && !input.accountMismatch) return
  throw new Error('本机仍有未进入账号工作区的修改；为避免退出时清除这些资料，请先处理同步或冲突。')
}
