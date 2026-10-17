import { verifiedDiscoveryObservationSchema } from './verifiedDiscoveryCommand.js'
import { applyUserDomainCommand } from './domainCommands.js'
import type { ChangeSetRecord } from './changeSet.js'
import {
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
  let next = upgradeSnapshotToLatest(snapshot)
  if ((next.data.changeSets ?? []).some((item) => item.id === changeSet.id)) {
    throw new Error('The signed proposal ChangeSet ID conflicts with existing workspace history.')
  }
  const timestamp = now.toISOString()
  const appliedOperations: ChangeSetRecord['operations'] = []
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
      if (!operation.verifiedObservation) throw new Error('DISCOVERY_VERIFICATION_REQUIRED: refresh this source before applying its facts.')
      const evaluated = applyUserDomainCommand(next, { kind: 'refresh_verified_discovery_posting', commandId: `${changeSet.id}:${operation.id}`,
        operationId: operation.id, ownerKind: operation.ownerKind, ownerId: operation.ownerId, expectedPostingId: operation.expectedPostingId,
        expectedCanonicalSourceUrl: operation.expectedCanonicalSourceUrl, observation: verifiedDiscoveryObservationSchema.parse(operation.verifiedObservation) }, now)
      next = evaluated.snapshot
      appliedOperations.push(evaluated.operation)
      next.data.timeline = [...(next.data.timeline ?? []), postingRefreshTimeline(evaluated.operation, target, changeSet.id, now)]
    }
  }
  const applied = { ...changeSet, operations: runOnly ? changeSet.operations : appliedOperations, status: 'applied' as const, appliedAt: timestamp, updatedAt: timestamp }
  next.data.changeSets = [...(next.data.changeSets ?? []), applied]
  next.data.timeline = [...(next.data.timeline ?? []), timelineFromChangeSetApplied(applied)]
  next.exportedAt = timestamp
  validateSnapshot(next)
  return {
    status: 'APPLIED' as const, changed: true, snapshot: next,
    summary: runOnly ? 'Recorded reviewed Discovery Run.' : `Applied ${changeSet.operations.length} reviewed source refreshes.`,
  }
}
