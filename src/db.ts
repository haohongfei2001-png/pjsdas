import { openDB, type DBSchema } from 'idb'
import type { Action, Opportunity, Prep, ProcessRecord } from './model'

interface PJSDASDatabase extends DBSchema {
  opportunities: {
    key: string
    value: Opportunity
  }
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
  prep: {
    key: string
    value: Prep
  }
}

export const dbPromise = openDB<PJSDASDatabase>('pjsdas', 1, {
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
