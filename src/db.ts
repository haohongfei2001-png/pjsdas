import { openDB, type DBSchema } from 'idb'
import { assertImportBundleSafe } from './importDiagnostics'
import {
  actionForProcessEvent,
  overlayProcessEventsOnOpportunities,
  overlayProcessEventsOnProcesses,
} from './processEvents'
import type {
  Action,
  ApplicationGroup,
  ImportBundle,
  ImportMeta,
  Opportunity,
  Prep,
  ProcessEvent,
  ProcessRecord,
} from './model'

interface PJSDASDatabase extends DBSchema {
  opportunities: { key: string; value: Opportunity }
  processes: {
    key: string
    value: ProcessRecord
    indexes: { 'by-opportunity': string }
  }
  processEvents: {
    key: string
    value: ProcessEvent
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

export const dbPromise = openDB<PJSDASDatabase>('pjsdas', 3, {
  upgrade(db) {
    if (!db.objectStoreNames.contains('opportunities')) {
      db.createObjectStore('opportunities', { keyPath: 'id' })
    }
    if (!db.objectStoreNames.contains('processes')) {
      const store = db.createObjectStore('processes', { keyPath: 'id' })
      store.createIndex('by-opportunity', 'opportunityId')
    }
    if (!db.objectStoreNames.contains('processEvents')) {
      const store = db.createObjectStore('processEvents', { keyPath: 'id' })
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
  const db = await dbPromise
  const [opportunities, processes, events] = await Promise.all([
    db.getAll('opportunities'),
    db.getAll('processes'),
    db.getAll('processEvents'),
  ])
  return overlayProcessEventsOnOpportunities(opportunities, events, processes)
}

export async function getAllActions() {
  return (await dbPromise).getAll('actions')
}

export async function getAllProcesses() {
  const db = await dbPromise
  const [processes, opportunities, events] = await Promise.all([
    db.getAll('processes'),
    db.getAll('opportunities'),
    db.getAll('processEvents'),
  ])
  return overlayProcessEventsOnProcesses(processes, opportunities, events)
}

export async function getAllProcessEvents() {
  return (await dbPromise).getAll('processEvents')
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

export async function addProcessEvent(event: ProcessEvent) {
  const db = await dbPromise
  const tx = db.transaction(['processEvents', 'actions'], 'readwrite')
  await tx.objectStore('processEvents').put(event)
  const action = actionForProcessEvent(event)
  if (action) await tx.objectStore('actions').put(action)
  await tx.done
}

export async function deleteProcessEvent(id: string) {
  const db = await dbPromise
  const tx = db.transaction(['processEvents', 'actions'], 'readwrite')
  await tx.objectStore('processEvents').delete(id)
  await tx.objectStore('actions').delete(`event-action:${id}`)
  await tx.done
}

export async function replaceImportedData(bundle: ImportBundle) {
  // Validate before opening the destructive replacement transaction. A malformed
  // future workbook must fail closed instead of partially overwriting good data.
  assertImportBundleSafe(bundle)

  const db = await dbPromise

  // Re-importing an updated spreadsheet must not resurrect actions the user has
  // already completed or skipped. Process-event actions are local records rather
  // than Excel-derived records, so they must survive the replacement entirely.
  const previousActions = await db.getAll('actions')
  const previousState = new Map(
    previousActions.map((item) => [item.id, { status: item.status, updatedAt: item.updatedAt }]),
  )
  const localEventActions = previousActions.filter((item) => item.processEventId)

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
  for (const item of localEventActions) await tx.objectStore('actions').put(item)
  for (const item of bundle.prep) await tx.objectStore('prep').put(item)
  for (const item of bundle.applicationGroups) await tx.objectStore('applicationGroups').put(item)
  await tx.objectStore('meta').put({ key: 'lastImport', ...bundle.summary })
  await tx.done
}
