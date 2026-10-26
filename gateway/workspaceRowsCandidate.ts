import { Buffer } from 'node:buffer'
import { validateSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'
import { decodeWorkspaceRows, diffWorkspaceRows, type WorkspaceEntityRow } from './workspaceRowsCodec.js'

/** Isolated Stage-A adapter. Not wired into the deployed transactional store. */
export interface WorkspaceRowsCandidateOptions {
  supabaseUrl: string
  serviceRoleKey: string
  readsEnabled?: boolean
  writesEnabled?: boolean
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}
export interface WorkspaceRowsRecord { workspaceId: string; userId: string; revision: number; epoch: string; snapshot: PJSDASSnapshot }
export interface WorkspaceRowsGmailCommand {
  commandId: string; payloadHash: string; operation: 'gmail_semantic_intake'; principal: 'automation'; sourceId: 'gmail:primary'
  compensation: Record<string, unknown>
  managementAuthorization?: never; aiCaptureAuthorization?: never; discoveryAuthorization?: never
}
export interface WorkspaceRowsPlanningCommand { commandId: string; payloadHash: string; compensation: Record<string, unknown>; grantId: string; grantRevision: number; clientId: string; operation?: 'planning_management' | 'undo_command'; undoOf?: string }
export type WorkspaceRowsDiscoveryProfileCommand = Omit<WorkspaceRowsPlanningCommand, 'operation'> & { operation?: 'discovery_profile_management' | 'undo_command' }
export type WorkspaceRowsPrivateReminderCommand = Omit<WorkspaceRowsPlanningCommand, 'operation'> & { operation?: 'private_reminder_management' | 'undo_command' }
export class WorkspaceRowsCandidateError extends Error {
  constructor(readonly code: 'DISABLED' | 'INVALID' | 'CONFLICT' | 'UNAVAILABLE' | 'UNSUPPORTED', readonly retryable = false) { super(`WORKSPACE_ROWS_${code}`) }
}
const object = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x)
const integer = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0
const uuid = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x)
function invalid(ok: unknown): asserts ok { if (!ok) throw new WorkspaceRowsCandidateError('INVALID') }

export function createWorkspaceRowsCandidate(options: WorkspaceRowsCandidateOptions) {
  const reads = options.readsEnabled === true, writes = options.writesEnabled === true
  if (writes && !reads) throw new WorkspaceRowsCandidateError('DISABLED')
  const request = async (rpc: string, body: unknown): Promise<unknown> => {
    if (!reads) throw new WorkspaceRowsCandidateError('DISABLED')
    invalid(options.serviceRoleKey.trim().length > 0)
    let response: Response
    try {
      response = await (options.fetchImpl ?? fetch)(`${options.supabaseUrl.replace(/\/+$/, '')}/rpc/${rpc}`, {
        method: 'POST', headers: { authorization: `Bearer ${options.serviceRoleKey}`, apikey: options.serviceRoleKey, 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: options.signal ?? AbortSignal.timeout(10_000),
      })
    } catch { throw new WorkspaceRowsCandidateError('UNAVAILABLE', true) }
    if (!response.ok) throw new WorkspaceRowsCandidateError(response.status === 409 ? 'CONFLICT' : 'UNAVAILABLE', response.status >= 500 || response.status === 429 || response.status === 409)
    return response.json().catch(() => { throw new WorkspaceRowsCandidateError('INVALID') })
  }
  const head = async (userId: string) => {
    invalid(uuid(userId)); const value = await request('read_head', { target_user_id: userId })
    if (value === null) return null
    invalid(object(value) && uuid(value.workspaceId) && value.userId === userId && uuid(value.epoch) && integer(value.revision) && value.format === 'workspace-rows-v1' && object(value.envelope) && Array.isArray(value.manifest))
    return value
  }
  return {
    /** One bounded attempt: conflicts are visible; caller must not retry beyond its existing budget. */
    async read(userId: string): Promise<WorkspaceRowsRecord | null> {
      const first = await head(userId); if (first === null) return null
      const rows: WorkspaceEntityRow[] = []; let cursor: WorkspaceEntityRow | undefined, bytes = 0
      let ended = false
      for (let pageNumber = 0; pageNumber < 512; pageNumber++) {
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
        invalid(page.rows.length === 127)
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
      invalid(Object.keys(command).every(key => ['commandId', 'payloadHash', 'compensation', 'grantId', 'grantRevision', 'clientId', 'operation', 'undoOf'].includes(key)))
      validateSnapshot(before.snapshot); validateSnapshot(snapshot)
      const operation = command.operation ?? 'planning_management'
      invalid(operation === 'planning_management' ? command.undoOf === undefined : operation === 'undo_command' && typeof command.undoOf === 'string' && command.undoOf.length > 0)
      const req = { ...diffWorkspaceRows(before.snapshot, snapshot), commandId: command.commandId, payloadHash: command.payloadHash, compensation: command.compensation, operation, provenance: command.undoOf ? { undoOf: command.undoOf } : {}, principal: 'delegated_mcp', workspaceId: before.workspaceId, userId: before.userId, expectedEpoch: before.epoch, expectedRevision: before.revision }
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
      invalid(Object.keys(command).every(key => ['commandId', 'payloadHash', 'compensation', 'grantId', 'grantRevision', 'clientId', 'operation', 'undoOf'].includes(key)))
      validateSnapshot(before.snapshot); validateSnapshot(snapshot)
      const operation = command.operation ?? 'discovery_profile_management'
      invalid(operation === 'discovery_profile_management' ? command.undoOf === undefined : operation === 'undo_command' && typeof command.undoOf === 'string' && command.undoOf.length > 0)
      const req = { ...diffWorkspaceRows(before.snapshot, snapshot), commandId: command.commandId, payloadHash: command.payloadHash, compensation: command.compensation, operation, provenance: command.undoOf ? { undoOf: command.undoOf } : {}, principal: 'delegated_mcp', workspaceId: before.workspaceId, userId: before.userId, expectedEpoch: before.epoch, expectedRevision: before.revision }
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
      invalid(Object.keys(command).every(key => ['commandId', 'payloadHash', 'compensation', 'grantId', 'grantRevision', 'clientId', 'operation', 'undoOf'].includes(key)))
      validateSnapshot(before.snapshot); validateSnapshot(snapshot)
      const operation = command.operation ?? 'private_reminder_management'
      invalid(operation === 'private_reminder_management' ? command.undoOf === undefined : operation === 'undo_command' && typeof command.undoOf === 'string' && command.undoOf.length > 0)
      const req = { ...diffWorkspaceRows(before.snapshot, snapshot), commandId: command.commandId, payloadHash: command.payloadHash, compensation: command.compensation, operation, provenance: command.undoOf ? { undoOf: command.undoOf } : {}, principal: 'delegated_mcp', workspaceId: before.workspaceId, userId: before.userId, expectedEpoch: before.epoch, expectedRevision: before.revision }
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
    async commit(before: WorkspaceRowsRecord, snapshot: PJSDASSnapshot, command: WorkspaceRowsGmailCommand) {
      if (!writes) throw new WorkspaceRowsCandidateError('DISABLED')
      if (command.operation !== 'gmail_semantic_intake' || command.principal !== 'automation' || command.sourceId !== 'gmail:primary' || 'managementAuthorization' in command || 'aiCaptureAuthorization' in command || 'discoveryAuthorization' in command) throw new WorkspaceRowsCandidateError('UNSUPPORTED')
      invalid(uuid(before.workspaceId) && uuid(before.userId) && uuid(before.epoch) && integer(before.revision) && command.commandId.length > 0 && /^[0-9a-f]{64}$/.test(command.payloadHash))
      validateSnapshot(before.snapshot); validateSnapshot(snapshot)
      invalid(Object.keys(command).every(key => ['commandId', 'payloadHash', 'operation', 'principal', 'sourceId', 'compensation'].includes(key)))
      const req = { ...diffWorkspaceRows(before.snapshot, snapshot), commandId: command.commandId, payloadHash: command.payloadHash, operation: command.operation, principal: command.principal, sourceId: command.sourceId, compensation: command.compensation, workspaceId: before.workspaceId, userId: before.userId, expectedEpoch: before.epoch, expectedRevision: before.revision }
      invalid(Buffer.byteLength(JSON.stringify(req)) <= 2_097_152 && req.changes.length <= 2000)
      const result = await request('commit_rows', { req }); invalid(object(result) && integer(result.revision))
      if (result.outcome === 'CONFLICT') throw new WorkspaceRowsCandidateError('CONFLICT', true)
      invalid((result.outcome === 'COMMITTED' || result.outcome === 'ALREADY_APPLIED') && object(result.receipt) && result.receipt.commandId === command.commandId && result.receipt.operation === command.operation && result.receipt.status === 'COMMITTED' && result.receipt.revision === result.revision)
      return { outcome: result.outcome, resultingRevision: result.revision, receipt: result.receipt }
    },
  }
}
