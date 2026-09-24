import { discoveryInboxItemsFromChangeSet, mergeDiscoveryInboxItems } from './discoveryInbox.js'
import { upgradeSnapshotToLatest, validateSnapshot, type PJSDASSnapshot } from './snapshot.js'
import type { McpProposalEnvelope } from './ai/mcpProposal.js'

// Only a server-verified, account-bound proposal may reach this function.
export function applyMcpInboxSaveCommand(snapshot: PJSDASSnapshot, proposal: McpProposalEnvelope, now = new Date()) {
  const next = upgradeSnapshotToLatest(snapshot)
  const changeSet = proposal.changeSet
  if (changeSet.source !== 'mcp' || changeSet.status !== 'pending') {
    throw new Error('Only a pending MCP discovery proposal can be saved to Discovery Inbox.')
  }
  const incoming = discoveryInboxItemsFromChangeSet(changeSet, now)
  const previous = (next.data.changeSets ?? []).find((item) => item.id === changeSet.id)
  if (previous) {
    if (previous.status === 'discarded' && incoming.every((item) =>
      (next.data.discoveryInbox ?? []).some((saved) => saved.sourceChangeSetId === changeSet.id && saved.sourceOperationId === item.sourceOperationId))) {
      return { status: 'ALREADY_APPLIED' as const, changed: false, snapshot: next, summary: 'Discovery proposal was already saved.' }
    }
    throw new Error('The signed proposal ChangeSet ID conflicts with existing workspace history.')
  }
  next.data.discoveryInbox = mergeDiscoveryInboxItems(next.data.discoveryInbox ?? [], incoming, now)
  const timestamp = now.toISOString()
  next.data.changeSets = [...(next.data.changeSets ?? []), {
    ...changeSet, status: 'discarded', discardedAt: timestamp, updatedAt: timestamp,
  }]
  next.exportedAt = timestamp
  validateSnapshot(next)
  return {
    status: 'APPLIED' as const,
    changed: true,
    snapshot: next,
    summary: `Saved ${incoming.length} signed discovery candidates to Discovery Inbox.`,
  }
}
