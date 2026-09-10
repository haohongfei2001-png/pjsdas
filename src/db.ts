import { openDB, type DBSchema } from 'idb'
import { assertImportBundleSafe } from './importDiagnostics'
import type {
  Action,
  ApplicationGroup,
  ImportBundle,
  ImportMeta,
  Opportunity,
  Prep,
  ProcessRecord,
} from './model'

interface PJSDASDatabase extends DBSchema {
  opportunities: { key: string; value: Opportunity }
  processes: {
    key: string
    value: ProcessRecord
    indexes: { 'by-opportunity': string }
  }
  actions: {
    key: string
    value: Action
    indexes: { 'by-opportunity': string }
  }
  prep: { key: string; value: Prep }
  applicationGroups: { key: string; value: ApplicationGroup }
  meta: { key: string; value: ImportMeta }
}

export const dbPromise = openDB<PJSDASDatabase>('pjsdas', 2, {
  upgrade(db) {
    if (!db.objectStoreNames.contains('opportunities')) {
      db.createObjectStore('opportunities', { keyPath: 'id' })
    }
    if (!db.objectStoreNames.contains('processes')) {
      const store = db.createObjectStore('processes', { keyPath: 'id' })
      store.createIndex('by-opportunity', 'opportunityId')
    }
    if (!db.objectStoreNames.contains('actions')) {
      const store = db.createObjectStore('actions', { keyPath: 'id' })
      store.createIndex('by-opportunity', 'opportunityId')
    }
    if (!db.objectStoreNames.contains('prep')) {
      db.createObjectStore('prep', { keyPath: 'id' })
    }
    if (!db.objectStoreNames.contains('applicationGroups')) {
      db.createObjectStore('applicationGroups', { keyPath: 'id' })
    }
    if (!db.objectStoreNames.contains('meta')) {
      db.createObjectStore('meta', { keyPath: 'key' })
    }
  },
})

export async function getAllOpportunities() {
  return (await dbPromise).getAll('opportunities')
}

export async function getAllActions() {
  return (await dbPromise).getAll('actions')
}

export async function getAllProcesses() {
  return (await dbPromise).getAll('processes')
}

export async function getAllPrep() {
  return (await dbPromise).getAll('prep')
}

export async function getAllApplicationGroups() {
  return (await dbPromise).getAll('applicationGroups')
}

export async function getLastImport() {
  return (await dbPromise).get('meta', 'lastImport')
}

export async function updateActionStatus(id: string, status: Action['status']) {
  const db = await dbPromise
  const action = await db.get('actions', id)
  if (!action) return
  await db.put('actions', { ...action, status, updatedAt: new Date().toISOString() })
}

export async function replaceImportedData(bundle: ImportBundle) {
  // Validate before opening the destructive replacement transaction. A malformed
  // future workbook must fail closed instead of partially overwriting good data.
  assertImportBundleSafe(bundle)

  const db = await dbPromise

  // Re-importing an updated spreadsheet must not resurrect actions the user has
  // already completed or skipped. Action IDs are treated as stable source IDs.
  const previousActions = await db.getAll('actions')
  const previousState = new Map(
    previousActions.map((item) => [item.id, { status: item.status, updatedAt: item.updatedAt }]),
  )

  const tx = db.transaction(
    ['opportunities', 'processes', 'actions', 'prep', 'applicationGroups', 'meta'],
    'readwrite',
  )

  await Promise.all([
    tx.objectStore('opportunities').clear(),
    tx.objectStore('processes').clear(),
    tx.objectStore('actions').clear(),
    tx.objectStore('prep').clear(),
    tx.objectStore('applicationGroups').clear(),
    tx.objectStore('meta').clear(),
  ])

  for (const item of bundle.opportunities) await tx.objectStore('opportunities').put(item)
  for (const item of bundle.processes) await tx.objectStore('processes').put(item)
  for (const item of bundle.actions) {
    const previous = previousState.get(item.id)
    await tx.objectStore('actions').put(
      previous
        ? { ...item, status: previous.status, updatedAt: previous.updatedAt }
        : item,
    )
  }
  for (const item of bundle.prep) await tx.objectStore('prep').put(item)
  for (const item of bundle.applicationGroups) await tx.objectStore('applicationGroups').put(item)
  await tx.objectStore('meta').put({ key: 'lastImport', ...bundle.summary })
  await tx.done
}
