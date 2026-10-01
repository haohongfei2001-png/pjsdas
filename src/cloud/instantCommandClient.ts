import { fingerprintWorkspace } from './workspaceFingerprint.js'
import { interactionMetric } from './interactionMetrics.js'
import type { UserDomainCommand } from '../domainCommands.js'
import type { PJSDASSnapshot } from '../snapshot.js'
import { exportLocalSnapshot, isRecordedAccountProjection, replaceLocalSnapshotFromCloud, persistInteractionProjections, persistInteractionProjection, readPendingCommandInteractions, readCommandInteraction, saveCommandInteraction, type CommandInteractionRecord } from '../db.js'
import { fetchBackend } from '../backendEndpoints.js'
import { getAccountAccessToken } from './cloudClient.js'
import { AccountCacheChangedError, captureAccountCacheLease } from './accountCacheLease.js'
import { getAccountCheckpoint, patchAccountCheckpoint } from './syncState.js'
import { interactionProjection, undoInteractionProjection } from './interactionProjection.js'
import { createConnectedCommandId, journalConnectedInteraction, settleConnectedInteraction, listAccountPendingOperations } from './authoritativeCommandClient.js'
import { reverseWorkspaceDelta, validateWorkspaceDelta, patchDeltaRow, type WorkspaceDelta, type EntityDelta } from '../workspaceDelta.js'

const flights = new Map<string, Promise<void>>()
const tails = new Map<string, Promise<void>>()
export interface InteractionEvent { accountKey: string; commandId: string; delta?: WorkspaceDelta; state: CommandInteractionRecord['state']; message?: string }
function emit(record: CommandInteractionRecord, delta?: WorkspaceDelta, message?: string) {
  window.dispatchEvent(new CustomEvent<InteractionEvent>('pjsdas:interaction', { detail: {
    accountKey: record.accountKey, commandId: record.commandId, delta, state: record.state, message,
  } }))
}
const recordId = (accountKey: string, commandId: string) => `${accountKey}:${commandId}`
const version = (accountKey: string) => Number(/^txn:(\d+)$/.exec(getAccountCheckpoint(accountKey).lastSyncedVersion ?? '')?.[1])
function dispatch(record: CommandInteractionRecord, recovery = false) {
  const active = flights.get(record.id)
  if (active) return active
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
/** Resolves after durable local settlement, never after the network round trip. */
export async function beginInstantCommand(accountKey: string, snapshot: PJSDASSnapshot, command: UserDomainCommand) {
  const started = performance.now()
  const lease = captureAccountCacheLease(accountKey)
  const baseRevision = version(accountKey)
  if (!Number.isSafeInteger(baseRevision)) throw new Error('请先连接并读取账号记录。')
  const projected = interactionProjection(snapshot, command, baseRevision)
  // Reserve durable intent before the first async yield so a background full
  // refresh cannot start fingerprinting while this click is settling.
  journalConnectedInteraction(accountKey, { commandId: command.commandId, command: { type: 'domain', value: command }, baseRevision })
  const existing = await readPendingCommandInteractions(accountKey)
  const overlapping = existing.filter(item => item.state === 'active' && item.delta.changes.some(left => projected.delta.changes.some(right => left.collection === right.collection && left.id === right.id)
    || (['set_date_capacity', 'set_daily_capacity', 'set_work_windows'].includes(command.kind) && left.collection === 'timePlanning')))
  const record: CommandInteractionRecord = { id: recordId(accountKey, command.commandId), accountKey, commandId: command.commandId,
    command, predecessors: overlapping.map(item => item.commandId), delta: projected.delta, compensation: projected.compensation, state: 'active', createdAt: new Date().toISOString() }
  try { await persistInteractionProjection(record, lease.assertCurrent) } catch (error) {
    try { await saveCommandInteraction({ ...record, state: 'rejected', lastError: 'Local projection refused.' }); settleConnectedInteraction(accountKey, command.commandId) }
    catch { settleConnectedInteraction(accountKey, command.commandId, 'conflict', '本机保存失败，原操作记录已保留。') }
    throw new Error('这项记录刚有变化，本次修改未写入，请查看最新内容。')
  }
  interactionMetric('durable-outbox', started)
  emit(record, record.delta)
  // Let the UI paint before starting auth or any remote work.
  setTimeout(() => { if (navigator.onLine) void dispatch(record).catch(() => undefined) }, 0)
  return record.commandId
}
export async function beginInstantUndo(accountKey: string, targetCommandId: string, snapshot: PJSDASSnapshot) {
  const started = performance.now()
  const lease = captureAccountCacheLease(accountKey)
  const commandId = createConnectedCommandId('instant-undo')
  journalConnectedInteraction(accountKey, { commandId, targetCommandId, baseRevision: version(accountKey) })
  let record: CommandInteractionRecord
  try {
    const target = await readCommandInteraction(accountKey, targetCommandId)
    if (!target || !['active', 'confirmed'].includes(target.state)) throw new Error('这次操作无法安全撤销，请核对最新记录。')
    record = { id: recordId(accountKey, commandId), commandId, accountKey, targetCommandId,
      predecessors: [targetCommandId], delta: undoInteractionProjection(snapshot, target.command, target.compensation, target.delta, version(accountKey)), state: 'active', createdAt: new Date().toISOString() }
    await persistInteractionProjection(record, lease.assertCurrent)
  } catch (error) { settleConnectedInteraction(accountKey, commandId); throw error }
  interactionMetric('durable-outbox', started)
  emit(record, record.delta)
  setTimeout(() => { if (navigator.onLine) void dispatch(record).catch(() => undefined) }, 0)
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
  const lease = captureAccountCacheLease(record.accountKey)
  const all = await readPendingCommandInteractions(record.accountKey)
  const rejectedIds = new Set([record.commandId])
  const dependents: CommandInteractionRecord[] = []
  let changed = true
  while (changed) {
    changed = false
    for (const item of all) if (item.state === 'active' && !rejectedIds.has(item.commandId) && item.predecessors?.some(id => rejectedIds.has(id))) {
      rejectedIds.add(item.commandId); dependents.push(item); changed = true
    }
  }
  // Outbox order is explicit in predecessor IDs, not primary-key iteration.
  const ordered = orderInteractions(dependents)
  const steps = [...ordered.reverse(), record].map(item => ({
    record: { ...item, state: (item.commandId === record.commandId ? state : 'rejected') as 'rejected' | 'conflict', lastError: message },
    delta: reverseWorkspaceDelta(item.delta),
  }))
  try {
    await persistInteractionProjections(steps, lease.assertCurrent)
    for (const step of steps) {
      emit(step.record, step.delta, message)
      settleConnectedInteraction(record.accountKey, step.record.commandId, step.record.state === 'conflict' ? 'conflict' : undefined, message)
    }
  } catch {
    for (const step of steps) {
      await saveCommandInteraction({ ...step.record, state: 'conflict' })
      settleConnectedInteraction(record.accountKey, step.record.commandId, 'conflict', message)
    }
    emit({ ...record, state: 'conflict' }, undefined, '记录已在别处变化，请打开设置核对；没有覆盖新修改。')
  }
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
  if (!payload.delta && payload.outcome === 'ALREADY_APPLIED' && !record.delta.changes.length) {
    await saveCommandInteraction({ ...record, state: 'confirmed', serverRevision: payload.revision })
    settleConnectedInteraction(record.accountKey, record.commandId)
    emit({ ...record, state: 'confirmed' })
    if (payload.revision !== version(record.accountKey)) void (await import('./authoritativeReadModelClient.js')).refreshConnectedAuthoritativeCache(record.accountKey).catch(() => undefined)
    return
  }
  try {
    if (!payload.delta && payload.snapshot) {
      const local = await exportLocalSnapshot()
      if ((!await isRecordedAccountProjection(record.accountKey, local)
        && getAccountCheckpoint(record.accountKey).clearedCacheFingerprint !== await fingerprintWorkspace(local))
        || listAccountPendingOperations(record.accountKey).some(item => item.commandId !== record.commandId && item.status !== 'conflict' && item.status !== 'projection_pending')) throw new Error('Projection awaits recovery.')
      const assertRecoveryCurrent = () => {
        assertCurrent()
        if (version(record.accountKey) > payload.revision) throw new AccountCacheChangedError()
      }
      const recoveredVersion = payload.workspaceVersion ?? `txn:${payload.revision}`
      const committed = await replaceLocalSnapshotFromCloud(payload.snapshot, { expectedLocal: local, assertCurrent: assertRecoveryCurrent, accountKey: record.accountKey, version: recoveredVersion })
      const [fingerprint, projectedFingerprint] = await Promise.all([fingerprintWorkspace(payload.snapshot), fingerprintWorkspace(committed)])
      assertRecoveryCurrent()
      patchAccountCheckpoint(record.accountKey, { clearedCacheFingerprint: undefined,
        lastSyncedVersion: recoveredVersion, lastSyncedFingerprint: fingerprint,
        lastReadProjectionFingerprint: projectedFingerprint, lastReadProjectionSourceFingerprint: fingerprint,
        lastSyncedAt: new Date().toISOString(), localPendingFingerprint: undefined, conflict: undefined, lastError: undefined })
      const delta: WorkspaceDelta = { ...record.delta, changes: record.delta.changes.map(change => {
        const rows = payload.snapshot.data[change.collection]
        const after = Array.isArray(rows) ? rows.find((row: { id: string }) => row.id === change.id) ?? null : rows ?? null
        const compactAfter = after && change.before && change.after
          ? Object.fromEntries([...new Set([...Object.keys(change.before), ...Object.keys(change.after)])].filter(key => key in after).map(key => [key, after[key]])) : after
        return { ...change, after: compactAfter }
      }).filter(change => change.before || change.after) }
      await saveCommandInteraction({ ...record, delta, state: 'confirmed', serverRevision: payload.revision })
      settleConnectedInteraction(record.accountKey, record.commandId)
      window.dispatchEvent(new Event('pjsdas:workspace-replaced'))
      emit({ ...record, state: 'confirmed' })
      return
    }
    validateWorkspaceDelta(payload.delta)
    const all = [...await readPendingCommandInteractions(record.accountKey), ...(
      await Promise.all((record.predecessors ?? []).map(id => readCommandInteraction(record.accountKey, id))))
      .filter((item): item is CommandInteractionRecord => Boolean(item && item.state === 'confirmed'))]
    const later = orderInteractions(all.filter(item => item.state === 'active' && item.commandId !== record.commandId
      && item.predecessors?.includes(record.commandId)))
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
    await persistInteractionProjection({ ...record, delta: payload.delta, state: 'confirmed', serverRevision: payload.revision }, assertCurrent, settlement)
    const current = version(record.accountKey)
    if (payload.delta.baseRevision === current && Number.isSafeInteger(payload.revision)) patchAccountCheckpoint(record.accountKey,
      { lastSyncedVersion: `txn:${payload.revision}`, lastSyncedAt: new Date().toISOString(), lastError: undefined })
    settleConnectedInteraction(record.accountKey, record.commandId)
    emit({ ...record, state: 'confirmed' }, settlement)
    if (payload.delta.baseRevision !== current) void (await import('./authoritativeReadModelClient.js')).refreshConnectedAuthoritativeCache(record.accountKey).catch(() => undefined)
  } catch (error) {
    const lastError = error instanceof Error ? error.message : String(error)
    await saveCommandInteraction({ ...record, state: 'projection_pending', lastError })
    settleConnectedInteraction(record.accountKey, record.commandId, 'projection_pending', lastError)
    emit({ ...record, state: 'projection_pending' }, undefined, '服务器已确认，本机状态待安全刷新。')
  }
}
async function send(record: CommandInteractionRecord, recovery: boolean) {
  if (!navigator.onLine) return
  const durable = await readCommandInteraction(record.accountKey, record.commandId)
  if (durable?.state === 'rejected' || durable?.state === 'conflict' || durable?.state === 'confirmed') return
  if (durable) record = durable
  try {
    if (recovery) {
      const read = await network(record.accountKey, { action: 'receipt', commandId: record.commandId })
      if (!read.response.ok) throw new Error('Receipt lookup unavailable.')
      if (read.payload.found) {
        const recovered = !read.payload.delta || record.state === 'projection_pending' ? await network(record.accountKey, { action: 'receipt', commandId: record.commandId, projection: 'snapshot' }) : read
        return reconcile(record, { ...recovered.payload, outcome: 'ALREADY_APPLIED' }, recovered.lease.assertCurrent)
      }
      if (record.state === 'projection_pending') {
        const readback = await network(record.accountKey, { action: 'read', projection: 'snapshot' })
        if (readback.response.ok) return reconcile(record, { ...readback.payload, outcome: 'ALREADY_APPLIED' }, readback.lease.assertCurrent)
        return
      }
    }
    const predecessors = (await Promise.all((record.predecessors ?? []).map(id => readCommandInteraction(record.accountKey, id)))).filter((item): item is CommandInteractionRecord => Boolean(item))
    if (predecessors.some(item => item.state === 'active' || item.state === 'projection_pending')) return
    if (predecessors.some(item => item.state === 'conflict' || item.state === 'rejected')) return reject(record, '先前相关操作未被接受；已恢复这次修改。', 'rejected')
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
  let record = await readCommandInteraction(accountKey, commandId)
  if (!record) {
    const pending = listAccountPendingOperations(accountKey).find(item => item.commandId === commandId)
    if (!pending?.interaction) return
    const local = await exportLocalSnapshot()
    const target = pending.targetCommandId
      ? await readCommandInteraction(accountKey, pending.targetCommandId) : undefined
    const delta = pending.command?.type === 'domain'
      ? interactionProjection(local, pending.command.value, pending.baseRevision ?? version(accountKey)).delta
      : target ? undoInteractionProjection(local, target.command, target.compensation, target.delta, version(accountKey)) : undefined
    if (!delta) return
    record = { id: recordId(accountKey, commandId), accountKey, commandId, command: pending.command?.type === 'domain' ? pending.command.value : undefined,
      targetCommandId: pending.targetCommandId, predecessors: target ? [target.commandId] : [],
      delta, state: 'active', createdAt: pending.createdAt }
    await persistInteractionProjection(record, captureAccountCacheLease(accountKey).assertCurrent)
    emit(record, delta)
  }
  if (record?.state === 'confirmed') { settleConnectedInteraction(accountKey, commandId); return }
  if (!record || !['active', 'projection_pending'].includes(record.state)) return
  await dispatch(record, true)
}
