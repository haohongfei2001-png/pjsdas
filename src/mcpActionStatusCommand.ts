import { applyUserDomainCommand } from './domainCommands.js'
import { upgradeSnapshotToLatest, validateSnapshot, type PJSDASSnapshot } from './snapshot.js'
import { timelineFromChangeSetApplied } from './timeline.js'
import type { McpProposalEnvelope } from './ai/mcpProposal.js'

// The gateway verifies the signed token, account and exact transactional
// fingerprint before calling this reducer. All operations commit together.
export function applyMcpActionStatusCommand(snapshot: PJSDASSnapshot, proposal: McpProposalEnvelope, now = new Date()) {
  const changeSet = proposal.changeSet
  if (changeSet.source !== 'mcp' || changeSet.status !== 'pending' || !changeSet.operations.length ||
    changeSet.operations.some((operation) => operation.kind !== 'set_action_status')) {
    throw new Error('Only a pending MCP action-status proposal can use this command.')
  }
  let next = upgradeSnapshotToLatest(snapshot)
  if ((next.data.changeSets ?? []).some((item) => item.id === changeSet.id)) {
    throw new Error('The signed proposal ChangeSet ID conflicts with existing workspace history.')
  }
  const seen = new Set<string>()
  const previous: Array<{ actionId: string; status: string }> = []
  for (const operation of changeSet.operations) {
    if (operation.kind !== 'set_action_status') throw new Error('Action-status proposal contains another operation type.')
    if (seen.has(operation.actionId)) throw new Error('Action-status proposal changes the same Action more than once.')
    seen.add(operation.actionId)
    const action = next.data.actions.find((item) => item.id === operation.actionId)
    if (!action || action.status !== operation.expectedStatus || action.status === operation.status) {
      throw new Error(`Action ${operation.actionId} changed since the signed proposal was prepared.`)
    }
    previous.push({ actionId: action.id, status: action.status })
    const evaluated = applyUserDomainCommand(next, {
      commandId: `mcp:${changeSet.id}:${operation.id}`,
      kind: 'set_action_status', actionId: action.id, status: operation.status,
    }, now)
    if (evaluated.status !== 'APPLIED') throw new Error(`Action ${action.id} could not be applied.`)
    next = evaluated.snapshot
  }
  const timestamp = now.toISOString()
  const applied = { ...changeSet, status: 'applied' as const, appliedAt: timestamp, updatedAt: timestamp }
  next.data.changeSets = [...(next.data.changeSets ?? []), applied]
  next.data.timeline = [...(next.data.timeline ?? []), timelineFromChangeSetApplied(applied)]
  next.exportedAt = timestamp
  validateSnapshot(next)
  return {
    status: 'APPLIED' as const, changed: true, snapshot: next,
    summary: `Applied ${changeSet.operations.length} reviewed Action status changes.`,
    compensation: { operation: 'mcp_action_status_batch', payload: { previous } },
  }
}
