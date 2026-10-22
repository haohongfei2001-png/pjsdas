import type { SemanticCandidate, SemanticIntakeObservation } from './model.js'
import type { PJSDASSnapshot } from './snapshot.js'
import { latestScheduleOccurrence } from './scheduleNodes.js'

export function selectedCompletionOpportunity(snapshot: PJSDASSnapshot, contextRefs: readonly string[] = []) {
  const ids = [...new Set(contextRefs.filter(ref => ref.startsWith('opportunity:')).map(ref => ref.slice('opportunity:'.length)))]
  if (!ids.length) return {}
  if (ids.length !== 1 || !snapshot.data.opportunities.some(job => job.id === ids[0])) {
    return { error: '当前岗位上下文已失效或不明确，整条输入尚未保存。请重新打开目标岗位。' }
  }
  return { opportunityId: ids[0]! }
}

// Context is a constraint, never permission or a global fallback. Recheck it
// against the authoritative snapshot, including any explicit occurrence IDs.
export function completionMatchesContext(snapshot: PJSDASSnapshot, candidate: SemanticCandidate, opportunityId: string) {
  const target = candidate.target
  if (target?.opportunityId !== opportunityId) return false
  const nodes = new Map((snapshot.data.scheduleNodes ?? []).map(node => [node.occurrenceId, latestScheduleOccurrence(snapshot.data.scheduleNodes ?? [], node.occurrenceId)!]))
  const eligible = [...nodes.values()].filter(node => node.opportunityId === opportunityId
    && !['completed', 'cancelled', 'superseded'].includes(node.state)
    && (!target.occurrenceKind || node.kind === target.occurrenceKind))
  const explicitNode = target.scheduleNodeId ? snapshot.data.scheduleNodes?.find(node => node.id === target.scheduleNodeId) : undefined
  if (target.scheduleNodeId && !explicitNode) return false
  if (explicitNode && target.occurrenceId && explicitNode.occurrenceId !== target.occurrenceId) return false
  const occurrenceId = target.occurrenceId ?? explicitNode?.occurrenceId
  return eligible.some(node => !occurrenceId || node.occurrenceId === occurrenceId)
}

export function contextualCompletionsMatch(snapshot: PJSDASSnapshot, observation: SemanticIntakeObservation) {
  const completions = observation.candidates.filter(candidate => candidate.kind === 'occurrence_completed')
  if (!completions.length) return true
  const context = selectedCompletionOpportunity(snapshot, observation.contextRefs)
  if (context.error) return false
  return !context.opportunityId || completions.every(candidate => completionMatchesContext(snapshot, candidate, context.opportunityId!))
}

export function semanticContextKey(contextRefs: readonly string[] = []) {
  return JSON.stringify([...new Set(contextRefs)].sort())
}
