import { verifiedAiInterviewReschedules } from './aiCaptureContract.js'
import { aiCapturePayloadHash, type AiCaptureLedger } from './aiCaptureLedger.js'
import { aiCapturePreviewInputSchema, prepareAiCapturePreview, type AiCaptureTransport } from './aiCapturePreview.js'
import { createSupabaseIdentityResolver, type PjsdasIdentity } from './supabaseIdentity.js'
import { WorkspaceSourceError } from './workspaceSource.js'
import type { ConnectedWorkspaceRecord } from './transactionalWorkspaceStore.js'

export interface AiCapturePreviewRuntime {
  transport: AiCaptureTransport
  ledger: AiCaptureLedger
  /** Worst-case free-credit units, approved separately from any paid budget. */
  reservationUnits: number
  /** Optional additional consent check; durable admission is always last. */
  beforeDispatch?: (input: { userId: string; requestId: string; text: string; timezone: string; referenceTime: string; workspaceRevision: number }) => Promise<void>
}
export function createAiCapturePreviewHandler(config: {
  supabaseUrl: string; supabasePublishableKey: string; allowedOrigins: string[]; fetchImpl?: typeof fetch
  authorizeIdentity: (identity: PjsdasIdentity) => Promise<unknown>
  readWorkspace: (userId: string) => Promise<ConnectedWorkspaceRecord | null | undefined>
  now?: () => Date
  /** Absent in production until approved funding/data scope AND durable
   * admission/receipt infrastructure have been verified. A key is not consent. */
  runtime?: AiCapturePreviewRuntime
}) {
  const resolveIdentity = createSupabaseIdentityResolver({ supabaseUrl: config.supabaseUrl, publishableKey: config.supabasePublishableKey, fetchImpl: config.fetchImpl })
  return async (request: Request) => {
    const origin = request.headers.get('origin')
    const allowed = Boolean(origin && config.allowedOrigins.includes(origin))
    const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store', vary: 'Origin' })
    if (allowed) { headers.set('access-control-allow-origin', origin!); headers.set('access-control-allow-headers', 'authorization, content-type'); headers.set('access-control-allow-methods', 'POST, OPTIONS') }
    const respond = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers })
    if (!allowed) return respond(403, { code: 'ORIGIN_NOT_ALLOWED' })
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    if (request.method !== 'POST') return respond(405, { code: 'METHOD_NOT_ALLOWED' })
    try {
      const { identity } = await resolveIdentity(request)
      if (identity.oauthClientId) return respond(403, { code: 'AUTH_FORBIDDEN' })
      const audience = await config.authorizeIdentity(identity) as { allowed?: boolean } | undefined
      if (audience?.allowed === false) return respond(403, { code: 'AUTH_FORBIDDEN' })
      if (!config.runtime) return respond(503, { code: 'AI_CAPTURE_NOT_ENABLED', message: 'AI interpretation is not enabled for this account. Nothing was sent to a model or saved.', retryable: false })
      if (Number(request.headers.get('content-length')) > 40_000) return respond(413, { code: 'AI_CAPTURE_TOO_LARGE' })
      // Bound stream consumption, not just a forgeable content-length header.
      const reader = request.body?.getReader(); let size = 0; const chunks: Uint8Array[] = []
      if (reader) try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 40_000) { await reader.cancel(); return respond(413, { code: 'AI_CAPTURE_TOO_LARGE' }) } chunks.push(next.value) } } finally { reader.releaseLock() }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      let input
      try { input = aiCapturePreviewInputSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) } catch { return respond(400, { code: 'INVALID_ARGUMENT' }) }
      const payloadHash = await aiCapturePayloadHash(input)
      const existing = await config.runtime.ledger.read(identity.userId, input.requestId)
      const workspace = await config.readWorkspace(identity.userId)
      if (!workspace || workspace.userId !== identity.userId) return respond(403, { code: 'WORKSPACE_NOT_AVAILABLE' })
      if (input.contextRefs?.some(ref => !workspace.snapshot.data.opportunities.some(job => `opportunity:${job.id}` === ref))) return respond(409, { code: 'AI_CAPTURE_CONTEXT_CHANGED', retryable: false })
      if (existing) {
        if (existing.payload_hash !== payloadHash) return respond(409, { code: 'AI_CAPTURE_REQUEST_ID_REUSED', retryable: false })
        if (!existing.review || !['READY', 'BLOCKED', 'COMMITTED'].includes(existing.status)) return respond(409, { code: 'AI_CAPTURE_RESULT_UNKNOWN', retryable: false })
        if (existing.status !== 'COMMITTED' && Date.parse(existing.expires_at) <= (config.now?.() ?? new Date()).getTime()) return respond(409, { code: 'AI_CAPTURE_EXPIRED', retryable: false })
        if (existing.status !== 'COMMITTED' && workspace.revision !== existing.expected_revision) return respond(409, { code: 'AI_CAPTURE_STALE', retryable: false })
        return respond(200, { requestId: input.requestId, referenceTime: existing.reference_time, workspaceRevision: existing.expected_revision,
          review: existing.review, canCommit: existing.status === 'READY' && workspace.revision === existing.expected_revision && Date.parse(existing.expires_at) > (config.now?.() ?? new Date()).getTime() })
      }
      if (workspace.revision !== input.expectedRevision) return respond(409, { code: 'AI_CAPTURE_STALE' })
      const referenceTime = (config.now?.() ?? new Date()).toISOString()
      let admitted = false
      let prepared: Awaited<ReturnType<typeof prepareAiCapturePreview>>
      try { prepared = await prepareAiCapturePreview(input, {
        trigger: 'explicit_user_request', ownerKey: identity.userId, inputId: `ai:${input.requestId}`, receiptId: `ai:${input.requestId}`,
        text: input.text, timezone: input.timezone, referenceTime, workspaceRevision: `txn:${workspace.revision}`, temporalResolutionBasis: 'user_explicit',
        source: { kind: 'web', sourceId: 'todayaction-web', sourceRecordId: input.requestId, sourceVersion: '1', observedAt: referenceTime, timezone: input.timezone },
        contextRefs: input.contextRefs,
        verifiedInterviewReschedules: verifiedAiInterviewReschedules(input.text, workspace.snapshot, referenceTime, input.timezone),
        opportunities: workspace.snapshot.data.opportunities.map(item => ({ opportunityId: item.id, company: item.company, role: item.role })),
      }, config.runtime.transport, async () => {
        const current = await config.readWorkspace(identity.userId)
        if (!current || current.userId !== identity.userId || current.revision !== workspace.revision) throw new WorkspaceSourceError('AI_CAPTURE_STALE', 'Workspace changed before model dispatch.', false)
        const currentAudience = await config.authorizeIdentity(identity) as { allowed?: boolean } | undefined
        if (currentAudience?.allowed === false) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Audience access was revoked.', false)
        await config.runtime!.beforeDispatch?.({ userId: identity.userId, requestId: input.requestId, text: input.text, timezone: input.timezone, referenceTime, workspaceRevision: workspace.revision })
        await config.runtime!.ledger.admit({ ...input, userId: identity.userId, referenceTime, payloadHash, reservationUnits: config.runtime!.reservationUnits })
        admitted = true
      })
      if (!admitted) throw new WorkspaceSourceError('AI_CAPTURE_ADMISSION_REQUIRED', 'Model transport skipped durable admission.', false)
      await config.runtime.ledger.finish({ userId: identity.userId, requestId: input.requestId, payloadHash,
        status: prepared.observation ? 'READY' : 'BLOCKED', ...prepared })
      } catch (error) {
        // Timeout, malformed response, or crash after admission never permits resend.
        if (admitted) await config.runtime.ledger.finish({ userId: identity.userId, requestId: input.requestId, payloadHash, status: 'UNKNOWN', review: null, observation: null }).catch(() => undefined)
        throw error
      }
      const { review, observation } = prepared
      const latest = await config.readWorkspace(identity.userId)
      if (!latest || latest.userId !== identity.userId || latest.revision !== workspace.revision) return respond(409, { code: 'AI_CAPTURE_STALE' })
      return respond(200, { requestId: input.requestId, referenceTime, workspaceRevision: workspace.revision, review, canCommit: Boolean(observation) })
    } catch (error) {
      // Never reflect upstream exception bodies, credentials or user text.
      const code = error instanceof WorkspaceSourceError ? error.code : 'AI_CAPTURE_FAILED'
      return respond(code.startsWith('AUTH_') ? 401 : code === 'AI_CAPTURE_STALE' ? 409 : 503,
        { code, message: 'AI interpretation could not be completed. No workspace changes were saved.', retryable: false })
    }
  }
}
