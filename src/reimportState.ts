import type { Action } from './model'

/**
 * Rebuild the action store for a spreadsheet re-import without resurrecting
 * actions the user already completed/skipped and without deleting local actions
 * that do not live in the workbook. For locally-managed Opportunities, the
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
      { status: item.status, updatedAt: item.updatedAt },
    ]),
  )

  const mergedImported = importedSafe.map((item) => {
    const previous = previousState.get(item.id)
    return previous
      ? { ...item, status: previous.status, updatedAt: previous.updatedAt }
      : item
  })

  const importedIds = new Set(importedSafe.map((item) => item.id))
  const localActions = previousActions.filter(
    (item) =>
      !importedIds.has(item.id) &&
      (
        Boolean(item.processEventId) ||
        item.sourceLabel === '自然语言更新' ||
        Boolean(item.opportunityId && locallyManagedOpportunityIds.has(item.opportunityId))
      ),
  )

  return [...mergedImported, ...localActions]
}
