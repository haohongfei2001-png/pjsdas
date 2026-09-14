export interface CloudSignOutGuardState {
  busy: boolean
  linking: boolean
  loading: boolean
}

export function assertCloudSignOutAllowed(state: CloudSignOutGuardState) {
  if (!state.busy && !state.linking && !state.loading) return
  throw new Error('A PJSDAS cloud operation is still in progress. Sign out after it finishes.')
}
