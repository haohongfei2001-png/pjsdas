export interface CloudSignOutGuardState {
  busy: boolean
  linking: boolean
  loading: boolean
}

export function assertCloudSignOutAllowed(state: CloudSignOutGuardState) {
  if (!state.busy && !state.linking && !state.loading) return
  throw new Error('A PJSDAS cloud operation is still in progress. Sign out after it finishes.')
}


export type CloudSignOutBlockingOutcome = 'local_pending' | 'conflict' | 'account_mismatch'

export function assertConnectedSignOutDataSafe(input: {
  outcomeKind?: string
  hasConflict: boolean
  accountMismatch: boolean
}) {
  if (input.outcomeKind !== 'local_pending'
    && input.outcomeKind !== 'conflict'
    && input.outcomeKind !== 'account_mismatch'
    && !input.hasConflict
    && !input.accountMismatch) return
  throw new Error('本机仍有未进入账号工作区的修改；为避免退出时清除这些资料，请先处理同步或冲突。')
}
