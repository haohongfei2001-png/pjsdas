/** Default-off staged adapter. Requires the complete SQL document/authority
 * capability and pre-authorized durable reservations; no universal coverage or
 * production resource policy is inferred from its synthetic tests. */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { validateSnapshot } from '../src/snapshot.js'
import { createWorkspaceRowsStoreBridge } from './workspaceRowsStoreBridge.js'
import { WorkspaceRowsCandidateError, type WorkspaceRowsCandidateOptions } from './workspaceRowsCandidate.js'
import { diffReadableWorkspaceRows } from './workspaceRowsCodec.js'
import { prepareStagedEffects, stagedEffectPages } from './workspaceRowsLargeCommandPrototype.js'
import { uploadStagedRequestDocuments, type StagedRequestBinding, type StagedDocumentUploadStatus } from './workspaceRowsStagedDocumentsPrototype.js'
import type { TransactionalWorkspaceStoreOptions } from './transactionalWorkspaceStore.js'
import { encodePreparedIntent, decodePreparedIntent, prepareAuditModeDocuments, selectDurableAuditDocuments, type WorkspaceRowsAuditMode, type AnyPreparedIntent, type EncodedPreparedIntent } from './workspaceRowsDurableIntent.js'
import type { ConnectedAuthoritativeCommitInput, ConnectedWorkspaceRecord, PreparedCommandIdentity, ConnectedCommitResult } from './transactionalWorkspaceStore.js'
import { WorkspaceSourceError } from './workspaceSource.js'

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
const invalid = (ok: unknown) => { if (!ok) throw new WorkspaceSourceError('WORKSPACE_INVALID', 'Invalid local staged command identity.', false) }
export type StagedBridgeOptions = WorkspaceRowsCandidateOptions & {
  durableIntent?: boolean
  /** Server-only v2 read/attempt capability; does not enable admission by itself. */
  durableAttemptsV2?: boolean
  /** Server-only: stop NEW durable admissions, without disabling recovery. */
  durableIntentAdmissionEnabled?: boolean
  /** New admissions only. Omitted preserves the original audit flags mapping;
   * no explicit inline mode can bypass the unchanged SQL readability guard. */
  auditAdmissionMode?: Exclude<WorkspaceRowsAuditMode, 'legacy-inline-v1'>
}

/** Stable command-intent slot. A different payload/manifest cannot silently
 * overwrite or revive it. Resume requires the original immutable prepared bytes;
 * rebuilding a timed draft with different bytes fails closed, never starts a new
 * command or a second stage automatically. */
export function stagedCommandStageId(request: Record<string, unknown>, family: string) {
  const hex = createHash('sha256').update(JSON.stringify([request.userId, request.workspaceId, request.expectedEpoch, request.commandId, family])).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export function createWorkspaceRowsStagedBridge(options: StagedBridgeOptions): Pick<TransactionalWorkspaceStoreOptions, 'rowLayoutReader' | 'rowLayoutWriter'> {
  options = { ...options, auditReadAuthorization: options.auditReadAuthorization ? Object.freeze({ ...options.auditReadAuthorization }) : undefined }
  if (options.auditAdmissionMode !== undefined && (!['fragments-v1', 'pages-v1'].includes(options.auditAdmissionMode) || !options.auditReadsEnabled)) throw new WorkspaceSourceError('INVALID_SOURCE_CONFIG', 'Audit admission mode requires a known complete audit byte capability.', false)
  if (options.durableAttemptsV2 && !options.durableIntent) throw new WorkspaceSourceError('INVALID_SOURCE_CONFIG', 'Durable attempts v2 requires durable intent recovery.', false)
  if (options.durableIntentAdmissionEnabled === false && !options.durableIntent) throw new WorkspaceSourceError('INVALID_SOURCE_CONFIG', 'Stopping durable admission requires durable recovery to remain enabled.', false)
  if (options.durableIntent && options.rpcTransport !== 'public-v1') throw new WorkspaceSourceError('INVALID_SOURCE_CONFIG', 'Durable intents require their deadline-guarded public-v1 transport.', false)
  if (options.readsEnabled !== true || options.writesEnabled !== true) throw new WorkspaceSourceError('INVALID_SOURCE_CONFIG', 'Staged writers require compatible reads and writes.', false)
  const callerBoundFetch: typeof fetch | undefined = options.signal ? (input, init) => (options.fetchImpl ?? fetch)(input,
    { ...init, signal: init?.signal ? AbortSignal.any([init.signal, options.signal!]) : options.signal }) : options.fetchImpl
  const base = createWorkspaceRowsStoreBridge({ ...options, signal: undefined, fetchImpl: callerBoundFetch })
  const rpc = async (name: string, body: unknown, signal: AbortSignal) => {
    let response: Response
    let value: unknown
    try {
      signal.throwIfAborted()
      response = await (options.fetchImpl ?? fetch)(options.supabaseUrl.replace(/\/+$/, '') + (options.rpcTransport === 'public-v1' ? '/rest/v1/rpc/pjsdas_rows_v1_' : '/rpc/') + name, {
        method: 'POST', signal, headers: { authorization: `Bearer ${options.serviceRoleKey}`, apikey: options.serviceRoleKey,
          'content-type': 'application/json', 'content-profile': options.rpcTransport === 'public-v1' ? 'public' : 'pjsdas_rows_candidate', 'accept-profile': options.rpcTransport === 'public-v1' ? 'public' : 'pjsdas_rows_candidate' }, body: JSON.stringify(body),
      })
      value = await response.json()
      signal.throwIfAborted()
    } catch {
      // Especially after finish dispatch this is an UNKNOWN outcome. Caller
      // uses original authorized command lookup/replay, never a fresh command.
      throw new WorkspaceSourceError('WORKSPACE_UNAVAILABLE', 'Staged transport interrupted; resolve the original command outcome before retrying.', true)
    }
    if (!response.ok) {
      const code = object(value) ? value.code : undefined
      throw new WorkspaceSourceError(code === 'PT410' ? 'WORKSPACE_RECOVERY_TERMINAL' : code === '42501' ? 'AUTH_FORBIDDEN' : code === '23505' ? 'COMMAND_ID_REUSED' : code === 'PT409' ? 'WORKSPACE_CONFLICT' : code === '22023' ? 'WORKSPACE_INVALID' : 'WORKSPACE_UNAVAILABLE',
        'The staged candidate refused this command; no legacy fallback is allowed.', response.status >= 500 || response.status === 429)
    }
    return value
  }
  function familyIdentity(input: PreparedCommandIdentity) {
    if (input.managementAuthorization?.consentVersion === 3 && input.principalKind === 'delegated_mcp' && input.clientId && ['opportunity_management', 'undo_command'].includes(input.operation)) return {
      family: 'opportunity_v3', authority: { grantId: input.managementAuthorization.grantId, grantRevision: input.managementAuthorization.grantRevision, clientId: input.clientId },
    }
    if (!input.managementAuthorization && input.principalKind === 'first_party_web' && !input.clientId && ['abandon_opportunity', 'domain:abandon_opportunity', 'undo_command'].includes(input.operation)) return { family: 'first_party_abandon', authority: {} }
    return null
  }
  function lookupIdentity(input: PreparedCommandIdentity) {
    const family = familyIdentity(input)
    return family ? { userId: input.userId, commandId: input.commandId, operation: input.operation, payloadHash: input.payloadHash, principal: input.principalKind, ...family } : null
  }
  type Attempt = { id: string; generation: number; deadlineAt: number }
  const terminal = (value: unknown) => {
    if (object(value) && value.outcome === 'TERMINAL_UNCOMMITTED' && typeof value.reason === 'string')
      throw new WorkspaceSourceError('WORKSPACE_RECOVERY_TERMINAL', `Original operation was not committed (${value.reason}); its local draft is retained.`, false)
  }
  const decode = (value: unknown) => {
    terminal(value)
    invalid(object(value) && object(value.encoded) && Number.isSafeInteger(value.reservedBytes))
    const record = value as { encoded: EncodedPreparedIntent; reservedBytes: number; deadlineAt: number | null; protocol?: string; binding: StagedRequestBinding & { preparedSha256: string; manifestSha256: string } }
    invalid((Number.isSafeInteger(record.deadlineAt) || record.protocol === 'workspace-prepared-intent-v2' && record.deadlineAt === null) && object(record.binding) && record.binding.preparedSha256 === record.encoded.sha256)
    // Check the separately persisted deadline before allocating decoded bytes.
    if (record.deadlineAt !== null) remainingSignal(record.deadlineAt).throwIfAborted()
    const saved = decodePreparedIntent(record.encoded, record.reservedBytes)
    invalid((saved.protocol === 'workspace-prepared-intent-v1' ? saved.deadlineAt === record.deadlineAt : options.durableAttemptsV2 && record.protocol === saved.protocol && record.deadlineAt === null) && saved.manifestSha256 === record.binding.manifestSha256
      && saved.before.workspaceId === record.binding.workspaceId && saved.before.rowEpoch === record.binding.expectedEpoch
      && saved.before.revision === record.binding.expectedRevision && saved.before.userId === record.binding.userId
      && saved.input.userId === record.binding.userId && saved.input.commandId === record.binding.commandId
      && saved.input.payloadHash === record.binding.payloadHash && saved.input.operation === record.binding.operation
      && saved.input.principalKind === record.binding.principal && saved.input.expectedRevision === record.binding.expectedRevision
      && familyIdentity(saved.input)?.family === record.binding.family && isDeepStrictEqual(familyIdentity(saved.input)?.authority, record.binding.authority)
      && stagedCommandStageId({userId:saved.input.userId,workspaceId:saved.before.workspaceId,expectedEpoch:saved.before.rowEpoch,commandId:saved.input.commandId},record.binding.family) === record.binding.stageId)
    if (record.deadlineAt !== null) remainingSignal(record.deadlineAt).throwIfAborted()
    return saved
  }
  const remainingSignal = (deadlineAt: number) => {
    const remaining = deadlineAt - Date.now()
    invalid(Number.isSafeInteger(deadlineAt) && remaining <= 10_000)
    if (remaining <= 0) throw new WorkspaceSourceError('WORKSPACE_UNAVAILABLE', 'Original durable intent deadline expired; only original authorized receipt replay may resolve its outcome.', true)
    return options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(remaining)]) : AbortSignal.timeout(remaining)
  }
  async function runCommit(before: ConnectedWorkspaceRecord, originalInput: ConnectedAuthoritativeCommitInput, durable?: AnyPreparedIntent): Promise<
    { outcome: 'COMMITTED' | 'ALREADY_APPLIED'; resultingRevision: number; receipt: Record<string, unknown>; snapshot?: ConnectedWorkspaceRecord['snapshot'] } | { outcome: 'CONFLICT' }
  > {
        // v1 retains its original absolute budget. v2 preflight has one local
        // bounded preparation budget; the DB then grants one separately fenced
        // execution attempt. Upload pages never refresh either allowance.
        const deadlineAt = durable?.deadlineAt ?? Date.now() + 10_000
        let signal = remainingSignal(deadlineAt)
        let attempt: Attempt | undefined
        const stageRpc = async (name: string, body: Record<string, unknown>) => {
          const result = await rpc(attempt ? `large_v2_${name.replace(/^large_/, '')}` : name, { ...body, ...(attempt ? { attempt } : {}) }, signal)
          terminal(result)
          if (object(result) && result.outcome === 'ALREADY_APPLIED' && !object(result.receipt)) throw new WorkspaceSourceError('WORKSPACE_CONFLICT', 'Original command has committed; resolve its original receipt.', false)
          return result
        }
        try {
        invalid(before.rowEpoch && before.userId === originalInput.userId && before.revision >= originalInput.expectedRevision)
        const input = before.revision > originalInput.expectedRevision ? { ...originalInput, snapshot: before.snapshot } : originalInput
        validateSnapshot(before.snapshot); validateSnapshot(input.snapshot)
        const delta = diffReadableWorkspaceRows(before.snapshot, input.snapshot)
        const request = { ...delta, commandId: input.commandId, payloadHash: input.payloadHash, operation: input.operation,
          principal: input.principalKind, ...(input.clientId && !input.managementAuthorization ? { clientId: input.clientId } : {}),
          workspaceId: before.workspaceId, userId: before.userId, expectedEpoch: before.rowEpoch!, expectedRevision: input.expectedRevision,
          schemaVersion: input.snapshot.version, compensation: input.compensation ?? null, provenance: input.provenance ?? {},
          receiptContext: input.receiptContext, effectiveTime: input.effectiveTime ?? null }
        // A validated size/count classification, NEVER a catch-all INVALID
        // fallback. Smaller requests retain the original guarded fast path.
        if (!durable && delta.changes.length <= 2000 && Buffer.byteLength(JSON.stringify(request)) <= 2_097_152) return base.rowLayoutWriter!.commit(before, input)
        invalid(uuid(before.workspaceId) && uuid(before.userId) && uuid(before.rowEpoch) && Number.isSafeInteger(input.expectedRevision)
          && input.expectedRevision >= 0 && input.commandId.length > 0 && /^[a-f0-9]{64}$/.test(input.payloadHash))
        let family: 'first_party_abandon' | 'opportunity_v3'
        let authority: Record<string, unknown> = {}
        if (!input.aiCaptureAuthorization && !input.discoveryAuthorization && input.managementAuthorization?.consentVersion === 3
          && input.principalKind === 'delegated_mcp' && input.clientId && ['opportunity_management', 'undo_command'].includes(input.operation)) {
          family = 'opportunity_v3'; authority = { grantId: input.managementAuthorization.grantId, grantRevision: input.managementAuthorization.grantRevision, clientId: input.clientId }
        } else if (!input.managementAuthorization && !input.aiCaptureAuthorization && !input.discoveryAuthorization && !input.clientId && input.principalKind === 'first_party_web'
          && (['abandon_opportunity', 'domain:abandon_opportunity', 'undo_command'].includes(input.operation))) {
          family = 'first_party_abandon'
        } else throw new WorkspaceSourceError('WORKSPACE_INVALID', 'This legal large command family still requires a separately proven staged capability; no quota is changed.', false)
        const preparedEffects = prepareStagedEffects(delta)
        // Preflight all pages before resource allocation; a giant individual
        // effect remains an explicit capability stop, not silent truncation.
        const pages = [...stagedEffectPages(preparedEffects.parts)]
        const { changes: _separateEffects, ...originalMetadata } = request
        // Reader negotiation belongs only to the staged metadata. Including
        // this marker in the original fast-path size test would divert a legal
        // near-cap small request into staging/reservation unnecessarily.
        const stageId = stagedCommandStageId(originalMetadata, family)
        invalid(uuid(stageId))
        const binding: StagedRequestBinding = { stageId, family, userId: input.userId, workspaceId: before.workspaceId, expectedEpoch: before.rowEpoch!,
          expectedRevision: input.expectedRevision, commandId: input.commandId, payloadHash: input.payloadHash, operation: input.operation, principal: input.principalKind, authority }
        const effects = { protocol: 'workspace-effect-chain-v1' as const, count: preparedEffects.parts.length, sha256: preparedEffects.finalDigest }
        const admissionMode: WorkspaceRowsAuditMode = options.auditAdmissionMode ?? (options.auditReadsEnabled && options.auditReadAuthorization
          ? options.auditPagesEnabled ? 'pages-v1' : 'fragments-v1' : 'legacy-inline-v1')
        // Only authenticated original durable bytes choose a recovery mode.
        // Current admission/read preferences cannot rewrite their manifest.
        const { mode, prepared } = durable
          ? selectDurableAuditDocuments(originalMetadata, binding, effects, durable.manifestSha256)
          : { mode: admissionMode, prepared: prepareAuditModeDocuments(originalMetadata, binding, effects, admissionMode) }
        signal.throwIfAborted()
        if (mode !== 'legacy-inline-v1') invalid(options.auditReadAuthorization)
        if (options.durableIntent && !durable && options.durableIntentAdmissionEnabled === false)
          throw new WorkspaceSourceError('WORKSPACE_UNAVAILABLE', 'New durable admission is stopped; original admitted intents remain recoverable.', true)
        if (family === 'first_party_abandon' && input.operation === 'undo_command') {
          const target = input.provenance?.undoOf
          if (typeof target !== 'string') throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Original staged Undo identity required.', false)
          // Selected recovery transport shares this attempt's ORIGINAL absolute
          // signal. Neither changing preferences nor local selection resets it.
          const boundedReader = createWorkspaceRowsStoreBridge({ ...options, signal,
            ...(durable ? { auditReadsEnabled: mode !== 'legacy-inline-v1', auditPagesEnabled: mode === 'pages-v1' } : {}) }).rowLayoutReader!
          const history = await boundedReader.readHistory!(input.userId, before.rowEpoch!, { mode: 'command', commandId: target })
          if (history.rows.length !== 1 || !object(history.rows[0].receipt) || !['abandon_opportunity', 'domain:abandon_opportunity'].includes(String(history.rows[0].receipt.operation))) {
            throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'This local staged Undo family is not proven.', false)
          }
        }
        if (options.durableIntent && !durable) {
          const { rowPreimage: _preimage, ...savedInput } = input
          const encoded = encodePreparedIntent(options.durableAttemptsV2
            ? { protocol: 'workspace-prepared-intent-v2', before, input: savedInput, manifestSha256: prepared.manifest.sha256 }
            : { protocol: 'workspace-prepared-intent-v1', before, input: savedInput, manifestSha256: prepared.manifest.sha256, deadlineAt })
          const admission = { identity: lookupIdentity(input), binding: { ...binding, preparedSha256: encoded.sha256, manifestSha256: prepared.manifest.sha256 }, encoded, ...(!options.durableAttemptsV2 ? { deadline_at: deadlineAt } : {}), target_user_id: input.userId }
          // This is an existing transport capability, not a newly invented
          // business-size quota. Incompressible bundles remain unsupported.
          if (Buffer.byteLength(JSON.stringify(admission)) > 2_097_152) throw new WorkspaceSourceError('WORKSPACE_INVALID', 'Complete durable intent exceeds the existing atomic transport capability; no bytes were staged.', false)
          signal.throwIfAborted()
          const admitted = await rpc(options.durableAttemptsV2 ? 'large_v2_intent_admit' : 'large_intent_admit', admission, signal)
          terminal(admitted)
          if (object(admitted) && admitted.outcome === 'ALREADY_APPLIED') throw new WorkspaceSourceError('WORKSPACE_CONFLICT', 'Original command committed during admission; resolve its original receipt.', false)
          const saved = decode(admitted)
          invalid(JSON.stringify(lookupIdentity(saved.input)) === JSON.stringify(admission.identity) && saved.before.workspaceId === before.workspaceId && saved.before.rowEpoch === before.rowEpoch && saved.before.revision === before.revision)
          signal.throwIfAborted()
          // Concurrent first admission owns the exact time/bytes. Never upload
          // this request's losing draft or allocate a replacement stage.
          return runCommit(saved.before, saved.input, saved)
        }
        if (durable?.protocol === 'workspace-prepared-intent-v2') {
          // Preflight reconstructs only the admitted bytes, not the reducer. The
          // DB execution attempt starts once, after preflight; upload/finish
          // and their lock waits share this one DB-issued deadline.
          const started = performance.now()
          const opened = await rpc('large_v2_attempt_begin', { identity: lookupIdentity(input), target_user_id: input.userId }, signal)
          terminal(opened)
          if (object(opened) && opened.outcome === 'ALREADY_APPLIED') {
            throw new WorkspaceSourceError('WORKSPACE_CONFLICT', 'Original command has committed; resolve its original authorized receipt.', false)
          }
          invalid(object(opened) && object(opened.attempt) && uuid(opened.attempt.id) && Number.isSafeInteger(opened.attempt.generation) && Number(opened.attempt.generation) > 0 && Number.isSafeInteger(opened.attempt.deadlineAt) && Number.isSafeInteger(opened.remainingMs) && Number(opened.remainingMs) >= 0 && Number(opened.remainingMs) <= 10_000)
          attempt = (opened as { attempt: Attempt }).attempt
          // DB time is authoritative. Do not compare it with a worker wall
          // clock; conservatively deduct the entire monotonic round trip.
          const remaining = Number((opened as Record<string, unknown>).remainingMs) - Math.ceil(performance.now() - started)
          if (remaining <= 0) throw new WorkspaceSourceError('WORKSPACE_UNAVAILABLE', 'The current execution attempt has no remaining budget.', true)
          signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(remaining)]) : AbortSignal.timeout(remaining)
        }
        await stageRpc('large_documents_check_reservation' , { stage_id: stageId, target_user_id: input.userId, target_workspace_id: before.workspaceId, required_bytes: prepared.totalBytes })
        const uploaded = await uploadStagedRequestDocuments({ prepared, signal, transport: {
          begin: async value => await stageRpc('large_documents_begin', { manifest_wire: value.manifestWire, manifest_sha256: value.manifestSha256, target_user_id: input.userId }) as unknown as StagedDocumentUploadStatus,
          append: async part => await stageRpc('large_documents_append', { part, target_user_id: input.userId }) as { stageId: string; manifestSha256: string; document: typeof part.document; nextOffset: number },
        } })
        if (!uploaded.previouslyCompleted) for (const parts of pages) await stageRpc('large_append', { stage_id: stageId, target_user_id: input.userId, parts })
        const result = await stageRpc('large_documents_finish', { stage_id: stageId, target_user_id: input.userId, manifest_sha256: prepared.manifest.sha256 })
        if (!object(result)) throw new WorkspaceSourceError('WORKSPACE_INVALID', 'Invalid staged reply.', false)
        if (result.outcome === 'CONFLICT') {
          if (durable) throw new WorkspaceSourceError('WORKSPACE_CONFLICT', 'Original durable intent CAS failed; no re-evaluation is allowed.', false)
          return { outcome: 'CONFLICT' as const }
        }
        invalid(Number.isSafeInteger(result.revision) && (result.outcome === 'COMMITTED' || result.outcome === 'ALREADY_APPLIED') && object(result.receipt)
          && result.receipt.commandId === input.commandId && result.receipt.status === 'COMMITTED' && result.receipt.operation === input.operation && result.receipt.revision === result.revision)
        if (!object(result.receipt)) throw new WorkspaceSourceError('WORKSPACE_INVALID', 'Invalid staged receipt.', false)
        if (family === 'opportunity_v3') {
          const proof = result.receipt.managementAuthorization
          invalid(object(proof) && uuid(proof.grantId) && Number.isSafeInteger(proof.grantRevision) && Number(proof.grantRevision) > 0 && proof.consentVersion === 3
            && (result.outcome !== 'COMMITTED' || proof.grantId === authority.grantId && proof.grantRevision === authority.grantRevision))
        }
        return { outcome: result.outcome as 'COMMITTED' | 'ALREADY_APPLIED', resultingRevision: result.revision as number, receipt: result.receipt, ...(durable ? { snapshot: input.snapshot } : {}) }
        } catch (error) {
          if (error instanceof WorkspaceRowsCandidateError) {
            if (error.code === 'CONFLICT' && !durable) return { outcome: 'CONFLICT' as const }
            const code = error.code === 'FORBIDDEN' ? 'AUTH_FORBIDDEN' : error.code === 'COMMAND_ID_REUSED' ? 'COMMAND_ID_REUSED' : error.code === 'INVALID' ? 'WORKSPACE_INVALID' : error.code === 'UNAVAILABLE' ? 'WORKSPACE_UNAVAILABLE' : 'WORKSPACE_CONFLICT'
            throw new WorkspaceSourceError(code, 'The original staged authority/history check did not complete.', error.retryable)
          }
          if (signal.aborted && !(error instanceof WorkspaceSourceError)) throw new WorkspaceSourceError('WORKSPACE_UNAVAILABLE', 'The original staged deadline/cancellation stopped this attempt; resolve its original command outcome.', true)
          throw error
        }
  }
  return {
    rowLayoutReader: base.rowLayoutReader,
    rowLayoutWriter: {
      ...base.rowLayoutWriter,
      commit: runCommit,
      ...(options.durableIntent ? { async resumePrepared(before: ConnectedWorkspaceRecord, input: PreparedCommandIdentity): Promise<ConnectedCommitResult | null> {
        const identity = lookupIdentity(input)
        if (!identity) return null
        const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000)
        const value = await rpc(options.durableAttemptsV2 ? 'large_v2_intent_read' : 'large_intent_read', { identity, target_user_id: input.userId }, signal)
        if (value === null) return null
        terminal(value)
        if (object(value) && value.outcome === 'ALREADY_APPLIED') throw new WorkspaceSourceError('WORKSPACE_CONFLICT', 'Original command has committed; resolve its original authorized receipt.', false)
        const saved = decode(value)
        const originalIdentity = lookupIdentity(saved.input)
        invalid(JSON.stringify(originalIdentity) === JSON.stringify(identity))
        if (saved.before.workspaceId !== before.workspaceId || saved.before.rowEpoch !== before.rowEpoch || saved.before.revision !== before.revision)
          throw new WorkspaceSourceError('WORKSPACE_CONFLICT', 'Original durable intent base generation or revision changed; it cannot be re-evaluated.', false)
        signal.throwIfAborted()
        const result = await runCommit(saved.before, saved.input, saved)
        if (result.outcome === 'CONFLICT') throw new WorkspaceSourceError('WORKSPACE_CONFLICT', 'Original durable intent CAS changed; no re-evaluation is allowed.', false)
        return { outcome: result.outcome, workspaceId: before.workspaceId, revision: result.resultingRevision,
          snapshot: result.snapshot ?? saved.input.snapshot, receipt: result.receipt }
      } } : {}),
    },
  }
}
