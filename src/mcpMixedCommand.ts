import { applyMcpActionStatusCommand } from './mcpActionStatusCommand.js'
import { applyMcpProgressCommand } from './mcpProgressCommand.js'
import { applyMcpRulesCommand } from './mcpRulesCommand.js'
import { timelineFromChangeSetApplied } from './timeline.js'
import { upgradeSnapshotToLatest, validateSnapshot, type PJSDASSnapshot } from './snapshot.js'
import type { ChangeSetOperation } from './changeSet.js'
import type { McpProposalEnvelope } from './ai/mcpProposal.js'

// The issuer can combine progress text, Action statuses and a Decision Rules
// patch in one reviewed proposal. Evaluate each family against a private copy;
// the gateway commits only the final combined snapshot and one real ChangeSet.
export function applyMcpMixedCommand(snapshot: PJSDASSnapshot, proposal: McpProposalEnvelope, now = new Date()) {
  const changeSet = proposal.changeSet
  if (changeSet.source !== 'mcp' || changeSet.status !== 'pending' || !changeSet.operations.length ||
    changeSet.operations.some((item) => !['progress_update', 'set_action_status', 'replace_decision_rules'].includes(item.kind))) {
    throw new Error('Only a pending progress/Action/Rules MCP proposal can use this command.')
  }
  const kinds = new Set(changeSet.operations.map((item) => item.kind))
  if (kinds.size < 2) throw new Error('Independent MCP proposals must use their dedicated command.')
  if (changeSet.operations.filter((item) => item.kind === 'replace_decision_rules').length > 1) {
    throw new Error('A mixed proposal cannot replace Decision Rules more than once.')
  }
  let next = upgradeSnapshotToLatest(snapshot)
  if ((next.data.changeSets ?? []).some((item) => item.id === changeSet.id)) {
    throw new Error('The signed proposal ChangeSet ID conflicts with existing workspace history.')
  }
  const applyFamily = (suffix: string, operations: ChangeSetOperation[], apply: typeof applyMcpProgressCommand) => {
    if (!operations.length) return
    const internalId = `${changeSet.id}:internal:${suffix}`
    const part = { ...proposal, changeSet: { ...changeSet, id: internalId, operations } }
    const evaluated = apply(next, part, now)
    next = evaluated.snapshot
    next.data.changeSets = (next.data.changeSets ?? []).filter((item) => item.id !== internalId)
    next.data.timeline = (next.data.timeline ?? []).filter((item) => item.id !== `timeline:changeset:${internalId}`)
  }
  applyFamily('progress', changeSet.operations.filter((item) => item.kind === 'progress_update'), applyMcpProgressCommand)
  applyFamily('actions', changeSet.operations.filter((item) => item.kind === 'set_action_status'), applyMcpActionStatusCommand)
  applyFamily('rules', changeSet.operations.filter((item) => item.kind === 'replace_decision_rules'), applyMcpRulesCommand)
  const timestamp = now.toISOString()
  const applied = { ...changeSet, status: 'applied' as const, appliedAt: timestamp, updatedAt: timestamp }
  next.data.changeSets = [...(next.data.changeSets ?? []), applied]
  next.data.timeline = [...(next.data.timeline ?? []), timelineFromChangeSetApplied(applied)]
  next.exportedAt = timestamp
  validateSnapshot(next)
  return { status: 'APPLIED' as const, changed: true, snapshot: next,
    summary: `Applied ${changeSet.operations.length} reviewed mixed changes in one account revision.` }
}
