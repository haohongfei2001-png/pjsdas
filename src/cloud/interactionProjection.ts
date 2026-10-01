import { applyDomainCompensation, applyUserDomainCommand, type DomainCompensation, type UserDomainCommand } from '../domainCommands.js'
import type { PJSDASSnapshot } from '../snapshot.js'
import { DELTA_COLLECTIONS, diffWorkspaceDelta, patchDeltaRow, sameValue, type WorkspaceDelta } from '../workspaceDelta.js'
import { INSTANT_COMMAND_KINDS } from '../instantCommandKinds.js'

/** The normal domain kernel runs on a bounded object closure, never historical audit rows. */
function interactionLens(snapshot: PJSDASSnapshot, command: UserDomainCommand): PJSDASSnapshot {
  if (!INSTANT_COMMAND_KINDS.has(command.kind)) throw new Error('This operation does not support an immediate projection.')
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
  const opportunities = snapshot.data.opportunities.filter(item => opportunityIds.has(item.id))
  const groupIds = new Set([...opportunities, ...actions].flatMap(item => item.applicationGroupId ? [item.applicationGroupId] : []))
  return { ...snapshot, data: {
    opportunities, actions,
    processes: snapshot.data.processes.filter(item => Boolean(item.opportunityId && opportunityIds.has(item.opportunityId))),
    processEvents: snapshot.data.processEvents.filter(item => Boolean(item.opportunityId && opportunityIds.has(item.opportunityId))),
    scheduleNodes: nodes.filter(item => item.occurrenceId === occurrenceId || item.relatedActionIds.some(id => actionIds.has(id))
      || Boolean(item.opportunityId && opportunityIds.has(item.opportunityId))),
    prep: [], applicationGroups: snapshot.data.applicationGroups.filter(item => groupIds.has(item.id)), timeline: [], timePlanning: snapshot.data.timePlanning,
  } }
}
export function interactionProjection(snapshot: PJSDASSnapshot, command: UserDomainCommand, baseRevision: number, now = new Date()) {
  const lens = interactionLens(snapshot, command)
  const result = applyUserDomainCommand(lens, command, now)
  if (result.status === 'NEEDS_CONFIRMATION') throw new Error(result.summary)
  return { delta: diffWorkspaceDelta(lens, result.snapshot, baseRevision), compensation: result.status === 'APPLIED' ? result.compensation : undefined }
}

/** User Undo follows the authoritative compensation; rejection rollback is a separate exact inverse. */
export function undoInteractionProjection(snapshot: PJSDASSnapshot, command: UserDomainCommand | undefined,
  compensation: DomainCompensation | undefined, targetDelta: WorkspaceDelta, baseRevision: number, now = new Date()) {
  if (!command || !compensation) throw new Error('这次操作没有安全撤销依据，请核对最新记录。')
  const lens = interactionLens(snapshot, command)
  // Occurrence compensation restores a captured whole node. A local edit to
  // even an otherwise unchanged node field must not be erased by that restore.
  for (const prior of [compensation.payload?.node, compensation.payload?.previousNode].filter(Boolean)) {
    const change = targetDelta.changes.find(item => item.collection === 'scheduleNodes' && item.id === prior.id)
    const expected = change ? patchDeltaRow(prior, change, false) : prior
    if (!sameValue(lens.data.scheduleNodes?.find(node => node.id === prior.id), expected))
      throw new Error('安排已变化，无法安全撤销；没有覆盖新修改。')
  }
  for (const change of targetDelta.changes.filter(item => item.collection !== 'timeline')) {
    const value = lens.data[change.collection]
    const current = (DELTA_COLLECTIONS as readonly string[]).includes(change.collection)
      ? (value as Array<{ id: string }> | undefined)?.find(item => item.id === change.id) ?? null : value ?? null
    const matches = !change.before || !change.after ? sameValue(current, change.after)
      : current && Object.keys({ ...change.before, ...change.after }).every(key => sameValue((current as Record<string, unknown>)[key], change.after![key]))
    if (!matches) throw new Error('记录已变化，无法安全撤销；没有覆盖新修改。')
  }
  const restored = applyDomainCompensation(lens, compensation, now)
  return diffWorkspaceDelta(lens, restored, baseRevision)
}
