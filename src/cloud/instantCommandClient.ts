import { markInteractionActivity } from './interactionActivity.js'
import { fingerprintWorkspace, workspaceIsEffectivelyEmpty } from './workspaceFingerprint.js'
import { interactionMetric } from './interactionMetrics.js'
import type { UserDomainCommand } from '../domainCommands.js'
import type { PJSDASSnapshot } from '../snapshot.js'
import { exportLocalSnapshot, isRecordedAccountProjection, replaceLocalSnapshotFromCloud, persistInteractionProjections, persistInteractionProjection, readPendingCommandInteractions, readCommandInteraction, saveCommandInteraction, type CommandInteractionRecord } from '../db.js'
import { fetchBackend } from '../backendEndpoints.js'
import { getAccountAccessToken } from './cloudClient.js'
import { AccountCacheChangedError, captureAccountCacheLease } from './accountCacheLease.js'
import { getAccountCheckpoint, patchAccountCheckpoint } from './syncState.js'
import { interactionProjection, undoInteractionProjection } from './interactionProjection.js'
import { createConnectedCommandId, journalConnectedInteraction, enrichConnectedInteraction, settleConnectedInteraction, listAccountPendingOperations } from './authoritativeCommandClient.js'
import { DELTA_COLLECTIONS, reverseWorkspaceDelta, validateWorkspaceDelta, patchDeltaRow, sameValue, type WorkspaceDelta, type EntityDelta } from '../workspaceDelta.js'

const flights = new Map<string, Promise<void>>()
const tails = new Map<string, Promise<void>>()
// A synchronous reservation is intentionally visible before its IDB journal.
// Only this live caller owns that gap; crash recovery is for a later realm.
const localPreparations = new Set<string>()
const preparedDispatches = new Map<string, CommandInteractionRecord>()
function schedulePreparedDispatch(record: CommandInteractionRecord) {
  // Local settlement is complete. A paused/throttled timer must not keep the
  // operation marked as preparing or block an explicit reconnect/recovery.
  preparedDispatches.set(record.id, record)
  localPreparations.delete(record.id)
  setTimeout(() => {
    if (preparedDispatches.get(record.id) !== record) return
    preparedDispatches.delete(record.id)
    if (navigator.onLine) void dispatch(record).catch(() => undefined)
  }, 0)
}
export interface InteractionEvent { accountKey: string; commandId: string; delta?: WorkspaceDelta; state: CommandInteractionRecord['state']; message?: string }
function emit(record: CommandInteractionRecord, delta?: WorkspaceDelta, message?: string) {
  markInteractionActivity(record.accountKey)
  window.dispatchEvent(new CustomEvent<InteractionEvent>('pjsdas:interaction', { detail: {
    accountKey: record.accountKey, commandId: record.commandId, delta, state: record.state, message,
  } }))
}
const recordId = (accountKey: string, commandId: string) => `${accountKey}:${commandId}`
const version = (accountKey: string) => Number(/^txn:(\d+)$/.exec(getAccountCheckpoint(accountKey).lastSyncedVersion ?? '')?.[1])
function dispatch(record: CommandInteractionRecord, recovery = false) {
  const active = flights.get(record.id)
  if (active) return active
  preparedDispatches.delete(record.id)
  const flight = (tails.get(record.accountKey) ?? Promise.resolve()).catch(() => undefined).then(() => send(record, recovery))
  flights.set(record.id, flight)
  tails.set(record.accountKey, flight)
  void flight.finally(() => { flights.delete(record.id); if (tails.get(record.accountKey) === flight) tails.delete(record.accountKey) }).catch(() => undefined)
  return flight
}
function orderInteractions(records: CommandInteractionRecord[]) {
  const ordered: CommandInteractionRecord[] = []
  const remaining = [...records].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.commandId.localeCompare(b.commandId))
  while (remaining.length) {
    const index = remaining.findIndex(item => !remaining.some(other => item.predecessors?.includes(other.commandId)))
    if (index < 0) throw new Error('Invalid interaction dependency cycle.')
    ordered.push(...remaining.splice(index, 1))
  }
  return ordered
}
function dependentInteractions(records: CommandInteractionRecord[], root: string) {
  const ids = new Set([root])
  const dependents: CommandInteractionRecord[] = []
  let changed = true
  while (changed) {
    changed = false
    for (const item of records) if (['active', 'projection_pending', 'rollback_pending'].includes(item.state) && !ids.has(item.commandId)
      && item.predecessors?.some(id => ids.has(id))) {
      ids.add(item.commandId); dependents.push(item); changed = true
    }
  }
  return orderInteractions(dependents)
}
function releaseIndependentQuarantine(accountKey: string, roots: Set<string>, retired: Set<string>) {
  for (const pending of listAccountPendingOperations(accountKey)) if (pending.rejectionRoot && roots.has(pending.rejectionRoot) && !retired.has(pending.commandId)) {
    // Only pause disposition changes. Original IDs and owned local overlays
    // remain durable; the next attempt must recover receipts before sending.
    settleConnectedInteraction(accountKey, pending.commandId, 'unknown')
  }
}
function advanceConfirmedCheckpoint(record: CommandInteractionRecord) {
  // The entity transaction and its confirmed journal can commit before the
  // localStorage checkpoint. Recover that exact adjacent revision only; a
  // larger gap still requires the existing authoritative read path. A no-op
  // observation never proves that its revision's other facts were installed.
  const lease = captureAccountCacheLease(record.accountKey)
  if (record.state === 'confirmed' && record.noOpRevision === undefined && record.delta.baseRevision === version(record.accountKey)
    && record.serverRevision === record.delta.baseRevision + 1) {
    lease.assertCurrent()
    patchAccountCheckpoint(record.accountKey, { lastSyncedVersion: `txn:${record.serverRevision}`,
      lastSyncedAt: new Date().toISOString(), lastError: undefined })
  }
}
async function reconcileTerminalJournal(record: CommandInteractionRecord) {
  if (!['confirmed', 'rejected', 'conflict'].includes(record.state)) return false
  const lease = captureAccountCacheLease(record.accountKey)
  const mirrors = listAccountPendingOperations(record.accountKey)
  const related = record.state !== 'confirmed' ? mirrors.filter(item => item.rejectionRoot === record.commandId && item.commandId !== record.commandId) : []
  const journals = await Promise.all(related.map(item => readCommandInteraction(record.accountKey, item.commandId)))
  lease.assertCurrent()
  const retired = new Set<string>()
  for (const journal of [record, ...journals]) if (journal && ['confirmed', 'rejected', 'conflict'].includes(journal.state)) {
    retired.add(journal.commandId)
    if (journal.state === 'confirmed') advanceConfirmedCheckpoint(journal)
    settleConnectedInteraction(record.accountKey, journal.commandId, journal.state === 'conflict' ? 'conflict' : undefined)
  }
  if (record.state !== 'confirmed') releaseIndependentQuarantine(record.accountKey, new Set([record.commandId]), retired)
  emit(record)
  return true
}
async function archiveFailedPreparation(record: CommandInteractionRecord) {
  try {
    await saveCommandInteraction({ ...record, state: 'rejected', lastError: 'Local projection refused.' })
    settleConnectedInteraction(record.accountKey, record.commandId)
  } catch {
    settleConnectedInteraction(record.accountKey, record.commandId, 'conflict', '本机保存失败，原操作记录已保留。')
  }
}
/** Resolves after durable local settlement, never after the network round trip. */
export async function beginInstantCommand(accountKey: string, snapshot: PJSDASSnapshot, command: UserDomainCommand) {
  const started = performance.now()
  markInteractionActivity(accountKey)
  const lease = captureAccountCacheLease(accountKey)
  const baseRevision = version(accountKey)
  if (!Number.isSafeInteger(baseRevision)) throw new Error('请先连接并读取账号记录。')
  const projected = interactionProjection(snapshot, command, baseRevision)
  interactionMetric('instant-projection', started)
  const journalStarted = performance.now()
  // Reserve durable intent before the first async yield so a background full
  // refresh cannot start fingerprinting while this click is settling.
  const mirroredPredecessors = listAccountPendingOperations(accountKey).filter(item => item.interaction && item.status !== 'conflict' && item.interactionDelta?.changes.some(left => projected.delta.changes.some(right => left.collection === right.collection && left.id === right.id))).map(item => item.commandId)
  localPreparations.add(recordId(accountKey, command.commandId))
  try { journalConnectedInteraction(accountKey, { commandId: command.commandId, command: { type: 'domain', value: command }, baseRevision,
    interactionDelta: projected.delta, interactionCompensation: projected.compensation, interactionPredecessors: mirroredPredecessors }) }
  catch (error) { localPreparations.delete(recordId(accountKey, command.commandId)); throw error }
  const record: CommandInteractionRecord = { id: recordId(accountKey, command.commandId), accountKey, commandId: command.commandId,
    command, predecessors: mirroredPredecessors, delta: projected.delta, compensation: projected.compensation, state: 'active', createdAt: new Date().toISOString() }
  try {
    interactionMetric('instant-journal', journalStarted)
    const pendingReadStarted = performance.now()
    const existing = await readPendingCommandInteractions(accountKey)
    interactionMetric('instant-pending-read', pendingReadStarted)
    const predecessorsStarted = performance.now()
    record.predecessors = [...new Set([...mirroredPredecessors, ...existing.filter(item => ['active', 'projection_pending', 'rollback_pending'].includes(item.state) && item.delta.changes.some(left => projected.delta.changes.some(right => left.collection === right.collection && left.id === right.id)
      || (['set_date_capacity', 'set_daily_capacity', 'set_work_windows'].includes(command.kind) && left.collection === 'timePlanning'))).map(item => item.commandId)])]
    enrichConnectedInteraction(accountKey, command.commandId, { interactionDelta: record.delta, interactionCompensation: record.compensation, interactionPredecessors: record.predecessors })
    interactionMetric('instant-predecessors', predecessorsStarted)
    await persistInteractionProjection(record, lease.assertCurrent)
  } catch (error) {
    try { await archiveFailedPreparation(record) } finally { localPreparations.delete(record.id) }
    throw new Error('本机没能保存这次修改，尚未提交，请核对最新内容后重试。')
  }
  // Let the UI paint before starting auth or any remote work. Scheduling in
  // finally also releases the live marker if optional UI instrumentation fails.
  try { interactionMetric('durable-outbox', started); emit(record, record.delta) }
  finally { schedulePreparedDispatch(record) }
  return record.commandId
}
export async function beginInstantUndo(accountKey: string, targetCommandId: string, snapshot: PJSDASSnapshot) {
  const started = performance.now()
  markInteractionActivity(accountKey)
  const lease = captureAccountCacheLease(accountKey)
  const commandId = createConnectedCommandId('instant-undo')
  localPreparations.add(recordId(accountKey, commandId))
  try { journalConnectedInteraction(accountKey, { commandId, targetCommandId, baseRevision: version(accountKey), interactionPredecessors: [targetCommandId] }) }
  catch (error) { localPreparations.delete(recordId(accountKey, commandId)); throw error }
  let record: CommandInteractionRecord = { id: recordId(accountKey, commandId), commandId, accountKey, targetCommandId, predecessors: [targetCommandId],
    delta: { contract: 'delta-v1', baseRevision: version(accountKey), changes: [] }, state: 'active', createdAt: new Date().toISOString() }
  try {
    const target = await readCommandInteraction(accountKey, targetCommandId)
    if (!target || !['active', 'confirmed'].includes(target.state)) throw new Error('这次操作无法安全撤销，请核对最新记录。')
    record = { id: recordId(accountKey, commandId), commandId, accountKey, targetCommandId,
      predecessors: [targetCommandId], delta: undoInteractionProjection(snapshot, target.command, target.compensation, target.delta, version(accountKey)), state: 'active', createdAt: new Date().toISOString() }
    enrichConnectedInteraction(accountKey, commandId, { interactionDelta: record.delta, interactionPredecessors: record.predecessors })
    await persistInteractionProjection(record, lease.assertCurrent)
  } catch (error) { try { await archiveFailedPreparation(record) } finally { localPreparations.delete(record.id) }; throw error }
  try { interactionMetric('durable-outbox', started); emit(record, record.delta) }
  finally { schedulePreparedDispatch(record) }
  return commandId
}
async function network(accountKey: string, body: Record<string, unknown>) {
  const lease = captureAccountCacheLease(accountKey)
  const token = await getAccountAccessToken(accountKey)
  lease.assertCurrent()
  const start = performance.now()
  const response = await fetchBackend('/api/workspace', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ projection: 'delta-v1', ...body }) })
  const payload = await response.json()
  const serverMs = Number(/workspace;dur=([\d.]+)/.exec(response.headers.get('server-timing') ?? '')?.[1])
  interactionMetric('network-confirmation', start, { ...(Number.isFinite(serverMs) ? { serverExecutionMs: serverMs } : {}), payloadBytes: new TextEncoder().encode(JSON.stringify(payload)).byteLength })
  lease.assertCurrent()
  return { response, payload, lease }
}
async function reject(record: CommandInteractionRecord, message: string, state: 'rejected' | 'conflict') {
  let all: CommandInteractionRecord[] | undefined
  let rollbackCommitted = false
  let steps: Array<{ record: CommandInteractionRecord; delta: WorkspaceDelta }> = []
  try {
    const lease = captureAccountCacheLease(record.accountKey)
    all = await readPendingCommandInteractions(record.accountKey)
    steps = await Promise.all([...dependentInteractions(all, record.commandId).reverse(), record].map(async item => {
      const confirmed = (await Promise.all((item.predecessors ?? []).map(id => readCommandInteraction(item.accountKey, id))))
        .filter((prior): prior is CommandInteractionRecord => prior?.state === 'confirmed')
      const rollback = reverseWorkspaceDelta(item.delta)
      // Roll back to the proven authoritative predecessor, rather than an
      // earlier optimistic clock or source field captured before its receipt.
      rollback.changes = rollback.changes.map(change => {
        if (!change.after) return change
        const after = { ...change.after }
        for (const prior of orderInteractions(confirmed)) {
          const accepted = prior.delta.changes.find(candidate => candidate.collection === change.collection && candidate.id === change.id)
          if (accepted?.after) for (const key of Object.keys(after)) {
            if (key in accepted.after) after[key] = accepted.after[key]
            else if (accepted.before && key in accepted.before) delete after[key]
          }
        }
        return { ...change, after }
      })
      return { record: { ...item, state: (item.commandId === record.commandId ? state : 'rejected') as 'rejected' | 'conflict', lastError: message }, delta: rollback }
    }))
    await persistInteractionProjections(steps, lease.assertCurrent)
    rollbackCommitted = true
    for (const step of steps) emit(step.record, step.delta, message)
    for (const step of steps) {
      settleConnectedInteraction(record.accountKey, step.record.commandId, step.record.state === 'conflict' ? 'conflict' : undefined, message)
    }
    const retired = new Set(steps.map(step => step.record.commandId))
    releaseIndependentQuarantine(record.accountKey, new Set([record.commandId]), retired)
  } catch {
    if (rollbackCommitted) {
      // The exact inverse and terminal journals already committed atomically.
      // Metadata cleanup must never turn them into another rollback obligation.
      for (const step of steps) try {
        settleConnectedInteraction(record.accountKey, step.record.commandId, step.record.state === 'conflict' ? 'conflict' : undefined, message)
      } catch { /* Recovery reconciles the remaining mirror from its terminal journal. */ }
      try { releaseIndependentQuarantine(record.accountKey, new Set([record.commandId]), new Set(steps.map(step => step.record.commandId))) } catch { /* Retain the account-scoped mirror for recovery. */ }
      emit({ ...record, state }, undefined, '这次修改未被接受，已恢复本机状态；同步状态稍后核对。')
      return
    }
    // A known rejection cannot become an unknown outcome if local rollback or
    // archival fails. Close the durable mirror first, including potential
    // dependents when their journal cannot be read; retain every original intent.
    const blocked = steps.length ? steps.map(step => step.record) : all ? [...dependentInteractions(all, record.commandId), record] : [record]
    const ids = steps.length ? blocked.map(item => item.commandId)
      : listAccountPendingOperations(record.accountKey).filter(item => item.interaction).map(item => item.commandId)
    for (const commandId of new Set([record.commandId, ...ids])) settleConnectedInteraction(record.accountKey, commandId, 'rollback_pending', message, record.commandId)
    for (const item of blocked) {
      try { await saveCommandInteraction({ ...item, state: 'rollback_pending', lastError: message }) } catch { /* The closed mirror retains the original command. */ }
    }
    emit({ ...record, state: 'conflict' }, undefined, '这次修改未被接受，本机状态待核对；请打开设置安全刷新。')
  }
}
function rebaseDelta(delta: WorkspaceDelta, confirmed: CommandInteractionRecord[]): WorkspaceDelta {
  return { ...delta, changes: delta.changes.map(change => {
    if (!change.before) return change
    if (!change.after) {
      let before = { ...change.before }
      for (const prior of orderInteractions(confirmed)) {
        const accepted = prior.delta.changes.find(item => item.collection === change.collection && item.id === change.id)
        if (accepted?.after) before = patchDeltaRow(before, accepted, false)!
      }
      return { ...change, before }
    }
    const before = { ...change.before }, after = { ...change.after }
    for (const prior of orderInteractions(confirmed)) {
      const accepted = prior.delta.changes.find(item => item.collection === change.collection && item.id === change.id)
      if (!accepted?.after) continue
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (key === 'id') continue
        const unchanged = !(key in before) === !(key in after) && sameValue(before[key], after[key])
        if (key in accepted.after) before[key] = accepted.after[key]
        else if (accepted.before && key in accepted.before) delete before[key]
        if (unchanged) { if (key in before) after[key] = before[key]; else delete after[key] }
      }
    }
    return { ...change, before, after }
  }) }
}
function bindProjectionPostimages(record: CommandInteractionRecord, snapshot: PJSDASSnapshot, receiptless = false): WorkspaceDelta {
  return { ...record.delta, changes: record.delta.changes.filter(change => !receiptless || change.collection !== 'timeline').map(change => {
    const data = snapshot.data[change.collection]
    const current = (DELTA_COLLECTIONS as readonly string[]).includes(change.collection)
      ? (data as Array<Record<string, unknown>> | undefined)?.find(row => row.id === change.id) ?? null : data ?? null
    if (!change.after) { if (current) throw new Error('Receipt deletion postimage mismatch'); return change }
    if (!current) throw new Error('Receipt object postimage missing')
    const after = !change.before ? current : Object.fromEntries([...new Set([...Object.keys(change.before), ...Object.keys(change.after)])]
      .filter(key => key in current).map(key => [key, (current as Record<string, unknown>)[key]]))
    return { ...change, after: after as Record<string, unknown> }
  }) }
}
// A legacy full reply can bind owned postimages only when its snapshot is
// exactly the receipt revision. A later current snapshot cannot prove what
// this command changed; preserve the original guard rather than adopt edits.
function receiptDelta(record: CommandInteractionRecord, payload: any): WorkspaceDelta {
  if (payload.delta || payload.receipt?.projectionDelta) return payload.delta ?? payload.receipt.projectionDelta
  if (!payload.snapshot || payload.receipt?.commandId !== record.commandId || payload.receipt?.revision !== payload.revision) return record.delta
  return bindProjectionPostimages(record, payload.snapshot)
}

async function recoverAuthoritativeProjection(accountKey: string, expectedLocal: PJSDASSnapshot, supplied?: { record: CommandInteractionRecord; payload: any }) {
  const lease = captureAccountCacheLease(accountKey)
  const mirrors = listAccountPendingOperations(accountKey)
  const reservationIds = mirrors.map(item => item.commandId).sort().join('|')
  const cleared = workspaceIsEffectivelyEmpty(expectedLocal)
    && getAccountCheckpoint(accountKey).clearedCacheFingerprint === await fingerprintWorkspace(expectedLocal)
  if (!cleared && !await isRecordedAccountProjection(accountKey, expectedLocal)) throw new AccountCacheChangedError()
  const records = await readPendingCommandInteractions(accountKey)
  if (supplied && !records.some(item => item.commandId === supplied.record.commandId)) records.push(supplied.record)
  // Read receipts before replaying any retained overlay. A full snapshot must
  // include every confirmed receipt; absent receipts preserve original intent.
  const receipts = new Map<string, any>()
  for (const item of records) {
    if (supplied?.record.commandId === item.commandId && ['COMMITTED', 'ALREADY_APPLIED'].includes(supplied.payload.outcome)) receipts.set(item.commandId, supplied.payload)
    else {
      const read = await network(accountKey, { action: 'receipt', commandId: item.commandId })
      if (!read.response.ok) throw new Error('暂时无法核对操作回执；原操作已保留。')
      if (read.payload.found) receipts.set(item.commandId, read.payload)
      else if (item.noOpRevision !== undefined) receipts.set(item.commandId, { outcome: 'ALREADY_APPLIED', revision: item.noOpRevision })
      else if (supplied?.record.commandId === item.commandId) receipts.set(item.commandId, supplied.payload)
    }
  }
  const read = await network(accountKey, { action: 'read', projection: 'snapshot' })
  if (!read.response.ok || !read.payload.snapshot) throw new Error('暂时无法读取账号记录；原操作已保留。')
  const remote = read.payload
  const assertCurrent = () => {
    lease.assertCurrent(); read.lease.assertCurrent()
    if (version(accountKey) > remote.revision || reservationIds !== listAccountPendingOperations(accountKey).map(item => item.commandId).sort().join('|')) throw new AccountCacheChangedError()
  }
  assertCurrent()
  if ([...receipts.values()].some(payload => Number(payload.receipt?.revision ?? payload.revision) > remote.revision)) throw new AccountCacheChangedError()
  const staleNoOps = new Set<string>()
  const confirmed: CommandInteractionRecord[] = []
  for (const item of records.filter(item => receipts.has(item.commandId))) {
    const payload = receipts.get(item.commandId)
    let delta: WorkspaceDelta
    if (item.noOpRevision !== undefined && !payload.receipt) {
      // A no-write response proves facts only at its original observed revision.
      // It grants no audit/Undo ownership. A later read cannot silently rebase
      // a dependent command onto someone else's newer edit.
      if (remote.revision !== item.noOpRevision) { staleNoOps.add(item.commandId); continue }
      try { delta = bindProjectionPostimages(item, remote.snapshot, true) }
      catch { staleNoOps.add(item.commandId); continue }
    } else delta = receiptDelta(item, payload)
    confirmed.push({ ...item, state: 'confirmed', delta,
      compensation: payload.receipt ? payload.receipt.undoCompensation ?? item.compensation : undefined,
      serverRevision: payload.receipt?.revision ?? item.noOpRevision ?? payload.revision })
  }
  const steps: Array<{ record: CommandInteractionRecord; delta: WorkspaceDelta }> = confirmed.map(record => ({ record,
    delta: { contract: 'delta-v1', baseRevision: remote.revision, changes: [] } }))
  const empty = (baseRevision: number): WorkspaceDelta => ({ contract: 'delta-v1', baseRevision, changes: [] })
  const receiptlessIds = new Set(records.filter(item => item.noOpRevision !== undefined && !receipts.get(item.commandId)?.receipt).map(item => item.commandId))
  const unownedUndos = new Set(records.filter(item => item.targetCommandId && receiptlessIds.has(item.targetCommandId) && !receipts.has(item.commandId)).map(item => item.commandId))
  const rejected = new Set([...staleNoOps, ...unownedUndos, ...records.filter(item => item.state === 'rollback_pending' && !receipts.has(item.commandId)).map(item => item.commandId)])
  let expanded = true
  while (expanded) { expanded = false; for (const item of records) if (!receipts.has(item.commandId) && !rejected.has(item.commandId) && item.predecessors?.some(id => rejected.has(id))) { rejected.add(item.commandId); expanded = true } }
  for (const item of orderInteractions(records.filter(item => !receipts.has(item.commandId) || staleNoOps.has(item.commandId)))) {
    if (rejected.has(item.commandId)) {
      const lastError = staleNoOps.size ? '账号记录已在确认后变化，后续修改尚未提交；请核对最新内容后重试。'
        : unownedUndos.size ? '这项记录已由别处完成，没有本次操作的撤销回执；撤销尚未提交。' : item.lastError
      steps.push({ record: { ...item, state: staleNoOps.has(item.commandId) ? 'conflict' : 'rejected', lastError }, delta: empty(remote.revision) }); continue
    }
    const ancestors = new Set(item.predecessors ?? [])
    let changed = true
    while (changed) { changed = false; for (const prior of records) if (ancestors.has(prior.commandId)) for (const id of prior.predecessors ?? []) if (!ancestors.has(id)) { ancestors.add(id); changed = true } }
    const durableParents = (await Promise.all([...ancestors].map(id => readCommandInteraction(accountKey, id))))
      .filter((prior): prior is CommandInteractionRecord => prior?.state === 'confirmed')
    const delta = rebaseDelta(item.delta, [...confirmed.filter(prior => ancestors.has(prior.commandId)),
      ...durableParents.filter(prior => !confirmed.some(candidate => candidate.commandId === prior.commandId)),
      ...steps.filter(step => step.record.state !== 'confirmed' && step.record.state !== 'rejected' && ancestors.has(step.record.commandId)).map(step => step.record)])
    steps.push({ record: { ...item, delta }, delta })
  }
  const committed = await replaceLocalSnapshotFromCloud(remote.snapshot, { expectedLocal, assertCurrent, accountKey,
    version: remote.workspaceVersion ?? `txn:${remote.revision}`, interactionSteps: steps })
  // The replacement and terminal journals are now committed. Metadata has a
  // separate failure boundary: never downgrade those journals or repeat the
  // projection because localStorage cleanup failed after the transaction.
  let finalized = false
  let fingerprints: [string, string] | undefined
  for (let attempt = 0; attempt < 2 && !finalized; attempt++) {
    try {
      fingerprints ??= await Promise.all([fingerprintWorkspace(remote.snapshot), fingerprintWorkspace(committed)])
      assertCurrent()
      patchAccountCheckpoint(accountKey, { clearedCacheFingerprint: undefined, lastSyncedVersion: remote.workspaceVersion ?? `txn:${remote.revision}`,
        lastSyncedFingerprint: fingerprints[0], lastReadProjectionFingerprint: fingerprints[1],
        lastReadProjectionSourceFingerprint: fingerprints[0], lastSyncedAt: new Date().toISOString(),
        localPendingFingerprint: undefined, conflict: undefined, lastError: undefined })
      finalized = true
    } catch { /* Retain the original mirrors for terminal metadata recovery. */ }
  }
  if (finalized) {
    for (const step of steps) if (['confirmed', 'rejected', 'conflict'].includes(step.record.state)) {
      try { settleConnectedInteraction(accountKey, step.record.commandId, step.record.state === 'conflict' ? 'conflict' : undefined, step.record.lastError) } catch { /* Recover from the terminal journal, never its inverse. */ }
    }
    try { releaseIndependentQuarantine(accountKey, rejected, new Set(steps.filter(step => ['confirmed', 'rejected', 'conflict'].includes(step.record.state)).map(step => step.record.commandId))) } catch { /* Original independent intent remains in its mirror. */ }
  }
  try {
    lease.assertCurrent()
    for (const step of steps) if (['confirmed', 'rejected', 'conflict'].includes(step.record.state)) emit(step.record, undefined, step.record.lastError)
    window.dispatchEvent(new Event('pjsdas:workspace-replaced'))
  } catch { /* An account change must not publish the old account's UI event. */ }
  return committed
}
async function reconcile(record: CommandInteractionRecord, payload: any, assertCurrent: () => void) {
  if (payload.outcome === 'CONFLICT') {
    await reject(record, '这项记录刚被另一处修改；已恢复本次修改，请核对最新内容。', 'conflict')
    void (await import('./authoritativeReadModelClient.js')).refreshConnectedAuthoritativeCache(record.accountKey).catch(() => undefined)
    return
  }
  if (!['COMMITTED', 'ALREADY_APPLIED', 'NO_WRITE'].includes(payload.outcome)) throw new Error('Invalid command outcome.')
  // Authenticated receipt evidence carries the server's exact compensation,
  // including its clock and provenance. Never infer that evidence from current local rows.
  if (payload.receipt?.undoCompensation) record = { ...record, compensation: payload.receipt.undoCompensation }
  if (payload.outcome === 'NO_WRITE') return reject(record, '这次操作未写入，已恢复原状态。', 'rejected')
  // A durable receipt remains confirmed even if safe local projection is blocked.
  if (!payload.delta && !payload.snapshot && payload.outcome === 'ALREADY_APPLIED' && !record.delta.changes.length
    && (record.noOpRevision === undefined || record.noOpRevision === version(record.accountKey))) {
    await saveCommandInteraction({ ...record, state: 'confirmed', serverRevision: payload.revision })
    settleConnectedInteraction(record.accountKey, record.commandId)
    emit({ ...record, state: 'confirmed' })
    if (payload.revision !== version(record.accountKey)) void (await import('./authoritativeReadModelClient.js')).refreshConnectedAuthoritativeCache(record.accountKey).catch(() => undefined)
    return
  }
  let committed: CommandInteractionRecord | undefined
  try {
    if (!payload.delta && payload.snapshot) {
      const local = await exportLocalSnapshot()
      await recoverAuthoritativeProjection(record.accountKey, local, { record, payload })
      return
    }
    validateWorkspaceDelta(payload.delta)
    if (!Number.isSafeInteger(payload.revision) || payload.revision !== payload.delta.baseRevision + 1
      || (payload.receipt?.revision !== undefined && payload.receipt.revision !== payload.revision)
      || (payload.receipt?.commandId && payload.receipt.commandId !== record.commandId)) throw new Error('Receipt/delta revision mismatch.')
    const all = [...await readPendingCommandInteractions(record.accountKey), ...(
      await Promise.all((record.predecessors ?? []).map(id => readCommandInteraction(record.accountKey, id))))
      .filter((item): item is CommandInteractionRecord => Boolean(item && item.state === 'confirmed'))]
    const later = dependentInteractions(all, record.commandId)
    const settlement: WorkspaceDelta = { ...payload.delta, changes: payload.delta.changes.map((change: EntityDelta) => {
      const optimistic = record.delta.changes.find(item => item.collection === change.collection && item.id === change.id)
      // Compact deltas omit unchanged fields. Keep the command's original
      // preimage for those fields; otherwise a partial acknowledgement can
      // accidentally delete an optimistic field such as sourceVersionRefs.
      const prior = orderInteractions(all.filter(item => item.state === 'confirmed' && record.predecessors?.includes(item.commandId)))
        .map(item => item.delta.changes.find(entry => entry.collection === change.collection && entry.id === change.id)?.after)
        .filter((row): row is NonNullable<typeof row> => Boolean(row))
      const baseline = change.before && optimistic?.before
        ? Object.assign({}, optimistic.before, ...prior, change.before) : change.before
      let before = optimistic ? patchDeltaRow(baseline, optimistic, false) : baseline
      let after = patchDeltaRow(baseline, change, false)
      for (const overlay of later) {
        const dependent = overlay.delta.changes.find(item => item.collection === change.collection && item.id === change.id)
        if (dependent) { before = patchDeltaRow(before, dependent, false); after = patchDeltaRow(after, dependent, false) }
      }
      return { ...change, before, after }
    }) }
    const confirmed: CommandInteractionRecord = { ...record, delta: payload.delta, state: 'confirmed', serverRevision: payload.revision }
    await persistInteractionProjection(confirmed, assertCurrent, settlement)
    committed = confirmed
    assertCurrent()
    emit(confirmed, settlement)
    const current = version(record.accountKey)
    advanceConfirmedCheckpoint(confirmed)
    settleConnectedInteraction(record.accountKey, record.commandId)
    if (payload.delta.baseRevision !== current) void (await import('./authoritativeReadModelClient.js')).refreshConnectedAuthoritativeCache(record.accountKey).catch(() => undefined)
  } catch (error) {
    if (committed) {
      // Metadata failure cannot undo a durable confirmation or disable Undo.
      // Retry only metadata; a retained mirror is recovered from the terminal
      // journal without another command, projection, or inverse.
      try { assertCurrent(); advanceConfirmedCheckpoint(committed); settleConnectedInteraction(record.accountKey, record.commandId) } catch { /* Keep the original mirror for receipt-free terminal recovery. */ }
      try { assertCurrent(); emit(committed, undefined, '修改已确认；同步状态稍后核对。') } catch { /* Do not publish across an account lease change. */ }
      return
    }
    const lastError = error instanceof Error ? error.message : String(error)
    await saveCommandInteraction({ ...record, state: 'projection_pending', lastError })
    settleConnectedInteraction(record.accountKey, record.commandId, 'projection_pending', lastError)
    emit({ ...record, state: 'projection_pending' }, undefined, '服务器已确认，本机状态待安全刷新。')
  }
}
async function send(record: CommandInteractionRecord, recovery: boolean) {
  if (!navigator.onLine || listAccountPendingOperations(record.accountKey).some(item => item.commandId === record.commandId && ['conflict', 'rollback_pending'].includes(item.status))) return
  if (!recovery && listAccountPendingOperations(record.accountKey).some(item => item.commandId === record.commandId && item.status === 'unknown')) return send(record, true)
  const durable = await readCommandInteraction(record.accountKey, record.commandId)
  if (durable?.state === 'rejected' || durable?.state === 'conflict' || durable?.state === 'confirmed' || durable?.state === 'rollback_pending') return
  if (durable) record = durable
  try {
    if (recovery) {
      const read = await network(record.accountKey, { action: 'receipt', commandId: record.commandId })
      if (!read.response.ok) throw new Error('Receipt lookup unavailable.')
      if (read.payload.found) {
        if (read.payload.delta) {
          await reconcile(record, { ...read.payload, outcome: 'ALREADY_APPLIED' }, read.lease.assertCurrent)
          if ((await readCommandInteraction(record.accountKey, record.commandId))?.state === 'confirmed') return
        }
        const recovered = await network(record.accountKey, { action: 'receipt', commandId: record.commandId, projection: 'snapshot' })
        return reconcile(record, { ...recovered.payload, outcome: 'ALREADY_APPLIED' }, recovered.lease.assertCurrent)
      }
      if (record.state === 'projection_pending' || record.noOpRevision !== undefined) {
        const readback = await network(record.accountKey, { action: 'read', projection: 'snapshot' })
        if (readback.response.ok) return reconcile(record, { ...readback.payload, outcome: 'ALREADY_APPLIED' }, readback.lease.assertCurrent)
        return
      }
    }
    const mirrors = listAccountPendingOperations(record.accountKey)
    const predecessors = (await Promise.all((record.predecessors ?? []).map(async id => {
      const prior = await readCommandInteraction(record.accountKey, id)
      return prior && mirrors.some(item => item.commandId === id && ['conflict', 'rollback_pending'].includes(item.status))
        ? { ...prior, state: 'conflict' as const } : prior
    }))).filter((item): item is CommandInteractionRecord => Boolean(item))
    if (predecessors.some(item => item.state === 'conflict' || item.state === 'rejected')) return reject(record, '先前相关操作未被接受；已恢复这次修改。', 'rejected')
    if (predecessors.some(item => item.state === 'active' || item.state === 'projection_pending')) return
    const baseRevision = Math.max(record.delta.baseRevision, ...predecessors.map(item => item.serverRevision ?? record.delta.baseRevision))
    const request = await network(record.accountKey, record.targetCommandId
      ? { action: 'undo', commandId: record.commandId, targetCommandId: record.targetCommandId }
      : { action: 'command', commandId: record.commandId, baseRevision, command: { type: 'domain', value: record.command } })
    if (request.response.status === 409 && request.payload.outcome === 'CONFLICT') return reconcile(record, request.payload, request.lease.assertCurrent)
    if (!request.response.ok) {
      if ([401, 403].includes(request.response.status)) {
        const message = request.response.status === 401
          ? '登录已过期；修改保留在本机，重新登录后会先核对原操作。'
          : '账号访问暂不可用；修改保留在本机，访问恢复后会先核对原操作。'
        settleConnectedInteraction(record.accountKey, record.commandId, 'pending', message)
        emit(record, undefined, message)
        return
      }
      if ([400, 404, 405, 422].includes(request.response.status)) return reject(record, '这次修改未被接受，已恢复原状态。请检查登录和这项记录。', 'rejected')
      throw new Error('Confirmation unavailable.')
    }
    if (request.payload.outcome === 'ALREADY_APPLIED' && !request.payload.receipt) {
      if (!Number.isSafeInteger(request.payload.revision) || request.payload.revision < 0) throw new Error('Invalid no-write acknowledgement revision.')
      record = { ...record, state: 'projection_pending', noOpRevision: request.payload.revision, compensation: undefined }
      await saveCommandInteraction(record)
    }
    await reconcile(record, request.payload, request.lease.assertCurrent)
  } catch {
    const message = '修改已保存在本机，恢复连接后会先核对回执。'
    settleConnectedInteraction(record.accountKey, record.commandId, record.state === 'projection_pending' ? 'projection_pending' : 'unknown', message)
    emit(record, undefined, message)
    // Receipt lookup is read-only and immediate; a transport loss must never resend blindly.
    if (!recovery && navigator.onLine) setTimeout(() => { void dispatch(record, true).catch(() => undefined) }, 0)
  }
}
export async function recoverInstantInteraction(accountKey: string, commandId: string) {
  const id = recordId(accountKey, commandId)
  if (localPreparations.has(id)) return
  const prepared = preparedDispatches.get(id)
  if (prepared) return dispatch(prepared)
  const flight = flights.get(id)
  if (flight) return flight
  const pending = listAccountPendingOperations(accountKey).find(item => item.commandId === commandId)
  let record = await readCommandInteraction(accountKey, commandId)
  if (pending?.interaction && pending.status === 'conflict' && (!record || !['confirmed', 'rejected', 'conflict'].includes(record.state))) return
  if (navigator.onLine && getAccountCheckpoint(accountKey).clearedCacheFingerprint) {
    const local = await exportLocalSnapshot()
    if (workspaceIsEffectivelyEmpty(local) && getAccountCheckpoint(accountKey).clearedCacheFingerprint === await fingerprintWorkspace(local)) {
      await recoverAuthoritativeProjection(accountKey, local)
      record = await readCommandInteraction(accountKey, commandId)
    }
  }
  // The IDB transaction can finish before its localStorage mirror is retired.
  // Terminal facts need metadata reconciliation only, never another inverse.
  if (record && await reconcileTerminalJournal(record)) return
  if (pending?.interaction && pending.status === 'rollback_pending') {
    const root = await readCommandInteraction(accountKey, pending.rejectionRoot ?? commandId)
    if (root && ['rejected', 'conflict'].includes(root.state)) {
      await reconcileTerminalJournal(root)
      return recoverInstantInteraction(accountKey, commandId)
    }
    if (root?.state === 'confirmed') {
      settleConnectedInteraction(accountKey, commandId, 'conflict', '先前操作已确认，本机状态待安全刷新。')
      return
    }
    if (root) await reject(root, pending.lastError ?? '这次修改未被接受，已恢复原状态。', 'rejected')
    return
  }
  if (!record) {
    // A failed local preparation may retain its original mirror when even the
    // archive store is unavailable. It is closed to replay, never a queued click.
    if (!pending?.interaction || pending.status === 'conflict') return
    const receipt = navigator.onLine ? await network(accountKey, { action: 'receipt', commandId }) : undefined
    let local = await exportLocalSnapshot()
    if (receipt?.response.ok && receipt.payload.found) {
      record = { id: recordId(accountKey, commandId), accountKey, commandId,
        command: pending.command?.type === 'domain' ? pending.command.value : undefined, targetCommandId: pending.targetCommandId,
        delta: { contract: 'delta-v1', baseRevision: pending.baseRevision ?? version(accountKey), changes: [] },
        state: 'active', createdAt: pending.createdAt }
      await saveCommandInteraction(record)
      return dispatch(record, true)
    }
    if (receipt && !receipt.response.ok) throw new Error('暂时无法核对操作回执；原操作已保留。')
    const predecessorIds = [...new Set([...(pending.interactionPredecessors ?? []), ...(pending.targetCommandId ? [pending.targetCommandId] : [])])]
    const predecessors = await Promise.all(predecessorIds.map(id => readCommandInteraction(accountKey, id)))
    const mirrors = listAccountPendingOperations(accountKey)
    if (predecessors.some(prior => prior && ['rejected', 'conflict', 'rollback_pending'].includes(prior.state))
      || mirrors.some(prior => predecessorIds.includes(prior.commandId) && ['conflict', 'rollback_pending'].includes(prior.status))) {
      // This reservation never acquired a local journal/projection. Archive
      // it directly: reversing an unapplied idempotent Undo revives rejection.
      const refused: CommandInteractionRecord = { id: recordId(accountKey, commandId), accountKey, commandId,
        command: pending.command?.type === 'domain' ? pending.command.value : undefined, targetCommandId: pending.targetCommandId,
        predecessors: predecessorIds, delta: pending.interactionDelta ?? { contract: 'delta-v1', baseRevision: pending.baseRevision ?? version(accountKey), changes: [] },
        compensation: pending.interactionCompensation, state: 'active', createdAt: pending.createdAt }
      await archiveFailedPreparation(refused)
      emit({ ...refused, state: 'rejected' }, undefined, '先前操作未被接受，这次操作尚未提交。')
      return
    }
    const target = predecessors.find(prior => prior?.commandId === pending.targetCommandId)
    if (!await isRecordedAccountProjection(accountKey, local)) {
      settleConnectedInteraction(accountKey, commandId, 'conflict', '本机记录已变化，原操作已保留，请在设置中核对。')
      return
    }
    const projected = !pending.interactionDelta && pending.command?.type === 'domain'
      ? interactionProjection(local, pending.command.value, pending.baseRevision ?? version(accountKey)) : undefined
    let delta = pending.interactionDelta ?? (projected ? projected.delta
      : target ? undoInteractionProjection(local, target.command, target.compensation, target.delta, version(accountKey)) : undefined)
    if (!delta) return
    const priorRecords = (await Promise.all((pending.interactionPredecessors ?? []).map(id => readCommandInteraction(accountKey, id))))
      .filter((prior): prior is CommandInteractionRecord => prior?.state === 'confirmed')
    delta = rebaseDelta(delta, priorRecords)
    record = { id: recordId(accountKey, commandId), accountKey, commandId, command: pending.command?.type === 'domain' ? pending.command.value : undefined,
      targetCommandId: pending.targetCommandId, predecessors: pending.interactionPredecessors ?? (target ? [target.commandId] : []),
      delta, compensation: pending.interactionCompensation ?? projected?.compensation, state: 'active', createdAt: pending.createdAt }
    await persistInteractionProjection(record, captureAccountCacheLease(accountKey).assertCurrent)
    emit(record, delta)
  }
  if (record && await reconcileTerminalJournal(record)) return
  if (!record || !['active', 'projection_pending'].includes(record.state)) return
  await dispatch(record, true)
}
