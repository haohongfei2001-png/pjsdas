import { decisionRulesEquivalent } from './changeSet.js'
import { decisionRulesForSnapshot, validateDecisionRules } from './decisionRules.js'
import { upgradeSnapshotToLatest, validateSnapshot, type PJSDASSnapshot } from './snapshot.js'
import { timelineFromChangeSetApplied, timelineFromRuleChange } from './timeline.js'
import type { McpProposalEnvelope } from './ai/mcpProposal.js'

// The gateway verifies the signed proposal and exact account workspace first.
export function applyMcpRulesCommand(snapshot: PJSDASSnapshot, proposal: McpProposalEnvelope, now = new Date()) {
  const changeSet = proposal.changeSet
  if (changeSet.source !== 'mcp' || changeSet.status !== 'pending' || changeSet.operations.length !== 1 ||
    changeSet.operations[0].kind !== 'replace_decision_rules') {
    throw new Error('Only a pending single-rules MCP proposal can use this command.')
  }
  const operation = changeSet.operations[0]
  const next = upgradeSnapshotToLatest(snapshot)
  if ((next.data.changeSets ?? []).some((item) => item.id === changeSet.id)) {
    throw new Error('The signed proposal ChangeSet ID conflicts with existing workspace history.')
  }
  const before = decisionRulesForSnapshot(next.data.decisionRules)
  if (before.updatedAt !== operation.expectedUpdatedAt || decisionRulesEquivalent(before, operation.rules)) {
    throw new Error('Decision rules changed since the signed proposal was prepared.')
  }
  const timestamp = now.toISOString()
  const after = { ...decisionRulesForSnapshot(operation.rules), updatedAt: timestamp }
  const errors = validateDecisionRules(after)
  if (errors.length) throw new Error(errors[0])
  next.data.decisionRules = after
  const applied = { ...changeSet, status: 'applied' as const, appliedAt: timestamp, updatedAt: timestamp }
  next.data.changeSets = [...(next.data.changeSets ?? []), applied]
  const ruleTimeline = timelineFromRuleChange(before, after, operation.mode)
  next.data.timeline = [...(next.data.timeline ?? []), ...(ruleTimeline ? [ruleTimeline] : []), timelineFromChangeSetApplied(applied)]
  next.exportedAt = timestamp
  validateSnapshot(next)
  return {
    status: 'APPLIED' as const, changed: true, snapshot: next,
    summary: 'Applied reviewed Decision Rules.',
    compensation: { operation: 'mcp_restore_decision_rules', payload: { before } },
  }
}
