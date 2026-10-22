import { z } from 'zod/v4'
import { semanticIntakeSchema } from './semanticIntake.js'
import type { AiCaptureReview } from './aiCaptureContract.js'
import type { AiCapturePreviewInput } from './aiCapturePreview.js'
import { hashMutationPayload } from './mutationKernel.js'
import { WorkspaceSourceError } from './workspaceSource.js'
import type { TransactionalWorkspaceStoreOptions } from './transactionalWorkspaceStore.js'

export const aiCaptureLedgerRowSchema = z.object({
  user_id: z.string().min(1), request_id: z.string().min(1), payload_hash: z.string().regex(/^[a-f0-9]{64}$/),
  text: z.string(), timezone: z.string(), reference_time: z.string(), expected_revision: z.number().int().nonnegative(),
  expires_at: z.string().refine(value => Number.isFinite(Date.parse(value))),
  status: z.enum(['DISPATCHED', 'READY', 'BLOCKED', 'UNKNOWN', 'COMMITTED']),
  review: z.object({ status: z.enum(['ready_for_review', 'clarification_required', 'no_write', 'invalid_output', 'stale']),
    statementMode: semanticIntakeSchema.shape.statementMode, candidates: semanticIntakeSchema.shape.candidates,
    issues: z.array(z.object({ candidateIndex: z.number().int().nonnegative().nullable(), field: z.enum(['identity', 'time', 'intent', 'unsupported', 'evidence', 'confidence', 'output']), message: z.string() }).strict()).max(100),
  }).strict().nullable(),
  observation: semanticIntakeSchema.nullable(), command_id: z.string().nullable().optional(),
})
export type AiCaptureLedgerRow = z.infer<typeof aiCaptureLedgerRowSchema>
export type AiCaptureAdmission = AiCapturePreviewInput & { userId: string; payloadHash: string; referenceTime: string; reservationUnits: number }
export interface AiCaptureLedger {
  read(userId: string, requestId: string): Promise<AiCaptureLedgerRow | null>
  admit(input: AiCaptureAdmission): Promise<void>
  finish(input: { userId: string; requestId: string; payloadHash: string; status: 'READY' | 'BLOCKED' | 'UNKNOWN'; review: AiCaptureReview | null; observation: z.infer<typeof semanticIntakeSchema> | null }): Promise<void>
}
export const aiCapturePayloadHash = (input: AiCapturePreviewInput) => hashMutationPayload('ai_capture_preview_v1', input)

/** Only service-role RPCs can write. No in-process lock or cache is admission authority.
 * The SQL policy defaults disabled, requires explicitly provisioned free-only credit,
 * and permanently reserves the worst-case units even on an unknown model result. */
export function createAiCaptureLedger(options: TransactionalWorkspaceStoreOptions): AiCaptureLedger {
  if (!options.serviceRoleKey.trim()) throw new WorkspaceSourceError('AI_CAPTURE_NOT_ENABLED', 'Capture ledger credential is unavailable.', false)
  const base = options.supabaseUrl.replace(/\/+$/, '')
  const headers = { authorization: `Bearer ${options.serviceRoleKey}`, apikey: options.serviceRoleKey, 'content-type': 'application/json' }
  const request = async (path: string, body?: unknown) => {
    let response: Response
    try { response = await (options.fetchImpl ?? fetch)(`${base}/rest/v1/${path}`, { headers, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) }) }
    catch { throw new WorkspaceSourceError('AI_CAPTURE_LEDGER_UNAVAILABLE', 'Capture ledger outcome is unknown; do not resend to the model.', false) }
    if (!response.ok) throw new WorkspaceSourceError('AI_CAPTURE_ADMISSION_REJECTED', 'Durable capture admission or persistence was rejected.', false)
    return response
  }
  return {
    async read(userId, requestId) {
      const query = new URLSearchParams({ select: '*', user_id: `eq.${userId}`, request_id: `eq.${requestId}`, limit: '1' })
      const rows = await (await request(`pjsdas_ai_capture_previews?${query}`)).json()
      if (!Array.isArray(rows) || rows.length > 1) throw new WorkspaceSourceError('AI_CAPTURE_LEDGER_INVALID', 'Invalid capture ledger response.', false)
      if (!rows.length) return null
      const row = aiCaptureLedgerRowSchema.parse(rows[0])
      if (row.user_id !== userId || row.request_id !== requestId) throw new WorkspaceSourceError('AI_CAPTURE_LEDGER_INVALID', 'Capture identity mismatch.', false)
      return row
    },
    async admit(input) {
      if (!Number.isSafeInteger(input.reservationUnits) || input.reservationUnits <= 0) throw new WorkspaceSourceError('AI_CAPTURE_NOT_ENABLED', 'Approved free-only reservation is not configured.', false)
      await request('rpc/pjsdas_admit_ai_capture', { target_user_id: input.userId, target_request_id: input.requestId, target_payload_hash: input.payloadHash,
        target_text: input.text, target_timezone: input.timezone, target_reference_time: input.referenceTime, target_expected_revision: input.expectedRevision, target_reservation_units: input.reservationUnits })
    },
    async finish(input) {
      await request('rpc/pjsdas_finish_ai_capture', { target_user_id: input.userId, target_request_id: input.requestId, target_payload_hash: input.payloadHash,
        target_status: input.status, target_review: input.review, target_observation: input.observation })
    },
  }
}
