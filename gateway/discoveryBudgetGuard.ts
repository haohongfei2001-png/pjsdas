import { WorkspaceSourceError } from './workspaceSource.js'
import { UncertainDiscoveryExecution } from './discoveryExecutionOutcome.js'

export interface DiscoverySpendRequest {
  requestId: string
  application: 'todayaction'
  provider: 'vercel-ai-gateway'
  accountId: string
  sourceId: string
  model: string
  inputBytes: number
  maxOutputTokens: number
  maxSdkAttempts: 1
}
export interface DiscoverySpendReservation extends DiscoverySpendRequest {
  reservationId: string
  reservedUsd: number
  expiresAt: string
}
/** Server-owned adapter only. It must atomically reserve against a separately
 * approved TodayAction monetary budget before returning this bound receipt.
 * No production adapter is installed by this default-deny foundation. */
export type ReserveDiscoverySpend = (request: Readonly<DiscoverySpendRequest>) => Promise<DiscoverySpendReservation>

export async function requireDiscoverySpendReservation(input: {
  accountId?: string
  sourceId?: string
  model: string
  prompt: string
  system: string
  maxOutputTokens: number
  reserve?: ReserveDiscoverySpend
}) {
  if (!input.reserve || !input.accountId || !input.sourceId) {
    throw new WorkspaceSourceError('DISCOVERY_BUDGET_APPROVAL_REQUIRED', 'Background search requires a separately approved and metered TodayAction budget.', false)
  }
  const inputBytes = new TextEncoder().encode(input.system + input.prompt).byteLength
  if (inputBytes > 262144) throw new WorkspaceSourceError('DISCOVERY_BUDGET_INPUT_TOO_LARGE', 'Discovery input exceeds the bounded budget request.', false)
  const request = Object.freeze({ requestId: crypto.randomUUID(), application: 'todayaction' as const, provider: 'vercel-ai-gateway' as const, accountId: input.accountId, sourceId: input.sourceId, model: input.model, inputBytes, maxOutputTokens: input.maxOutputTokens, maxSdkAttempts: 1 as const })
  let receipt
  try { receipt = await input.reserve(request) }
  catch (caught) {
    if (caught instanceof WorkspaceSourceError && caught.code === 'DISCOVERY_BUDGET_EXHAUSTED') throw caught
    throw new UncertainDiscoveryExecution('DISCOVERY_BUDGET_RESERVATION_UNCERTAIN', 'The original model budget reservation may exist. Retain its hold and reconcile before retrying.', false)
  }
  if (!receipt || Object.entries(request).some(([key, value]) => receipt[key as keyof DiscoverySpendRequest] !== value)
    || !receipt.reservationId || typeof receipt.reservationId !== 'string'
    || !Number.isFinite(receipt.reservedUsd) || receipt.reservedUsd <= 0
    || !Number.isFinite(Date.parse(receipt.expiresAt)) || Date.parse(receipt.expiresAt) <= Date.now()) {
    throw new UncertainDiscoveryExecution('DISCOVERY_BUDGET_RESERVATION_INVALID', 'The returned reservation does not prove the original hold; reconcile before retrying.', false)
  }
  return Object.freeze({ ...receipt })
}
