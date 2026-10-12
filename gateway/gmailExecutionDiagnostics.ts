/** Closed, content-free diagnostics. Never accepts URLs, identities or error text. */
export const GMAIL_EXECUTION_PHASES = ['claim', 'token_refresh', 'workspace_read', 'gmail_list', 'gmail_fetch',
  'message_parse', 'semantic_apply', 'lease_assert', 'workspace_commit', 'checkpoint', 'complete'] as const
export type GmailExecutionPhase = typeof GMAIL_EXECUTION_PHASES[number]
export interface GmailExecutionDiagnostics {
  version: 1
  phase: GmailExecutionPhase
  processedCount: number
  durationsMs: Partial<Record<GmailExecutionPhase, number>>
}
export interface GmailExecutionObserver {
  phase(value: GmailExecutionPhase): void
  processed(): void
}
/** Durations are cumulative wall time sampled before the finish RPC, not its future response time. */
export function createGmailExecutionDiagnostics(now: () => number = () => performance.now()) {
  let phase: GmailExecutionPhase = 'claim'
  let since = now()
  let processedCount = 0
  const durations: Partial<Record<GmailExecutionPhase, number>> = {}
  const bounded = (value: number) => Number.isFinite(value) ? Math.min(25_000, Math.max(0, Math.round(value))) : 0
  const observer: GmailExecutionObserver = {
    phase(value) {
      if (!GMAIL_EXECUTION_PHASES.includes(value) || value === phase) return
      const at = now()
      durations[phase] = bounded((durations[phase] ?? 0) + at - since)
      phase = value
      since = at
    },
    processed() { processedCount = Math.min(100, processedCount + 1) },
  }
  return {
    observer,
    snapshot(): GmailExecutionDiagnostics {
      return { version: 1, phase, processedCount, durationsMs: {
        ...durations, [phase]: bounded((durations[phase] ?? 0) + now() - since),
      } }
    },
  }
}
