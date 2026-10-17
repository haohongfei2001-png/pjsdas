// Frozen pre-indexing oracle from 99cec9a96750610f451af234ec8484725ca8e155.
// Do not optimize this intentionally scan-based reference together with production.
import { confirmedApplicationNode, resolveApplicationDeadline } from '../../src/applicationDeadline.js'
import { actionDeadline, hasKnownActionTiming, type ActionTimingOwner, type DeadlineOrderValue } from '../../src/deadlineOrder.js'
import type { Action, Opportunity, ProcessEvent, ScheduleNode } from '../../src/model.js'

export function referenceActionNodesById(nodes: ScheduleNode[], actions: Action[] = [], opportunities: Opportunity[] = [], processEvents: ProcessEvent[] = []) {
  const actionsById = new Map(actions.map(action => [action.id, action]))
  const eventActions = new Map<string, Action[]>()
  const applicationActions = new Map<string, Action[]>()
  for (const action of actions) {
    if (action.processEventId) eventActions.set(action.processEventId, [...(eventActions.get(action.processEventId) ?? []), action])
    if (action.kind === 'apply' && action.opportunityId) applicationActions.set(action.opportunityId, [...(applicationActions.get(action.opportunityId) ?? []), action])
  }
  const latest = new Map<string, ScheduleNode>()
  for (const node of nodes) {
    const previous = latest.get(node.occurrenceId)
    if (!previous || node.version > previous.version) latest.set(node.occurrenceId, node)
  }
  const byAction = new Map<string, ActionTimingOwner>()
  const ownersByAction = new Map<string, ScheduleNode[]>()
  for (const node of latest.values()) {
    // Canonical ownership may precede a generated action, so explicit entity
    // identity also establishes the relationship without fabricating stored links.
    const byEvent = node.processEventId ? (eventActions.get(node.processEventId) ?? [])
      .filter(action => !node.opportunityId || !action.opportunityId || node.opportunityId === action.opportunityId) : []
    const byApplication = node.kind === 'application_deadline' && node.opportunityId
      ? applicationActions.get(node.opportunityId) ?? [] : []
    const ids = new Set([...node.relatedActionIds, ...byEvent.map(action => action.id), ...byApplication.map(action => action.id)])
    for (const id of ids) {
      ownersByAction.set(id, [...(ownersByAction.get(id) ?? []), node])
      const previous = byAction.get(id)
      // Retain a terminal owner so consumers cannot mistake withdrawal for no
      // canonical history and revive a retained raw action date. An independent
      // live occurrence still owns the action even if a tombstone has a higher version.
      const active = node.state !== 'cancelled' && node.state !== 'superseded'
      const previousActive = previous && previous.state !== 'cancelled' && previous.state !== 'superseded'
      if (!previous || active && !previousActive || active === previousActive
        && (node.version > previous.version || node.version === previous.version && node.id.localeCompare(previous.id) < 0)) byAction.set(id, node)
    }
  }
  for (const [id, owners] of ownersByAction) {
    const action = actionsById.get(id)
    if (action?.processEventId) {
      const processOwners = owners.filter(node => node.processEventId === action.processEventId && hasKnownActionTiming(node))
      const facts = new Set(processOwners.map(node => {
        const value = actionDeadline(action, node)
        return JSON.stringify([node.temporal.shape, value.precision,
          value.precision === 'date' ? [value.deadline, value.timezone] : value.deadline ? Date.parse(value.deadline) : null])
      }))
      if (facts.size > 1) {
        byAction.set(id, { ...byAction.get(id)!, timingUnknown: true })
        continue
      }
    }
    const applications = owners.filter(node => node.kind === 'application_deadline' && (!action?.opportunityId || node.opportunityId === action.opportunityId))
    if ((action && action.kind !== 'apply') || !applications.length) continue
    const confirmed = confirmedApplicationNode(applications)
    // This is a derived unknown result, never a stored node, state transition or
    // guessed source choice. Every reader must honor canonical source conflict.
    byAction.set(id, confirmed?.node ?? { ...byAction.get(id)!, timingUnknown: true })
  }
  for (const action of actions) {
    const event = processEvents.find(item => item.id === action.processEventId && !item.invalidation)
    if (!byAction.has(action.id) && event?.temporal && ['deadline', 'date_only', 'availability_window'].includes(event.temporal.shape) && event.timingMode !== 'fixed') {
      byAction.set(action.id, { projectionOnly: true, id: `process-obligation:${event.id}`, occurrenceId: `process-obligation:${event.id}`, version: 1,
        opportunityId: event.opportunityId, processEventId: event.id, kind: event.type === 'written_test_invite' ? 'written_test' : 'assessment',
        state: 'scheduled', temporal: structuredClone(event.temporal), constraintKind: 'employer_hard',
        relatedActionIds: [action.id], relatedPrepIds: [], evidenceRefs: [`process-event:${event.id}`], sourceVersionRefs: [], createdAt: event.createdAt, updatedAt: event.updatedAt })
    }
  }
  for (const action of actions) {
    if (action.timingContractVersion === 2 && byAction.has(action.id) && !action.processEventId) {
      const original = byAction.get(action.id)!
      byAction.set(action.id, { ...original, id: `action-deadline-fact:${action.id}`, occurrenceId: `action-deadline-fact:${action.id}`, projectionOnly: true,
        state: action.dueAt ? 'scheduled' : 'cancelled',
        temporal: { shape: action.duePrecision === 'date' ? 'date_only' : 'deadline', precision: action.duePrecision ?? 'datetime',
          timezone: action.duePrecision === 'date' ? 'floating-date' : 'source-offset', resolutionBasis: 'user_explicit',
          date: action.duePrecision === 'date' ? action.dueAt?.slice(0, 10) : undefined,
          deadlineAt: action.duePrecision === 'date' ? undefined : action.dueAt },
        completionDeadline: { id: action.id, deadline: action.dueAt, precision: action.duePrecision } })
    }
    const opportunity = opportunities.find(item => item.id === action.opportunityId)
    let deadline: DeadlineOrderValue | undefined
    if (action.kind === 'apply' && opportunity?.detail?.deadlineCorrections?.at(-1)?.acknowledgedNodeFacts !== undefined) {
      const fact = resolveApplicationDeadline(opportunity, { scheduleNodes: nodes })
      deadline = { id: action.id, deadline: fact.deadline, precision: fact.precision, timezone: fact.timezone }
      byAction.set(action.id, {
        projectionOnly: true, id: `deadline-fact:${action.id}`, occurrenceId: `deadline-fact:${action.id}`, version: 1,
        opportunityId: opportunity.id, kind: 'application_deadline', state: fact.state === 'confirmed' ? 'scheduled' : 'cancelled',
        temporal: { shape: fact.precision === 'date' ? 'date_only' : 'deadline', precision: fact.precision ?? 'datetime',
          timezone: fact.timezone ?? 'source-offset', date: fact.precision === 'date' ? fact.deadline : undefined,
          deadlineAt: fact.precision === 'date' ? undefined : fact.deadline, resolutionBasis: 'source_explicit' },
        constraintKind: 'employer_hard', relatedActionIds: [action.id], relatedPrepIds: [],
        evidenceRefs: fact.evidenceRefs ?? [], sourceVersionRefs: [], createdAt: action.createdAt, updatedAt: action.updatedAt,
        completionDeadline: deadline,
      })
    }
    const arrangement = [...latest.values()].filter(node => node.constraintKind === 'user_plan'
      && node.kind !== 'application_deadline' && node.relatedActionIds.includes(action.id)
      && node.temporal.resolutionBasis === 'user_explicit' && node.temporal.shape === 'fixed_range')
      .sort((a, b) => b.version - a.version)[0]
    if (arrangement) byAction.set(action.id, { ...arrangement,
      completionDeadline: deadline ?? { id: action.id, deadline: action.dueAt, precision: action.duePrecision } })
  }
  return byAction
}
