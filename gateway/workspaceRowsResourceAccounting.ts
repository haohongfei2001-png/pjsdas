/** Local, default-off executable specification. No IO, authority, quota defaults,
 * runtime registration, SQL or deletion. See the integration contract before use. */
import { isDeepStrictEqual } from 'node:util'
import type { StagedRequestBinding } from './workspaceRowsStagedDocumentsPrototype.js'

export interface ResourceLimits { commandBytes: number; ownerBytes: number; globalBytes: number }
export type ResourceConfiguration = { enabled?: false } | { enabled: true; limits: ResourceLimits }
/** The existing reservation identity remains stageId; intent uniqueness remains
 * (userId, commandId), NOT (owner, epoch, command). */
export interface ResourceBinding extends StagedRequestBinding {
  manifestSha256: string
  preparedSha256?: string
}
export interface ResourceAdmission {
  binding: ResourceBinding
  reservedBytes: number
  expiresAt: number
  /** The original absolute prepared-intent deadline, never a new timeout. */
  deadlineAt: number
}
export type ResourceKind = 'intent-encoded' | 'intent-decoded' | 'document-fragments'
  | 'effect-wire' | 'effect-jsonb' | 'audit-spool' | 'storage-overhead' | 'retained-control'
export interface ResourceChunk {
  offset: number; bytes: number; sha256: string; status: 'pending' | 'present'
}
export interface ResourceAllocation {
  allocationId: string; kind: ResourceKind; chunks: ResourceChunk[]; removed: boolean
}
export type ResourcePhase = 'open' | 'stopped' | 'finalizing' | 'unknown'
  | 'committed' | 'not-committed' | 'reclaiming' | 'reclaimed' | 'released'
/** Trusted adapter evidence, not a client-supplied authorization decision. A
 * reducer cannot establish a DB lock, a durable fence or retained audit bytes. */
export type ResourceOutcome =
  | { outcome: 'not-committed'; fenceId: string }
  | { outcome: 'committed'; fenceId: string; resultingRevision: number
      auditRetention: 'original-receipt-projection-compensation-retained' }
export interface ResourceReservation extends ResourceAdmission {
  revision: number
  /** Immutable R = currentHeldBytes + releasedBytes; residual control stays charged. */
  currentHeldBytes: number
  releasedBytes: number
  retainedControlBytes: number
  peakOccupiedBytes: number
  phase: ResourcePhase
  allocations: ResourceAllocation[]
  finalizeAttemptId?: string
  stopReason?: 'cancelled' | 'expired' | 'process-crash'
  resolution?: ResourceOutcome
  reclaimId?: string
  /** Independent of the business finalizer fence: no old byte writer can run. */
  writerFenceId?: string
}
export interface ResourceLedger {
  protocol: 'workspace-resource-accounting-v1'
  configuration: ResourceConfiguration
  revision: number
  /** Admission/materialization freeze until a complete consistent inventory. */
  inventoryVerified: boolean
  reservations: ResourceReservation[]
}
export interface ResourceInventoryEntry {
  stageId: string; allocationId: string; offset: number; bytes: number; sha256: string
}
export interface ResourceInventoryIssue {
  code: 'incomplete-inventory' | 'orphan' | 'mismatch' | 'missing-confirmed'
  stageId?: string; allocationId?: string; offset?: number
}
export type ResourceAction =
  | { type: 'inventory'; observedRevision: number; complete: boolean; entries: ResourceInventoryEntry[] }
  | { type: 'admit'; admission: ResourceAdmission }
  | ({ binding: ResourceBinding } & (
    | { type: 'append'; allocationId: string; kind: ResourceKind; offset: number; bytes: number; sha256: string }
    | { type: 'confirm-append'; allocationId: string; offset: number; bytes: number; sha256: string }
    | { type: 'begin-finalize'; attemptId: string }
    | { type: 'stop'; reason: 'cancelled' | 'expired' | 'process-crash' }
    | { type: 'mark-unknown'; attemptId: string }
    | { type: 'resolve'; reservationRevision: number; evidence: ResourceOutcome }
    | { type: 'begin-reclaim'; reclaimId: string; writerFenceId: string; reservationRevision: number }
    | { type: 'confirm-removed'; reclaimId: string; allocationId: string }
    | { type: 'release'; reclaimId: string }
    | { type: 'retire-to-control'; reclaimId: string; writerFenceId: string; reservationRevision: number;
        inventory: ResourceInventoryEntry[]; control: ResourceInventoryEntry; observedControl: ResourceInventoryEntry }
  ))
export interface ResourceTransition {
  state: ResourceLedger
  disposition: 'applied' | 'replayed' | 'disabled'
  inventoryIssues?: ResourceInventoryIssue[]
}
export interface ResourceUsage { heldBytes: number; occupiedUpperBoundBytes: number; confirmedPresentBytes: number }
export interface ResourceTotals {
  global: ResourceUsage
  owners: { userId: string; usage: ResourceUsage }[]
  commands: { userId: string; commandId: string; usage: ResourceUsage }[]
}
export class ResourceAccountingError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ResourceAccountingError' }
}
function requireValue(value: unknown, code: string): asserts value {
  if (!value) throw new ResourceAccountingError(code)
}
const uint = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0
const text = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0
const hex = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s)
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const kinds: ResourceKind[] = ['intent-encoded', 'intent-decoded', 'document-fragments', 'effect-wire', 'effect-jsonb', 'audit-spool', 'storage-overhead', 'retained-control']
const phases: ResourcePhase[] = ['open', 'stopped', 'finalizing', 'unknown', 'committed', 'not-committed', 'reclaiming', 'reclaimed', 'released']
function plus(a: number, b: number) { const n = a + b; requireValue(uint(n), 'BYTE_COUNTER_OVERFLOW'); return n }
function clone<T>(value: T): T { return structuredClone(value) }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value)) freeze(child)
  }
  return value
}
function checkConfiguration(config: ResourceConfiguration) {
  requireValue(object(config) && (config.enabled === undefined || config.enabled === false || config.enabled === true), 'INVALID_CONFIGURATION')
  if (config.enabled) requireValue(object(config.limits) && uint(config.limits.commandBytes)
    && uint(config.limits.ownerBytes) && uint(config.limits.globalBytes), 'EXPLICIT_RESOURCE_LIMITS_REQUIRED')
}
function checkBinding(binding: ResourceBinding) {
  requireValue(object(binding), 'INVALID_RESOURCE_BINDING')
  for (const key of ['stageId', 'userId', 'workspaceId', 'expectedEpoch', 'commandId', 'family', 'operation', 'principal'] as const) {
    requireValue(text(binding[key]), 'INVALID_RESOURCE_BINDING')
  }
  requireValue(uint(binding.expectedRevision) && hex(binding.payloadHash) && hex(binding.manifestSha256)
    && (binding.preparedSha256 === undefined || hex(binding.preparedSha256)) && object(binding.authority), 'INVALID_RESOURCE_BINDING')
  // Persistable exact authority values, never functions/undefined/NaN silently dropped.
  try { requireValue(isDeepStrictEqual(JSON.parse(JSON.stringify(binding)), binding), 'NON_JSON_RESOURCE_BINDING') }
  catch { throw new ResourceAccountingError('NON_JSON_RESOURCE_BINDING') }
}
function checkAdmission(admission: ResourceAdmission) {
  requireValue(object(admission), 'INVALID_RESOURCE_ADMISSION'); checkBinding(admission.binding)
  requireValue(uint(admission.reservedBytes) && admission.reservedBytes > 0
    && uint(admission.expiresAt) && uint(admission.deadlineAt), 'INVALID_RESOURCE_ADMISSION')
}
function checkOutcome(evidence: ResourceOutcome) {
  requireValue(object(evidence) && text(evidence.fenceId), 'DURABLE_FINALIZER_FENCE_REQUIRED')
  requireValue(evidence.outcome === 'not-committed' || (evidence.outcome === 'committed'
    && uint(evidence.resultingRevision) && evidence.resultingRevision > 0
    && evidence.auditRetention === 'original-receipt-projection-compensation-retained'), 'ORIGINAL_AUDIT_RETENTION_REQUIRED')
}
const chunkKey = (stageId: string, allocationId: string, offset: number) => JSON.stringify([stageId, allocationId, offset])
function chunkBytes(allocation: ResourceAllocation) { return allocation.chunks.reduce((n, part) => plus(n, part.bytes), 0) }
function usage(reservation: ResourceReservation): ResourceUsage {
  return {
    heldBytes: reservation.currentHeldBytes,
    occupiedUpperBoundBytes: reservation.allocations.filter(a => !a.removed).reduce((n, a) => plus(n, chunkBytes(a)), 0),
    confirmedPresentBytes: reservation.allocations.filter(a => !a.removed).reduce((n, a) => a.chunks.filter(c => c.status === 'present').reduce((sum, c) => plus(sum, c.bytes), n), 0),
  }
}
const zero = (): ResourceUsage => ({ heldBytes: 0, occupiedUpperBoundBytes: 0, confirmedPresentBytes: 0 })
function addUsage(a: ResourceUsage, b: ResourceUsage) {
  a.heldBytes = plus(a.heldBytes, b.heldBytes)
  a.occupiedUpperBoundBytes = plus(a.occupiedUpperBoundBytes, b.occupiedUpperBoundBytes)
  a.confirmedPresentBytes = plus(a.confirmedPresentBytes, b.confirmedPresentBytes)
}
/** Recomputed from records, not trusted cached aggregate counters. Never count
 * both reserved capacity and the bytes already occupying that same capacity. */
export function resourceTotals(state: ResourceLedger): ResourceTotals {
  const result: ResourceTotals = { global: zero(), owners: [], commands: [] }
  for (const r of state.reservations) {
    const u = usage(r), { userId, commandId } = r.binding
    let owner = result.owners.find(o => o.userId === userId)
    if (!owner) { owner = { userId, usage: zero() }; result.owners.push(owner) }
    let command = result.commands.find(c => c.userId === userId && c.commandId === commandId)
    if (!command) { command = { userId, commandId, usage: zero() }; result.commands.push(command) }
    addUsage(result.global, u); addUsage(owner.usage, u); addUsage(command.usage, u)
  }
  return result
}
/** Validation is also performed at every external snapshot/transition boundary. */
export function assertResourceLedger(state: ResourceLedger): void {
  requireValue(object(state) && state.protocol === 'workspace-resource-accounting-v1'
    && uint(state.revision) && typeof state.inventoryVerified === 'boolean' && Array.isArray(state.reservations), 'INVALID_RESOURCE_LEDGER')
  checkConfiguration(state.configuration)
  const stages = new Set<string>(), commands = new Set<string>()
  for (const r of state.reservations) {
    checkAdmission(r)
    const command = JSON.stringify([r.binding.userId, r.binding.commandId])
    requireValue(!stages.has(r.binding.stageId) && !commands.has(command), 'DUPLICATE_RESERVATION_IDENTITY')
    stages.add(r.binding.stageId); commands.add(command)
    requireValue(uint(r.revision) && r.revision <= state.revision && phases.includes(r.phase) && Array.isArray(r.allocations), 'INVALID_RESERVATION_STATE')
    requireValue(r.finalizeAttemptId === undefined || text(r.finalizeAttemptId), 'INVALID_FINALIZE_ATTEMPT')
    requireValue(!['finalizing', 'unknown'].includes(r.phase) || text(r.finalizeAttemptId), 'FINALIZE_ATTEMPT_REQUIRED')
    requireValue(r.stopReason === undefined || ['cancelled', 'expired', 'process-crash'].includes(r.stopReason), 'INVALID_STOP_REASON')
    requireValue(r.phase !== 'stopped' || r.stopReason !== undefined, 'STOP_REASON_REQUIRED')
    if (r.resolution !== undefined) checkOutcome(r.resolution)
    const resolved = ['committed', 'not-committed', 'reclaiming', 'reclaimed', 'released'].includes(r.phase)
    requireValue(resolved === (r.resolution !== undefined), 'RESOLUTION_STATE_MISMATCH')
    if (r.phase === 'committed' || r.phase === 'not-committed') requireValue(r.resolution?.outcome === r.phase, 'RESOLUTION_STATE_MISMATCH')
    const reclaiming = ['reclaiming', 'reclaimed', 'released'].includes(r.phase)
    requireValue(reclaiming ? text(r.reclaimId) && text(r.writerFenceId) : r.reclaimId === undefined && r.writerFenceId === undefined, 'RECLAIM_STATE_MISMATCH')
    const ids = new Set<string>()
    for (const a of r.allocations) {
      requireValue(text(a.allocationId) && !ids.has(a.allocationId) && kinds.includes(a.kind)
        && typeof a.removed === 'boolean' && Array.isArray(a.chunks) && a.chunks.length > 0, 'INVALID_ALLOCATION')
      ids.add(a.allocationId); let cursor = 0
      for (const c of a.chunks) {
        requireValue(uint(c.offset) && c.offset === cursor && uint(c.bytes) && c.bytes > 0 && hex(c.sha256)
          && ['pending', 'present'].includes(c.status), 'INVALID_RESOURCE_CHUNK')
        cursor = plus(cursor, c.bytes)
      }
      requireValue(a.kind !== 'retained-control' || (!a.removed && ['reclaiming','reclaimed'].includes(r.phase) && a.chunks.length === 1 && a.chunks[0].status === 'present'), 'RETAINED_CONTROL_PERMANENT')
      requireValue(!a.removed || reclaiming, 'UNFENCED_ALLOCATION_REMOVAL')
      requireValue(r.phase !== 'released' || a.removed, 'RELEASE_WITH_LIVE_ALLOCATION')
    }
    requireValue(['reclaimed','released'].includes(r.phase) || (r.currentHeldBytes === r.reservedBytes && r.releasedBytes === 0), 'UNFENCED_CAPACITY_RELEASE')
    requireValue(['reclaiming','reclaimed'].includes(r.phase) || r.retainedControlBytes === 0, 'UNFENCED_RETAINED_CONTROL')
    const historical = r.allocations.reduce((n,a) => plus(n,chunkBytes(a)),0)
    requireValue(historical <= r.reservedBytes, 'RESERVATION_EXCEEDED')
    requireValue(r.peakOccupiedBytes >= historical, 'HISTORICAL_PEAK_MISMATCH')
    requireValue(r.allocations.filter(a => a.kind === 'retained-control').length <= 1, 'RETAINED_CONTROL_PERMANENT')
    const u = usage(r), control = r.allocations.filter(a => !a.removed && a.kind === 'retained-control').reduce((n,a) => plus(n,chunkBytes(a)),0)
    requireValue(uint(r.currentHeldBytes) && uint(r.releasedBytes) && uint(r.retainedControlBytes) && uint(r.peakOccupiedBytes)
      && plus(r.currentHeldBytes,r.releasedBytes) === r.reservedBytes && r.retainedControlBytes === control, 'INVALID_HELD_RELEASE_CONTROL')
    requireValue(u.confirmedPresentBytes <= u.occupiedUpperBoundBytes && u.occupiedUpperBoundBytes <= r.currentHeldBytes
      && r.peakOccupiedBytes >= u.occupiedUpperBoundBytes && r.peakOccupiedBytes <= r.reservedBytes, 'RESERVATION_EXCEEDED')
    requireValue(r.phase !== 'reclaimed' || (control > 0 && u.confirmedPresentBytes === control && u.occupiedUpperBoundBytes === control && r.currentHeldBytes === control), 'INVALID_RECLAIMED_RESIDUAL')
    requireValue(r.phase !== 'released' || (r.currentHeldBytes === 0 && control === 0), 'RELEASE_WITH_RETAINED_CONTROL')
  }
  const totals = resourceTotals(state)
  if (state.configuration.enabled) {
    const limits = state.configuration.limits
    requireValue(totals.global.heldBytes <= limits.globalBytes, 'GLOBAL_LIMIT_EXCEEDED')
    requireValue(totals.owners.every(o => o.usage.heldBytes <= limits.ownerBytes), 'OWNER_LIMIT_EXCEEDED')
    requireValue(totals.commands.every(c => c.usage.heldBytes <= limits.commandBytes), 'COMMAND_LIMIT_EXCEEDED')
  } else requireValue(state.reservations.length === 0, 'DISABLED_LEDGER_HAS_RESERVATIONS')
}
export function createResourceLedger(configuration: ResourceConfiguration = {}): ResourceLedger {
  const state: ResourceLedger = { protocol: 'workspace-resource-accounting-v1', configuration: clone(configuration),
    revision: 0, inventoryVerified: false, reservations: [] }
  assertResourceLedger(state); return freeze(state)
}
/** Restart never assumes request-finally cleanup succeeded. Even a valid saved
 * snapshot freezes new bytes until an independently fenced inventory succeeds. */
export function restoreResourceLedger(snapshot: ResourceLedger): ResourceLedger {
  assertResourceLedger(snapshot)
  const state = clone(snapshot); state.inventoryVerified = false; state.revision = plus(state.revision, 1)
  return freeze(state)
}
/** Inventory is observational. Missing pending writes retain their charge;
 * orphans/corruption block new allocation, never trigger speculative deletion. */
export function inspectResourceInventory(state: ResourceLedger, entries: ResourceInventoryEntry[], complete: boolean): ResourceInventoryIssue[] {
  assertResourceLedger(state)
  requireValue(Array.isArray(entries) && typeof complete === 'boolean', 'INVALID_RESOURCE_INVENTORY')
  const expected = new Map<string, ResourceChunk>()
  for (const r of state.reservations) for (const a of r.allocations) if (!a.removed) {
    for (const c of a.chunks) expected.set(chunkKey(r.binding.stageId, a.allocationId, c.offset), c)
  }
  const seen = new Set<string>(), issues: ResourceInventoryIssue[] = complete ? [] : [{ code: 'incomplete-inventory' }]
  for (const item of entries) {
    requireValue(object(item) && text(item.stageId) && text(item.allocationId) && uint(item.offset)
      && uint(item.bytes) && item.bytes > 0 && hex(item.sha256), 'INVALID_RESOURCE_INVENTORY')
    const key = chunkKey(item.stageId, item.allocationId, item.offset)
    requireValue(!seen.has(key), 'DUPLICATE_INVENTORY_ENTRY'); seen.add(key)
    const c = expected.get(key), locator = { stageId: item.stageId, allocationId: item.allocationId, offset: item.offset }
    if (!c) issues.push({ code: 'orphan', ...locator })
    else if (c.bytes !== item.bytes || c.sha256 !== item.sha256) issues.push({ code: 'mismatch', ...locator })
  }
  if (complete) for (const [key, c] of expected) if (c.status === 'present' && !seen.has(key)) {
    const [stageId, allocationId, offset] = JSON.parse(key) as [string, string, number]
    issues.push({ code: 'missing-confirmed', stageId, allocationId, offset })
  }
  return issues
}
/** One serial transition. The caller must atomically compare/persist the whole
 * revision (or implement the documented equivalent DB locks). This is NOT an
 * in-memory mutex, durable transaction, authorizer or physical byte writer. */
export function transitionResourceLedger(state: ResourceLedger, expectedRevision: number, action: ResourceAction, now: number): ResourceTransition {
  assertResourceLedger(state)
  requireValue(uint(now) && uint(expectedRevision), 'INVALID_RESOURCE_CLOCK_OR_REVISION')
  requireValue(expectedRevision === state.revision, 'STALE_LEDGER_REVISION')
  if (!state.configuration.enabled) return { state, disposition: 'disabled' }
  const next = clone(state)
  let changed = false, issues: ResourceInventoryIssue[] | undefined, touched: ResourceReservation | undefined
  if (action.type === 'inventory') {
    requireValue(action.observedRevision === state.revision, 'STALE_INVENTORY_EVIDENCE')
    issues = inspectResourceInventory(state, action.entries, action.complete)
    next.inventoryVerified = issues.length === 0
    changed = next.inventoryVerified !== state.inventoryVerified
  } else if (action.type === 'admit') {
    checkAdmission(action.admission)
    const admitted = clone(action.admission), b = admitted.binding
    const existing = next.reservations.find(r => r.binding.stageId === b.stageId)
    if (existing) {
      requireValue(isDeepStrictEqual(existing.binding, b) && existing.reservedBytes === admitted.reservedBytes
        && existing.expiresAt === admitted.expiresAt && existing.deadlineAt === admitted.deadlineAt, 'RESERVATION_IDENTITY_REUSED')
    } else {
      requireValue(next.inventoryVerified, 'RESOURCE_RECONCILIATION_REQUIRED')
      requireValue(!next.reservations.some(r => r.binding.userId === b.userId && r.binding.commandId === b.commandId), 'COMMAND_ID_REUSED')
      requireValue(now < admitted.expiresAt && now < admitted.deadlineAt, 'RESOURCE_ADMISSION_EXPIRED')
      touched = { ...admitted, phase: 'open', revision: 0, currentHeldBytes: admitted.reservedBytes, releasedBytes: 0, retainedControlBytes: 0, peakOccupiedBytes: 0, allocations: [] }
      next.reservations.push(touched); changed = true
    }
  } else {
    checkBinding(action.binding)
    const r = next.reservations.find(item => item.binding.stageId === action.binding.stageId)
    requireValue(r && isDeepStrictEqual(r.binding, action.binding), 'RESOURCE_BINDING_MISMATCH')
    touched = r
    const writable = () => {
      requireValue(next.inventoryVerified, 'RESOURCE_RECONCILIATION_REQUIRED')
      requireValue(r.phase === 'open' && now < r.deadlineAt && now < r.expiresAt, 'RESOURCE_WRITES_CLOSED')
    }
    const allocation = (id: string) => {
      const a = r.allocations.find(item => item.allocationId === id)
      requireValue(a, 'ALLOCATION_NOT_FOUND'); return a
    }
    switch (action.type) {
      case 'append': {
        writable()
        requireValue(text(action.allocationId) && kinds.includes(action.kind) && action.kind !== 'retained-control' && uint(action.offset)
          && uint(action.bytes) && action.bytes > 0 && hex(action.sha256), 'INVALID_APPEND')
        let a = r.allocations.find(item => item.allocationId === action.allocationId)
        if (!a) { a = { allocationId: action.allocationId, kind: action.kind, chunks: [], removed: false }; r.allocations.push(a) }
        requireValue(a.kind === action.kind && !a.removed, 'ALLOCATION_IDENTITY_REUSED')
        const prior = a.chunks.find(c => c.offset === action.offset)
        if (prior) requireValue(prior.bytes === action.bytes && prior.sha256 === action.sha256, 'APPEND_IDENTITY_REUSED')
        else {
          requireValue(action.offset === chunkBytes(a), 'APPEND_GAP_OR_OVERLAP')
          a.chunks.push({ offset: action.offset, bytes: action.bytes, sha256: action.sha256, status: 'pending' }); changed = true
        }
        break
      }
      case 'confirm-append': {
        writable()
        const a = allocation(action.allocationId), c = a.chunks.find(item => item.offset === action.offset)
        requireValue(c && c.bytes === action.bytes && c.sha256 === action.sha256, 'APPEND_IDENTITY_REUSED')
        if (c.status !== 'present') { c.status = 'present'; changed = true }
        break
      }
      case 'begin-finalize': {
        requireValue(text(action.attemptId), 'INVALID_FINALIZE_ATTEMPT')
        if (r.finalizeAttemptId !== undefined) requireValue(r.finalizeAttemptId === action.attemptId, 'FINALIZE_ATTEMPT_REUSED')
        else { writable(); r.finalizeAttemptId = action.attemptId; r.phase = 'finalizing'; changed = true }
        break
      }
      case 'stop': {
        requireValue(['cancelled', 'expired', 'process-crash'].includes(action.reason), 'INVALID_STOP_REASON')
        if (action.reason === 'expired') requireValue(now >= Math.min(r.deadlineAt, r.expiresAt), 'NOT_EXPIRED')
        if (r.phase === 'open' || r.phase === 'finalizing') {
          r.phase = r.phase === 'open' ? 'stopped' : 'unknown'; r.stopReason = action.reason; changed = true
        }
        break
      }
      case 'mark-unknown': {
        requireValue(text(action.attemptId) && action.attemptId === r.finalizeAttemptId, 'FINALIZE_ATTEMPT_REUSED')
        if (r.phase === 'finalizing') { r.phase = 'unknown'; changed = true }
        else requireValue(['unknown', 'committed', 'not-committed', 'reclaiming', 'reclaimed', 'released'].includes(r.phase), 'FINALIZE_NOT_DISPATCHED')
        break
      }
      case 'resolve': {
        checkOutcome(action.evidence)
        if (r.resolution) requireValue(isDeepStrictEqual(r.resolution, action.evidence), 'OUTCOME_EVIDENCE_CHANGED')
        else {
          requireValue(action.reservationRevision === r.revision, 'STALE_RESOLUTION_EVIDENCE')
          r.resolution = clone(action.evidence); r.phase = action.evidence.outcome; changed = true
        }
        break
      }
      case 'begin-reclaim': {
        requireValue(text(action.reclaimId) && text(action.writerFenceId), 'WRITER_FENCE_REQUIRED')
        if (r.reclaimId !== undefined) requireValue(r.reclaimId === action.reclaimId && r.writerFenceId === action.writerFenceId, 'RECLAIM_ID_REUSED')
        else {
          requireValue(r.phase === 'committed' || r.phase === 'not-committed', 'ORIGINAL_OUTCOME_UNRESOLVED')
          requireValue(action.reservationRevision === r.revision, 'STALE_WRITER_FENCE')
          r.reclaimId = action.reclaimId; r.writerFenceId = action.writerFenceId; r.phase = 'reclaiming'; changed = true
        }
        break
      }
      case 'confirm-removed': {
        requireValue(text(action.reclaimId) && r.reclaimId === action.reclaimId
          && ['reclaiming', 'reclaimed', 'released'].includes(r.phase), 'RECLAIM_FENCE_REQUIRED')
        const a = allocation(action.allocationId)
        requireValue(a.kind !== 'retained-control', 'RETAINED_CONTROL_PERMANENT')
        if (!a.removed) { a.removed = true; changed = true }
        break
      }
      case 'release': {
        requireValue(text(action.reclaimId) && r.reclaimId === action.reclaimId
          && ['reclaiming', 'reclaimed', 'released'].includes(r.phase), 'RECLAIM_FENCE_REQUIRED')
        requireValue(r.allocations.every(a => a.removed), 'PHYSICAL_REMOVAL_NOT_CONFIRMED')
        if (r.phase !== 'released') { r.phase = 'released'; r.releasedBytes = r.reservedBytes; r.currentHeldBytes = 0; changed = true }
        break
      }
      case 'retire-to-control': {
        requireValue(text(action.reclaimId) && text(action.writerFenceId), 'WRITER_FENCE_REQUIRED')
        const control = action.control
        requireValue(object(control) && control.stageId === r.binding.stageId && text(control.allocationId) && control.offset === 0
          && uint(control.bytes) && control.bytes > 0 && hex(control.sha256)
          && isDeepStrictEqual(control,action.observedControl), 'RETAINED_CONTROL_UNCONFIRMED')
        if (r.phase === 'reclaimed') {
          const a = allocation(control.allocationId)
          requireValue(r.reclaimId === action.reclaimId && r.writerFenceId === action.writerFenceId && a.kind === 'retained-control'
            && a.chunks[0].bytes === control.bytes && a.chunks[0].sha256 === control.sha256, 'RECLAIM_ID_REUSED')
          break
        }
        requireValue(next.inventoryVerified && (r.phase === 'committed' || r.phase === 'not-committed'), 'ORIGINAL_OUTCOME_UNRESOLVED')
        requireValue(r.revision === action.reservationRevision, 'STALE_WRITER_FENCE')
        requireValue(inspectResourceInventory(state,action.inventory,true).length === 0, 'RECLAMATION_INVENTORY_MISMATCH')
        requireValue(r.allocations.every(a => a.removed || a.chunks.every(c => c.status === 'present')), 'RECLAMATION_INVENTORY_UNCERTAIN')
        requireValue(!r.allocations.some(a => a.allocationId === control.allocationId), 'ALLOCATION_IDENTITY_REUSED')
        // Charge the transition copy BEFORE retiring old representations. This
        // peak remains visible; reclamation cannot rescue an over-budget writer.
        const peak = plus(usage(r).occupiedUpperBoundBytes,control.bytes)
        requireValue(peak <= r.currentHeldBytes, 'RESERVATION_EXCEEDED')
        r.peakOccupiedBytes = Math.max(r.peakOccupiedBytes,peak)
        for (const a of r.allocations) a.removed = true
        r.allocations.push({allocationId:control.allocationId,kind:'retained-control',removed:false,
          chunks:[{offset:0,bytes:control.bytes,sha256:control.sha256,status:'present'}]})
        r.reclaimId=action.reclaimId; r.writerFenceId=action.writerFenceId; r.phase='reclaimed'
        r.currentHeldBytes=control.bytes; r.releasedBytes=r.reservedBytes-control.bytes; r.retainedControlBytes=control.bytes; changed=true
        break
      }
      default: throw new ResourceAccountingError('UNKNOWN_RESOURCE_ACTION')
    }
  }
  if (!changed) return { state, disposition: 'replayed', ...(issues ? { inventoryIssues: issues } : {}) }
  next.revision = plus(next.revision, 1)
  if (touched) { touched.revision = next.revision; touched.peakOccupiedBytes = Math.max(touched.peakOccupiedBytes,usage(touched).occupiedUpperBoundBytes) }
  assertResourceLedger(next)
  return { state: freeze(next), disposition: 'applied', ...(issues ? { inventoryIssues: issues } : {}) }
}
