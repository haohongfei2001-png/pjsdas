import { dbPromise } from './db.js'
import { reconcileProcessEventActions } from './processEvents.js'

/**
 * Mutation review sometimes needs an older process Action that is intentionally
 * hidden from Today because a later recruiting stage superseded it. This reader
 * returns the complete stored/reconstructed process-action baseline without
 * applying UI visibility suppression.
 *
 * It is mutation support only; normal product reads should continue using
 * getAllActions(), which hides superseded tasks.
 */
export async function getAllActionsForMutationBaseline() {
  const db = await dbPromise
  const [actions, events] = await Promise.all([
    db.getAll('actions'),
    db.getAll('processEvents'),
  ])
  return reconcileProcessEventActions(actions, events)
}
