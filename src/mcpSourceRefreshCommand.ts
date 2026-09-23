import type { ChangeSetRecord } from './changeSet.js'
import {
  applyPostingRefreshToInbox,
  applyPostingRefreshToOpportunity,
  postingRefreshTimeline,
  resolvePostingRefreshTarget,
} from './postingRefresh.js'
import { upgradeSnapshotToLatest, validateSnapshot, type PJSDASSnapshot } from './snapshot.js'
import { timelineFromChangeSetApplied } from './timeline.js'
import type { McpProposalEnvelope } from './ai/mcpProposal.js'

// Signed token, account and exact revision/fingerprint are checked by the
// gateway before this pure reducer is called.
export function applyMcpSourceRefreshCommand(snapshot: PJSDASSnapshot, proposal: McpProposalEnvelope, now = new Date()) {
  const changeSet: ChangeSetRecord = proposal.changeSet
  const refreshOnly = changeSet.operations.length > 0 && changeSet.operations.every((item) => item.kind === 'refresh_job_posting')
  const runOnly = changeSet.operations.length > 0 && changeSet.operations.every((item) => item.kind === 'record_discovery_run')
  if (changeSet.source !== 'mcp' || changeSet.status !== 'pending' || (!refreshOnly && !runOnly)) {
    throw new Error('Only a pending independent MCP source-refresh or Discovery Run proposal can use this command.')
  }
  const next = upgradeSnapshotToLatest(snapshot)
  if ((next.data.changeSets ?? []).some((item) => item.id === changeSet.id)) {
    throw new Error('The signed proposal ChangeSet ID conflicts with existing workspace history.')
  }
  const timestamp = now.toISOString()
  if (runOnly) {
    if (!changeSet.discoveryRun || changeSet.operations.some((item) =>
      item.kind !== 'record_discovery_run' || item.runId !== changeSet.discoveryRun?.id)) {
      throw new Error('Discovery Run record does not match signed ChangeSet metadata.')
    }
  } else {
    const seen = new Set<string>()
    for (const operation of changeSet.operations) {
      if (operation.kind !== 'refresh_job_posting') throw new Error('Source-refresh proposal contains another operation type.')
      const identity = `${operation.ownerKind}:${operation.ownerId}`
      if (seen.has(identity)) throw new Error('Source-refresh proposal changes the same posting twice.')
      seen.add(identity)
      const target = resolvePostingRefreshTarget(operation, next.data.opportunities, next.data.discoveryInbox ?? [])
      if (!target) throw new Error(`Posting ${operation.expectedPostingId} changed since the signed proposal was prepared.`)
      if (target.ownerKind === 'opportunity') {
        const owner = next.data.opportunities.find((item) => item.id === target.ownerId)
        if (!owner) throw new Error(`Opportunity ${target.ownerId} was not found.`)
        const updated = applyPostingRefreshToOpportunity(owner, operation)
        next.data.opportunities = next.data.opportunities.map((item) => item.id === updated.id ? updated : item)
      } else {
        const owner = (next.data.discoveryInbox ?? []).find((item) => item.id === target.ownerId)
        if (!owner) throw new Error(`Discovery Inbox item ${target.ownerId} was not found.`)
        const updated = applyPostingRefreshToInbox(owner, operation)
        next.data.discoveryInbox = (next.data.discoveryInbox ?? []).map((item) => item.id === updated.id ? updated : item)
      }
      next.data.timeline = [...(next.data.timeline ?? []), postingRefreshTimeline(operation, target, changeSet.id)]
    }
  }
  const applied = { ...changeSet, status: 'applied' as const, appliedAt: timestamp, updatedAt: timestamp }
  next.data.changeSets = [...(next.data.changeSets ?? []), applied]
  next.data.timeline = [...(next.data.timeline ?? []), timelineFromChangeSetApplied(applied)]
  next.exportedAt = timestamp
  validateSnapshot(next)
  return {
    status: 'APPLIED' as const, changed: true, snapshot: next,
    summary: runOnly ? 'Recorded reviewed Discovery Run.' : `Applied ${changeSet.operations.length} reviewed source refreshes.`,
  }
}
