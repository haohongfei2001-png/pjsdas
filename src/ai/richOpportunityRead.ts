import { applicationDeadlineFingerprint, classifyJob, hasApplicationEvidence, resolveApplicationDeadline } from '../applicationDeadline.js'
import { upgradeSnapshotToLatest } from '../snapshot.js'
import { cloneOpportunityFacts, opportunityFactsCompleteness } from '../richOpportunity.js'
import type { PJSDASSnapshot } from '../snapshot.js'

export function enrichOpportunityListWithFacts<
  T extends { opportunities: Array<{ opportunityId: string }> },
>(snapshot: PJSDASSnapshot, output: T, includeFacts = false) {
  const rawSnapshot = snapshot
  snapshot = upgradeSnapshotToLatest(snapshot)
  const byId = new Map(snapshot.data.opportunities.map((item) => [item.id, item]))
  return {
    ...output,
    opportunities: output.opportunities.map((item) => {
      const opportunity = byId.get(item.opportunityId)
      const facts = opportunity?.detail?.facts
      return {
        ...item,
        processFactAudit: includeFacts && opportunity ? snapshot.data.processEvents.filter(event => event.opportunityId === opportunity.id).slice(-30).map(event => ({
          eventId: event.id, eventType: event.type, occurredAt: event.occurredAt, updatedAt: event.updatedAt, invalidation: event.invalidation,
          receiptIds: (snapshot.data.semanticReceipts ?? []).filter(receipt => receipt.affectedObjects.some(object => object.type === 'process_event' && object.id === event.id)).map(receipt => receipt.id),
        })) : undefined,
        deadlineAudit: includeFacts && opportunity ? {
          ...resolveApplicationDeadline(opportunity, snapshot.data),
          fingerprint: applicationDeadlineFingerprint(rawSnapshot.data.opportunities.find(raw => raw.id === opportunity.id)!, rawSnapshot.data),
          hasApplicationEvidence: hasApplicationEvidence(opportunity, snapshot.data),
          category: classifyJob(opportunity, snapshot.data, new Date(snapshot.exportedAt), 'Asia/Shanghai'),
          actionIds: snapshot.data.actions.filter(action => action.opportunityId === opportunity.id && action.kind === 'apply').map(action => action.id),
          sourceUrls: [...new Set([opportunity.detail?.discovery?.sourceUrl, opportunity.detail?.facts?.evidence.sourceUrl].filter(Boolean))],
          correctionHistory: opportunity.detail?.deadlineCorrections,
        } : undefined,
        factCompleteness: opportunityFactsCompleteness(facts),
        factsAvailable: Boolean(facts),
        facts: includeFacts ? cloneOpportunityFacts(facts) : undefined,
        userFacts: includeFacts && opportunity?.detail?.userFacts
          ? structuredClone(opportunity.detail.userFacts)
          : undefined,
      }
    }),
  }
}
