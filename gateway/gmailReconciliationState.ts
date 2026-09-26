import type { GmailReconciliationState } from '../src/model.js'

export const GMAIL_RECONCILIATION_STATES: GmailReconciliationState[] = [
  'NO_ACTION',
  'WAITING',
  'ACTION_REQUIRED',
  'COMPLETED',
  'EXPLICITLY_DECLINED',
  'CLOSED',
  'UNRESOLVED',
]

export interface GmailReconciliationAccumulator {
  scannedCount: number
  recruitingRelevantCount: number
  stateCounts: Record<GmailReconciliationState, number>
  gmailOnlyCount: number
  fixedOrHardWithin7DaysCount: number
  unavailableMessageCount: number
  gmailOpportunityIds: string[]
}

export interface GmailReconciliationContinuationState {
  version: 1
  cycleStartedAt: string
  pageToken?: string
  pendingMessageIds: string[]
  aggregate: GmailReconciliationAccumulator
}

export function emptyGmailReconciliationAccumulator(): GmailReconciliationAccumulator {
  return {
    scannedCount: 0,
    recruitingRelevantCount: 0,
    stateCounts: Object.fromEntries(
      GMAIL_RECONCILIATION_STATES.map((state) => [state, 0]),
    ) as Record<GmailReconciliationState, number>,
    gmailOnlyCount: 0,
    fixedOrHardWithin7DaysCount: 0,
    unavailableMessageCount: 0,
    gmailOpportunityIds: [],
  }
}

export function mergeGmailReconciliationAccumulator(
  prior: GmailReconciliationAccumulator,
  next: GmailReconciliationAccumulator,
): GmailReconciliationAccumulator {
  const stateCounts = Object.fromEntries(
    GMAIL_RECONCILIATION_STATES.map((state) => [
      state,
      (prior.stateCounts[state] ?? 0) + (next.stateCounts[state] ?? 0),
    ]),
  ) as Record<GmailReconciliationState, number>
  return {
    scannedCount: prior.scannedCount + next.scannedCount,
    recruitingRelevantCount: prior.recruitingRelevantCount + next.recruitingRelevantCount,
    stateCounts,
    gmailOnlyCount: prior.gmailOnlyCount + next.gmailOnlyCount,
    fixedOrHardWithin7DaysCount:
      prior.fixedOrHardWithin7DaysCount + next.fixedOrHardWithin7DaysCount,
    unavailableMessageCount: prior.unavailableMessageCount + next.unavailableMessageCount,
    gmailOpportunityIds: [...new Set([
      ...prior.gmailOpportunityIds,
      ...next.gmailOpportunityIds,
    ])],
  }
}
