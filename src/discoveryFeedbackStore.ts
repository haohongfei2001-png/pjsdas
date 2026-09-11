import { dbPromise } from './db.js'
import type { TimelineRecord } from './model.js'

export async function saveDiscoveryFeedbackRecords(records: TimelineRecord[]) {
  if (!records.length) return
  const db = await dbPromise
  const tx = db.transaction('timeline', 'readwrite')
  const store = tx.objectStore('timeline')
  for (const record of records) await store.put(record)
  await tx.done
}
