import { deriveDiscoveryReviewChangeSet, createDiscoveryFeedbackRecords, type DiscoveryRejectionSelection } from './discoveryFeedback.js'
import { discoveryInboxIdentity } from './discoveryInbox.js'
import { upgradeSnapshotToLatest, validateSnapshot, type PJSDASSnapshot } from './snapshot.js'
import { timelineFromChangeSetApplied } from './timeline.js'
import type { McpProposalEnvelope } from './ai/mcpProposal.js'
import type { TimelineRecord } from './model.js'

// The caller must first verify the signed proposal, account and exact workspace baseline.
export function applyMcpDiscoveryCommand(
  snapshot: PJSDASSnapshot,
  proposal: McpProposalEnvelope,
  selectedOperationIds: string[],
  rejectionSelections: Record<string, DiscoveryRejectionSelection>,
  now = new Date(),
) {
  const next = upgradeSnapshotToLatest(snapshot)
  if (proposal.changeSet.source !== 'mcp' || proposal.changeSet.status !== 'pending') {
    throw new Error('Only a pending MCP discovery proposal can be applied.')
  }
  const selected = new Set(selectedOperationIds)
  if (selected.size !== selectedOperationIds.length) throw new Error('Discovery selection contains duplicate operation IDs.')
  const reviewed = deriveDiscoveryReviewChangeSet(proposal.changeSet, selected)
  if ((next.data.changeSets ?? []).some((item) => item.id === reviewed.id)) {
    throw new Error('The signed proposal ChangeSet ID conflicts with existing workspace history.')
  }
  const known = new Set(proposal.changeSet.operations.map((item) => item.id))
  if (Object.keys(rejectionSelections).some((id) => !known.has(id))) {
    throw new Error('Discovery rejection reason refers to an unknown operation.')
  }
  const identities = new Set(next.data.opportunities.map((item) => discoveryInboxIdentity(item.company, item.role)))
  const newIds = new Set<string>()
  for (const operation of reviewed.operations) {
    if (operation.kind !== 'add_discovered_opportunity') throw new Error('Discovery proposal contains another operation type.')
    const opportunity = operation.opportunity
    const identity = discoveryInboxIdentity(opportunity.company, opportunity.role)
    if (next.data.opportunities.some((item) => item.id === opportunity.id) || identities.has(identity) || newIds.has(opportunity.id)) {
      throw new Error(`Job ${opportunity.company} | ${opportunity.role} already exists. Request a proposal based on the current workspace.`)
    }
    identities.add(identity)
    newIds.add(opportunity.id)
  }
  const timestamp = now.toISOString()
  const applied = { ...reviewed, status: 'applied' as const, appliedAt: timestamp, updatedAt: timestamp }
  const timeline: TimelineRecord[] = [...(next.data.timeline ?? [])]
  for (const operation of reviewed.operations) {
    if (operation.kind !== 'add_discovered_opportunity') continue
    const opportunity = operation.opportunity
    const actionId = `apply:${opportunity.id}`
    next.data.opportunities.push(opportunity)
    next.data.actions.push({
      id: actionId, kind: 'apply', title: `投递 ${opportunity.company}｜${opportunity.role}`,
      opportunityId: opportunity.id, processStage: 'not_applied', dueAt: opportunity.deadline,
      timingMode: opportunity.deadline ? 'deadline' : undefined,
      estimatedMinutes: opportunity.prepEstimateMinutes ?? 45, leverage: 70,
      delayCost: opportunity.deadline ? 65 : 40, status: 'todo', sourceLabel: 'ChatGPT 岗位发现',
      createdAt: opportunity.importedAt, updatedAt: opportunity.importedAt,
    })
    timeline.push({
      id: `timeline:discovery:${opportunity.id}`, kind: 'opportunity_added', category: 'opportunity',
      source: 'changeset', occurredAt: opportunity.importedAt, recordedAt: timestamp,
      title: '接受 AI 发现岗位', detail: opportunity.detail?.discovery?.rationale,
      opportunityId: opportunity.id, actionId, changeSetId: applied.id,
      company: opportunity.company, role: opportunity.role, sourceRef: opportunity.detail?.discovery?.sourceUrl,
    })
  }
  timeline.push(...createDiscoveryFeedbackRecords(proposal.changeSet, selected, rejectionSelections, proposal.discoveryReview, now))
  timeline.push(timelineFromChangeSetApplied(applied))
  next.data.timeline = timeline
  next.data.changeSets = [...(next.data.changeSets ?? []), applied]
  next.exportedAt = timestamp
  validateSnapshot(next)
  return {
    status: 'APPLIED' as const, changed: true, snapshot: next,
    summary: `Applied ${reviewed.operations.length} reviewed discovery candidates.`,
  }
}
