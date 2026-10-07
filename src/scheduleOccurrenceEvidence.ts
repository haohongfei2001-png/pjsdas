import type { ScheduleNode, TimelineRecord } from './model.js'

export function recruitingScheduleNode(node: ScheduleNode) {
  return ['application_deadline', 'assessment', 'written_test', 'interview'].includes(node.kind)
}

// Upgrade observations do not prove when an action or occurrence completed.
export function syntheticActionBackfill(item: TimelineRecord) {
  return item.kind === 'action_status_changed' && item.source === 'system'
    && item.id.startsWith('timeline:backfill-action:')
}

export function indexScheduleOccurrenceEvidence(timeline: TimelineRecord[]) {
  const actionFacts = new Map<string, TimelineRecord[]>()
  const occurrenceFacts = new Map<string, TimelineRecord[]>()
  const submissions = new Map<string, TimelineRecord[]>()
  const append = (map: Map<string, TimelineRecord[]>, key: string, fact: TimelineRecord) => {
    const values = map.get(key)
    if (values) values.push(fact)
    else map.set(key, [fact])
  }
  for (const fact of timeline) {
    if (fact.kind === 'action_status_changed' && fact.actionId && !syntheticActionBackfill(fact)) append(actionFacts, fact.actionId, fact)
    if (fact.kind === 'semantic_intake_applied' && fact.scheduleNodeId
      && ['complete_occurrence', 'cancel_occurrence'].includes(fact.commandOperation ?? '')) append(occurrenceFacts, fact.scheduleNodeId, fact)
    if (fact.kind === 'application_submitted' && fact.opportunityId) append(submissions, fact.opportunityId, fact)
  }
  return { actionFacts, occurrenceFacts, submissions }
}

function instant(value: string | undefined) {
  const time = value ? Date.parse(value) : NaN
  return Number.isFinite(time) ? time : undefined
}

/** Display and commands must agree on which terminal states are only task observations. */
export function recruitingOccurrenceNeedsConfirmation(
  node: ScheduleNode,
  evidence: ReturnType<typeof indexScheduleOccurrenceEvidence>,
  now: Date,
) {
  if (!recruitingScheduleNode(node) || !['completed', 'cancelled'].includes(node.state)) return false
  const completed = node.state === 'completed'
  const terminalAt = completed ? node.completedAt : node.cancelledAt
  const terminalTime = instant(terminalAt)
  const matchesTerminal = (fact: TimelineRecord) => {
    const time = instant(fact.occurredAt)
    return time !== undefined && time <= now.getTime() && (terminalTime === undefined || time === terminalTime)
  }
  const typed = (evidence.occurrenceFacts.get(node.id) ?? []).some(fact =>
    fact.commandOperation === (completed ? 'complete_occurrence' : 'cancel_occurrence') && matchesTerminal(fact))
    || Boolean(completed && node.kind === 'application_deadline' && node.opportunityId
      && evidence.submissions.get(node.opportunityId)?.some(matchesTerminal))
  if (typed) return false
  const checkboxOnly = node.relatedActionIds.some(id => (evidence.actionFacts.get(id) ?? []).some(fact =>
    fact.changes?.status?.after === (completed ? 'done' : 'skipped')
    && (!terminalAt || instant(fact.occurredAt) !== undefined && instant(fact.occurredAt) === terminalTime)))
  return checkboxOnly || completed && node.temporal.resolutionBasis === 'legacy_projection' && !node.completedAt
}
