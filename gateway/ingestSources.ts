import type { CallToolResult } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import {
  applyGmailIngestion,
  applyMonitorIngestion,
  type GmailIngestionRunInput,
  type MonitorIngestionRunInput,
} from '../src/autonomousIngestion.js'
import { requireWritableWorkspaceSource, WorkspaceSourceError, type WorkspaceSource } from './workspaceSource.js'

const isoString = z.string().min(1).refine((value) => !Number.isNaN(new Date(value).getTime()), 'Must be a valid ISO/date timestamp.')
const confidenceSchema = z.enum(['high', 'medium', 'low'])
const roleTypeSchema = z.enum(['core', 'backup', 'reach', 'lottery', 'practice'])
const postingStatusSchema = z.enum(['open', 'closed', 'unknown'])
const processEventTypeSchema = z.enum(['assessment_invite', 'written_test_invite', 'interview_invite', 'offer', 'rejection', 'status_update', 'other'])
const processStageSchema = z.enum(['not_applied', 'screening', 'assessment', 'written_test', 'interview', 'offer', 'waiting_release', 'closed'])
const timingModeSchema = z.enum(['deadline', 'fixed'])

export const ingestDiscoveryRunSchema = z.object({
  runId: z.string().trim().min(1).max(180),
  sourceId: z.string().trim().min(1).max(180),
  startedAt: isoString,
  completedAt: isoString,
  observations: z.array(z.object({
    sourceRecordId: z.string().trim().min(1).max(500),
    company: z.string().trim().min(1).max(200),
    role: z.string().trim().min(1).max(260),
    sourceUrl: z.string().url().max(2_000),
    sourceTitle: z.string().trim().min(1).max(400),
    location: z.string().trim().max(240).optional(),
    deadline: isoString.optional(),
    compensationText: z.string().trim().max(600).optional(),
    rationale: z.string().trim().min(1).max(1_600),
    roleType: roleTypeSchema,
    opportunityValue: z.number().min(0).max(100),
    fitScore: z.number().min(0).max(100),
    fitConfidence: confidenceSchema,
    opportunityValueConfidence: confidenceSchema,
    postingStatus: postingStatusSchema.optional(),
    discoveredAt: isoString.optional(),
  })).max(100),
})

export const ingestGmailRunSchema = z.object({
  runId: z.string().trim().min(1).max(180),
  sourceId: z.string().trim().min(1).max(180),
  startedAt: isoString,
  completedAt: isoString,
  cursor: z.string().trim().max(500).optional(),
  messages: z.array(z.object({
    sourceRecordId: z.string().trim().min(1).max(500),
    receivedAt: isoString,
    classification: z.enum(['recruiting', 'ignored']),
    confidence: confidenceSchema,
    sender: z.string().trim().max(320).optional(),
    subject: z.string().trim().max(500).optional(),
    company: z.string().trim().max(200).optional(),
    role: z.string().trim().max(260).optional(),
    eventType: processEventTypeSchema.optional(),
    dueAt: isoString.optional(),
    timingMode: timingModeSchema.optional(),
    estimatedMinutes: z.number().int().min(5).max(720).optional(),
    notes: z.string().trim().max(800).optional(),
    stage: processStageSchema.optional(),
    stageLabel: z.string().trim().max(120).optional(),
    roleType: roleTypeSchema.optional(),
    fitScore: z.number().min(0).max(100).optional(),
    opportunityValue: z.number().min(0).max(100).optional(),
  })).max(100),
})

export type TrustedIngestionToolName = 'ingest_discovery_run' | 'ingest_gmail_run'

function success(output: object): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
    structuredContent: { ...output },
  }
}

function toolError(code: string, message: string, retryable: boolean): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ code, message, retryable }) }],
  }
}

function failure(caught: unknown): CallToolResult {
  if (caught instanceof WorkspaceSourceError) return toolError(caught.code, caught.message, caught.retryable)
  if (caught instanceof z.ZodError) return toolError('INVALID_ARGUMENT', caught.issues[0]?.message ?? 'Invalid ingestion arguments.', false)
  return toolError(
    'INGESTION_FAILED',
    caught instanceof Error ? caught.message : 'PJSDAS trusted-source ingestion failed.',
    false,
  )
}

async function persistResult(
  source: WorkspaceSource,
  workspaceVersion: string | undefined,
  updatedByDevice: string,
  result: ReturnType<typeof applyMonitorIngestion> | ReturnType<typeof applyGmailIngestion>,
) {
  if (result.alreadyApplied) return { workspaceVersion, result }
  const writable = requireWritableWorkspaceSource(source)
  const written = await writable.write({
    snapshot: result.snapshot,
    expectedWorkspaceVersion: workspaceVersion,
    updatedByDevice,
  })
  return { workspaceVersion: written.context.workspaceVersion, result }
}

function outputFor(
  workspaceVersion: string | undefined,
  result: ReturnType<typeof applyMonitorIngestion> | ReturnType<typeof applyGmailIngestion>,
) {
  return {
    workspaceVersion,
    run: result.run,
    alreadyApplied: result.alreadyApplied,
    allInputsAccounted: result.run.receivedCount === result.run.accountedCount,
    createdOpportunityIds: result.createdOpportunityIds,
    touchedOpportunityIds: result.touchedOpportunityIds,
    processEventIds: result.processEventIds,
    unresolvedCount: result.run.outcomes.unresolved ?? 0,
    message: result.run.outcomes.unresolved
      ? `${result.run.receivedCount} inputs were fully accounted for; ${result.run.outcomes.unresolved} remain as explicit exceptions.`
      : `${result.run.receivedCount} inputs were fully accounted for with no unresolved exceptions.`,
  }
}

export async function invokeTrustedIngestion(
  source: WorkspaceSource,
  name: TrustedIngestionToolName,
  args: unknown,
): Promise<CallToolResult> {
  try {
    const workspace = await source.read()
    if (name === 'ingest_discovery_run') {
      const input = ingestDiscoveryRunSchema.parse(args) as MonitorIngestionRunInput
      const result = applyMonitorIngestion(workspace.snapshot, input)
      const persisted = await persistResult(
        source,
        workspace.context.workspaceVersion,
        `gpt-monitor:${input.sourceId}`,
        result,
      )
      return success(outputFor(persisted.workspaceVersion, persisted.result))
    }

    const input = ingestGmailRunSchema.parse(args) as GmailIngestionRunInput
    const result = applyGmailIngestion(workspace.snapshot, input)
    const persisted = await persistResult(
      source,
      workspace.context.workspaceVersion,
      `gmail-ingestion:${input.sourceId}`,
      result,
    )
    return success(outputFor(persisted.workspaceVersion, persisted.result))
  } catch (caught) {
    return failure(caught)
  }
}
