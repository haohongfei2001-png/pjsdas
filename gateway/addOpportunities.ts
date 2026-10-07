import { assertNoScoringInput, ScoringRetiredError } from '../src/scoringRetirement.js'
import type { CallToolResult } from '@modelcontextprotocol/server'
import { z } from 'zod/v4'
import { stableIngestionHash } from '../src/ingestion.js'
import { normalizedUserJobFacts, findUserJobDuplicate } from '../src/opportunityCreation.js'
import { userJobFactsSchema } from '../src/userJobFactsSchema.js'
import { applySemanticIntake } from '../src/semanticIntake.js'
import { hashMutationPayload } from './mutationKernel.js'
import { requireWritableWorkspaceSource, WorkspaceSourceError, type WorkspaceSource } from './workspaceSource.js'

export const addOpportunityCandidateSchema = userJobFactsSchema
export const addOpportunitiesSchema = z.object({
  commandId: z.string().trim().min(8).max(160).optional(),
  opportunities: z.array(addOpportunityCandidateSchema).min(1).max(12),
}).strict()
export type AddOpportunityCandidate = z.infer<typeof addOpportunityCandidateSchema>
export type AddOpportunitiesArgs = z.infer<typeof addOpportunitiesSchema>
function jsonResult(value: Record<string, unknown>, isError = false): CallToolResult {
  return { isError, content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value }
}

/** Explicit-user adapter; never an automatic verification fallback. */
export async function invokeAddOpportunities(source: WorkspaceSource, rawArgs: unknown): Promise<CallToolResult> {
  try {
    assertNoScoringInput(rawArgs)
    const args = addOpportunitiesSchema.parse(rawArgs)
    const facts = args.opportunities.map(normalizedUserJobFacts)
    const workspace = await source.read()
    const now = workspace.context.now ?? new Date()
    const commandId = args.commandId ?? `explicit-jobs:${stableIngestionHash(JSON.stringify(facts))}`
    const applied = applySemanticIntake(workspace.snapshot, {
      contractVersion: 1, inputId: commandId, statementMode: 'current_intent',
      source: { kind: 'mcp', sourceId: 'explicit-user-add', sourceRecordId: commandId,
        sourceVersion: '1', observedAt: now.toISOString(), assertedAt: now.toISOString(), timezone: workspace.context.timezone ?? 'UTC' },
      candidates: facts.map((item, index) => ({ ...item, id: `job:${index}`, kind: 'user_opportunity',
        objectConfidence: 'high', eventConfidence: 'high', evidenceRefs: [], sourceVersionRefs: [] })),
    }, { authorized: true, workspaceRevision: workspace.context.workspaceVersion, now })
    const created = applied.snapshot.data.opportunities.filter(item => !workspace.snapshot.data.opportunities.some(prior => prior.id === item.id))
      .map(item => ({ opportunityId: item.id, company: item.company, role: item.role }))
    const duplicates = facts.flatMap(item => {
      const existing = findUserJobDuplicate(item, workspace.snapshot.data.opportunities)
      return existing ? [{ opportunityId: existing.id, company: item.company, role: item.role, existingCompany: existing.company, existingRole: existing.role }] : []
    })
    let version = workspace.context.workspaceVersion
    if (applied.changed) {
      const written = await requireWritableWorkspaceSource(source).write({ snapshot: applied.snapshot,
        expectedWorkspaceVersion: version ?? workspace.snapshot.exportedAt, updatedByDevice: 'mcp-explicit-user-write',
        command: { commandId, operation: 'add_opportunities', payload: args,
          payloadHash: await hashMutationPayload('add_opportunities', args),
          compensation: applied.compensation as unknown as Record<string, unknown>, provenance: { channel: 'mcp-explicit-user-write' } },
      })
      version = written.context.workspaceVersion
    }
    return jsonResult({ applied: ['APPLIED', 'ALREADY_APPLIED'].includes(applied.status),
      reviewRequired: applied.status === 'DECISION_REQUIRED' || applied.status === 'NO_WRITE',
      message: applied.summary, workspaceVersion: version, commandId, createdCount: created.length,
      duplicateCount: duplicates.length, ambiguityCount: applied.decisionRequests.length,
      created, duplicates, ambiguities: [], receiptId: applied.receipt?.id })
  } catch (caught) {
    const known = caught instanceof WorkspaceSourceError || caught instanceof ScoringRetiredError
    return jsonResult({ code: known ? caught.code : 'DIRECT_WRITE_FAILED',
      message: caught instanceof Error ? caught.message : 'Explicit job save failed.', retryable: known ? caught.retryable : false }, true)
  }
}
