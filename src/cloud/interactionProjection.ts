import { applyUserDomainCommand, type UserDomainCommand } from '../domainCommands.js'
import type { PJSDASSnapshot } from '../snapshot.js'
import { diffWorkspaceDelta } from '../workspaceDelta.js'

const SUPPORTED = new Set(['set_action_status', 'record_application_submission', 'set_date_capacity', 'set_daily_capacity', 'set_work_windows',
  'complete_occurrence', 'cancel_occurrence', 'reschedule_occurrence'])
/** The normal domain kernel runs on a bounded object closure, never historical audit rows. */
export function interactionProjection(snapshot: PJSDASSnapshot, command: UserDomainCommand, baseRevision: number, now = new Date()) {
  if (!SUPPORTED.has(command.kind)) throw new Error('This operation does not support an immediate projection.')
  const actionIds = new Set<string>('actionId' in command ? [command.actionId] : [])
  const opportunityIds = new Set<string>('opportunityId' in command ? [command.opportunityId] : [])
  const occurrenceId = 'occurrenceId' in command ? command.occurrenceId : undefined
  const nodes = snapshot.data.scheduleNodes ?? []
  const targetNode = occurrenceId ? nodes.filter(node => node.occurrenceId === occurrenceId) : []
  for (const node of targetNode) {
    node.relatedActionIds.forEach(id => actionIds.add(id))
    if (node.opportunityId) opportunityIds.add(node.opportunityId)
  }
  snapshot.data.actions.filter(item => actionIds.has(item.id)).forEach(item => { if (item.opportunityId) opportunityIds.add(item.opportunityId) })
  const actions = snapshot.data.actions.filter(item => actionIds.has(item.id) || Boolean(item.opportunityId && opportunityIds.has(item.opportunityId)))
  actions.forEach(item => actionIds.add(item.id))
  const lens: PJSDASSnapshot = { ...snapshot, data: {
    opportunities: snapshot.data.opportunities.filter(item => opportunityIds.has(item.id)), actions,
    processes: snapshot.data.processes.filter(item => Boolean(item.opportunityId && opportunityIds.has(item.opportunityId))),
    processEvents: snapshot.data.processEvents.filter(item => Boolean(item.opportunityId && opportunityIds.has(item.opportunityId))),
    scheduleNodes: nodes.filter(item => item.occurrenceId === occurrenceId || item.relatedActionIds.some(id => actionIds.has(id))
      || Boolean(item.opportunityId && opportunityIds.has(item.opportunityId))),
    prep: [], applicationGroups: [], timeline: [], timePlanning: snapshot.data.timePlanning,
  } }
  const result = applyUserDomainCommand(lens, command, now)
  if (result.status === 'NEEDS_CONFIRMATION') throw new Error(result.summary)
  return { delta: diffWorkspaceDelta(lens, result.snapshot, baseRevision), compensation: result.status === 'APPLIED' ? result.compensation : undefined }
}
