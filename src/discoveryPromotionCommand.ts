import { appendOpportunityOnly } from './opportunityCreation.js'
import { canonicalOpportunityId } from './opportunityCanonicalization.js'
import { createInboxPromotionChangeSet, discoveryInboxDecisionTimeline } from './discoveryInbox.js'
import { findSimilarOpportunity } from './discoveryQuality.js'
import { upgradeSnapshotToLatest, validateSnapshot, type PJSDASSnapshot } from './snapshot.js'
import { timelineFromChangeSetApplied } from './timeline.js'
import type { DiscoveryInboxItem, TimelineRecord } from './model.js'

export interface DiscoveryPromotionCommand { inboxItemId: string }

export function applyDiscoveryPromotionCommand(snapshot: PJSDASSnapshot, command: DiscoveryPromotionCommand, now = new Date()) {
  const next = upgradeSnapshotToLatest(snapshot)
  const index = (next.data.discoveryInbox ?? []).findIndex((item) => item.id === command.inboxItemId)
  if (index < 0) throw new Error(`Discovery Inbox item ${command.inboxItemId} was not found.`)
  const previous = next.data.discoveryInbox![index]
  if (previous.status === 'promoted') {
    return { status: 'ALREADY_APPLIED' as const, changed: false, snapshot: next, summary: 'Job already promoted.' }
  }
  const existing = next.data.opportunities.find((item) => item.id === canonicalOpportunityId(next, previous.candidateOpportunityId))
    ?? findSimilarOpportunity({ company: previous.company, role: previous.role }, next.data.opportunities)
  let promotedOpportunityId = existing?.id
  let createdOpportunityId: string | undefined
  let createdChangeSetId: string | undefined
  const timelineIds: string[] = []

  if (!existing) {
    const pending = createInboxPromotionChangeSet(previous, now)
    const operation = pending.operations[0]
    if (operation.kind !== 'add_discovered_opportunity') throw new Error('Promotion ChangeSet is invalid.')
    const opportunity = operation.opportunity
    const timestamp = now.toISOString()
    const applied = { ...pending, status: 'applied' as const, appliedAt: timestamp, updatedAt: timestamp }
    const added: TimelineRecord = {
      id: `timeline:discovery:${opportunity.id}`, kind: 'opportunity_added', category: 'opportunity',
      source: 'changeset', occurredAt: opportunity.importedAt, recordedAt: timestamp,
      title: '接受 AI 发现岗位', detail: opportunity.detail?.discovery?.rationale,
      opportunityId: opportunity.id, changeSetId: applied.id,
      company: opportunity.company, role: opportunity.role, sourceRef: opportunity.detail?.discovery?.sourceUrl,
    }
    if ((next.data.opportunityAliases ?? []).some(alias => alias.id === opportunity.id)) throw new Error('An aliased opportunity cannot be recreated.')
    appendOpportunityOnly(next.data, opportunity)
    next.data.changeSets = [...(next.data.changeSets ?? []), applied]
    const changeTimeline = timelineFromChangeSetApplied(applied)
    next.data.timeline = [...(next.data.timeline ?? []), added, changeTimeline]
    timelineIds.push(added.id, changeTimeline.id)
    promotedOpportunityId = opportunity.id
    createdOpportunityId = opportunity.id
    createdChangeSetId = applied.id
  }

  const promoted: DiscoveryInboxItem = {
    ...previous, status: 'promoted', rejectionReason: undefined, promotedOpportunityId,
    updatedAt: now.toISOString(),
  }
  next.data.discoveryInbox![index] = promoted
  const decision = discoveryInboxDecisionTimeline(promoted, 'accepted', now)
  next.data.timeline = [...(next.data.timeline ?? []), decision]
  timelineIds.push(decision.id)
  next.exportedAt = now.toISOString()
  validateSnapshot(next)
  return {
    status: 'APPLIED' as const, changed: true, snapshot: next,
    summary: `Promoted Discovery Inbox item ${command.inboxItemId}.`,
    compensation: { operation: 'restore_discovery_promotion', payload: {
      inboxItemId: command.inboxItemId, status: previous.status,
      rejectionReason: previous.rejectionReason, promotedOpportunityId: previous.promotedOpportunityId,
      createdOpportunityId, createdChangeSetId, timelineIds,
    } },
  }
}
