import { captureAccountCacheLease, AccountCacheChangedError } from './accountCacheLease.js'
import type { UserDomainCommand } from '../domainCommands.js'
import type { DiscoveryStatusCommand } from '../discoveryStatusCommand.js'
import type { DiscoveryProfile } from '../discoveryProfile.js'
import type { SemanticIntakeObservation } from '../model.js'
import { validateSnapshot, type PJSDASSnapshot } from '../snapshot.js'
import { fetchBackend } from '../backendEndpoints.js'
import { isRecordedAccountProjection, assertLocalSnapshotCurrent, exportLocalSnapshot, replaceLocalSnapshotFromCloud } from '../db.js'
import { getAccountAccessToken } from './cloudClient.js'
import { getAccountCheckpoint, getCloudDeviceState, patchAccountCheckpoint } from './syncState.js'
import { equivalentReadProjection, fingerprintWorkspace } from './workspaceFingerprint.js'

export type ConnectedBusinessCommand =
  | { type: 'domain'; value: UserDomainCommand }
  | { type: 'semantic_intake'; value: SemanticIntakeObservation }
  | { type: 'resolve_semantic_decision'; value: { requestId: string; choiceId: string } }
  | { type: 'discovery_status'; value: DiscoveryStatusCommand }
  | { type: 'discovery_profile'; value: DiscoveryProfile }
  | { type: 'discovery_promotion'; value: { inboxItemId: string } }
  | { type: 'process_event_delete'; value: { eventId: string } }
  | { type: 'mcp_save_inbox'; value: { token: string } }
  | { type: 'mcp_apply_actions'; value: { token: string } }
  | { type: 'mcp_apply_rules'; value: { token: string } }
  | { type: 'mcp_apply_source_refresh'; value: { token: string } }
  | { type: 'mcp_apply_progress'; value: { token: string } }
  | { type: 'mcp_apply_mixed'; value: { token: string } }
  | { type: 'mcp_discard'; value: {
      token: string
      rejectionSelections: Record<string, { code: 'location' | 'compensation' | 'role_direction' | 'company_value' | 'requirements' | 'already_have_better' | 'not_interested' | 'other'; note?: string }>
    } }
  | { type: 'mcp_apply_discovery'; value: {
      token: string
      selectedOperationIds: string[]
      rejectionSelections: Record<string, { code: 'location' | 'compensation' | 'role_direction' | 'company_value' | 'requirements' | 'already_have_better' | 'not_interested' | 'other'; note?: string }>
    } }

export interface ConnectedCommandResponse {
  outcome: 'COMMITTED' | 'ALREADY_APPLIED' | 'NO_WRITE' | 'CONFLICT'
  revision: number
  workspaceVersion: string
  schemaVersion: number
  snapshot: PJSDASSnapshot
  /** The server outcome is durable even when this browser cannot project it. */
  localProjection?: 'applied' | 'pending'
  receipt?: Record<string, unknown>
  result?: Record<string, unknown>
  conflict?: {
    kind: string
    message: string
    objects: Array<{ type: string; id: string }>
    interveningCommandIds?: string[]
    reason?: string
  }
}

interface PendingCommand {
  commandId: string
  action: 'command' | 'undo'
  baseRevision?: number
  command?: ConnectedBusinessCommand
  targetCommandId?: string
  status: 'pending' | 'unknown' | 'conflict' | 'projection_pending'
  createdAt: string
  updatedAt: string
  lastError?: string
  interaction?: boolean
}

const PENDING_PREFIX = 'pjsdas-cgr01-pending:'
const DRAFT_PREFIX = 'pjsdas-cgr01-draft:'
const commandFlights = new Map<string, Promise<ConnectedCommandResponse>>()

function oneCommandFlight(accountKey: string, commandId: string, run: () => Promise<ConnectedCommandResponse>) {
  const key = `${accountKey}\u0000${commandId}`
  const active = commandFlights.get(key)
  if (active) return active
  const flight = run()
  commandFlights.set(key, flight)
  void flight.finally(() => { if (commandFlights.get(key) === flight) commandFlights.delete(key) }).catch(() => undefined)
  return flight
}

function storage() {
  return typeof window === 'undefined' ? undefined : window.localStorage
}

function pendingKey(accountKey: string) {
  return `${PENDING_PREFIX}${encodeURIComponent(accountKey)}`
}

function draftKey(accountKey: string, name: string) {
  return `${DRAFT_PREFIX}${encodeURIComponent(accountKey)}:${encodeURIComponent(name)}`
}

function readPending(accountKey: string): PendingCommand[] {
  const raw = storage()?.getItem(pendingKey(accountKey))
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error('Invalid account command outbox.')
    return parsed
  } catch {
    throw new Error('账号待提交操作记录无法读取；已停止写入以保护原记录。')
  }
}

/** No command payload leaves this read-only diagnostic. */
export function pendingCommandSummary(accountKey: string) {
  const pending = readPending(accountKey)
  return {
    count: pending.length,
    pending: pending.filter(item => item.status === 'pending').length,
    unknown: pending.filter(item => item.status === 'unknown').length,
    conflict: pending.filter(item => item.status === 'conflict').length,
  }
}

function writePending(accountKey: string, items: PendingCommand[]) {
  const store = storage()
  if (!store) return
  if (!items.length) store.removeItem(pendingKey(accountKey))
  else store.setItem(pendingKey(accountKey), JSON.stringify(items))
}

function upsertPending(accountKey: string, value: PendingCommand) {
  const items = readPending(accountKey).filter((item) => item.commandId !== value.commandId)
  items.push(value)
  writePending(accountKey, items)
}

function patchPending(accountKey: string, commandId: string, patch: Partial<PendingCommand>) {
  writePending(accountKey, readPending(accountKey).map((item) =>
    item.commandId === commandId ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item))
}

function removePending(accountKey: string, commandId: string) {
  writePending(accountKey, readPending(accountKey).filter((item) => item.commandId !== commandId))
}

export function listAccountPendingOperations(accountKey: string) {
  return readPending(accountKey)
}

export function discardAccountPendingOperation(accountKey: string, commandId: string) {
  removePending(accountKey, commandId)
}

export function findAccountPendingSemanticOperation(accountKey: string, originalText?: string) {
  const match = readPending(accountKey)
    .filter((item) =>
      item.action === 'command'
      && item.command?.type === 'semantic_intake'
      && (!originalText || item.command.value.originalText === originalText))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  if (!match || match.command?.type !== 'semantic_intake') return undefined
  return {
    commandId: match.commandId,
    status: match.status,
    originalText: match.command.value.originalText,
    lastError: match.lastError,
  }
}

export function saveAccountDraft(accountKey: string, name: string, value: string) {
  storage()?.setItem(draftKey(accountKey, name), value)
}

export function readAccountDraft(accountKey: string, name: string) {
  return storage()?.getItem(draftKey(accountKey, name)) ?? ''
}

export function clearAccountDraft(accountKey: string, name: string) {
  storage()?.removeItem(draftKey(accountKey, name))
}

export function createConnectedCommandId(prefix = 'web') {
  const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${prefix}:${id}`
}

async function request(accountKey: string, body: Record<string, unknown>) {
  const lease = captureAccountCacheLease(accountKey)
  const local = await exportLocalSnapshot()
  const checkpoint = getAccountCheckpoint(accountKey)
  const baseline = checkpoint.lastReadProjectionSourceFingerprint === checkpoint.lastSyncedFingerprint
    ? checkpoint.lastReadProjectionFingerprint ?? checkpoint.lastSyncedFingerprint : checkpoint.lastSyncedFingerprint
  // A later receipt retry must not relabel a genuine local edit as the new baseline.
  const localFingerprint = await fingerprintWorkspace(local)
  if (baseline && localFingerprint !== baseline && localFingerprint !== checkpoint.clearedCacheFingerprint
    && !await isRecordedAccountProjection(accountKey, local)) throw new AccountCacheChangedError()
  const accessToken = await getAccountAccessToken(accountKey)
  lease.assertCurrent()
  const response = await fetchBackend('/api/workspace', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ...body, projection: 'snapshot' }),
  })
  const payload = await response.json().catch(() => undefined) as Record<string, any> | undefined
  lease.assertCurrent()
  return { response, payload, lease, local }
}

function parseCommandResponse(payload: Record<string, any> | undefined): ConnectedCommandResponse {
  if (!payload || !Number.isInteger(payload.revision)) throw new Error('CONNECTED_COMMAND_INVALID: authoritative response metadata is incomplete.')
  validateSnapshot(payload.snapshot)
  return payload as ConnectedCommandResponse
}

function revisionFromCheckpoint(accountKey: string) {
  const version = getAccountCheckpoint(accountKey).lastSyncedVersion
  const match = version ? /^txn:(\d+)$/.exec(version) : undefined
  return match ? Number(match[1]) : undefined
}

async function currentRevision(accountKey: string) {
  const { response, payload } = await request(accountKey, { action: 'read' })
  if (!response.ok || !payload || !Number.isInteger(payload.revision)) {
    throw new Error(`${payload?.code ?? 'CONNECTED_WORKSPACE_FAILED'}: ${payload?.message ?? `HTTP ${response.status}`}`)
  }
  return Number(payload.revision)
}

async function projectAuthoritativeResult(accountKey: string, result: ConnectedCommandResponse,
  guard: { expectedLocal: PJSDASSnapshot; assertCurrent: () => void }) {
  const assertCurrent = () => {
    guard.assertCurrent()
    if ((revisionFromCheckpoint(accountKey) ?? -1) > result.revision) throw new AccountCacheChangedError()
  }
  const committed = await replaceLocalSnapshotFromCloud(result.snapshot, { ...guard, assertCurrent, accountKey, version: result.workspaceVersion })
  const fingerprint = await fingerprintWorkspace(result.snapshot)
  const projectedFingerprint = await fingerprintWorkspace(committed)
  assertCurrent()
  patchAccountCheckpoint(accountKey, {
    clearedCacheFingerprint: undefined,
    lastSyncedVersion: result.workspaceVersion ?? `txn:${result.revision}`,
    lastSyncedFingerprint: fingerprint,
    lastReadProjectionFingerprint: projectedFingerprint,
    lastReadProjectionSourceFingerprint: fingerprint,
    lastSyncedAt: new Date().toISOString(),
    conflict: undefined,
    lastError: undefined,
  })
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('pjsdas:workspace-replaced'))
}

function serverError(response: Response, payload?: Record<string, any>) {
  return new Error(`${payload?.code ?? 'CONNECTED_COMMAND_FAILED'}: ${payload?.message ?? payload?.conflict?.message ?? `HTTP ${response.status}`}`)
}

export class PreExecutionCommandError extends Error {
  constructor(message: string, readonly code: 'SESSION_EXPIRED_BEFORE_COMMAND' | 'AUTH_REJECTED_BEFORE_COMMAND' | 'COMMAND_REJECTED') {
    super(message)
  }
}
export class UnknownCommandOutcomeError extends Error {
  readonly code = 'UNKNOWN_COMMAND_OUTCOME'
}
export class ConnectedProjectionPendingError extends Error {
  readonly code = 'CONNECTED_PROJECTION_PENDING'
  constructor() { super('服务器已确认操作，本机状态待安全刷新。请在设置中核对同步状态。') }
}
export class CommandBlockedByPendingProjectionError extends Error {
  readonly code = 'COMMAND_BLOCKED_BY_PENDING_PROJECTION'
  constructor() { super('本机还有已确认操作待安全刷新；这次新操作尚未发送。请先在设置中核对同步状态。') }
}

export async function lookupConnectedCommandReceipt(accountKey: string, commandId: string): Promise<ConnectedCommandResponse | undefined> {
  // Receipt existence is a server fact. Local projection safety is checked
  // only after the receipt has been read, and cannot change its outcome.
  const lease = captureAccountCacheLease(accountKey)
  const accessToken = await getAccountAccessToken(accountKey)
  lease.assertCurrent()
  const response = await fetchBackend('/api/workspace', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'receipt', commandId, projection: 'snapshot' }),
  })
  const payload = await response.json().catch(() => undefined) as Record<string, any> | undefined
  lease.assertCurrent()
  if (!response.ok) throw serverError(response, payload)
  if (!payload?.found) return undefined
  const result = parseCommandResponse({
    outcome: 'ALREADY_APPLIED',
    revision: payload.revision,
    workspaceVersion: payload.workspaceVersion,
    schemaVersion: payload.schemaVersion,
    snapshot: payload.snapshot,
    receipt: payload.receipt,
    result: payload.receipt?.result,
  })
  try {
    const local = await exportLocalSnapshot()
    return projectConfirmedResult(accountKey, commandId, result,
      { expectedLocal: local, assertCurrent: lease.assertCurrent })
  } catch (caught) {
    patchPending(accountKey, commandId, {
      status: 'projection_pending',
      lastError: caught instanceof Error ? caught.message : String(caught),
    })
    return { ...result, localProjection: 'pending' }
  }
}

async function projectConfirmedResult(accountKey: string, commandId: string, result: ConnectedCommandResponse,
  guard: { expectedLocal: PJSDASSnapshot; assertCurrent: () => void }): Promise<ConnectedCommandResponse> {
  try {
    const checkpoint = getAccountCheckpoint(accountKey)
    const baseline = checkpoint.lastReadProjectionSourceFingerprint === checkpoint.lastSyncedFingerprint
      ? checkpoint.lastReadProjectionFingerprint ?? checkpoint.lastSyncedFingerprint : checkpoint.lastSyncedFingerprint
    const localFingerprint = await fingerprintWorkspace(guard.expectedLocal)
    if (baseline && localFingerprint !== baseline && localFingerprint !== checkpoint.clearedCacheFingerprint
      && !await isRecordedAccountProjection(accountKey, guard.expectedLocal)
      && !equivalentReadProjection(guard.expectedLocal, result.snapshot)) throw new AccountCacheChangedError()
    await projectAuthoritativeResult(accountKey, result, guard)
    return { ...result, localProjection: 'applied' }
  } catch (caught) {
    // The command is already committed. Preserve its identity and retry only
    // the read/projection path after the local difference is resolved.
    if (result.outcome !== 'NO_WRITE') patchPending(accountKey, commandId, {
      status: 'projection_pending',
      lastError: caught instanceof Error ? caught.message : String(caught),
    })
    return { ...result, localProjection: 'pending' }
  }
}

async function recoverUnknown(accountKey: string, pending: PendingCommand, _caught: unknown) {
  try {
    const recovered = await lookupConnectedCommandReceipt(accountKey, pending.commandId)
    if (recovered) {
      if (recovered.localProjection === 'applied') removePending(accountKey, pending.commandId)
      return recovered
    }
  } catch {
    // Preserve the unknown-outcome state. A later retry performs the same
    // receipt lookup before reusing the stable command identity.
  }
  const unknown = '尚未确认这次操作是否已提交。记录已保留；恢复连接后会先核对服务器回执，请勿重复操作。'
  patchPending(accountKey, pending.commandId, { status: 'unknown', lastError: unknown })
  throw new UnknownCommandOutcomeError(unknown)
}

function rejectBeforeExecution(accountKey: string, pending: PendingCommand, response: Response, payload?: Record<string, any>): never {
  const raw = serverError(response, payload)
  if (response.status === 401) {
    const message = '登录会话已过期；服务器没有执行这次操作。重新登录后会先核对原操作。'
    patchPending(accountKey, pending.commandId, { status: 'pending', lastError: message })
    throw new PreExecutionCommandError(message, 'SESSION_EXPIRED_BEFORE_COMMAND')
  }
  if (response.status === 403) {
    const message = '当前账号没有执行这次操作的权限；服务器没有提交修改。'
    patchPending(accountKey, pending.commandId, { status: 'pending', lastError: message })
    throw new PreExecutionCommandError(message, 'AUTH_REJECTED_BEFORE_COMMAND')
  }
  removePending(accountKey, pending.commandId)
  throw new PreExecutionCommandError(raw.message, 'COMMAND_REJECTED')
}

async function submitPending(accountKey: string, pending: PendingCommand): Promise<ConnectedCommandResponse> {
  try {
    const { response, payload, lease, local } = await request(accountKey, pending.action === 'command'
      ? {
          action: 'command',
          commandId: pending.commandId,
          baseRevision: pending.baseRevision,
          command: pending.command,
        }
      : {
          action: 'undo',
          commandId: pending.commandId,
          targetCommandId: pending.targetCommandId,
        })

    if (response.status === 409 && payload?.outcome === 'CONFLICT') {
      const result = parseCommandResponse(payload)
      try {
        await projectAuthoritativeResult(accountKey, result, { expectedLocal: local, assertCurrent: lease.assertCurrent })
      } catch {
        // The server conflict remains known even if this browser cannot
        // safely project the latest snapshot yet.
      }
      patchPending(accountKey, pending.commandId, {
        status: 'conflict',
        lastError: payload.conflict?.message ?? 'Authoritative command conflict.',
      })
      return result
    }
    if (!response.ok) {
      if ([400, 401, 403, 404, 405, 422].includes(response.status)) {
        return rejectBeforeExecution(accountKey, pending, response, payload)
      }
      return recoverUnknown(accountKey, pending, serverError(response, payload))
    }

    const result = parseCommandResponse(payload)
    const projected = await projectConfirmedResult(accountKey, pending.commandId, result,
      { expectedLocal: local, assertCurrent: lease.assertCurrent })
    if (projected.localProjection === 'applied' || projected.outcome === 'NO_WRITE') removePending(accountKey, pending.commandId)
    return projected
  } catch (caught) {
    if (caught instanceof PreExecutionCommandError || caught instanceof AccountCacheChangedError
      || caught instanceof ConnectedProjectionPendingError || caught instanceof CommandBlockedByPendingProjectionError) throw caught
    return recoverUnknown(accountKey, pending, caught)
  }
}

function forCaller(result: ConnectedCommandResponse, allowProjectionPending?: boolean) {
  if (result.localProjection === 'pending' && result.outcome !== 'NO_WRITE' && !allowProjectionPending) {
    throw new ConnectedProjectionPendingError()
  }
  return result
}

export async function executeConnectedBusinessCommand(
  accountKey: string,
  command: ConnectedBusinessCommand,
  options: { commandId?: string; baseRevision?: number; allowProjectionPending?: boolean } = {},
) {
  const commandId = options.commandId
    ?? (command.type === 'domain' ? command.value.commandId : createConnectedCommandId(command.type))
  if (command.type === 'domain' && command.value.commandId !== commandId) {
    throw new Error('Connected domain command identity must be stable across client and server.')
  }
  const existing = readPending(accountKey).find((item) => item.commandId === commandId)
  if (existing) {
    if (existing.action !== 'command' || JSON.stringify(existing.command) !== JSON.stringify(command)) {
      throw new Error('原操作内容已变化；为避免重复或错误提交，请先核对待处理操作。')
    }
    return forCaller(await oneCommandFlight(accountKey, commandId, async () => {
      const recovered = await lookupConnectedCommandReceipt(accountKey, commandId)
      if (recovered) {
        if (recovered.localProjection === 'applied') removePending(accountKey, commandId)
        return recovered
      }
      if (existing.status === 'projection_pending') throw new ConnectedProjectionPendingError()
      return submitPending(accountKey, existing)
    }), options.allowProjectionPending)
  }

  const base = options.baseRevision ?? revisionFromCheckpoint(accountKey) ?? await currentRevision(accountKey)
  const timestamp = new Date().toISOString()
  const pending: PendingCommand = {
    commandId,
    action: 'command',
    baseRevision: base,
    command,
    status: 'pending',
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  upsertPending(accountKey, pending)
  return forCaller(await oneCommandFlight(accountKey, commandId, () => submitPending(accountKey, pending)), options.allowProjectionPending)
}

/** Persist user intent before any network request. Requires a verified account cache. */
export async function queueConnectedBusinessCommand(
  accountKey: string,
  command: ConnectedBusinessCommand,
  options: { commandId?: string } = {},
) {
  const commandId = options.commandId
    ?? (command.type === 'domain' ? command.value.commandId : createConnectedCommandId(command.type))
  if (command.type === 'domain' && command.value.commandId !== commandId) {
    throw new Error('Connected domain command identity must be stable across client and server.')
  }
  const lease = captureAccountCacheLease(accountKey)
  const existing = readPending(accountKey).find(item => item.commandId === commandId)
  if (existing) {
    if (existing.action !== 'command' || JSON.stringify(existing.command) !== JSON.stringify(command)) {
      throw new Error('原操作内容已变化；为避免重复或错误提交，请先核对待处理操作。')
    }
    return commandId
  }
  const checkpoint = getAccountCheckpoint(accountKey)
  const baseRevision = revisionFromCheckpoint(accountKey)
  if (getCloudDeviceState().workspaceOwnerUserId !== accountKey
    || baseRevision === undefined || !checkpoint.lastSyncedFingerprint) {
    throw new Error('此账号尚无已核实的本机记录，暂不能离线提交。')
  }
  const local = await exportLocalSnapshot()
  const localFingerprint = await fingerprintWorkspace(local)
  const baseline = checkpoint.lastReadProjectionSourceFingerprint === checkpoint.lastSyncedFingerprint
    ? checkpoint.lastReadProjectionFingerprint ?? checkpoint.lastSyncedFingerprint : checkpoint.lastSyncedFingerprint
  if (localFingerprint !== baseline && localFingerprint !== checkpoint.clearedCacheFingerprint
    && !await isRecordedAccountProjection(accountKey, local)) throw new AccountCacheChangedError()
  lease.assertCurrent()
  await assertLocalSnapshotCurrent(local, lease.assertCurrent)
  lease.assertCurrent()
  const timestamp = new Date().toISOString()
  upsertPending(accountKey, { commandId, action: 'command', command, baseRevision,
    status: 'pending', createdAt: timestamp, updatedAt: timestamp })
  return commandId
}

export async function confirmConnectedCommand(accountKey: string, commandId: string,
  options: { allowProjectionPending?: boolean } = {}): Promise<ConnectedCommandResponse> {
  return forCaller(await oneCommandFlight(accountKey, commandId, async () => {
  try {
    const recovered = await lookupConnectedCommandReceipt(accountKey, commandId)
    if (recovered) {
      if (recovered.localProjection === 'applied') removePending(accountKey, commandId)
      return recovered
    }
  } catch (caught) {
    if (caught instanceof ConnectedProjectionPendingError) throw caught
    throw new UnknownCommandOutcomeError('暂时无法核对服务器回执。原操作仍已保留，请稍后重试。')
  }
  const existing = readPending(accountKey).find((item) => item.commandId === commandId)
  if (existing?.status === 'projection_pending') throw new ConnectedProjectionPendingError()
  if (existing) return submitPending(accountKey, existing)
  throw new UnknownCommandOutcomeError('无法找到原操作记录；未发送新的操作。请在设置中核对账号状态。')
  }), options.allowProjectionPending)
}

export async function undoConnectedBusinessCommand(
  accountKey: string,
  targetCommandId: string,
  options: { commandId?: string } = {},
) {
  const commandId = options.commandId ?? createConnectedCommandId(`undo:${targetCommandId}`)
  const existing = readPending(accountKey).find((item) => item.commandId === commandId)
  if (existing) {
    return forCaller(await oneCommandFlight(accountKey, commandId, async () => {
      const recovered = await lookupConnectedCommandReceipt(accountKey, commandId)
      if (recovered) {
        if (recovered.localProjection === 'applied') removePending(accountKey, commandId)
        return recovered
      }
      if (existing.status === 'projection_pending') throw new ConnectedProjectionPendingError()
      return submitPending(accountKey, existing)
    }))
  }
  const timestamp = new Date().toISOString()
  const pending: PendingCommand = {
    commandId,
    action: 'undo',
    targetCommandId,
    status: 'pending',
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  upsertPending(accountKey, pending)
  return forCaller(await oneCommandFlight(accountKey, commandId, () => submitPending(accountKey, pending)))
}

export async function replayAccountPendingOperations(accountKey: string) {
  // Background refresh can fire after the browser goes offline. Keep every
  // account-bound command intact until a real reconnect triggers recovery.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return []
  const results: ConnectedCommandResponse[] = []
  for (const pending of readPending(accountKey)) {
    if (pending.status === 'conflict') continue
    if (pending.interaction) {
      await (await import('./instantCommandClient.js')).recoverInstantInteraction(accountKey, pending.commandId)
      continue
    }
    const current = readPending(accountKey).find(item => item.commandId === pending.commandId)
    if (!current) continue
    if (current.status === 'projection_pending') {
      const recovered = await lookupConnectedCommandReceipt(accountKey, pending.commandId)
      if (recovered) {
        if (recovered.localProjection === 'applied') removePending(accountKey, pending.commandId)
        clearRecoveredSemanticDraft(accountKey, pending, recovered)
        results.push(recovered)
        notifyRecoveredCommand(pending.commandId, recovered)
      }
      continue
    }
    const result = await oneCommandFlight(accountKey, pending.commandId, async () => {
      const recovered = await lookupConnectedCommandReceipt(accountKey, pending.commandId)
      if (recovered) {
        if (recovered.localProjection === 'applied') removePending(accountKey, pending.commandId)
        return recovered
      }
      return submitPending(accountKey, current)
    })
    clearRecoveredSemanticDraft(accountKey, pending, result)
    results.push(result)
    notifyRecoveredCommand(pending.commandId, result)
  }
  return results
}

function notifyRecoveredCommand(commandId: string, result: ConnectedCommandResponse) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('pjsdas:command-recovered', { detail: {
    commandId, outcome: result.outcome, localProjection: result.localProjection,
    resultStatus: result.result?.status,
    decisionRequestIds: result.result?.decisionRequestIds,
  } }))
}

function clearRecoveredSemanticDraft(accountKey: string, pending: PendingCommand, result: ConnectedCommandResponse) {
  if (result.localProjection !== 'applied') return
  if (pending.action !== 'command' || pending.command?.type !== 'semantic_intake') return
  if (result.outcome !== 'COMMITTED' && result.outcome !== 'ALREADY_APPLIED') return
  if (result.result?.status !== 'APPLIED' && result.result?.status !== 'ALREADY_APPLIED') return
  const originalText = pending.command.value.originalText
  if (readAccountDraft(accountKey, 'tell-pjsdas') === originalText) {
    clearAccountDraft(accountKey, 'tell-pjsdas')
  }
}


/** Immediate interactions use the same account-scoped recovery queue and stable identity. */
export function journalConnectedInteraction(accountKey: string, input: { commandId: string; command?: ConnectedBusinessCommand; targetCommandId?: string; baseRevision: number }) {
  const lease = captureAccountCacheLease(accountKey)
  const checkpoint = getAccountCheckpoint(accountKey)
  if (getCloudDeviceState().workspaceOwnerUserId !== accountKey || !checkpoint.lastSyncedFingerprint
    || checkpoint.localPendingFingerprint || checkpoint.conflict) throw new AccountCacheChangedError()
  lease.assertCurrent()
  const existing = readPending(accountKey).find(item => item.commandId === input.commandId)
  if (existing) throw new Error('This command is already in the durable outbox.')
  const timestamp = new Date().toISOString()
  upsertPending(accountKey, { ...input, action: input.targetCommandId ? 'undo' : 'command', interaction: true,
    status: 'pending', createdAt: timestamp, updatedAt: timestamp })
}
export function settleConnectedInteraction(accountKey: string, commandId: string, status?: PendingCommand['status'], message?: string) {
  if (status) patchPending(accountKey, commandId, { status, lastError: message })
  else removePending(accountKey, commandId)
}
