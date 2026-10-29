import type { Opportunity } from './model.js'
import type { PJSDASSnapshot } from './snapshot.js'

/** Shared by semantic confirmation and fresh first-party domain admission.
 * Zero capacity is still governance; an absent group or blank rule is not. */
export function applicationGroupGoverned(snapshot: PJSDASSnapshot, opportunity: Opportunity) {
  if (!opportunity.applicationGroupId) return false
  const group = snapshot.data.applicationGroups.find(item => item.id === opportunity.applicationGroupId)
  if (!group) return false
  return Boolean(group.locked || group.total !== undefined || group.remaining !== undefined || group.rule?.trim())
}
