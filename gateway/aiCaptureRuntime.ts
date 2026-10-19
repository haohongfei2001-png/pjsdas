import { createAiCaptureLedger } from './aiCaptureLedger.js'
import { createAiCaptureGatewayTransport } from './aiCapturePreview.js'
import type { AiCapturePreviewRuntime } from './aiCapturePreviewHandler.js'
import type { TransactionalWorkspaceStoreOptions } from './transactionalWorkspaceStore.js'

/** Explicit activation metadata is not evidence that upstream billing is capped.
 * Operators must verify the funding/cap and provision account policies separately.
 * No API key, old monthly budget, or model availability can activate this feature. */
export function createConfiguredAiCaptureRuntime(options: TransactionalWorkspaceStoreOptions & {
  env?: Record<string, string | undefined>
}): AiCapturePreviewRuntime | undefined {
  const env = options.env ?? process.env
  if (env.PJSDAS_AI_CAPTURE !== 'enabled'
    || env.PJSDAS_AI_CAPTURE_FUNDING !== 'verified-free-only-no-overage'
    || !options.serviceRoleKey.trim()) return undefined
  const reservationUnits = Number(env.PJSDAS_AI_CAPTURE_MAX_RESERVATION_UNITS)
  if (!Number.isSafeInteger(reservationUnits) || reservationUnits <= 0) return undefined
  return { transport: createAiCaptureGatewayTransport({ fetchImpl: options.fetchImpl }),
    ledger: createAiCaptureLedger(options), reservationUnits }
}
