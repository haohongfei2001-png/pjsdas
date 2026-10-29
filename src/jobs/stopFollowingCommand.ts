import { captureWorkspaceWriteLease } from '../cloud/workspaceWriteLease.js'
import {
  clearAccountDraft, confirmConnectedCommand, createConnectedCommandId,
  executeConnectedBusinessCommand, listAccountPendingOperations, lookupConnectedCommandReceipt,
  PreExecutionCommandError, queueConnectedBusinessCommand, readAccountDraft,
  saveAccountDraft, undoConnectedBusinessCommand, type ConnectedCommandResponse,
} from '../cloud/authoritativeCommandClient.js'

// A bounded locator, not a command journal, receipt, compensation or authority.
// The existing account outbox owns submission and automatic recovery. Retaining
// this locator lets the detail find the original receipt after that outbox clears.
interface StopReference { version: 1; opportunityId: string; commandId: string; undoCommandId?: string }
export interface StopFollowingState {
  status: 'idle' | 'pending' | 'conflict' | 'confirmed' | 'undone' | 'no_write' | 'projection_pending'
  commandId?: string
  undoAvailable?: boolean
  undoPending?: boolean
  automaticRecovery?: boolean
  currentAbandoned?: boolean
}
const flights = new Map<string, Promise<StopFollowingState>>()
const name = (id: string) => `stop-following:${id}`
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512

function readReference(account: string, opportunityId: string): StopReference | undefined {
  const raw = readAccountDraft(account, name(opportunityId))
  if (!raw) return undefined
  let value: StopReference
  try { value = JSON.parse(raw) } catch { throw new Error('STOP_REFERENCE_INVALID: 原操作记录无法读取；没有发送新操作。') }
  if (!value || value.version !== 1 || value.opportunityId !== opportunityId || !validId(value.commandId)
    || (value.undoCommandId !== undefined && (!validId(value.undoCommandId) || value.undoCommandId === value.commandId))
    || Object.keys(value).some(key => !['version', 'opportunityId', 'commandId', 'undoCommandId'].includes(key))) {
    throw new Error('STOP_REFERENCE_INVALID: 原操作记录版本或目标不匹配；没有发送新操作。')
  }
  return value
}
function assertReference(account: string, ref: StopReference) {
  if (JSON.stringify(readReference(account, ref.opportunityId)) !== JSON.stringify(ref)) throw new Error('STOP_REFERENCE_CHANGED: 原操作记录已在另一页面变化；请重新核对。')
}
function saveReference(account: string, value: StopReference) {
  // A denied/quota-full store is not permission to submit an unremembered command.
  if (typeof window === 'undefined') throw new Error('STOP_REFERENCE_UNAVAILABLE')
  saveAccountDraft(account, name(value.opportunityId), JSON.stringify(value))
  if (readAccountDraft(account, name(value.opportunityId)) !== JSON.stringify(value)) throw new Error('STOP_REFERENCE_UNAVAILABLE')
}
function pendingFor(account: string, ref: StopReference, undo = false) {
  const id = undo ? ref.undoCommandId : ref.commandId
  const pending = listAccountPendingOperations(account).find(item => item.commandId === id)
  if (pending && (undo ? pending.action !== 'undo' || pending.targetCommandId !== ref.commandId
    : pending.action !== 'command' || pending.command?.type !== 'domain'
      || pending.command.value.kind !== 'abandon_opportunity' || pending.command.value.opportunityId !== ref.opportunityId
      || pending.command.value.commandId !== ref.commandId)) throw new Error('STOP_REFERENCE_MISMATCH: 原操作身份不匹配。')
  return pending
}
function checkedResult(account: string, ref: StopReference, result: ConnectedCommandResponse, undo = false): StopFollowingState {
  if (result.outcome === 'CONFLICT') return { status: 'conflict', commandId: ref.commandId }
  if (!result.receipt) return { status: 'no_write', commandId: ref.commandId }
  const receipt = result.receipt
  if (receipt.commandId !== (undo ? ref.undoCommandId : ref.commandId) || receipt.status !== 'COMMITTED'
    || receipt.operation !== (undo ? 'undo_command' : 'domain:abandon_opportunity')
    || (undo ? receipt.undoOf !== ref.commandId : !Array.isArray(receipt.affectedObjects)
      || !receipt.affectedObjects.some((item: { type?: unknown; id?: unknown }) => item?.type === 'opportunity' && item.id === ref.opportunityId))) {
    throw new Error('STOP_RECEIPT_MISMATCH: 回执与原岗位操作不匹配。')
  }
  if (result.localProjection !== 'applied') return { status: 'projection_pending', commandId: ref.commandId, undoPending: undo, automaticRecovery: Boolean(pendingFor(account, ref, undo)) }
  const current = result.snapshot?.data.opportunities.find(item => item.id === ref.opportunityId)
  return { status: undo ? 'undone' : 'confirmed', commandId: ref.commandId, undoAvailable: !undo && receipt.undoAvailable === true,
    ...(current ? { currentAbandoned: current.participationStatus === 'abandoned' } : {}) }
}
async function inspect(account: string, ref: StopReference, assertCurrent: () => void): Promise<StopFollowingState> {
  const undo = Boolean(ref.undoCommandId)
  const pending = pendingFor(account, ref, undo)
  const result = await lookupConnectedCommandReceipt(account, ref.undoCommandId ?? ref.commandId)
  assertCurrent()
  assertReference(account, ref)
  if (result) return checkedResult(account, ref, result, undo)
  return { status: pending?.status === 'conflict' || pending?.status === 'rollback_pending' ? 'conflict' : pending?.status === 'projection_pending' ? 'projection_pending' : 'pending', commandId: ref.commandId, undoPending: undo, automaticRecovery: Boolean(pending) }
}

/** Local presentation only. A locator never grants Undo or proves submission. */
export function retainedStopFollowing(account: string, opportunityId: string): StopFollowingState {
  const ref = readReference(account, opportunityId)
  if (!ref) return { status: 'idle' }
  const pending = pendingFor(account, ref, Boolean(ref.undoCommandId))
  return { status: pending?.status === 'conflict' || pending?.status === 'rollback_pending' ? 'conflict' : pending?.status === 'projection_pending' ? 'projection_pending' : 'pending', commandId: ref.commandId, undoPending: Boolean(ref.undoCommandId), automaticRecovery: Boolean(pending) }
}

/** Mount/reload and background notifications are receipt-only, never resubmission. */
export async function inspectStopFollowing(account: string, opportunityId: string): Promise<StopFollowingState> {
  const lease = captureWorkspaceWriteLease(account)
  const ref = readReference(account, opportunityId)
  if (!ref) return { status: 'idle' }
  return inspect(account, ref, lease.assertCurrent)
}
function oneFlight(account: string, opportunityId: string, run: () => Promise<StopFollowingState>) {
  const key = `${account}\u0000${opportunityId}`
  const active = flights.get(key)
  if (active) return active
  // Shared across tabs, unlike the in-memory flight map. No silent unsafe
  // fallback if this browser cannot coordinate durable receipt locators.
  if (typeof navigator === 'undefined' || !navigator.locks?.request) throw new Error('STOP_LOCK_UNAVAILABLE: 当前浏览器不能安全协调此操作，请使用“告诉 TodayAction”。')
  const flight = Promise.resolve(navigator.locks.request(`todayaction:stop-following:${key}`, run))
  flights.set(key, flight)
  void flight.finally(() => { if (flights.get(key) === flight) flights.delete(key) }).catch(() => undefined)
  return flight
}
function retainUnlessKnownRejected(account: string, ref: StopReference, error: unknown) {
  // Generic terminal/permission/unknown/conflict pending records stay recoverable.
  if (error instanceof PreExecutionCommandError && error.code === 'COMMAND_REJECTED'
    && !listAccountPendingOperations(account).some(item => item.commandId === (ref.undoCommandId ?? ref.commandId))
    && JSON.stringify(readReference(account, ref.opportunityId)) === JSON.stringify(ref)) {
    // A rejected Undo must not erase the still-owned original receipt locator.
    if (ref.undoCommandId) saveReference(account, { version: 1, opportunityId: ref.opportunityId, commandId: ref.commandId })
    else clearAccountDraft(account, name(ref.opportunityId))
  }
}

export async function stopFollowing(account: string, opportunityId: string, options: { newDecision?: boolean } = {}): Promise<StopFollowingState> {
  const lease = captureWorkspaceWriteLease(account)
  const result = await oneFlight(account, opportunityId, async () => {
    lease.assertCurrent()
    let ref = readReference(account, opportunityId)
    if (ref) {
      const state = await inspect(account, ref, lease.assertCurrent)
      if (state.status === 'confirmed' && options.newDecision && state.currentAbandoned === false && !ref.undoCommandId) ref = undefined
      else {
        if (state.status === 'confirmed' || state.status === 'projection_pending' || state.status === 'conflict' || (ref.undoCommandId && state.status !== 'undone')) return state
        if (state.status === 'undone') ref = undefined
      }
    }
    if (!ref) {
      const existing = listAccountPendingOperations(account).filter(item => item.action === 'command'
        && item.command?.type === 'domain' && item.command.value.kind === 'abandon_opportunity'
        && item.command.value.opportunityId === opportunityId)
      if (existing.length > 1) throw new Error('STOP_REFERENCE_AMBIGUOUS: 请先核对原操作。')
      ref = { version: 1, opportunityId, commandId: existing[0]?.commandId ?? createConnectedCommandId('stop-following') }
      lease.assertCurrent()
      saveReference(account, ref)
    }
    const pending = pendingFor(account, ref)
    if (pending?.status === 'conflict' || pending?.status === 'rollback_pending') return { status: 'conflict', commandId: ref.commandId }
    const command = { type: 'domain' as const, value: { commandId: ref.commandId, kind: 'abandon_opportunity' as const, opportunityId } }
    try {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        await queueConnectedBusinessCommand(account, command, { commandId: ref.commandId })
        lease.assertCurrent(); assertReference(account, ref)
        return { status: 'pending', commandId: ref.commandId, automaticRecovery: true }
      }
      const response = pending ? await confirmConnectedCommand(account, ref.commandId)
        : await executeConnectedBusinessCommand(account, command, { commandId: ref.commandId })
      lease.assertCurrent(); assertReference(account, ref)
      return checkedResult(account, ref, response)
    } catch (error) { lease.assertCurrent(); retainUnlessKnownRejected(account, ref, error); throw error }
  })
  lease.assertCurrent()
  return result
}

export async function undoStopFollowing(account: string, opportunityId: string): Promise<StopFollowingState> {
  const lease = captureWorkspaceWriteLease(account)
  const result = await oneFlight(account, opportunityId, async () => {
    lease.assertCurrent()
    let ref = readReference(account, opportunityId)
    if (!ref) throw new Error('STOP_RECEIPT_REQUIRED: 无法找到原回执；未发送撤销。')
    if (ref.undoCommandId) {
      const state = await inspect(account, ref, lease.assertCurrent)
      if (state.status === 'undone' || state.status === 'projection_pending' || state.status === 'conflict') return state
    } else {
      const original = await inspect(account, ref, lease.assertCurrent)
      if (original.status !== 'confirmed' || !original.undoAvailable) return original
      const pending = listAccountPendingOperations(account).filter(item => item.action === 'undo' && item.targetCommandId === ref!.commandId)
      if (pending.length > 1) throw new Error('STOP_REFERENCE_AMBIGUOUS: 请先核对原撤销。')
      ref = { ...ref, undoCommandId: pending[0]?.commandId ?? createConnectedCommandId(`undo:${ref.commandId}`) }
      lease.assertCurrent()
      saveReference(account, ref)
    }
    const pending = pendingFor(account, ref, true)
    if (pending?.status === 'conflict' || pending?.status === 'rollback_pending') return { status: 'conflict', commandId: ref.commandId }
    try {
      const response = await undoConnectedBusinessCommand(account, ref.commandId, { commandId: ref.undoCommandId })
      lease.assertCurrent(); assertReference(account, ref)
      return checkedResult(account, ref, response, true)
    } catch (error) { lease.assertCurrent(); retainUnlessKnownRejected(account, ref, error); throw error }
  })
  lease.assertCurrent()
  return result
}
