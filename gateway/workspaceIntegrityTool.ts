import { readLegacyProcessCorrection } from '../src/legacyProcessCorrection.js'
import { decisionRequestFingerprint } from '../src/decisionDismissal.js'
import { readOpportunityMerge } from '../src/opportunityMerge.js'
import { applicationDeadlineExpired, applicationDeadlineFingerprint, classifyJob, hasApplicationEvidence, resolveApplicationDeadline } from '../src/applicationDeadline.js'
import { upgradeSnapshotToLatest } from '../src/snapshot.js'
import type { CallToolResult } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { auditWorkspaceIntegrity } from '../src/workspaceIntegrity.js'
import { WorkspaceSourceError, type WorkspaceSource } from './workspaceSource.js'

export const getWorkspaceIntegritySchema = z.object({
  review: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('legacy_process_event'), eventId: z.string().min(1).max(240) }).strict(),
    z.object({ kind: z.literal('decision_request'), requestId: z.string().min(1).max(240) }).strict(),
    z.object({ kind: z.literal('opportunity_merge'), canonicalOpportunityId: z.string().min(1).max(240), duplicateOpportunityId: z.string().min(1).max(240) }).strict(),
  ]).optional(),
}).strict()

function success(output: object): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], structuredContent: { ...output } }
}

function failure(caught: unknown): CallToolResult {
  const code = caught instanceof WorkspaceSourceError ? caught.code : 'TEMPORARILY_UNAVAILABLE'
  const retryable = caught instanceof WorkspaceSourceError ? caught.retryable : true
  const message = caught instanceof Error ? caught.message : 'TodayAction workspace integrity audit is unavailable.'
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code, message, retryable }) }] }
}

export async function invokeWorkspaceIntegrity(source: WorkspaceSource, rawArgs: unknown = {}): Promise<CallToolResult> {
  try {
    const args = getWorkspaceIntegritySchema.parse(rawArgs)
    const { snapshot, context } = await source.read()
    const requestId = args.review?.kind === 'decision_request' ? args.review.requestId : undefined
    const request = requestId ? snapshot.data.decisionRequests?.find(item => item.id === requestId) : undefined
    if (args.review?.kind === 'decision_request' && !request) throw new Error('DecisionRequest was not found.')
    const repairReview = args.review?.kind === 'legacy_process_event' ? await readLegacyProcessCorrection(snapshot, args.review.eventId)
      : args.review?.kind === 'opportunity_merge' ? await readOpportunityMerge(snapshot, args.review.canonicalOpportunityId, args.review.duplicateOpportunityId)
        : request ? { request, expectedFingerprint: await decisionRequestFingerprint(request), expectedRequestUpdatedAt: request.updatedAt } : undefined
    const generatedAt = context.now ?? new Date()
    const integrity = auditWorkspaceIntegrity(snapshot, generatedAt)
    const normalized = upgradeSnapshotToLatest(snapshot)
    const deadlineAudit = normalized.data.opportunities.map(opportunity => {
      const deadline = resolveApplicationDeadline(opportunity, normalized.data)
      const category = classifyJob(opportunity, normalized.data, generatedAt, context.timezone ?? 'Asia/Shanghai')
      const applied = hasApplicationEvidence(opportunity, normalized.data)
      const effectiveStage = normalized.data.processes.find(item => item.opportunityId === opportunity.id)?.stage ?? opportunity.processStage
      return { opportunityId: opportunity.id, eligibleForCorrection: !applied && opportunity.participationStatus !== 'abandoned' && ['not_applied', 'waiting_release'].includes(opportunity.processStage) && ['not_applied', 'waiting_release'].includes(effectiveStage), expiredOrClosed: deadline.postingStatus === 'closed' || applicationDeadlineExpired(deadline, generatedAt, context.timezone ?? 'Asia/Shanghai'), company: opportunity.company, role: opportunity.role, stage: opportunity.processStage, category,
        hasApplicationEvidence: hasApplicationEvidence(opportunity, normalized.data), ...deadline,
        fingerprint: applicationDeadlineFingerprint(snapshot.data.opportunities.find(item => item.id === opportunity.id)!, snapshot.data),
        actionIds: normalized.data.actions.filter(item => item.opportunityId === opportunity.id && item.kind === 'apply').map(item => item.id),
        sourceUrls: [...new Set([deadline.sourceUrl, opportunity.detail?.discovery?.sourceUrl, opportunity.detail?.facts?.evidence.sourceUrl].filter(Boolean))],
      }
    }).filter(item => item.expiredOrClosed)
    return success({
      repairReview,
      applicationDeadlineAudit: { totalCandidates: deadlineAudit.filter(item => item.eligibleForCorrection).length, totalProtected: deadlineAudit.filter(item => !item.eligibleForCorrection).length, truncated: deadlineAudit.length > 500, candidates: deadlineAudit.filter(item => item.eligibleForCorrection).slice(0, 500), protectedRecords: deadlineAudit.filter(item => !item.eligibleForCorrection).slice(0, 500) },
      meta: { workspaceVersion: context.workspaceVersion, generatedAt: generatedAt.toISOString(), source: 'pjsdas' },
      integrity,
      assurance: integrity.criticalCount > 0
        ? `${integrity.criticalCount} critical workspace integrity issue(s) require attention before trusting autonomous writes.`
        : integrity.warningCount > 0
          ? `No critical corruption found; ${integrity.warningCount} warning(s) should be reviewed. The audit did not modify data.`
          : 'No structural integrity issue was detected by the current read-only audit. The audit did not modify data.',
    })
  } catch (caught) {
    return failure(caught)
  }
}
