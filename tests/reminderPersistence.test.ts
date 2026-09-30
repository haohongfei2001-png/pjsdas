import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const db = readFileSync(new URL('../src/db.ts', import.meta.url), 'utf8')

describe('UU-07 reminder persistence', () => {
  it('persists ReminderIntent and reminder outbox in IndexedDB v12 and snapshot flows', () => {
    expect(db).toContain("openDB<PJSDASDatabase>('pjsdas', 13")
    expect(db).toContain("db.createObjectStore('reminderIntents'")
    expect(db).toContain("store.createIndex('by-dedupe-key', 'dedupeKey', { unique: true })")
    expect(db).toContain("db.createObjectStore('reminderOutbox'")
    expect(db).toContain("tx.objectStore('reminderIntents').getAll()")
    expect(db).toContain("tx.objectStore('reminderOutbox').getAll()")
    expect(db).toContain("tx.objectStore('reminderIntents').put(item)")
    expect(db).toContain("tx.objectStore('reminderOutbox').put(item)")
  })
})
