import type { PJSDASSnapshot, SnapshotData } from './snapshot.js'

export const DELTA_COLLECTIONS = ['opportunities', 'processes', 'processEvents', 'scheduleNodes', 'actions', 'prep',
  'applicationGroups', 'decisionRequests', 'semanticReceipts', 'reminderIntents', 'reminderOutbox', 'discoveryInbox', 'timeline', 'changeSets'] as const
export const DELTA_SINGLETONS = ['timePlanning', 'decisionRules', 'discoveryProfile', 'meta'] as const
export type DeltaKey = typeof DELTA_COLLECTIONS[number] | typeof DELTA_SINGLETONS[number]
export type DeltaRow = Record<string, unknown>
export interface EntityDelta { collection: DeltaKey; id: string; before: DeltaRow | null; after: DeltaRow | null }
export interface WorkspaceDelta { contract: 'delta-v1'; baseRevision: number; changes: EntityDelta[] }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, canonical(v)]))
  return value
}
export const sameValue = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))

/** Field-scoped compare-and-patch: unrelated newer fields are never replaced. */
export function patchDeltaRow(current: DeltaRow | null, change: EntityDelta, check = true): DeltaRow | null {
  if (!change.before || !change.after) {
    if (check && !sameValue(current, change.before) && !sameValue(current, change.after)) throw new Error('LOCAL_FIELD_CONFLICT')
    return change.after
  }
  if (!current) throw new Error('LOCAL_OBJECT_MISSING')
  const next = { ...current }
  for (const key of new Set([...Object.keys(change.before), ...Object.keys(change.after)])) {
    if (check && !sameValue(current[key], change.before[key]) && !sameValue(current[key], change.after[key])) throw new Error('LOCAL_FIELD_CONFLICT')
    if (sameValue(change.before[key], change.after[key])) continue
    if (key in change.after) next[key] = change.after[key]
    else delete next[key]
  }
  return next
}
function compactEntityDelta(change: EntityDelta): EntityDelta {
  if (!change.before || !change.after) return change
  const before: DeltaRow = {}, after: DeltaRow = {}
  for (const key of new Set([...Object.keys(change.before), ...Object.keys(change.after)])) {
    if (key !== 'id' && sameValue(change.before[key], change.after[key])) continue
    if (key in change.before) before[key] = change.before[key]
    if (key in change.after) after[key] = change.after[key]
  }
  return { ...change, before, after }
}
export function diffWorkspaceDelta(before: PJSDASSnapshot, after: PJSDASSnapshot, baseRevision = 0): WorkspaceDelta {
  const changes: EntityDelta[] = []
  const row = (value: unknown) => value ? value as DeltaRow : null
  for (const collection of DELTA_COLLECTIONS) {
    const left = new Map((before.data[collection] ?? []).map(item => [item.id, item]))
    const right = new Map((after.data[collection] ?? []).map(item => [item.id, item]))
    for (const id of new Set([...left.keys(), ...right.keys()])) {
      if (!sameValue(left.get(id), right.get(id))) changes.push(compactEntityDelta({ collection, id, before: row(left.get(id)), after: row(right.get(id)) }))
    }
  }
  for (const collection of DELTA_SINGLETONS) {
    if (!sameValue(before.data[collection], after.data[collection])) changes.push(compactEntityDelta({ collection, id: 'current',
      before: row(before.data[collection]), after: row(after.data[collection]) }))
  }
  return { contract: 'delta-v1', baseRevision, changes }
}
export function applyWorkspaceDelta(snapshot: PJSDASSnapshot, delta: WorkspaceDelta, check = true): PJSDASSnapshot {
  const data: Record<string, unknown> = { ...snapshot.data }
  const groups = new Map<DeltaKey, EntityDelta[]>()
  for (const change of delta.changes) groups.set(change.collection, [...(groups.get(change.collection) ?? []), change])
  for (const [key, changes] of groups) {
    if ((DELTA_COLLECTIONS as readonly string[]).includes(key)) {
      const rows = [...(data[key] as DeltaRow[] ?? [])]
      for (const change of changes) {
        const index = rows.findIndex(item => item.id === change.id)
        const next = patchDeltaRow(index < 0 ? null : rows[index], change, check)
        if (next) { if (index < 0) rows.push(next); else rows[index] = next }
        else if (index >= 0) rows.splice(index, 1)
      }
      data[key] = rows
    } else {
      const next = patchDeltaRow(data[key] as DeltaRow ?? null, changes[0], check)
      if (next) data[key] = next
      else delete data[key]
    }
  }
  return { ...snapshot, data: data as unknown as SnapshotData }
}
export function reverseWorkspaceDelta(delta: WorkspaceDelta): WorkspaceDelta {
  return { ...delta, changes: delta.changes.map(change => ({ ...change, before: change.after, after: change.before })) }
}
export function validateWorkspaceDelta(value: unknown): asserts value is WorkspaceDelta {
  const delta = value as WorkspaceDelta
  if (!delta || delta.contract !== 'delta-v1' || !Number.isSafeInteger(delta.baseRevision) || delta.baseRevision < 0
    || !Array.isArray(delta.changes) || delta.changes.length > 1000) throw new Error('Invalid command delta.')
  const keys = new Set<string>()
  for (const change of delta.changes) {
    const key = `${change.collection}:${change.id}`
    if (![...DELTA_COLLECTIONS, ...DELTA_SINGLETONS].includes(change.collection) || !change.id || keys.has(key)
      || [change.before, change.after].some(row => row !== null && (typeof row !== 'object' || Array.isArray(row)))) throw new Error('Invalid entity delta.')
    if ((DELTA_COLLECTIONS as readonly string[]).includes(change.collection)
      && [change.before, change.after].some(row => row !== null && row.id !== change.id)) throw new Error('Invalid delta identity.')
    keys.add(key)
  }
}
