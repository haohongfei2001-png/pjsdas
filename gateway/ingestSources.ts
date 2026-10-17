import { applyUserDomainCommand } from '../src/domainCommands.js'
import { discoveryProfileForSnapshot, isDiscoveryProfileConfigured, isDiscoverySearchScopeConfirmed } from '../src/discoveryProfile.js'
import { discoveryProfileManagementFingerprint } from '../src/discoveryProfileManagement.js'
import { hashMutationPayload } from './mutationKernel.js'
import { prepareVerifiedDiscoveryCommand, commitVerifiedDiscoveryRun, readVerifiedDiscoveryReceipt, verifiedDiscoveryCommandId } from './verifiedDiscoveryCommit.js'
import { discoveryObservationClaimSchema } from '../src/discoveryFactSchema.js'
import { assertNoScoringInput, ScoringRetiredError } from '../src/scoringRetirement.js'
import type { CallToolResult } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import type { GmailMessageObservation, MonitorJobObservation } from '../src/autonomousIngestion.js'
import {
  applyGmailIngestionHardened,
  applyMonitorIngestionHardened,
  type HardenedGmailIngestionRunInput,
  type HardenedGmailMessageObservation,
  type HardenedMonitorIngestionRunInput,
} from '../src/ingestionHardening.js'
import { jobRoleSimilarity, normalizeJobCompany } from '../src/jobPosting.js'
import type { IngestionRunSummary, Opportunity } from '../src/model.js'
import { resolveSourcePolicy } from '../src/sourceRegistry.js'
import { requireWritableWorkspaceSource, WorkspaceSourceError, type WorkspaceSource, type DiscoveryCommitAuthorization } from './workspaceSource.js'
import { createDiscoverySourceVerifier } from './discoverySourceVerifier.js'

const isoString = z.string().min(1).refine((value) => !Number.isNaN(new Date(value).getTime()), 'Must be a valid ISO/date timestamp.')
const confidenceSchema = z.enum(['high', 'medium', 'low'])
const roleTypeSchema = z.enum(['core', 'backup', 'reach', 'lottery', 'practice'])
const processEventTypeSchema = z.enum(['assessment_invite', 'written_test_invite', 'interview_invite', 'offer', 'rejection', 'status_update', 'other'])
const processStageSchema = z.enum(['unknown', 'not_applied', 'screening', 'assessment', 'written_test', 'interview', 'offer', 'waiting_release', 'closed'])
const timingModeSchema = z.enum(['deadline', 'fixed'])
const eventStateSchema = z.enum(['scheduled', 'rescheduled', 'completed', 'cancelled'])
const sourcePolicySchema = z.object({
  version: z.literal(1), enabled: z.boolean(), label: z.string().trim().min(1).max(160).optional(),
  cadenceMinutes: z.number().int().min(15).max(60 * 24 * 30), freshnessSlaMinutes: z.number().int().min(15).max(60 * 24 * 30),
}).strict()
const simulationFields = {
  dryRun: z.boolean().optional(),
  replayOfRunId: z.string().trim().min(1).max(180).optional(),
}

export const ingestDiscoveryRunSchema = z.object({
  runId: z.string().trim().min(1).max(180), sourceId: z.string().trim().min(1).max(180), startedAt: isoString, completedAt: isoString,
  sourcePolicy: sourcePolicySchema.optional(), ...simulationFields,
  observations: z.array(discoveryObservationClaimSchema).max(100),
}).strict()

export const ingestGmailRunSchema = z.object({
  runId: z.string().trim().min(1).max(180), sourceId: z.string().trim().min(1).max(180), startedAt: isoString, completedAt: isoString,
  cursor: z.string().trim().max(500).optional(), sourcePolicy: sourcePolicySchema.optional(), ...simulationFields,
  messages: z.array(z.object({
    sourceRecordId: z.string().trim().min(1).max(500), receivedAt: isoString, classification: z.enum(['recruiting', 'ignored']), confidence: confidenceSchema,
    sender: z.string().trim().max(320).optional(), subject: z.string().trim().max(500).optional(), company: z.string().trim().max(200).optional(), role: z.string().trim().max(260).optional(),
    eventType: processEventTypeSchema.optional(), eventKey: z.string().trim().max(500).optional(), eventState: eventStateSchema.optional(), dueAt: isoString.optional(), timingMode: timingModeSchema.optional(),
    estimatedMinutes: z.number().int().min(5).max(720).optional(), notes: z.string().trim().max(800).optional(), stage: processStageSchema.optional(), stageLabel: z.string().trim().max(120).optional(),
    roleType: roleTypeSchema.optional(),
  })).max(100),
})

export type TrustedIngestionToolName = 'ingest_discovery_run' | 'ingest_gmail_run'

type SimulationArgs = { dryRun?: boolean; replayOfRunId?: string }

function success(output: object): CallToolResult { return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], structuredContent: { ...output } } }
function toolError(code: string, message: string, retryable: boolean): CallToolResult { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code, message, retryable }) }] } }
function failure(caught: unknown): CallToolResult {
  if (caught instanceof WorkspaceSourceError || caught instanceof ScoringRetiredError) return toolError(caught.code, caught.message, caught.retryable)
  if (caught instanceof z.ZodError) return toolError('INVALID_ARGUMENT', caught.issues[0]?.message ?? 'Invalid ingestion arguments.', false)
  return toolError('INGESTION_FAILED', caught instanceof Error ? caught.message : 'PJSDAS trusted-source ingestion failed.', false)
}

function appendResolutionNote<T extends GmailMessageObservation>(message: T, note: string): T {
  const notes = [message.notes?.trim(), note].filter(Boolean).join('；')
  return { ...message, notes: notes.slice(0, 800) }
}
function companyKey(value: string) { return normalizeJobCompany(value).replace(/(?:校园招聘|校园|校招|招聘)$/g, '').trim() }
function activeOpportunity(opportunity: Opportunity) { return opportunity.processStage !== 'closed' }

export function normalizeGmailMessagesForWorkspace<T extends HardenedGmailMessageObservation>(messages: T[], opportunities: Opportunity[]): T[] {
  return messages.map((message) => {
    if (message.classification !== 'recruiting' || message.confidence !== 'high' || !message.company?.trim()) return message
    const key = companyKey(message.company)
    const companyMatches = opportunities.filter((opportunity) => companyKey(opportunity.company) === key)
    const active = companyMatches.filter(activeOpportunity)
    const pool = active.length ? active : companyMatches
    if (!message.role?.trim()) {
      if (pool.length === 1) {
        const target = pool[0]!
        return appendResolutionNote({ ...message, company: target.company, role: target.role }, 'Gmail 网关按该公司唯一活跃 Opportunity 自动关联。')
      }
      if (pool.length > 1) return appendResolutionNote({ ...message, confidence: 'medium' }, '同一公司存在多个活跃 Opportunity，邮件未明确岗位；自动关联已停止。')
      return message
    }
    const scored = pool.map((opportunity) => ({ opportunity, score: jobRoleSimilarity(message.role!, opportunity.role) })).filter((item) => item.score >= 0.84).sort((a, b) => b.score - a.score || a.opportunity.id.localeCompare(b.opportunity.id))
    if (scored.length === 0) return message
    if (scored.length === 1) return { ...message, company: scored[0]!.opportunity.company, role: scored[0]!.opportunity.role }
    const best = scored[0]!, second = scored[1]!
    if (best.score >= 0.94 && best.score - second.score >= 0.12) return { ...message, company: best.opportunity.company, role: best.opportunity.role }
    return appendResolutionNote({ ...message, confidence: 'medium' }, '存在多个高度相似的同公司岗位；Gmail 自动关联已停止，保留为 unresolved。')
  })
}

function findRun(snapshot: Awaited<ReturnType<WorkspaceSource['read']>>['snapshot'], sourceKind: 'gpt_monitor' | 'gmail', sourceId: string, runId: string) {
  return (snapshot.data.timeline ?? []).find((item) => item.ingestionRun?.sourceKind === sourceKind && item.ingestionRun.sourceId === sourceId && item.ingestionRun.runId === runId)?.ingestionRun
}

function snapshotForReplay(snapshot: Awaited<ReturnType<WorkspaceSource['read']>>['snapshot'], sourceKind: 'gpt_monitor' | 'gmail', sourceId: string, replayOfRunId?: string) {
  if (!replayOfRunId) return snapshot
  const next = structuredClone(snapshot)
  next.data.timeline = (next.data.timeline ?? []).filter((item) => !(
    (item.ingestionRun?.sourceKind === sourceKind && item.ingestionRun.sourceId === sourceId && item.ingestionRun.runId === replayOfRunId) ||
    (item.ingestion?.sourceKind === sourceKind && item.ingestion.sourceId === sourceId && item.ingestion.runId === replayOfRunId)
  ))
  return next
}

async function persistResult(source: WorkspaceSource, workspaceVersion: string | undefined, updatedByDevice: string, result: ReturnType<typeof applyMonitorIngestionHardened> | ReturnType<typeof applyGmailIngestionHardened>) {
  if (result.alreadyApplied) return { workspaceVersion, result }
  const writable = requireWritableWorkspaceSource(source)
  const written = await writable.write({ snapshot: result.snapshot, expectedWorkspaceVersion: workspaceVersion, updatedByDevice })
  return { workspaceVersion: written.context.workspaceVersion, result }
}

function replayComparison(baseline: IngestionRunSummary | undefined, preview: IngestionRunSummary, replayOfRunId?: string) {
  if (!replayOfRunId) return undefined
  return {
    replayOfRunId,
    baselineFound: Boolean(baseline),
    baseline: baseline ? { receivedCount: baseline.receivedCount, accountedCount: baseline.accountedCount, outcomes: baseline.outcomes } : undefined,
    preview: { receivedCount: preview.receivedCount, accountedCount: preview.accountedCount, outcomes: preview.outcomes },
  }
}

function outputFor(workspaceVersion: string | undefined, result: ReturnType<typeof applyMonitorIngestionHardened> | ReturnType<typeof applyGmailIngestionHardened>, simulation: SimulationArgs = {}, baseline?: IngestionRunSummary) {
  return {
    workspaceVersion,
    dryRun: Boolean(simulation.dryRun),
    run: result.run,
    alreadyApplied: result.alreadyApplied,
    allInputsAccounted: result.run.receivedCount === result.run.accountedCount,
    createdOpportunityIds: result.createdOpportunityIds,
    touchedOpportunityIds: result.touchedOpportunityIds,
    processEventIds: result.processEventIds,
    unresolvedCount: result.run.outcomes.unresolved ?? 0,
    replay: replayComparison(baseline, result.run, simulation.replayOfRunId),
    message: simulation.dryRun
      ? `Dry run only: ${result.run.receivedCount} inputs simulated; no workspace write was performed.`
      : result.run.outcomes.unresolved
        ? `${result.run.receivedCount} inputs were fully accounted for; ${result.run.outcomes.unresolved} remain as explicit exceptions.`
        : `${result.run.receivedCount} inputs were fully accounted for with no unresolved exceptions.`,
  }
}

export async function invokeTrustedIngestion(
  source: WorkspaceSource,
  name: TrustedIngestionToolName,
  args: unknown,
  options: {
    authorize?: (name: TrustedIngestionToolName, sourceId: string) => Promise<void | DiscoveryCommitAuthorization>
    fetchImpl?: typeof fetch
    sourceVerifier?: (observation: MonitorJobObservation) => Promise<MonitorJobObservation>
  } = {},
): Promise<CallToolResult> {
  try {
    assertNoScoringInput(args)
    if (name === 'ingest_discovery_run') {
      const parsed = ingestDiscoveryRunSchema.parse(args) as HardenedMonitorIngestionRunInput & SimulationArgs
      const discoveryAuthorization = await options.authorize?.(name, parsed.sourceId)
      const workspace = await source.read()
      const now = workspace.context.now ?? new Date()
      if (parsed.replayOfRunId && !parsed.dryRun) return toolError('INVALID_ARGUMENT', 'replayOfRunId is dry-run only.', false)
      if (!parsed.dryRun) requireWritableWorkspaceSource(source)
      const policy = resolveSourcePolicy('gpt_monitor', parsed.sourceId, parsed.sourcePolicy)
      const request = { sourceId: parsed.sourceId, runId: parsed.runId, sourcePolicy: policy, observations: parsed.observations }
      const fingerprint = await hashMutationPayload('ingest_verified_discovery', request)
      const previous = !parsed.replayOfRunId && findRun(workspace.snapshot, 'gpt_monitor', parsed.sourceId, parsed.runId)
      if (previous) {
        const commandId = await verifiedDiscoveryCommandId(parsed.sourceId, parsed.runId)
        if (previous.inputFingerprint !== fingerprint || previous.commandId !== commandId) return toolError('COMMAND_ID_REUSED', 'This run ID has different facts or unsupported legacy evidence.', false)
        if (parsed.dryRun) return success({ ...outputFor(workspace.context.workspaceVersion, { snapshot: workspace.snapshot, run: previous, records: [],
          alreadyApplied: true, createdOpportunityIds: [], touchedOpportunityIds: [], processEventIds: [] }, parsed),
          durableCommit: false, readbackVerified: false, commandId })
        const receipt = await readVerifiedDiscoveryReceipt(source, { commandId, kind: 'ingest_verified_discovery', inputFingerprint: fingerprint }, workspace.context.workspaceVersion)
        if (!receipt) return toolError('DISCOVERY_COMMIT_UNVERIFIED', 'This run has no matching authoritative command receipt.', true)
        return success({ ...outputFor(workspace.context.workspaceVersion, { snapshot: workspace.snapshot, run: previous, records: [],
          alreadyApplied: true, createdOpportunityIds: [], touchedOpportunityIds: [], processEventIds: [] }, parsed),
          durableCommit: true, readbackVerified: true, commandId, receipt })
      }
      if (!isDiscoveryProfileConfigured(discoveryProfileForSnapshot(workspace.snapshot.data.discoveryProfile))) {
        return toolError('DISCOVERY_PROFILE_REQUIRED', 'Confirm the search scope before automatic Discovery ingestion. Explicit user job creation remains a separate command.', false)
      }
      if (!isDiscoverySearchScopeConfirmed(discoveryProfileForSnapshot(workspace.snapshot.data.discoveryProfile))) {
        return toolError('DISCOVERY_SCOPE_CONFIRMATION_REQUIRED', 'Confirm the complete current search scope before automatic Discovery ingestion. Historical preferences remain unchanged.', false)
      }
      const scopeFingerprint = await discoveryProfileManagementFingerprint(workspace.snapshot.data.discoveryProfile ?? null)
      const verifyObservation = options.sourceVerifier ?? createDiscoverySourceVerifier({ fetchImpl: options.fetchImpl, now })
      const verifiedObservations = await Promise.all(parsed.observations.map(observation => verifyObservation(observation)))
      const baseline = parsed.replayOfRunId ? findRun(workspace.snapshot, 'gpt_monitor', parsed.sourceId, parsed.replayOfRunId) : undefined
      if (parsed.replayOfRunId && !baseline) return toolError('REPLAY_BASELINE_NOT_FOUND', `Run ${parsed.replayOfRunId} was not found for ${parsed.sourceId}.`, false)
      const command = await prepareVerifiedDiscoveryCommand({ request, scopeFingerprint, run: {
        sourceId: parsed.sourceId, runId: parsed.runId, producer: 'mcp_trusted_ingestion',
        startedAt: now.toISOString(), completedAt: now.toISOString(), sourcePolicy: policy,
        observations: verifiedObservations as Parameters<typeof prepareVerifiedDiscoveryCommand>[0]['run']['observations'],
      } })
      if (parsed.dryRun) {
        const simulationSnapshot = snapshotForReplay(workspace.snapshot, 'gpt_monitor', parsed.sourceId, parsed.replayOfRunId)
        const applied = applyUserDomainCommand(simulationSnapshot, command, now)
        return success({ ...outputFor(workspace.context.workspaceVersion, applied.ingestion, parsed, baseline), durableCommit: false, readbackVerified: false })
      }
      const persisted = await commitVerifiedDiscoveryRun(source, command, { discoveryAuthorization: discoveryAuthorization || undefined,
        authorize: async () => { await options.authorize?.(name, parsed.sourceId) } })
      return success({ ...outputFor(persisted.workspaceVersion, persisted.result),
        durableCommit: persisted.durableCommit, readbackVerified: persisted.readbackVerified,
        commandId: persisted.commandId, receipt: persisted.receipt,
        ...('verificationWarning' in persisted ? { verificationWarning: persisted.verificationWarning } : {}) })
    }

    const parsed = ingestGmailRunSchema.parse(args) as HardenedGmailIngestionRunInput & SimulationArgs
    await options.authorize?.(name, parsed.sourceId)
    const workspace = await source.read()
    if (parsed.replayOfRunId && !parsed.dryRun) return toolError('INVALID_ARGUMENT', 'replayOfRunId is dry-run only.', false)
    if (!parsed.dryRun) requireWritableWorkspaceSource(source)
    const baseline = parsed.replayOfRunId ? findRun(workspace.snapshot, 'gmail', parsed.sourceId, parsed.replayOfRunId) : undefined
    if (parsed.replayOfRunId && !baseline) return toolError('REPLAY_BASELINE_NOT_FOUND', `Run ${parsed.replayOfRunId} was not found for ${parsed.sourceId}.`, false)
    const simulationSnapshot = snapshotForReplay(workspace.snapshot, 'gmail', parsed.sourceId, parsed.replayOfRunId)
    const input: HardenedGmailIngestionRunInput = {
      ...parsed,
      producer: 'mcp_trusted_ingestion',
      sourcePolicy: resolveSourcePolicy('gmail', parsed.sourceId, parsed.sourcePolicy),
      messages: normalizeGmailMessagesForWorkspace(parsed.messages, simulationSnapshot.data.opportunities),
    }
    const result = applyGmailIngestionHardened(simulationSnapshot, input)
    if (parsed.dryRun) return success(outputFor(workspace.context.workspaceVersion, result, parsed, baseline))
    const persisted = await persistResult(source, workspace.context.workspaceVersion, `gmail-ingestion:${input.sourceId}`, result)
    return success(outputFor(persisted.workspaceVersion, persisted.result))
  } catch (caught) {
    return failure(caught)
  }
}
