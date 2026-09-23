import { createDiscoveryFeedbackRecords, type DiscoveryRejectionSelection } from './discoveryFeedback.js'
import { upgradeSnapshotToLatest, validateSnapshot, type PJSDASSnapshot } from './snapshot.js'
import type { McpProposalEnvelope } from './ai/mcpProposal.js'

// The gateway verifies the signed account, expiry and exact workspace baseline.
// Discarding never applies any proposed business mutation.
export function applyMcpDiscardCommand(
  snapshot: PJSDASSnapshot,
  proposal: McpProposalEnvelope,
  rejectionSelections: Record<string, DiscoveryRejectionSelection>,
  now = new Date(),
) {
  const changeSet = proposal.changeSet
  if (changeSet.source !== 'mcp' || changeSet.status !== 'pending') {
    throw new Error('Only a pending signed MCP proposal can be discarded.')
  }
  const next = upgradeSnapshotToLatest(snapshot)
  if ((next.data.changeSets ?? []).some((item) => item.id === changeSet.id)) {
    throw new Error('The signed proposal ChangeSet ID conflicts with existing workspace history.')
  }
  const discovery = changeSet.operations.filter((item) => item.kind === 'add_discovered_opportunity')
  if (Object.keys(rejectionSelections).some((id) => !discovery.some((item) => item.id === id))) {
    throw new Error('Discovery rejection reason refers to an unknown operation.')
  }
  const timestamp = now.toISOString()
  const discarded = { ...changeSet, status: 'discarded' as const, discardedAt: timestamp, updatedAt: timestamp }
  next.data.changeSets = [...(next.data.changeSets ?? []), discarded]
  if (discovery.length) {
    if (discovery.length !== changeSet.operations.length) throw new Error('Discovery proposal mixes operation types.')
    next.data.timeline = [
      ...(next.data.timeline ?? []),
      ...createDiscoveryFeedbackRecords(changeSet, new Set(), rejectionSelections, proposal.discoveryReview, now),
    ]
  }
  next.exportedAt = timestamp
  validateSnapshot(next)
  return {
    status: 'APPLIED' as const, changed: true, snapshot: next,
    summary: discovery.length
      ? `Discarded ${discovery.length} reviewed discovery candidates and recorded rejection feedback.`
      : 'Discarded the reviewed proposal without changing business facts.',
  }
}
