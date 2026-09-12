import {
  createProgressChangeSet,
  type ChangeSetOperation,
  type ChangeSetRecord,
} from './changeSet.js'
import { actionForProcessEvent, isActionableProcessEvent } from './processEvents.js'
import type { Action, ProcessEvent } from './model.js'
import type { ExecutableProgressOperation } from './progressUpdate.js'

function latestMatchingEvent(
  operation: Extract<ExecutableProgressOperation, { kind: 'process_event' }>,
  events: ProcessEvent[],
) {
  return events
    .filter((event) =>
      event.opportunityId === operation.opportunityId &&
      event.type === operation.eventType,
    )
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.updatedAt.localeCompare(a.updatedAt))[0]
}

function completionStatusOperation(action: Action): ChangeSetOperation {
  return {
    id: `action:${action.id}:done`,
    kind: 'set_action_status',
    summary: action.status === 'done' ? `已完成｜${action.title}` : `完成｜${action.title}`,
    actionId: action.id,
    expectedStatus: action.status,
    status: 'done',
  }
}

/**
 * Natural-language history can say “测评已完成” after the invitation already
 * exists as a Process Event. In that case the correct mutation is to complete
 * the existing event Action, not create a second synthetic assessment event.
 *
 * If no matching visible Action exists, the original progress operation is kept
 * so historical backfill still works for events that were never recorded before.
 */
export function createCanonicalProgressChangeSet(
  operations: ExecutableProgressOperation[],
  events: ProcessEvent[],
  actions: Action[],
  now = new Date(),
): ChangeSetRecord {
  const changeSet = createProgressChangeSet(operations, now)
  const actionsById = new Map(actions.map((action) => [action.id, action]))
  const replacements = new Map<string, ChangeSetOperation>()

  for (const operation of operations) {
    if (operation.kind !== 'process_event' ||
      !operation.completed ||
      !isActionableProcessEvent(operation.eventType)) continue

    const existingEvent = latestMatchingEvent(operation, events)
    if (!existingEvent) continue
    const generated = actionForProcessEvent(existingEvent)
    if (!generated) continue
    const existingAction = actionsById.get(generated.id)
    if (!existingAction) continue

    replacements.set(`progress:${operation.id}`, completionStatusOperation(existingAction))
  }

  if (replacements.size === 0) return changeSet
  return {
    ...changeSet,
    operations: changeSet.operations.map((operation) => replacements.get(operation.id) ?? operation),
  }
}
