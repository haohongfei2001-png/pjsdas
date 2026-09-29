import type { DecisionRequest, Opportunity, ReminderIntent, ScheduleNode } from './model.js'
import { resolveOpportunityTarget } from './semanticTargetMatching.js'

export interface DecisionContext {
  opportunities: Opportunity[]
  scheduleNodes?: ScheduleNode[]
  reminderIntents?: ReminderIntent[]
  now: Date
}

function currentSource(request: DecisionRequest, now: Date) {
  if (request.payloadBinding.source.kind !== 'gmail') return true
  const source = request.payloadBinding.source
  const asserted = Date.parse(source.assertedAt ?? source.observedAt ?? request.createdAt)
  if (!Number.isFinite(asserted)) return false
  const recent = asserted >= now.getTime() - 14 * 24 * 60 * 60_000
  const candidate = request.payloadBinding.candidate
  const temporal = 'temporal' in candidate ? candidate.temporal : undefined
  const future = [
    temporal?.date, temporal?.startAt, temporal?.endAt, temporal?.deadlineAt,
    'dueAt' in candidate ? candidate.dueAt : undefined,
    candidate.kind === 'opportunity_deadline' ? candidate.deadline : undefined,
  ].some(value => value && Date.parse(value) >= now.getTime() - 24 * 60 * 60_000)
  return recent || future
}

/** A read-model rule. It never changes a stored request or its audit trail. */
export function actionableDecision(request: DecisionRequest, context: DecisionContext): boolean {
  if (request.state !== 'open' || (request.expiresAt && Date.parse(request.expiresAt) < context.now.getTime())) return false
  if (!currentSource(request, context.now)) return false
  if (request.choices.length < 2 || request.choices.length > 4) return false
  const candidate = request.payloadBinding.candidate
  const opportunityIds = new Set(context.opportunities.filter(item => item.processStage !== 'closed').map(item => item.id))
  const nodeIds = new Set((context.scheduleNodes ?? []).filter(item =>
    item.state !== 'cancelled' && item.state !== 'completed' && item.state !== 'superseded').map(item => item.occurrenceId))
  const choices = request.choices
  if (request.reason === 'missing_required_field') {
    if (candidate.kind !== 'reminder_cancelled') return false
    const ids = choices.map(item => item.resolution?.reminderIntentId)
    const occurrence = candidate.target?.occurrenceId
      ? (context.scheduleNodes ?? []).filter(item => item.occurrenceId === candidate.target?.occurrenceId)
        .sort((a, b) => b.version - a.version)[0]
      : undefined
    if (candidate.target?.occurrenceId && !occurrence) return false
    const active = (context.reminderIntents ?? []).filter(item => item.state !== 'cancelled'
      && (!candidate.purpose || item.purpose === candidate.purpose)
      && (!candidate.target?.scheduleNodeId || item.scheduleNodeId === candidate.target.scheduleNodeId)
      && (!occurrence || item.scheduleNodeId === occurrence.id))
    return ids.every((id): id is string => Boolean(id && active.some(item => item.id === id)))
      && new Set(ids).size === ids.length
      && new Set(choices.map(item => item.label.trim())).size === choices.length
      && active.length === ids.length
  }
  if (request.reason === 'low_confidence' && request.payloadBinding.source.kind === 'gmail') return false
  if (request.reason === 'ambiguous_target') {
    if (candidate.eventConfidence !== 'high'
      || (candidate.temporalConfidence && candidate.temporalConfidence !== 'high')) return false
    if (!candidate.target?.company?.trim() && !candidate.target?.role?.trim()) return false
    const ids = choices.map(item => item.resolution?.opportunityId)
    const resolved = resolveOpportunityTarget(context.opportunities, candidate.target)
    if (resolved.status !== 'ambiguous') return false
    const plausible = new Set(resolved.opportunities.map(item => item.id))
    return ids.length >= 2 && ids.every((id): id is string => Boolean(id && opportunityIds.has(id)))
      && new Set(ids).size === ids.length
      && new Set(choices.map(item => item.label.trim())).size === choices.length
      && plausible.size === ids.length
      && ids.every(id => Boolean(id && plausible.has(id)))
  }
  if (request.reason === 'ambiguous_occurrence') {
    if (candidate.eventConfidence !== 'high'
      || (candidate.temporalConfidence && candidate.temporalConfidence !== 'high')) return false
    const ids = choices.map(item => item.resolution?.occurrenceId)
    const latest = new Map<string, ScheduleNode>()
    for (const node of context.scheduleNodes ?? []) {
      const prior = latest.get(node.occurrenceId)
      if (!prior || node.version > prior.version) latest.set(node.occurrenceId, node)
    }
    const plausible = [...latest.values()].filter(node =>
      node.state !== 'cancelled' && node.state !== 'completed' && node.state !== 'superseded'
      && (!candidate.target?.opportunityId || node.opportunityId === candidate.target.opportunityId)
      && (!candidate.target?.occurrenceKind || node.kind === candidate.target.occurrenceKind))
    return ids.length >= 2 && ids.every((id): id is string => Boolean(id && nodeIds.has(id)))
      && new Set(ids).size === ids.length
      && new Set(choices.map(item => item.label.trim())).size === choices.length
      && plausible.length === ids.length
  }
  if (request.payloadBinding.source.kind === 'gmail'
    && (candidate.objectConfidence !== 'high' || candidate.eventConfidence !== 'high'
      || (candidate.temporalConfidence && candidate.temporalConfidence !== 'high'))) return false
  const target = candidate.target
  const hasObject = Boolean(
    (target?.opportunityId && opportunityIds.has(target.opportunityId))
    || (target?.occurrenceId && nodeIds.has(target.occurrenceId))
    || request.affectedObjects.some(item => item.type === 'opportunity' && opportunityIds.has(item.id))
    || (request.payloadBinding.source.kind !== 'gmail' && candidate.kind === 'manual_action' && candidate.title.trim()),
  )
  if (!hasObject) return false
  // Two dismiss/clarify buttons cannot resolve source uncertainty. At least
  // one choice must perform a bounded internal update.
  return choices.some(item => item.resolution?.confirm === true)
    && choices.some(item => item.resolution?.dismiss === true)
}

export function partitionDecisions(requests: DecisionRequest[], context: DecisionContext) {
  const actionable: DecisionRequest[] = []
  const dataQuality: DecisionRequest[] = []
  for (const request of requests.filter(item => item.state === 'open')) {
    if (actionableDecision(request, context)) actionable.push(request)
    else dataQuality.push(request)
  }
  return { actionable, dataQuality }
}
