import { isDeepStrictEqual } from 'node:util'
/** Stage-A lossless JSON-wire codec. Not a rollout or a replacement for domain guards. */
export const workspaceRowCollections = ['opportunities', 'opportunityAliases', 'processes', 'processEvents', 'scheduleNodes', 'actions', 'prep', 'applicationGroups', 'decisionRequests', 'semanticReceipts', 'reminderIntents', 'reminderOutbox', 'discoveryInbox', 'timeline', 'changeSets'] as const
export type RowCollection = typeof workspaceRowCollections[number]
export type JsonObject = Record<string, unknown>
export interface WorkspaceEntityRow { collection: RowCollection; id: string; ordinal: number; value: JsonObject }
export interface WorkspaceRowManifest { collection: RowCollection; count: number }
export interface WorkspaceRowEncoding { contract: 'workspace-rows-v1'; envelope: JsonObject; manifest: WorkspaceRowManifest[]; rows: WorkspaceEntityRow[] }
export interface WorkspaceRowChange { collection: RowCollection; id: string; before: WorkspaceEntityRow | null; after: WorkspaceEntityRow | null }
export interface WorkspaceRowDelta { contract: 'workspace-rows-v1'; beforeEnvelope: JsonObject; afterEnvelope: JsonObject; beforeManifest: WorkspaceRowManifest[]; afterManifest: WorkspaceRowManifest[]; changes: WorkspaceRowChange[] }
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value)
function check(ok: unknown): asserts ok { if (!ok) throw new Error('WORKSPACE_ROWS_INVALID') }
function cloneWire<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
const collection = (value: unknown): value is RowCollection => typeof value === 'string' && (workspaceRowCollections as readonly string[]).includes(value)
export function encodeWorkspaceRows(snapshot: unknown): WorkspaceRowEncoding {
  const envelope = cloneWire(snapshot)
  check(object(envelope) && object(envelope.data))
  const rows: WorkspaceEntityRow[] = [], manifest: WorkspaceRowManifest[] = []
  for (const name of workspaceRowCollections) {
    if (!Object.hasOwn(envelope.data, name)) continue
    const values = envelope.data[name]; check(Array.isArray(values))
    const ids = new Set<string>()
    values.forEach((value: unknown, ordinal: number) => {
      check(object(value) && typeof value.id === 'string' && value.id.length > 0 && !ids.has(value.id))
      ids.add(value.id); rows.push({ collection: name, id: value.id, ordinal, value })
    })
    manifest.push({ collection: name, count: values.length }); delete envelope.data[name]
  }
  return { contract: 'workspace-rows-v1', envelope, manifest, rows }
}
export function decodeWorkspaceRows(input: unknown): JsonObject {
  check(object(input) && input.contract === 'workspace-rows-v1' && Array.isArray(input.rows) && Array.isArray(input.manifest))
  const envelope = cloneWire(input.envelope); check(object(envelope) && object(envelope.data))
  const directory = new Map<RowCollection, number>()
  for (const entry of input.manifest) {
    check(object(entry) && collection(entry.collection) && !directory.has(entry.collection) && Number.isSafeInteger(entry.count) && (entry.count as number) >= 0)
    directory.set(entry.collection, entry.count as number)
  }
  for (const name of workspaceRowCollections) check(!Object.hasOwn(envelope.data, name))
  const grouped = new Map<RowCollection, WorkspaceEntityRow[]>([...directory.keys()].map(name => [name, []]))
  const keys = new Set<string>()
  for (const row of input.rows) {
    check(object(row) && collection(row.collection) && directory.has(row.collection) && typeof row.id === 'string' && row.id.length > 0 && Number.isSafeInteger(row.ordinal) && (row.ordinal as number) >= 0 && object(row.value) && row.value.id === row.id)
    const key = JSON.stringify([row.collection, row.id]); check(!keys.has(key)); keys.add(key)
    grouped.get(row.collection)!.push(row as unknown as WorkspaceEntityRow)
  }
  for (const [name, count] of directory) {
    const values = grouped.get(name)!.sort((a, b) => a.ordinal - b.ordinal); check(values.length === count)
    values.forEach((row, ordinal) => check(row.ordinal === ordinal))
    Object.defineProperty(envelope.data, name, { enumerable: true, configurable: true, writable: true, value: values.map(row => row.value) })
  }
  return envelope
}
/** Full before/after entity images, not the client UI projection delta. */
export function diffWorkspaceRows(before: unknown, after: unknown): WorkspaceRowDelta {
  const left = encodeWorkspaceRows(before), right = encodeWorkspaceRows(after)
  const key = (row: WorkspaceEntityRow) => JSON.stringify([row.collection, row.id])
  const a = new Map(left.rows.map(row => [key(row), row])), b = new Map(right.rows.map(row => [key(row), row]))
  const changes: WorkspaceRowChange[] = []
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const oldRow = a.get(id) ?? null, newRow = b.get(id) ?? null
    if (!isDeepStrictEqual(oldRow, newRow)) changes.push({ collection: (oldRow ?? newRow)!.collection, id: (oldRow ?? newRow)!.id, before: oldRow, after: newRow })
  }
  return { contract: 'workspace-rows-v1', beforeEnvelope: left.envelope, afterEnvelope: right.envelope, beforeManifest: left.manifest, afterManifest: right.manifest, changes }
}
