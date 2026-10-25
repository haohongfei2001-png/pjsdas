/** Failure-only, payload-free diagnostics on the existing application log sink. */
export interface WorkspaceCommitFailureDiagnostic {
  event: 'workspace_commit_failed'
  rpcVersion: 'v2' | 'v3' | 'v4'
  requestBytes: number
  durationMs: number
  httpStatus: number | null
  errorClass: 'query_canceled' | 'permission_denied' | 'unique_violation' | 'serialization_failure' | 'deadlock' | 'lock_unavailable' | 'database_other' | 'http_error' | 'network_error'
}
export type WorkspaceCommitFailureSink = (diagnostic: WorkspaceCommitFailureDiagnostic) => void | Promise<void>

export function commitFailureClass(code: unknown): WorkspaceCommitFailureDiagnostic['errorClass'] {
  switch (code) {
    // 57014 includes explicit cancellation; it does NOT prove a timeout.
    case '57014': return 'query_canceled'
    case '42501': return 'permission_denied'
    case '23505': return 'unique_violation'
    case '40001': return 'serialization_failure'
    case '40P01': return 'deadlock'
    case '55P03': return 'lock_unavailable'
    default: return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? 'database_other' : 'http_error'
  }
}
export function emitCommitFailure(diagnostic: WorkspaceCommitFailureDiagnostic, sink: WorkspaceCommitFailureSink = value => console.warn(value)) {
  // Neither a synchronous logging error nor a rejected custom sink may change
  // the original commit failure or cause a retry/unhandled rejection.
  try { void Promise.resolve(sink(Object.freeze(diagnostic))).catch(() => undefined) } catch { /* Diagnostics are best effort. */ }
}
