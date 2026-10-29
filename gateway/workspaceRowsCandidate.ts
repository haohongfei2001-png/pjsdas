import { Buffer } from 'node:buffer'
import { boundedAuditResponse, createAuditSpool, type AuditDocument, type WorkspaceRowsAuditAuthorization } from './workspaceRowsAuditSpool.js'
import type { VerifiedFragment } from './workspaceRowsLargeCommandPrototype.js'
import { validateSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'
import { decodeWorkspaceRows, diffReadableWorkspaceRows, workspaceRowCollections, type WorkspaceEntityRow } from './workspaceRowsCodec.js'

/** Stage-A adapter. Runtime capability is default-off; no production layout is enabled. */
export interface WorkspaceRowsCandidateOptions {
  supabaseUrl: string
  serviceRoleKey: string
  readsEnabled?: boolean
  writesEnabled?: boolean
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  /** Public-schema invoker wrappers avoid adding an exposed API schema. Still default-off. */
  rpcTransport?: 'candidate' | 'public-v1'
  /** Bounded candidate transport option; default serial, never changes writer authority. */
  readConcurrency?: number
  /** Server-only/default-off complete audit reader; never inferred from a body. */
  auditReadsEnabled?: boolean
  /** Aggregate original 64KiB fragments within the unchanged 2MiB response cap. */
  auditPagesEnabled?: boolean
  auditReadAuthorization?: WorkspaceRowsAuditAuthorization
}
export interface WorkspaceRowsRecord { workspaceId: string; userId: string; revision: number; epoch: string; snapshot: PJSDASSnapshot }
export type WorkspaceRowsHistoryQuery =
  | { mode: 'command'; commandId: string }
  | { mode: 'after'; afterRevision: number }
  | { mode: 'latest_discovery'; sourceId: string; scopeFingerprint: string }
  | { mode: 'discovery_scope'; sourceId: string; scopeFingerprint: string; planFingerprint: string; cycleId?: string }
export interface WorkspaceRowsCommandAudit { provenance?: Record<string, unknown>; receiptContext?: Record<string, unknown>; effectiveTime?: string }
export interface WorkspaceRowsGmailCommand extends WorkspaceRowsCommandAudit {
  commandId: string; payloadHash: string; operation: 'gmail_semantic_intake'; principal: 'automation'; sourceId: 'gmail:primary'
  compensation: Record<string, unknown> | null
  managementAuthorization?: never; aiCaptureAuthorization?: never; discoveryAuthorization?: never
}
export interface WorkspaceRowsPlanningCommand extends WorkspaceRowsCommandAudit { commandId: string; payloadHash: string; compensation: Record<string, unknown> | null; grantId: string; grantRevision: number; clientId: string; operation?: 'planning_management' | 'undo_command'; undoOf?: string }
export type WorkspaceRowsDiscoveryProfileCommand = Omit<WorkspaceRowsPlanningCommand, 'operation'> & { operation?: 'discovery_profile_management' | 'undo_command' }
export type WorkspaceRowsPrivateReminderCommand = Omit<WorkspaceRowsPlanningCommand, 'operation'> & { operation?: 'private_reminder_management' | 'undo_command' }
export type WorkspaceRowsOpportunityCommand = Omit<WorkspaceRowsPlanningCommand, 'operation'> & { operation?: 'opportunity_management' | 'undo_command' }
export type WorkspaceRowsBusinessCommand = Omit<WorkspaceRowsPlanningCommand, 'operation'> & { operation?: 'business_management' | 'undo_command' }
export interface WorkspaceRowsBaseCommand extends WorkspaceRowsCommandAudit { commandId: string; payloadHash: string; compensation: Record<string, unknown> | null; operation: string; principal: 'first_party_web' | 'delegated_mcp' | 'automation'; clientId?: string }
export interface WorkspaceRowsCaptureCommand extends WorkspaceRowsCommandAudit { commandId: string; payloadHash: string; compensation: Record<string, unknown> | null; requestId: string; observation: Record<string, unknown> }
export interface WorkspaceRowsCaptureAdmission { requestId: string; payloadHash: string; text: string; timezone: string; referenceTime: string; reservationUnits: number }
export interface WorkspaceRowsDiscoveryCommand extends WorkspaceRowsCommandAudit { commandId: string; payloadHash: string; operation: 'checkpoint_discovery_search' | 'ingest_verified_discovery'; principal: 'automation' | 'delegated_mcp'; clientId?: string; provenance: Record<string, unknown>; compensation: Record<string, unknown> | null; authorization: Record<string, unknown> }
export class WorkspaceRowsCandidateError extends Error {
  constructor(readonly code: 'DISABLED' | 'INVALID' | 'CONFLICT' | 'UNAVAILABLE' | 'UNSUPPORTED' | 'FORBIDDEN' | 'COMMAND_ID_REUSED', readonly retryable = false) { super(`WORKSPACE_ROWS_${code}`) }
}
const object = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x)
const integer = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0
const uuid = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x)
function invalid(ok: unknown): asserts ok { if (!ok) throw new WorkspaceRowsCandidateError('INVALID') }
function diffWorkspaceRows(before: unknown, after: unknown) {
  try { return diffReadableWorkspaceRows(before, after) } catch { throw new WorkspaceRowsCandidateError('INVALID') }
}

/** Trusted application command metadata, never provider-generated authority. */
function auditFields(command: WorkspaceRowsCommandAudit) {
  invalid(command.provenance === undefined || object(command.provenance))
  invalid(command.receiptContext === undefined || object(command.receiptContext))
  invalid(command.effectiveTime === undefined || (typeof command.effectiveTime === 'string' && Number.isFinite(Date.parse(command.effectiveTime))))
  return { provenance: command.provenance ?? {}, receiptContext: command.receiptContext ?? {}, effectiveTime: command.effectiveTime ?? null }
}

export function createWorkspaceRowsCandidate(options: WorkspaceRowsCandidateOptions) {
  const reads = options.readsEnabled === true, writes = options.writesEnabled === true
  invalid(options.rpcTransport === undefined || options.rpcTransport === 'candidate' || options.rpcTransport === 'public-v1')
  invalid(!options.auditPagesEnabled || options.auditReadsEnabled)
  const auditAuthorization = options.auditReadAuthorization ? Object.freeze({ ...options.auditReadAuthorization }) : undefined
  const publicTransport = options.rpcTransport === 'public-v1'
  const concurrency = options.readConcurrency ?? 1
  invalid(Number.isSafeInteger(concurrency) && concurrency >= 1 && concurrency <= 4)
  if (writes && !reads) throw new WorkspaceRowsCandidateError('DISABLED')
  const request = async (rpc: string, body: unknown, signal?: AbortSignal, bounded = false): Promise<unknown> => {
    if (!reads) throw new WorkspaceRowsCandidateError('DISABLED')
    invalid(options.serviceRoleKey.trim().length > 0)
    let response: Response
    try {
      response = await (options.fetchImpl ?? fetch)(`${options.supabaseUrl.replace(/\/+$/, '')}${publicTransport ? '/rest/v1/rpc/pjsdas_rows_v1_' : '/rpc/'}${rpc}`, {
        method: 'POST', headers: { authorization: `Bearer ${options.serviceRoleKey}`, apikey: options.serviceRoleKey, 'content-type': 'application/json', ...(publicTransport ? { 'accept-profile': 'public', 'content-profile': 'public' } : {}) },
        body: JSON.stringify(body), signal: signal && options.signal && signal !== options.signal ? AbortSignal.any([signal, options.signal]) : signal ?? options.signal ?? AbortSignal.timeout(10_000),
      })
    } catch { throw new WorkspaceRowsCandidateError('UNAVAILABLE', true) }
    if (!response.ok) {
      const body = await (bounded ? boundedAuditResponse(response, signal!) : response.json()).catch(() => undefined)
      const code = object(body) ? body.code : undefined
      if (code === '23505') throw new WorkspaceRowsCandidateError('COMMAND_ID_REUSED')
      if (response.status === 403 || code === '42501') throw new WorkspaceRowsCandidateError('FORBIDDEN')
      if (code === '22023' || code === '23514') throw new WorkspaceRowsCandidateError('INVALID')
      throw new WorkspaceRowsCandidateError(response.status === 409 ? 'CONFLICT' : 'UNAVAILABLE', response.status >= 500 || response.status === 429 || response.status === 409)
    }
    try { return bounded ? await boundedAuditResponse(response, signal!) : await response.json() } catch { throw new WorkspaceRowsCandidateError(signal?.aborted ? 'UNAVAILABLE' : 'INVALID', Boolean(signal?.aborted)) }
  }
  const head = async (userId: string, signal?: AbortSignal) => {
    invalid(uuid(userId)); const value = await request('read_head', { target_user_id: userId }, signal)
    if (value === null) return null
    invalid(object(value) && uuid(value.workspaceId) && value.userId === userId && uuid(value.epoch) && integer(value.revision) && value.format === 'workspace-rows-v1' && integer(value.schemaVersion) && value.schemaVersion > 0 && object(value.envelope) && value.envelope.version === value.schemaVersion && Array.isArray(value.manifest))
    invalid(Buffer.byteLength(JSON.stringify(value.envelope)) <= 1_048_576)
    return value
  }
  const parallelRows = async (userId: string, first: NonNullable<Awaited<ReturnType<typeof head>>>) => {
    const directory: { collection: string; count: number }[] = [], seen = new Set<string>()
    let count = 0
    for (const entry of first.manifest as unknown[]) {
      invalid(object(entry) && typeof entry.collection === 'string' && (workspaceRowCollections as readonly string[]).includes(entry.collection) && integer(entry.count) && !seen.has(entry.collection))
      count += entry.count; invalid(count <= 65_024); seen.add(entry.collection); directory.push({ collection: entry.collection, count: entry.count })
    }
    directory.sort((a, b) => a.collection < b.collection ? -1 : a.collection > b.collection ? 1 : 0)
    const segments: { collection: string; start: number; end: number; afterCollection: string | null; afterOrdinal: number | null }[] = []
    let previous: { collection: string; count: number } | undefined
    for (const entry of directory) {
      for (let start = 0; start < entry.count; start += 127) segments.push({ collection: entry.collection, start, end: Math.min(entry.count, start + 127),
        afterCollection: start > 0 ? entry.collection : previous?.collection ?? null,
        afterOrdinal: start > 0 ? start - 1 : previous ? previous.count - 1 : null })
      if (entry.count > 0) previous = entry
    }
    const results: WorkspaceEntityRow[][] = new Array(segments.length), abort = new AbortController()
    let next = 0, bytes = 0, requests = 0
    const worker = async () => {
      while (!abort.signal.aborted) {
        const index = next++; if (index >= segments.length) return
        const segment = segments[index], rows: WorkspaceEntityRow[] = []
        let ordinal = segment.start, afterCollection = segment.afterCollection, afterOrdinal = segment.afterOrdinal
        while (ordinal < segment.end) {
          invalid(++requests <= 1024)
          const maximum = segment.end - ordinal
          const page = await request('read_page', { target_user_id: userId, target_workspace_id: first.workspaceId, target_epoch: first.epoch, target_revision: first.revision,
            after_collection: afterCollection, after_ordinal: afterOrdinal, max_rows: maximum }, options.signal ? abort.signal : AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]))
          invalid(object(page))
          if (page.outcome === 'CONFLICT') throw new WorkspaceRowsCandidateError('CONFLICT', true)
          invalid(page.outcome === 'PAGE' && page.workspaceId === first.workspaceId && page.epoch === first.epoch && page.revision === first.revision && Array.isArray(page.rows) && page.rows.length > 0 && page.rows.length <= maximum && typeof page.end === 'boolean')
          const size = Buffer.byteLength(JSON.stringify(page.rows)); bytes += size
          invalid(size <= 1_048_576 && bytes <= 33_554_432)
          for (const row of page.rows) {
            invalid(object(row) && row.collection === segment.collection && row.ordinal === ordinal)
            rows.push(row as unknown as WorkspaceEntityRow); ordinal++
          }
          if (page.end) invalid(ordinal === segment.end)
          afterCollection = segment.collection; afterOrdinal = ordinal - 1
        }
        results[index] = rows
      }
    }
    const workers = Array.from({ length: Math.min(concurrency, segments.length) }, worker)
    try { await Promise.all(workers) } catch (error) { abort.abort(); await Promise.allSettled(workers); throw error }
    return results.flat()
  }
  // Only the last fully verified audit in this server-owned adapter instance.
  // No cross-owner/generation reuse: even a hit repeats negotiated current
  // authorization, exact descriptor identity and the final generation fence.
  let verifiedAudit: { key: string; row: Record<string, unknown> } | undefined
  return {
    async readHistory(userId: string, epoch: string, query: WorkspaceRowsHistoryQuery) {
      const authorization = options.auditReadsEnabled ? auditAuthorization : undefined
      // Negotiated bytes share ONE ten-second read budget. An existing staged
      // signal is reused verbatim; flag-off retains the prior request budgets.
      const signal = options.signal ?? (authorization ? AbortSignal.timeout(10_000) : undefined)
      if (authorization) invalid(authorization.userId === userId)
      const spools: Awaited<ReturnType<typeof createAuditSpool>>[] = []
      const cachedRows = new Map<Record<string, unknown>, Record<string, unknown>>()
      const documentKeys = new Map<Record<string, unknown>, string>()
      const documents = new Map<Record<string, unknown>, { document: AuditDocument; spool: Awaited<ReturnType<typeof createAuditSpool>> }>()
      try {
      const first = await head(userId, signal)
      if (!first || first.epoch !== epoch) throw new WorkspaceRowsCandidateError('CONFLICT', true)
      const rows: Record<string, unknown>[] = [], seen = new Set<string>()
      const cycle = query.mode === 'discovery_scope' && Boolean(query.cycleId)
      let cursorRevision = query.mode === 'after' ? query.afterRevision : 0, cursorCommand = '', cursorCreatedAt: string | undefined, bytes = 0, complete = false
      for (let pageNumber = 0; pageNumber < 1024; pageNumber++) {
        const value = await request('read_history', { target_user_id: userId, target_epoch: epoch, target_revision: first.revision, query: {
          ...query, ...(authorization ? { auditProtocol: 'workspace-audit-bytes-v1', auditAuthorization: authorization, ...(options.auditPagesEnabled ? { auditPageProtocol: 'workspace-audit-page-v1' } : {}) } : {}), ...(query.mode === 'after' ? { cursorRevision, cursorCommand } : {}),
          ...(cycle && cursorCreatedAt !== undefined ? { cursorCreatedAt, cursorRevision, cursorCommand, cursorCount: rows.length } : {}),
        } }, signal, Boolean(authorization))
        invalid(object(value))
        if (value.outcome === 'CONFLICT') throw new WorkspaceRowsCandidateError('CONFLICT', true)
        const maximum = query.mode === 'after' ? 128 : cycle ? 161 - rows.length : 1
        invalid(value.outcome === 'HISTORY' && value.workspaceId === first.workspaceId && value.userId === userId && value.epoch === epoch && value.revision === first.revision && Array.isArray(value.rows) && value.rows.length <= maximum)
        if (authorization) invalid(value.auditProtocol === 'workspace-audit-bytes-v1' && (!options.auditPagesEnabled || value.auditPageProtocol === 'workspace-audit-page-v1'))
        invalid(value.hasMore === undefined || typeof value.hasMore === 'boolean')
        const pageBytes = Buffer.byteLength(JSON.stringify(value.rows)); bytes += pageBytes
        invalid(pageBytes <= 2_097_152 && bytes <= 33_554_432)
        // Legacy count-lookahead replies remain readable during a compatible rollout.
        const page = query.mode === 'after' && value.hasMore === undefined ? value.rows.slice(0, 127) : value.rows
        for (const row of page) {
          invalid(object(row) && row.user_id === userId && row.workspace_id === first.workspaceId && integer(row.resulting_revision) && row.resulting_revision <= (first.revision as number) && typeof row.command_id === 'string' && row.command_id.length > 0)
          if (row.auditDocument !== undefined) {
            invalid(authorization && object(row.auditDocument))
            const d = row.auditDocument
            invalid(d.protocol === 'workspace-audit-bytes-v1' && d.workspaceId === first.workspaceId && d.userId === userId
              && d.epoch === epoch && d.revision === first.revision && d.commandId === row.command_id && d.resultingRevision === row.resulting_revision
              && integer(d.totalBytes) && d.totalBytes > 0 && typeof d.sha256 === 'string' && /^[a-f0-9]{64}$/.test(d.sha256))
            bytes += d.totalBytes; invalid(bytes <= 33_554_432)
            const key = JSON.stringify(d); documentKeys.set(row, key)
            if (verifiedAudit?.key === key) cachedRows.set(row, structuredClone(verifiedAudit.row))
            else {
            const document = d as unknown as AuditDocument, spool = await createAuditSpool(); spools.push(spool)
            // One bounded page is request-owned provisional memory, never a
            // persistent cache. Each original fragment still enters the same
            // contiguous-offset/length/SHA spool verifier. No failed-page retry
            // or implicit downgrade to a different authority/reader protocol.
            let pending: Record<string, unknown>[] = []
            try { await spool.receive(document, signal!, async offset => {
              let part: unknown
              if (options.auditPagesEnabled) {
                if (!pending.length) {
                  const page = await request('read_audit_page', { document, byte_offset: offset, proof: authorization }, signal, true)
                  invalid(object(page))
                  if (page.outcome === 'CONFLICT') throw new WorkspaceRowsCandidateError('CONFLICT', true)
                  invalid(page.protocol === 'workspace-audit-page-v1' && page.offset === offset && object(page.document)
                    && Object.keys(page.document).length === Object.keys(document).length
                    && Object.entries(document).every(([name, value]) => (page.document as Record<string, unknown>)[name] === value)
                    && Array.isArray(page.fragments) && page.fragments.length > 0 && page.fragments.length <= 16)
                  pending = page.fragments.map((fragment, i) => {
                    invalid(object(fragment) && Object.keys(fragment).length === 2 && typeof fragment.base64 === 'string'
                      && fragment.offset === offset + i * 65_536 && Number(fragment.offset) < document.totalBytes)
                    return { ...document, documentKey: document.commandId, ...fragment }
                  })
                }
                part = pending.shift()
              } else part = await request('read_audit_fragment', { document, byte_offset: offset, proof: authorization }, signal, true)
              invalid(object(part))
              if (part.outcome === 'CONFLICT') throw new WorkspaceRowsCandidateError('CONFLICT', true)
              invalid(part.userId === userId && part.workspaceId === first.workspaceId && part.resultingRevision === row.resulting_revision)
              return part as unknown as VerifiedFragment
            }) } catch (error) {
              if (error instanceof WorkspaceRowsCandidateError) throw error
              throw new WorkspaceRowsCandidateError(signal?.aborted ? 'UNAVAILABLE' : 'INVALID', Boolean(signal?.aborted))
            }
            documents.set(row, { document, spool })
            }
          }
          if (query.mode === 'command') invalid(row.command_id === query.commandId)
          const identity = JSON.stringify([row.resulting_revision, row.command_id]); invalid(!seen.has(identity)); seen.add(identity)
          if (query.mode === 'after') {
            invalid(row.resulting_revision > query.afterRevision && (row.resulting_revision > cursorRevision || row.resulting_revision === cursorRevision && row.command_id > cursorCommand))
          }
          if (cycle) { invalid(typeof row.created_at === 'string' && Number.isFinite(Date.parse(row.created_at))); cursorCreatedAt = row.created_at }
          cursorRevision = row.resulting_revision; cursorCommand = row.command_id; rows.push(row)
        }
        const more = value.hasMore === undefined ? query.mode === 'after' && value.rows.length > 127 : value.hasMore
        if (!more) { complete = true; break }
        invalid((query.mode === 'after' || cycle) && page.length > 0 && (!cycle || rows.length < 161))
      }
      invalid(complete)
      if (authorization) {
        const fence = await request('read_audit_fence', { target_user_id: userId, target_workspace_id: first.workspaceId, target_epoch: epoch, target_revision: first.revision, proof: authorization }, signal, true)
        invalid(object(fence))
        if (fence.outcome === 'CONFLICT') throw new WorkspaceRowsCandidateError('CONFLICT', true)
        invalid(fence.outcome === 'FENCED' && fence.userId === userId && fence.workspaceId === first.workspaceId && fence.epoch === epoch && fence.revision === first.revision)
      }
      const last = await head(userId, signal)
      if (!last || last.workspaceId !== first.workspaceId || last.epoch !== epoch || last.revision !== first.revision) throw new WorkspaceRowsCandidateError('CONFLICT', true)
      signal?.throwIfAborted()
      const result: Record<string, unknown>[] = []
      for (const row of rows) {
        const cached = cachedRows.get(row)
        if (cached) { result.push(cached); continue }
        const stored = documents.get(row)
        if (!stored) { result.push(row); continue }
        const value = await stored.spool.materialize(signal!)
        invalid(object(value) && value.user_id === userId && value.workspace_id === first.workspaceId && value.command_id === row.command_id && value.resulting_revision === row.resulting_revision)
        result.push(value)
      }
      signal?.throwIfAborted()
      if (documentKeys.size) {
        const final = await request('read_audit_fence', { target_user_id: userId, target_workspace_id: first.workspaceId, target_epoch: epoch, target_revision: first.revision, proof: authorization }, signal, true)
        invalid(object(final))
        if (final.outcome === 'CONFLICT') throw new WorkspaceRowsCandidateError('CONFLICT', true)
        invalid(final.outcome === 'FENCED' && final.userId === userId && final.workspaceId === first.workspaceId && final.epoch === epoch && final.revision === first.revision)
      }
      signal?.throwIfAborted()
      for (let i = 0; i < rows.length; i++) {
        const key = documentKeys.get(rows[i])
        if (key) verifiedAudit = { key, row: structuredClone(result[i]) }
      }
      return { workspaceId: first.workspaceId as string, userId, epoch, revision: first.revision as number, rows: result }
      } finally { await Promise.all(spools.map(spool => spool.dispose())) }
    },
    async authorizeExistingBootstrap(userId: string, epoch: string, input: { snapshot: PJSDASSnapshot; schemaVersion: number; migratedFrom?: string; consumerAudienceMode?: 'allowlist' | 'legacy' }) {
      const value = await request('bootstrap_existing', { target_user_id: userId, target_epoch: epoch,
        initial_snapshot: input.consumerAudienceMode ? input.snapshot : null, initial_schema_version: input.schemaVersion,
        initial_migrated_from: input.migratedFrom ?? null, target_audience_mode: input.consumerAudienceMode ?? null })
      invalid(object(value) && value.outcome === 'EXISTS' && uuid(value.workspaceId) && value.userId === userId && value.epoch === epoch && integer(value.revision))
      return { workspaceId: value.workspaceId, userId, epoch, revision: value.revision }
    },
    async readDiscoveryProfile(userId: string, signal?: AbortSignal) {
      const value = await head(userId, signal)
      if (!value) return null
      invalid(object(value.envelope) && object(value.envelope.data))
      return { workspaceId: value.workspaceId as string, userId, epoch: value.epoch as string, revision: value.revision as number, profile: value.envelope.data.discoveryProfile ?? null }
    },
    async readIdentity(userId: string) {
      const value = await head(userId)
      return value === null ? null : { workspaceId: value.workspaceId as string, userId, epoch: value.epoch as string, revision: value.revision as number, schemaVersion: value.schemaVersion as number }
    },
    /** One bounded attempt: conflicts are visible; caller must not retry beyond its existing budget. */
    async read(userId: string): Promise<WorkspaceRowsRecord | null> {
      const first = await head(userId); if (first === null) return null
      const rows: WorkspaceEntityRow[] = concurrency > 1 ? await parallelRows(userId, first) : []; let cursor: WorkspaceEntityRow | undefined, bytes = 0
      let ended = concurrency > 1
      for (let pageNumber = 0; !ended && pageNumber < 1024; pageNumber++) {
        const page = await request('read_page', { target_user_id: userId, target_workspace_id: first.workspaceId, target_epoch: first.epoch, target_revision: first.revision, after_collection: cursor?.collection ?? null, after_ordinal: cursor?.ordinal ?? null })
        invalid(object(page))
        if (page.outcome === 'CONFLICT') throw new WorkspaceRowsCandidateError('CONFLICT', true)
        invalid(page.outcome === 'PAGE' && page.workspaceId === first.workspaceId && page.epoch === first.epoch && page.revision === first.revision && Array.isArray(page.rows) && page.rows.length <= 127 && typeof page.end === 'boolean')
        const pageBytes = Buffer.byteLength(JSON.stringify(page.rows)); bytes += pageBytes
        invalid(pageBytes <= 1_048_576 && bytes <= 33_554_432)
        for (const row of page.rows) {
          invalid(object(row) && typeof row.collection === 'string' && integer(row.ordinal))
          if (cursor) invalid(row.collection > cursor.collection || (row.collection === cursor.collection && row.ordinal > cursor.ordinal))
          cursor = row as unknown as WorkspaceEntityRow; rows.push(cursor)
        }
        if (page.end) { ended = true; break }
        invalid(page.rows.length > 0) // A byte-full page can contain fewer than 127 rows.
      }
      invalid(ended)
      const last = await head(userId)
      if (last === null || last.workspaceId !== first.workspaceId || last.revision !== first.revision || last.epoch !== first.epoch) throw new WorkspaceRowsCandidateError('CONFLICT', true)
      let snapshot: unknown
      try { snapshot = decodeWorkspaceRows({ contract: 'workspace-rows-v1', envelope: first.envelope, manifest: first.manifest, rows }); validateSnapshot(snapshot) }
      catch { throw new WorkspaceRowsCandidateError('INVALID') }
      return { workspaceId: first.workspaceId as string, userId, epoch: first.epoch as string, revision: first.revision as number, snapshot: snapshot as PJSDASSnapshot }
    },
    /** Separate guarded entry; never route delegated planning through the Gmail primitive. */
    async commitPlanning(before: WorkspaceRowsRecord, snapshot: PJSDASSnapshot, command: WorkspaceRowsPlanningCommand) {
      if (!writes) throw new WorkspaceRowsCandidateError('DISABLED')
      invalid(uuid(before.workspaceId) && uuid(before.userId) && uuid(before.epoch) && integer(before.revision) && uuid(command.grantId) && integer(command.grantRevision) && command.clientId.trim().length > 0 && command.commandId.length > 0 && /^[0-9a-f]{64}$/.test(command.payloadHash))
      invalid(Object.keys(command).every(key => ['commandId', 'payloadHash', 'compensation', 'provenance', 'receiptContext', 'effectiveTime', 'grantId', 'grantRevision', 'clientId', 'operation', 'undoOf'].includes(key)))
      validateSnapshot(before.snapshot); validateSnapshot(snapshot)
      const operation = command.operation ?? 'planning_management'
      invalid(operation === 'planning_management' ? command.undoOf === undefined : operation === 'undo_command' && typeof command.undoOf === 'string' && command.undoOf.length > 0)
      const req = { ...diffWorkspaceRows(before.snapshot, snapshot), commandId: command.commandId, payloadHash: command.payloadHash, compensation: command.compensation, ...auditFields(command), operation, provenance: { ...command.provenance, ...(command.undoOf ? { undoOf: command.undoOf } : {}) }, principal: 'delegated_mcp', workspaceId: before.workspaceId, userId: before.userId, expectedEpoch: before.epoch, expectedRevision: before.revision, schemaVersion: snapshot.version }
      invalid(Buffer.byteLength(JSON.stringify(req)) <= 2_097_152 && req.changes.length <= 2000)
      const result = await request('commit_planning', { req, target_grant_id: command.grantId, target_grant_revision: command.grantRevision, target_client_id: command.clientId })
      invalid(object(result) && integer(result.revision))
      if (result.outcome === 'CONFLICT') throw new WorkspaceRowsCandidateError('CONFLICT', true)
      invalid((result.outcome === 'COMMITTED' || result.outcome === 'ALREADY_APPLIED') && object(result.receipt) && result.receipt.commandId === command.commandId && result.receipt.operation === operation && result.receipt.status === 'COMMITTED' && result.receipt.revision === result.revision)
      const authorization = result.receipt.managementAuthorization
      invalid(object(authorization) && uuid(authorization.grantId) && integer(authorization.grantRevision) && authorization.grantRevision > 0 && authorization.consentVersion === 4)
      // Current authorization is checked in SQL before replay. A replay still returns
      // the original immutable receipt, not a rewrite with today's grant revision.
      if (result.outcome === 'COMMITTED') invalid(authorization.grantId === command.grantId && authorization.grantRevision === command.grantRevision)
      return { outcome: result.outcome, resultingRevision: result.revision, receipt: result.receipt }
    },
    /** Separate guarded entry; never route delegated Discovery-profile through the Gmail primitive. */
    async commitDiscoveryProfile(before: WorkspaceRowsRecord, snapshot: PJSDASSnapshot, command: WorkspaceRowsDiscoveryProfileCommand) {
      if (!writes) throw new WorkspaceRowsCandidateError('DISABLED')
      invalid(uuid(before.workspaceId) && uuid(before.userId) && uuid(before.epoch) && integer(before.revision) && uuid(command.grantId) && integer(command.grantRevision) && command.clientId.trim().length > 0 && command.commandId.length > 0 && /^[0-9a-f]{64}$/.test(command.payloadHash))
      invalid(Object.keys(command).every(key => ['commandId', 'payloadHash', 'compensation', 'provenance', 'receiptContext', 'effectiveTime', 'grantId', 'grantRevision', 'clientId', 'operation', 'undoOf'].includes(key)))
      validateSnapshot(before.snapshot); validateSnapshot(snapshot)
      const operation = command.operation ?? 'discovery_profile_management'
      invalid(operation === 'discovery_profile_management' ? command.undoOf === undefined : operation === 'undo_command' && typeof command.undoOf === 'string' && command.undoOf.length > 0)
      const req = { ...diffWorkspaceRows(before.snapshot, snapshot), commandId: command.commandId, payloadHash: command.payloadHash, compensation: command.compensation, ...auditFields(command), operation, provenance: { ...command.provenance, ...(command.undoOf ? { undoOf: command.undoOf } : {}) }, principal: 'delegated_mcp', workspaceId: before.workspaceId, userId: before.userId, expectedEpoch: before.epoch, expectedRevision: before.revision, schemaVersion: snapshot.version }
      invalid(Buffer.byteLength(JSON.stringify(req)) <= 2_097_152 && req.changes.length <= 2000)
      const result = await request('commit_discovery_profile', { req, target_grant_id: command.grantId, target_grant_revision: command.grantRevision, target_client_id: command.clientId })
      invalid(object(result) && integer(result.revision))
      if (result.outcome === 'CONFLICT') throw new WorkspaceRowsCandidateError('CONFLICT', true)
      invalid((result.outcome === 'COMMITTED' || result.outcome === 'ALREADY_APPLIED') && object(result.receipt) && result.receipt.commandId === command.commandId && result.receipt.operation === operation && result.receipt.status === 'COMMITTED' && result.receipt.revision === result.revision)
      const authorization = result.receipt.managementAuthorization
      invalid(object(authorization) && uuid(authorization.grantId) && integer(authorization.grantRevision) && authorization.grantRevision > 0 && authorization.consentVersion === 5)
      // Current authorization is checked in SQL before replay. A replay still returns
      // the original immutable receipt, not a rewrite with today's grant revision.
      if (result.outcome === 'COMMITTED') invalid(authorization.grantId === command.grantId && authorization.grantRevision === command.grantRevision)
      return { outcome: result.outcome, resultingRevision: result.revision, receipt: result.receipt }
    },
    /** Separate guarded entry; never route delegated private reminder through the Gmail primitive. */
    async commitPrivateReminder(before: WorkspaceRowsRecord, snapshot: PJSDASSnapshot, command: WorkspaceRowsPrivateReminderCommand) {
      if (!writes) throw new WorkspaceRowsCandidateError('DISABLED')
      invalid(uuid(before.workspaceId) && uuid(before.userId) && uuid(before.epoch) && integer(before.revision) && uuid(command.grantId) && integer(command.grantRevision) && command.clientId.trim().length > 0 && command.commandId.length > 0 && /^[0-9a-f]{64}$/.test(command.payloadHash))
      invalid(Object.keys(command).every(key => ['commandId', 'payloadHash', 'compensation', 'provenance', 'receiptContext', 'effectiveTime', 'grantId', 'grantRevision', 'clientId', 'operation', 'undoOf'].includes(key)))
      validateSnapshot(before.snapshot); validateSnapshot(snapshot)
      const operation = command.operation ?? 'private_reminder_management'
      invalid(operation === 'private_reminder_management' ? command.undoOf === undefined : operation === 'undo_command' && typeof command.undoOf === 'string' && command.undoOf.length > 0)
      const req = { ...diffWorkspaceRows(before.snapshot, snapshot), commandId: command.commandId, payloadHash: command.payloadHash, compensation: command.compensation, ...auditFields(command), operation, provenance: { ...command.provenance, ...(command.undoOf ? { undoOf: command.undoOf } : {}) }, principal: 'delegated_mcp', workspaceId: before.workspaceId, userId: before.userId, expectedEpoch: before.epoch, expectedRevision: before.revision, schemaVersion: snapshot.version }
      invalid(Buffer.byteLength(JSON.stringify(req)) <= 2_097_152 && req.changes.length <= 2000)
      const result = await request('commit_private_reminder', { req, target_grant_id: command.grantId, target_grant_revision: command.grantRevision, target_client_id: command.clientId })
      invalid(object(result) && integer(result.revision))
      if (result.outcome === 'CONFLICT') throw new WorkspaceRowsCandidateError('CONFLICT', true)
      invalid((result.outcome === 'COMMITTED' || result.outcome === 'ALREADY_APPLIED') && object(result.receipt) && result.receipt.commandId === command.commandId && result.receipt.operation === operation && result.receipt.status === 'COMMITTED' && result.receipt.revision === result.revision)
      const authorization = result.receipt.managementAuthorization
      invalid(object(authorization) && uuid(authorization.grantId) && integer(authorization.grantRevision) && authorization.grantRevision > 0 && authorization.consentVersion === 6)
      // Current authorization is checked in SQL before replay. A replay still returns
      // the original immutable receipt, not a rewrite with today's grant revision.
      if (result.outcome === 'COMMITTED') invalid(authorization.grantId === command.grantId && authorization.grantRevision === command.grantRevision)
      return { outcome: result.outcome, resultingRevision: result.revision, receipt: result.receipt }
    },
    /** Separate guarded entry; never route delegated opportunity through the Gmail primitive. */
    async commitOpportunity(before: WorkspaceRowsRecord, snapshot: PJSDASSnapshot, command: WorkspaceRowsOpportunityCommand) {
      if (!writes) throw new WorkspaceRowsCandidateError('DISABLED')
      invalid(uuid(before.workspaceId) && uuid(before.userId) && uuid(before.epoch) && integer(before.revision) && uuid(command.grantId) && integer(command.grantRevision) && command.clientId.trim().length > 0 && command.commandId.length > 0 && /^[0-9a-f]{64}$/.test(command.payloadHash))
      invalid(Object.keys(command).every(key => ['commandId', 'payloadHash', 'compensation', 'provenance', 'receiptContext', 'effectiveTime', 'grantId', 'grantRevision', 'clientId', 'operation', 'undoOf'].includes(key)))
      validateSnapshot(before.snapshot); validateSnapshot(snapshot)
      const operation = command.operation ?? 'opportunity_management'
      invalid(operation === 'opportunity_management' ? command.undoOf === undefined : operation === 'undo_command' && typeof command.undoOf === 'string' && command.undoOf.length > 0)
      const req = { ...diffWorkspaceRows(before.snapshot, snapshot), commandId: command.commandId, payloadHash: command.payloadHash, compensation: command.compensation, ...auditFields(command), operation, provenance: { ...command.provenance, ...(command.undoOf ? { undoOf: command.undoOf } : {}) }, principal: 'delegated_mcp', workspaceId: before.workspaceId, userId: before.userId, expectedEpoch: before.epoch, expectedRevision: before.revision, schemaVersion: snapshot.version }
      invalid(Buffer.byteLength(JSON.stringify(req)) <= 2_097_152 && req.changes.length <= 2000)
      const result = await request('commit_opportunity', { req, target_grant_id: command.grantId, target_grant_revision: command.grantRevision, target_client_id: command.clientId })
      invalid(object(result) && integer(result.revision))
      if (result.outcome === 'CONFLICT') throw new WorkspaceRowsCandidateError('CONFLICT', true)
      invalid((result.outcome === 'COMMITTED' || result.outcome === 'ALREADY_APPLIED') && object(result.receipt) && result.receipt.commandId === command.commandId && result.receipt.operation === operation && result.receipt.status === 'COMMITTED' && result.receipt.revision === result.revision)
      const authorization = result.receipt.managementAuthorization
      invalid(object(authorization) && uuid(authorization.grantId) && integer(authorization.grantRevision) && authorization.grantRevision > 0 && authorization.consentVersion === 3)
      // Current authorization is checked in SQL before replay. A replay still returns
      // the original immutable receipt, not a rewrite with today's grant revision.
      if (result.outcome === 'COMMITTED') invalid(authorization.grantId === command.grantId && authorization.grantRevision === command.grantRevision)
      return { outcome: result.outcome, resultingRevision: result.revision, receipt: result.receipt }
    },
    /** Separate guarded entry; never route delegated business through the Gmail primitive. */
    async commitBusiness(before: WorkspaceRowsRecord, snapshot: PJSDASSnapshot, command: WorkspaceRowsBusinessCommand) {
      if (!writes) throw new WorkspaceRowsCandidateError('DISABLED')
      invalid(uuid(before.workspaceId) && uuid(before.userId) && uuid(before.epoch) && integer(before.revision) && uuid(command.grantId) && integer(command.grantRevision) && command.clientId.trim().length > 0 && command.commandId.length > 0 && /^[0-9a-f]{64}$/.test(command.payloadHash))
      invalid(Object.keys(command).every(key => ['commandId', 'payloadHash', 'compensation', 'provenance', 'receiptContext', 'effectiveTime', 'grantId', 'grantRevision', 'clientId', 'operation', 'undoOf'].includes(key)))
      validateSnapshot(before.snapshot); validateSnapshot(snapshot)
      const operation = command.operation ?? 'business_management'
      invalid(operation === 'business_management' ? command.undoOf === undefined : operation === 'undo_command' && typeof command.undoOf === 'string' && command.undoOf.length > 0)
      const req = { ...diffWorkspaceRows(before.snapshot, snapshot), commandId: command.commandId, payloadHash: command.payloadHash, compensation: command.compensation, ...auditFields(command), operation, provenance: { ...command.provenance, ...(command.undoOf ? { undoOf: command.undoOf } : {}) }, principal: 'delegated_mcp', workspaceId: before.workspaceId, userId: before.userId, expectedEpoch: before.epoch, expectedRevision: before.revision, schemaVersion: snapshot.version }
      invalid(Buffer.byteLength(JSON.stringify(req)) <= 2_097_152 && req.changes.length <= 2000)
      const result = await request('commit_business', { req, target_grant_id: command.grantId, target_grant_revision: command.grantRevision, target_client_id: command.clientId })
      invalid(object(result) && integer(result.revision))
      if (result.outcome === 'CONFLICT') throw new WorkspaceRowsCandidateError('CONFLICT', true)
      invalid((result.outcome === 'COMMITTED' || result.outcome === 'ALREADY_APPLIED') && object(result.receipt) && result.receipt.commandId === command.commandId && result.receipt.operation === operation && result.receipt.status === 'COMMITTED' && result.receipt.revision === result.revision)
      const authorization = result.receipt.managementAuthorization
      invalid(object(authorization) && uuid(authorization.grantId) && integer(authorization.grantRevision) && authorization.grantRevision > 0 && authorization.consentVersion === 7)
      // Current authorization is checked in SQL before replay. A replay still returns
      // the original immutable receipt, not a rewrite with today's grant revision.
      if (result.outcome === 'COMMITTED') invalid(authorization.grantId === command.grantId && authorization.grantRevision === command.grantRevision)
      return { outcome: result.outcome, resultingRevision: result.revision, receipt: result.receipt }
    },
    /** Separate guarded entry; never route delegated business through the Gmail primitive. */
    async commitLegacyManagement(before: WorkspaceRowsRecord, snapshot: PJSDASSnapshot, command: WorkspaceRowsBusinessCommand) {
      if (!writes) throw new WorkspaceRowsCandidateError('DISABLED')
      invalid(uuid(before.workspaceId) && uuid(before.userId) && uuid(before.epoch) && integer(before.revision) && uuid(command.grantId) && integer(command.grantRevision) && command.clientId.trim().length > 0 && command.commandId.length > 0 && /^[0-9a-f]{64}$/.test(command.payloadHash))
      invalid(Object.keys(command).every(key => ['commandId', 'payloadHash', 'compensation', 'provenance', 'receiptContext', 'effectiveTime', 'grantId', 'grantRevision', 'clientId', 'operation', 'undoOf'].includes(key)))
      validateSnapshot(before.snapshot); validateSnapshot(snapshot)
      const operation = command.operation ?? 'business_management'
      invalid(operation === 'business_management' ? command.undoOf === undefined : operation === 'undo_command' && typeof command.undoOf === 'string' && command.undoOf.length > 0)
      const req = { ...diffWorkspaceRows(before.snapshot, snapshot), commandId: command.commandId, payloadHash: command.payloadHash, compensation: command.compensation, ...auditFields(command), operation, provenance: { ...command.provenance, ...(command.undoOf ? { undoOf: command.undoOf } : {}) }, principal: 'delegated_mcp', workspaceId: before.workspaceId, userId: before.userId, expectedEpoch: before.epoch, expectedRevision: before.revision, schemaVersion: snapshot.version }
      invalid(Buffer.byteLength(JSON.stringify(req)) <= 2_097_152 && req.changes.length <= 2000)
      const result = await request('commit_management_v2', { req, target_grant_id: command.grantId, target_grant_revision: command.grantRevision, target_client_id: command.clientId })
      invalid(object(result) && integer(result.revision))
      if (result.outcome === 'CONFLICT') throw new WorkspaceRowsCandidateError('CONFLICT', true)
      invalid((result.outcome === 'COMMITTED' || result.outcome === 'ALREADY_APPLIED') && object(result.receipt) && result.receipt.commandId === command.commandId && result.receipt.operation === operation && result.receipt.status === 'COMMITTED' && result.receipt.revision === result.revision)
      const authorization = result.receipt.managementAuthorization
      invalid(object(authorization) && uuid(authorization.grantId) && integer(authorization.grantRevision) && authorization.grantRevision > 0 && authorization.consentVersion === 2)
      // Current authorization is checked in SQL before replay. A replay still returns
      // the original immutable receipt, not a rewrite with today's grant revision.
      if (result.outcome === 'COMMITTED') invalid(authorization.grantId === command.grantId && authorization.grantRevision === command.grantRevision)
      return { outcome: result.outcome, resultingRevision: result.revision, receipt: result.receipt }
    },
    /** Existing verified Discovery and internal claim/settlement authority only. */
    async commitDiscovery(before: WorkspaceRowsRecord, snapshot: PJSDASSnapshot, command: WorkspaceRowsDiscoveryCommand) {
      if (!writes) throw new WorkspaceRowsCandidateError('DISABLED')
      invalid(uuid(before.workspaceId) && uuid(before.userId) && uuid(before.epoch) && integer(before.revision) && command.commandId.length > 0 && /^[0-9a-f]{64}$/.test(command.payloadHash) && object(command.authorization))
      invalid(Object.keys(command).every(key => ['commandId', 'payloadHash', 'operation', 'principal', 'clientId', 'provenance', 'compensation', 'receiptContext', 'effectiveTime', 'authorization'].includes(key)))
      invalid(['checkpoint_discovery_search', 'ingest_verified_discovery'].includes(command.operation) && ['automation', 'delegated_mcp'].includes(command.principal))
      validateSnapshot(before.snapshot); validateSnapshot(snapshot)
      const req = { ...diffWorkspaceRows(before.snapshot, snapshot), commandId: command.commandId, payloadHash: command.payloadHash, compensation: command.compensation, ...auditFields(command), operation: command.operation, principal: command.principal, clientId: command.clientId ?? null, workspaceId: before.workspaceId, userId: before.userId, expectedEpoch: before.epoch, expectedRevision: before.revision, schemaVersion: snapshot.version }
      const body = { req, target_discovery_authorization: command.authorization }
      invalid(Buffer.byteLength(JSON.stringify(body)) <= 2_097_152 && req.changes.length <= 2000)
      const result = await request('commit_discovery', body); invalid(object(result) && integer(result.revision))
      if (result.outcome === 'CONFLICT') throw new WorkspaceRowsCandidateError('CONFLICT', true)
      invalid((result.outcome === 'COMMITTED' || result.outcome === 'ALREADY_APPLIED') && object(result.receipt) && result.receipt.commandId === command.commandId && result.receipt.operation === command.operation && result.receipt.status === 'COMMITTED' && result.receipt.revision === result.revision && object(result.receipt.discoveryAuthorization) && result.receipt.discoveryAuthorization.userId === before.userId)
      return { outcome: result.outcome, resultingRevision: result.revision, receipt: result.receipt }
    },
    /** Layout-aware at-most-once admission only; provider dispatch is not part of this adapter. */
    async admitCapture(before: Pick<WorkspaceRowsRecord, 'userId' | 'epoch' | 'revision'>, admission: WorkspaceRowsCaptureAdmission) {
      if (!writes) throw new WorkspaceRowsCandidateError('DISABLED')
      invalid(uuid(before.userId) && uuid(before.epoch) && integer(before.revision) && admission.requestId.trim().length > 0 && /^[0-9a-f]{64}$/.test(admission.payloadHash) && admission.text.trim().length > 0 && admission.timezone.trim().length > 0 && Number.isFinite(Date.parse(admission.referenceTime)) && integer(admission.reservationUnits) && admission.reservationUnits > 0)
      const result = await request('admit_ai_capture', { target_user_id: before.userId, target_request_id: admission.requestId, target_payload_hash: admission.payloadHash, target_text: admission.text, target_timezone: admission.timezone, target_reference_time: admission.referenceTime, target_expected_revision: before.revision, target_reservation_units: admission.reservationUnits, target_epoch: before.epoch })
      invalid(Array.isArray(result) && result.length === 1 && object(result[0]) && result[0].user_id === before.userId && result[0].request_id === admission.requestId && result[0].payload_hash === admission.payloadHash && result[0].status === 'DISPATCHED' && result[0].expected_revision === before.revision && result[0].reservation_units === admission.reservationUnits)
      return result[0]
    },
    /** The existing durable review is consumed atomically; no model is invoked. */
    async commitCapture(before: WorkspaceRowsRecord, snapshot: PJSDASSnapshot, command: WorkspaceRowsCaptureCommand) {
      if (!writes) throw new WorkspaceRowsCandidateError('DISABLED')
      invalid(uuid(before.workspaceId) && uuid(before.userId) && uuid(before.epoch) && integer(before.revision) && command.commandId.length > 0 && command.requestId.trim().length > 0 && /^[0-9a-f]{64}$/.test(command.payloadHash) && object(command.observation))
      invalid(Object.keys(command).every(key => ['commandId', 'payloadHash', 'compensation', 'provenance', 'receiptContext', 'effectiveTime', 'requestId', 'observation'].includes(key)))
      validateSnapshot(before.snapshot); validateSnapshot(snapshot)
      const req = { ...diffWorkspaceRows(before.snapshot, snapshot), commandId: command.commandId, payloadHash: command.payloadHash, compensation: command.compensation, ...auditFields(command), operation: 'ai_capture_confirm', principal: 'first_party_web', workspaceId: before.workspaceId, userId: before.userId, expectedEpoch: before.epoch, expectedRevision: before.revision, schemaVersion: snapshot.version }
      const body = { req, target_capture_request_id: command.requestId, target_capture_observation: command.observation }
      invalid(Buffer.byteLength(JSON.stringify(body)) <= 2_097_152 && req.changes.length <= 2000)
      const result = await request('commit_ai_capture', body); invalid(object(result) && integer(result.revision))
      if (result.outcome === 'CONFLICT') throw new WorkspaceRowsCandidateError('CONFLICT', true)
      invalid((result.outcome === 'COMMITTED' || result.outcome === 'ALREADY_APPLIED') && object(result.receipt) && result.receipt.commandId === command.commandId && result.receipt.operation === 'ai_capture_confirm' && result.receipt.status === 'COMMITTED' && result.receipt.revision === result.revision)
      return { outcome: result.outcome, resultingRevision: result.revision, receipt: result.receipt }
    },
    /** Same trusted server-core boundary as v2, never a guarded-family fallback. */
    async commitAuthoritative(before: WorkspaceRowsRecord, snapshot: PJSDASSnapshot, command: WorkspaceRowsBaseCommand) {
      if (!writes) throw new WorkspaceRowsCandidateError('DISABLED')
      if (['gmail_semantic_intake', 'business_management', 'opportunity_management', 'planning_management', 'discovery_profile_management', 'private_reminder_management', 'ai_capture_confirm', 'ingest_verified_discovery', 'checkpoint_discovery_search'].includes(command.operation)) throw new WorkspaceRowsCandidateError('UNSUPPORTED')
      invalid(uuid(before.workspaceId) && uuid(before.userId) && uuid(before.epoch) && integer(before.revision) && command.commandId.length > 0 && command.operation.length > 0 && /^[0-9a-f]{64}$/.test(command.payloadHash))
      invalid(['first_party_web', 'delegated_mcp', 'automation'].includes(command.principal) && (command.principal === 'delegated_mcp' ? typeof command.clientId === 'string' && command.clientId.trim().length > 0 : command.clientId === undefined))
      invalid(Object.keys(command).every(key => ['commandId', 'payloadHash', 'compensation', 'operation', 'principal', 'clientId', 'provenance', 'receiptContext', 'effectiveTime'].includes(key)))
      validateSnapshot(before.snapshot); validateSnapshot(snapshot)
      const req = { ...diffWorkspaceRows(before.snapshot, snapshot), ...command, ...auditFields(command), workspaceId: before.workspaceId, userId: before.userId, expectedEpoch: before.epoch, expectedRevision: before.revision, schemaVersion: snapshot.version }
      invalid(Buffer.byteLength(JSON.stringify(req)) <= 2_097_152 && req.changes.length <= 2000)
      const result = await request('commit_authoritative', { req }); invalid(object(result) && integer(result.revision))
      if (result.outcome === 'CONFLICT') throw new WorkspaceRowsCandidateError('CONFLICT', true)
      invalid((result.outcome === 'COMMITTED' || result.outcome === 'ALREADY_APPLIED') && object(result.receipt) && result.receipt.commandId === command.commandId && result.receipt.operation === command.operation && result.receipt.status === 'COMMITTED' && result.receipt.revision === result.revision)
      return { outcome: result.outcome, resultingRevision: result.revision, receipt: result.receipt }
    },
    async commit(before: WorkspaceRowsRecord, snapshot: PJSDASSnapshot, command: WorkspaceRowsGmailCommand) {
      if (!writes) throw new WorkspaceRowsCandidateError('DISABLED')
      if (command.operation !== 'gmail_semantic_intake' || command.principal !== 'automation' || command.sourceId !== 'gmail:primary' || 'managementAuthorization' in command || 'aiCaptureAuthorization' in command || 'discoveryAuthorization' in command) throw new WorkspaceRowsCandidateError('UNSUPPORTED')
      invalid(uuid(before.workspaceId) && uuid(before.userId) && uuid(before.epoch) && integer(before.revision) && command.commandId.length > 0 && /^[0-9a-f]{64}$/.test(command.payloadHash))
      validateSnapshot(before.snapshot); validateSnapshot(snapshot)
      invalid(Object.keys(command).every(key => ['commandId', 'payloadHash', 'operation', 'principal', 'sourceId', 'compensation', 'provenance', 'receiptContext', 'effectiveTime'].includes(key)))
      const req = { ...diffWorkspaceRows(before.snapshot, snapshot), commandId: command.commandId, payloadHash: command.payloadHash, operation: command.operation, principal: command.principal, sourceId: command.sourceId, compensation: command.compensation, ...auditFields(command), provenance: { ...command.provenance, sourceId: command.sourceId }, workspaceId: before.workspaceId, userId: before.userId, expectedEpoch: before.epoch, expectedRevision: before.revision, schemaVersion: snapshot.version }
      invalid(Buffer.byteLength(JSON.stringify(req)) <= 2_097_152 && req.changes.length <= 2000)
      const result = await request('commit_rows', { req }); invalid(object(result) && integer(result.revision))
      if (result.outcome === 'CONFLICT') throw new WorkspaceRowsCandidateError('CONFLICT', true)
      invalid((result.outcome === 'COMMITTED' || result.outcome === 'ALREADY_APPLIED') && object(result.receipt) && result.receipt.commandId === command.commandId && result.receipt.operation === command.operation && result.receipt.status === 'COMMITTED' && result.receipt.revision === result.revision)
      return { outcome: result.outcome, resultingRevision: result.revision, receipt: result.receipt }
    },
  }
}
