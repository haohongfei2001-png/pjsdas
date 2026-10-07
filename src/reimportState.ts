import type { Action } from './model.js'

/**
 * Rebuild the action store for a spreadsheet re-import without resurrecting
 * actions the user already completed/skipped or deleting omitted task history.
 * Source omission is not a deletion command. For locally-managed Opportunities, the
 * browser-side action state is authoritative and imported actions for that
 * Opportunity are ignored.
 */
export function mergeActionsForReimport(
  importedActions: Action[],
  previousActions: Action[],
  locallyManagedOpportunityIds: Set<string> = new Set(),
): Action[] {
  const importedSafe = importedActions.filter(
    (item) => !item.opportunityId || !locallyManagedOpportunityIds.has(item.opportunityId),
  )

  const previousState = new Map(
    previousActions.map((item) => [
      item.id,
      { status: item.status, updatedAt: item.updatedAt, plannedDate: item.plannedDate, scheduledTemporal: item.scheduledTemporal, timingContractVersion: item.timingContractVersion, dueAt: item.dueAt, duePrecision: item.duePrecision },
    ]),
  )

  const mergedImported = importedSafe.map((item) => {
    const previous = previousState.get(item.id)
    return previous
      ? { ...item, status: previous.status, updatedAt: previous.updatedAt, plannedDate: previous.plannedDate, scheduledTemporal: previous.scheduledTemporal,
          timingContractVersion: previous.timingContractVersion ?? (previous.dueAt !== item.dueAt || previous.duePrecision !== item.duePrecision ? 2 as const : undefined) }
      : item
  })

  const importedIds = new Set(importedSafe.map((item) => item.id))
  // Source omission is not a deletion command. Retain prior task/history rows,
  // including unacted pre-B1 artifacts; Today membership is a separate projection.
  const localActions = previousActions.filter(item => !importedIds.has(item.id))

  return [...mergedImported, ...localActions]
}
