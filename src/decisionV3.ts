export * from './decisionCoreV3'

import { rankActions as rankActionsCore } from './decisionCoreV3'
import { isUnresolvedPastProcessEvent } from './fixedEventGuardLogic'
import type { Action, Opportunity } from './model'

export function rankActions(actions: Action[], opportunities: Opportunity[], now = new Date()) {
  const actionable = actions.filter((action) => !isUnresolvedPastProcessEvent(action, now))
  return rankActionsCore(actionable, opportunities, now)
}
