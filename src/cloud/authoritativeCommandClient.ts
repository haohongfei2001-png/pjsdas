import type { UserDomainCommand } from '../domainCommands.js'
import type { DiscoveryStatusCommand } from '../discoveryStatusCommand.js'
import type { DiscoveryProfile } from '../discoveryProfile.js'
import type { SemanticIntakeObservation } from '../model.js'
import { validateSnapshot, type PJSDASSnapshot } from '../snapshot.js'
import { fetchBackend } from '../backendEndpoints.js'
import { exportLocalSnapshot, replaceLocalSnapshotFromCloud } from '../db.js'
import { getAccountAccessToken } from './cloudClient.js'
import { getAccountCheckpoint, patchAccountCheckpoint } from './syncState.js'
import { fingerprintWorkspace } from './workspaceFingerprint.js'

export type ConnectedBusinessCommand =
  | { type: 'domain'; value: UserDomainCommand }
  | { type: 'semantic_intake'; value: SemanticIntakeObservation }
  | { type: 'resolve_semantic_decision'; value: { requestId: string; choiceId: string } }
  | { type: 'discovery_status'; value: DiscoveryStatusCommand }
  | { type: 'discovery_profile'; value: DiscoveryProfile }
  | { type: 'discovery_promotion'; value: { inboxItemId: string } }

export interface ConnectedCommandResponse {
  outcome: 'COMMITTED' | 'ALREADY_APPLIED' | 'NO_WRITE' | 'CONFLICT'
  revision: number
  workspaceVersion: string
  schemaVersion: number
  snapshot: PJSDASSnapshot
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
  status: 'pending' | 'unknown' | 'conflict'
  createdAt: string
  updatedAt: string
  lastError?: string
}

const PENDING_PREFIX = 'pjsdas-cgr01-pending:'
const DRAFT_PREFIX = 'pjsdas-cgr01-draft:'

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
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
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

async function request(body: Record<string, unknown>) {
  const response = await fetchBackend('/api/workspace', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await getAccountAccessToken()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => undefined) as Record<string, any> | undefined
  return { response, payload }
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

async function currentRevision() {
  const { response, payload } = await request({ action: 'read' })
  if (!response.ok || !payload || !Number.isInteger(payload.revision)) {
    throw new Error(`${payload?.code ?? 'CONNECTED_WORKSPACE_FAILED'}: ${payload?.message ?? `HTTP ${response.status}`}`)
  }
  return Number(payload.revision)
}

async function projectAuthoritativeResult(accountKey: string, result: ConnectedCommandResponse) {
  await replaceLocalSnapshotFromCloud(result.snapshot)
  const fingerprint = await fingerprintWorkspace(result.snapshot)
  const projectedFingerprint = await fingerprintWorkspace(await exportLocalSnapshot())
  patchAccountCheckpoint(accountKey, {
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

class PreExecutionCommandError extends Error {}

export async function lookupConnectedCommandReceipt(accountKey: string, commandId: string) {
  const { response, payload } = await request({ action: 'receipt', commandId })
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
  await projectAuthoritativeResult(accountKey, result)
  return result
}

async function recoverUnknown(accountKey: string, pending: PendingCommand, caught: unknown) {
  try {
    const recovered = await lookupConnectedCommandReceipt(accountKey, pending.commandId)
    if (recovered) {
      removePending(accountKey, pending.commandId)
      return recovered
    }
  } catch {
    // Preserve the unknown-outcome state. A later retry performs the same
    // receipt lookup before reusing the stable command identity.
  }
  const message = caught instanceof Error ? caught.message : String(caught)
  const unknown = `UNKNOWN_COMMAND_OUTCOME: PJSDAS 尚未确认这次操作是否已提交。已保留 commandId ${pending.commandId}，恢复连接后会先查询 receipt，再以同一 commandId 安全重试；请不要重复创建同一操作。原始错误：${message}`
  patchPending(accountKey, pending.commandId, { status: 'unknown', lastError: unknown })
  throw new Error(unknown)
}

function rejectBeforeExecution(accountKey: string, pending: PendingCommand, response: Response, payload?: Record<string, any>): never {
  const raw = serverError(response, payload)
  if (response.status === 401) {
    const message = 'SESSION_EXPIRED_BEFORE_COMMAND: PJSDAS 登录会话已过期；服务端在授权阶段拒绝了本次命令，因此它没有执行。重新登录后会使用同一 commandId 安全重试。'
    patchPending(accountKey, pending.commandId, { status: 'pending', lastError: message })
    throw new PreExecutionCommandError(message)
  }
  if (response.status === 403) {
    const message = `AUTH_REJECTED_BEFORE_COMMAND: 当前身份没有执行这次命令的权限；命令没有提交。原始错误：${raw.message}`
    patchPending(accountKey, pending.commandId, { status: 'pending', lastError: message })
    throw new PreExecutionCommandError(message)
  }
  removePending(accountKey, pending.commandId)
  throw new PreExecutionCommandError(raw.message)
}

async function submitPending(accountKey: string, pending: PendingCommand): Promise<ConnectedCommandResponse> {
  try {
    const { response, payload } = await request(pending.action === 'command'
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
      await projectAuthoritativeResult(accountKey, result)
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
    await projectAuthoritativeResult(accountKey, result)
    removePending(accountKey, pending.commandId)
    return result
  } catch (caught) {
    if (caught instanceof PreExecutionCommandError) throw caught
    return recoverUnknown(accountKey, pending, caught)
  }
}

export async function executeConnectedBusinessCommand(
  accountKey: string,
  command: ConnectedBusinessCommand,
  options: { commandId?: string; baseRevision?: number } = {},
) {
  const commandId = options.commandId
    ?? (command.type === 'domain' ? command.value.commandId : createConnectedCommandId(command.type))
  if (command.type === 'domain' && command.value.commandId !== commandId) {
    throw new Error('Connected domain command identity must be stable across client and server.')
  }
  const existing = readPending(accountKey).find((item) => item.commandId === commandId)
  if (existing) {
    const recovered = await lookupConnectedCommandReceipt(accountKey, commandId)
    if (recovered) {
      removePending(accountKey, commandId)
      return recovered
    }
    return submitPending(accountKey, existing)
  }

  const base = options.baseRevision ?? revisionFromCheckpoint(accountKey) ?? await currentRevision()
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
  return submitPending(accountKey, pending)
}

export async function confirmConnectedCommand(accountKey: string, commandId: string): Promise<ConnectedCommandResponse> {
  try {
    const recovered = await lookupConnectedCommandReceipt(accountKey, commandId)
    if (recovered) {
      removePending(accountKey, commandId)
      return recovered
    }
  } catch (caught) {
    const detail = caught instanceof Error ? caught.message : String(caught)
    throw new Error(`UNKNOWN_COMMAND_OUTCOME: receipt lookup failed for ${commandId}: ${detail}`)
  }
  const existing = readPending(accountKey).find((item) => item.commandId === commandId)
  if (existing) return submitPending(accountKey, existing)
  throw new Error(`UNKNOWN_COMMAND_OUTCOME: original command ${commandId} is unavailable; no new command was sent.`)
}

export async function undoConnectedBusinessCommand(
  accountKey: string,
  targetCommandId: string,
  options: { commandId?: string } = {},
) {
  const commandId = options.commandId ?? createConnectedCommandId(`undo:${targetCommandId}`)
  const existing = readPending(accountKey).find((item) => item.commandId === commandId)
  if (existing) return submitPending(accountKey, existing)
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
  return submitPending(accountKey, pending)
}

export async function replayAccountPendingOperations(accountKey: string) {
  const results: ConnectedCommandResponse[] = []
  for (const pending of readPending(accountKey)) {
    if (pending.status === 'conflict') continue
    const recovered = await lookupConnectedCommandReceipt(accountKey, pending.commandId)
    if (recovered) {
      removePending(accountKey, pending.commandId)
      clearRecoveredSemanticDraft(accountKey, pending, recovered)
      results.push(recovered)
      continue
    }
    const result = await submitPending(accountKey, pending)
    clearRecoveredSemanticDraft(accountKey, pending, result)
    results.push(result)
  }
  return results
}

function clearRecoveredSemanticDraft(accountKey: string, pending: PendingCommand, result: ConnectedCommandResponse) {
  if (pending.action !== 'command' || pending.command?.type !== 'semantic_intake') return
  if (result.outcome !== 'COMMITTED' && result.outcome !== 'ALREADY_APPLIED') return
  if (result.result?.status !== 'APPLIED' && result.result?.status !== 'ALREADY_APPLIED') return
  const originalText = pending.command.value.originalText
  if (readAccountDraft(accountKey, 'tell-pjsdas') === originalText) {
    clearAccountDraft(accountKey, 'tell-pjsdas')
  }
}
