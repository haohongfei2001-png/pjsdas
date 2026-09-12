import { dbPromise } from './db.js'
import type { PJSDASSnapshot } from './snapshot.js'
import { auditWorkspaceIntegrity } from './workspaceIntegrity.js'

/**
 * Read raw persistence stores deliberately. Normal PJSDAS getters reconcile
 * process-event Actions and overlay effective stages for product UX; integrity
 * auditing must see the stored baseline so it can report those gaps instead of
 * hiding them behind read-time repair.
 */
export async function auditLocalWorkspaceIntegrity(now = new Date()) {
  const db = await dbPromise
  const [opportunities, processEvents, actions] = await Promise.all([
    db.getAll('opportunities'),
    db.getAll('processEvents'),
    db.getAll('actions'),
  ])

  const snapshot = {
    data: {
      opportunities,
      processEvents,
      actions,
    },
  } as unknown as PJSDASSnapshot

  return auditWorkspaceIntegrity(snapshot, now)
}
