import { assertNoScoringInput, ScoringRetiredError } from '../src/scoringRetirement.js'
import type { CallToolResult } from '@modelcontextprotocol/server'
import { z } from 'zod/v4'
import { stableIngestionHash } from '../src/ingestion.js'
import { normalizedUserJobFacts, findUserJobDuplicate } from '../src/opportunityCreation.js'
import { userJobFactsSchema } from '../src/userJobFactsSchema.js'
import { applySemanticIntake } from '../src/semanticIntake.js'
import { hashMutationPayload } from './mutationKernel.js'
import { requireWritableWorkspaceSource, WorkspaceSourceError, type WorkspaceSource, type GatewayWorkspace } from './workspaceSource.js'

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

function revision(value: string | undefined) {
  const match = /^txn:(\d+)$/.exec(value ?? '')
  return match ? Number(match[1]) : undefined
}
function receiptMatches(receipt: Record<string, unknown> | undefined, commandId: string, resultingRevision: number) {
  return receipt?.commandId === commandId && receipt.operation === 'add_opportunities' && receipt.status === 'COMMITTED'
    && receipt.receiptId === `command-receipt:${commandId}` && receipt.revision === resultingRevision
}
async function originalCommandReceipt(source: WorkspaceSource, commandId: string, hashes: string[], workspace: GatewayWorkspace, required = false, candidateFingerprint?: string) {
  const recorded = await source.readCommandReceipt?.(commandId)
  if (!recorded) {
    if (required) throw new WorkspaceSourceError('OPPORTUNITY_COMMIT_UNVERIFIED', 'The saved job marker has no matching authoritative command receipt.', true)
    return undefined
  }
  const originalSemantic = workspace.snapshot.data.semanticReceipts?.find(item => item.inputId === commandId)
  let compatibleLegacyFacts = false
  if (!hashes.includes(recorded.payloadHash) && candidateFingerprint && originalSemantic?.inputFacts
    && originalSemantic.commandId === `semantic-intake:${commandId}` && originalSemantic.sourceKind === 'mcp'
    && originalSemantic.sourceId === 'explicit-user-add' && originalSemantic.sourceRecordId === commandId && originalSemantic.sourceVersion === '1'
    && revision(workspace.context.workspaceVersion) === recorded.resultingRevision
    && recorded.receipt.contractVersion === 2 && recorded.receipt.commandType === 'workspace_source_semantic'
    && Array.isArray(recorded.receipt.affectedObjects) && recorded.receipt.affectedObjects.some(item =>
      item && typeof item === 'object' && item.type === 'semantic_receipt' && item.id === originalSemantic.id)) {
    // B1 hashed the raw tracking URL, while its immutable semantic receipt
    // retained normalized candidates. Only the original committed revision can
    // prove the row content; a later recovery may replace even historical rows.
    // Join that exact original affected object;
    // a marker or a matching job alone cannot waive a different command hash.
    try { compatibleLegacyFacts = await hashMutationPayload('explicit_user_candidates', JSON.parse(originalSemantic.inputFacts)) === candidateFingerprint }
    catch { /* Unsupported historical fact encoding stays a conflict. */ }
  }
  if (recorded.commandId !== commandId || recorded.operation !== 'add_opportunities' || !hashes.includes(recorded.payloadHash) && !compatibleLegacyFacts) {
    throw new WorkspaceSourceError('COMMAND_ID_REUSED', 'This command ID belongs to different job facts or another operation.', false)
  }
  const currentRevision = revision(workspace.context.workspaceVersion)
  if (!Number.isSafeInteger(recorded.resultingRevision) || recorded.resultingRevision < 1 || currentRevision === undefined
    || recorded.resultingRevision > currentRevision || !receiptMatches(recorded.receipt, commandId, recorded.resultingRevision)) {
    throw new WorkspaceSourceError('OPPORTUNITY_RECEIPT_MISMATCH', 'The authoritative job receipt does not match its original committed revision.', false)
  }
  return recorded.receipt
}

/** Explicit-user adapter; never an automatic verification fallback. The domain
 * command is retried on CAS only; acknowledgements come from persisted facts. */
export async function invokeAddOpportunities(source: WorkspaceSource, rawArgs: unknown): Promise<CallToolResult> {
  try {
    assertNoScoringInput(rawArgs)
    const args = addOpportunitiesSchema.parse(rawArgs)
    const facts = args.opportunities.map(normalizedUserJobFacts)
    const commandId = args.commandId ?? `explicit-jobs:${stableIngestionHash(JSON.stringify(facts))}`
    const payload = { ...args, opportunities: facts }
    const payloadHash = await hashMutationPayload('add_opportunities', payload)
    const compatibleHashes = [payloadHash, await hashMutationPayload('add_opportunities', args)]
    let workspace = await source.read()
    const now = workspace.context.now ?? new Date()
    const observation = {
      contractVersion: 1 as const, inputId: commandId, statementMode: 'current_intent' as const,
      source: { kind: 'mcp' as const, sourceId: 'explicit-user-add', sourceRecordId: commandId,
        sourceVersion: '1', observedAt: now.toISOString(), assertedAt: now.toISOString(), timezone: workspace.context.timezone ?? 'UTC' },
      candidates: facts.map((item, index) => ({ ...item, id: `job:${index}`, kind: 'user_opportunity' as const,
        objectConfidence: 'high' as const, eventConfidence: 'high' as const, evidenceRefs: [], sourceVersionRefs: [] })),
    }
    const candidateFingerprint = await hashMutationPayload('explicit_user_candidates', observation.candidates)
    const semanticReceipt = (saved: GatewayWorkspace) => saved.snapshot.data.semanticReceipts?.find(item => item.inputId === commandId)
    const response = (saved: GatewayWorkspace, createdIds: string[], options: { message: string; applied: boolean; reviewRequired?: boolean;
      receipt?: Record<string, unknown>; durableCommit?: boolean; readbackVerified?: boolean; alreadyApplied?: boolean; warning?: string }) => {
      const created = saved.snapshot.data.opportunities.filter(item => createdIds.includes(item.id)).map(item => ({ opportunityId: item.id, company: item.company, role: item.role }))
      const duplicates = facts.flatMap(item => {
        const existing = findUserJobDuplicate(item, saved.snapshot.data.opportunities)
        return existing && !createdIds.includes(existing.id) ? [{ opportunityId: existing.id, company: item.company, role: item.role,
          existingCompany: existing.company, existingRole: existing.role }] : []
      })
      const stored = semanticReceipt(saved)
      return jsonResult({ applied: options.applied, reviewRequired: options.reviewRequired ?? false, message: options.message,
        workspaceVersion: saved.context.workspaceVersion, commandId, createdCount: created.length, duplicateCount: duplicates.length,
        ambiguityCount: stored?.decisionRequestIds.length ?? 0, created, duplicates, ambiguities: [], receiptId: stored?.id,
        commandReceipt: options.receipt, durableCommit: options.durableCommit ?? false, readbackVerified: options.readbackVerified ?? false,
        alreadyApplied: options.alreadyApplied ?? false, originalOperationTime: stored?.createdAt,
        ...(options.warning ? { verificationWarning: options.warning } : {}) })
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt) workspace = await source.read()
      const original = await originalCommandReceipt(source, commandId, compatibleHashes, workspace, false, candidateFingerprint)
      if (original) {
        const stored = semanticReceipt(workspace)
        if (!stored) throw new WorkspaceSourceError('OPPORTUNITY_COMMIT_UNVERIFIED', 'The original command receipt has no matching semantic job record.', true)
        const stillApplied = stored.status !== 'undone' && !stored.factInvalidations?.length
        return response(workspace, [], { message: stillApplied ? stored.summary : 'The original command was undone. A new explicit request needs a new command ID.',
          applied: stillApplied, alreadyApplied: true, receipt: original, durableCommit: true, readbackVerified: true })
      }
      const recordedSemantic = semanticReceipt(workspace)
      if (recordedSemantic && (recordedSemantic.status === 'undone' || recordedSemantic.factInvalidations?.length)) {
        let sameFacts = false
        if (recordedSemantic.sourceKind === 'mcp' && recordedSemantic.sourceId === 'explicit-user-add'
          && recordedSemantic.sourceRecordId === commandId && recordedSemantic.sourceVersion === '1'
          && recordedSemantic.commandId === `semantic-intake:${commandId}` && recordedSemantic.inputFacts) {
          try { sameFacts = await hashMutationPayload('explicit_user_candidates', JSON.parse(recordedSemantic.inputFacts)) === candidateFingerprint }
          catch { /* A legacy unknown identity never authorizes re-creation. */ }
        }
        if (!sameFacts) throw new WorkspaceSourceError('COMMAND_ID_REUSED', 'The original undone command cannot be reused for different or unverifiable job facts.', false)
        if (revision(workspace.context.workspaceVersion) !== undefined) await originalCommandReceipt(source, commandId, compatibleHashes, workspace, true, candidateFingerprint)
        return response(workspace, [], { message: 'The original command was undone. A new explicit request needs a new command ID.',
          applied: false, alreadyApplied: true, durableCommit: true, readbackVerified: true })
      }
      const evaluated = applySemanticIntake(workspace.snapshot, observation, { authorized: true, workspaceRevision: workspace.context.workspaceVersion, now })
      if (!evaluated.changed) {
        if (revision(workspace.context.workspaceVersion) !== undefined && evaluated.receipt?.inputId === commandId) {
          await originalCommandReceipt(source, commandId, compatibleHashes, workspace, true, candidateFingerprint)
        }
        return response(workspace, [], { message: evaluated.summary, applied: evaluated.status === 'ALREADY_APPLIED',
          reviewRequired: evaluated.status === 'NO_WRITE', alreadyApplied: evaluated.status === 'ALREADY_APPLIED', readbackVerified: true })
      }
      const createdIds = evaluated.snapshot.data.opportunities.filter(item => !workspace.snapshot.data.opportunities.some(previous => previous.id === item.id)).map(item => item.id)
      const expectedReceipt = evaluated.receipt
      const matchesSemanticReceipt = (saved: GatewayWorkspace) => {
        const stored = semanticReceipt(saved)
        return Boolean(stored && expectedReceipt && stored.id === expectedReceipt.id && stored.inputFacts === expectedReceipt.inputFacts
          && stored.sourceId === expectedReceipt.sourceId && stored.sourceRecordId === expectedReceipt.sourceRecordId)
      }
      let written: GatewayWorkspace
      try {
        written = await requireWritableWorkspaceSource(source).write({ snapshot: evaluated.snapshot,
          expectedWorkspaceVersion: workspace.context.workspaceVersion ?? workspace.snapshot.exportedAt, updatedByDevice: 'mcp-explicit-user-write',
          command: { commandId, operation: 'add_opportunities', payload, payloadHash,
            compensation: evaluated.compensation as unknown as Record<string, unknown>, provenance: { channel: 'mcp-explicit-user-write' } } })
      } catch (caught) {
        if (caught instanceof WorkspaceSourceError && caught.code === 'WORKSPACE_CONFLICT' && attempt === 0) continue
        const recovered = await source.read().catch(() => undefined)
        if (recovered && matchesSemanticReceipt(recovered)) {
          const receipt = await originalCommandReceipt(source, commandId, compatibleHashes, recovered, revision(recovered.context.workspaceVersion) !== undefined, candidateFingerprint)
          const restored = semanticReceipt(recovered)!
          const stillApplied = restored.status !== 'undone' && !restored.factInvalidations?.length
          return response(recovered, [], { message: stillApplied ? restored.summary : 'The original command was committed and subsequently undone; its jobs were not recreated.', applied: stillApplied, alreadyApplied: true,
            durableCommit: true, readbackVerified: true, receipt })
        }
        throw caught
      }
      if (!matchesSemanticReceipt(written)) throw new WorkspaceSourceError('OPPORTUNITY_COMMIT_UNVERIFIED', 'The write response did not establish the expected job command.', true)
      const writtenRevision = revision(written.context.workspaceVersion)
      if (writtenRevision !== undefined) {
        const receiptRevision = written.commandReceipt?.revision
        if (typeof receiptRevision !== 'number' || !Number.isSafeInteger(receiptRevision) || receiptRevision < 1 || receiptRevision > writtenRevision
          || !receiptMatches(written.commandReceipt, commandId, receiptRevision) || !['COMMITTED', 'ALREADY_APPLIED'].includes(written.commandOutcome ?? '')
          || written.commandOutcome === 'COMMITTED' && (receiptRevision !== writtenRevision || writtenRevision !== (revision(workspace.context.workspaceVersion) ?? -1) + 1)) {
          throw new WorkspaceSourceError('OPPORTUNITY_RECEIPT_MISMATCH', 'The job write acknowledgement does not match the original command and revision.', false)
        }
      }
      const readback = await source.read().catch(() => undefined)
      const receipt = readback ? await originalCommandReceipt(source, commandId, compatibleHashes, readback, false, candidateFingerprint).catch(caught => {
        if (caught instanceof WorkspaceSourceError && ['OPPORTUNITY_RECEIPT_MISMATCH', 'COMMAND_ID_REUSED'].includes(caught.code)) throw caught
        return undefined
      }) : undefined
      const readbackVerified = Boolean(readback && matchesSemanticReceipt(readback) && (writtenRevision === undefined || receipt))
      if (receipt && receipt.revision !== written.commandReceipt?.revision) throw new WorkspaceSourceError('OPPORTUNITY_RECEIPT_MISMATCH', 'The write response and ledger identify different original job revisions.', false)
      const confirmed = readbackVerified ? readback! : written
      const confirmedReceipt = semanticReceipt(confirmed)!
      const stillApplied = confirmedReceipt.status !== 'undone' && !confirmedReceipt.factInvalidations?.length
      return response(confirmed, written.commandOutcome === 'ALREADY_APPLIED' || !stillApplied ? [] : createdIds, {
        message: stillApplied ? evaluated.summary : 'The original command was committed and subsequently undone; its jobs were not recreated.',
        applied: stillApplied && evaluated.status === 'APPLIED', reviewRequired: stillApplied && evaluated.status === 'DECISION_REQUIRED',
        alreadyApplied: written.commandOutcome === 'ALREADY_APPLIED', durableCommit: true, readbackVerified, receipt: receipt ?? written.commandReceipt,
        ...(readbackVerified ? {} : { warning: 'The write was acknowledged; independent readback is pending. Do not repeat the job creation.' }) })
    }
    throw new WorkspaceSourceError('WORKSPACE_CONFLICT', 'Job facts were not committed after the bounded CAS retry.', true)
  } catch (caught) {
    const known = caught instanceof WorkspaceSourceError || caught instanceof ScoringRetiredError
    return jsonResult({ code: known ? caught.code : 'DIRECT_WRITE_FAILED',
      message: caught instanceof Error ? caught.message : 'Explicit job save failed.', retryable: known ? caught.retryable : false }, true)
  }
}
