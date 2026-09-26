export type GmailRunMode = 'history' | 'initial_backfill' | 'history_recovery' | 'reconciliation' | 'unknown'
export interface GmailHistoryLag {
  count: number
  sumMs: number
  maxMs: number
  under2m: number
  under15m: number
  over15m: number
}
export interface GmailExecutionMetrics {
  status: 'completed' | 'error'
  mode: GmailRunMode
  errorCode?: string
  providerOperation?: 'profile' | 'history' | 'list' | 'message_fetch' | 'unknown'
  providerStatus?: number
  providerReason?: string
  failureScope?: 'run' | 'record'
  recordGapCount?: number
  receivedCount?: number
  accountedCount?: number
  unresolvedCount?: number
  historyLag?: GmailHistoryLag
}

/** Only aggregate instants. Caller excludes backfill and already consumed messages. */
export function aggregateHistoryLag(receivedTimes: number[], committedAt: number): GmailHistoryLag {
  const result: GmailHistoryLag = { count: 0, sumMs: 0, maxMs: 0, under2m: 0, under15m: 0, over15m: 0 }
  for (const receivedAt of receivedTimes) {
    const lag = committedAt - receivedAt
    if (!Number.isFinite(lag) || lag < 0 || lag > 365 * 86_400_000) continue
    result.count += 1; result.sumMs += lag; result.maxMs = Math.max(result.maxMs, lag)
    if (lag < 120_000) result.under2m += 1
    else if (lag <= 900_000) result.under15m += 1
    else result.over15m += 1
  }
  return result
}
