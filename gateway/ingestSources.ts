import type { CallToolResult } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import {
  applyGmailIngestion,
  applyMonitorIngestion,
  type GmailIngestionRunInput,
  type GmailMessageObservation,
  type MonitorIngestionRunInput,
} from '../src/autonomousIngestion.js'
import { jobRoleSimilarity, normalizeJobCompany } from '../src/jobPosting.js'
import type { Opportunity } from '../src/model.js'
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

function appendResolutionNote(message: GmailMessageObservation, note: string): GmailMessageObservation {
  const notes = [message.notes?.trim(), note].filter(Boolean).join('；')
  return { ...message, notes: notes.slice(0, 800) }
}

function companyKey(value: string) {
  return normalizeJobCompany(value)
    .replace(/(?:校园招聘|校园|校招|招聘)$/g, '')
    .trim()
}

function activeOpportunity(opportunity: Opportunity) {
  return opportunity.processStage !== 'closed'
}

/**
 * Re-check Gmail entity resolution at the trusted-write boundary.
 *
 * The upstream automation may extract a company/role from mail, but it is not
 * allowed to pick an arbitrary Opportunity when more than one existing role is
 * plausible. Missing roles can be filled only when the company has exactly one
 * active Opportunity. Otherwise confidence is downgraded and the ingestion
 * engine will preserve the message as unresolved instead of guessing.
 */
export function normalizeGmailMessagesForWorkspace(
  messages: GmailMessageObservation[],
  opportunities: Opportunity[],
): GmailMessageObservation[] {
  return messages.map((message) => {
    if (message.classification !== 'recruiting' || message.confidence !== 'high' || !message.company?.trim()) {
      return message
    }

    const key = companyKey(message.company)
    const companyMatches = opportunities.filter((opportunity) => companyKey(opportunity.company) === key)
    const active = companyMatches.filter(activeOpportunity)
    const pool = active.length ? active : companyMatches

    if (!message.role?.trim()) {
      if (pool.length === 1) {
        const target = pool[0]!
        return appendResolutionNote({
          ...message,
          company: target.company,
          role: target.role,
        }, 'Gmail 网关按该公司唯一活跃 Opportunity 自动关联。')
      }
      if (pool.length > 1) {
        return appendResolutionNote({ ...message, confidence: 'medium' }, '同一公司存在多个活跃 Opportunity，邮件未明确岗位；自动关联已停止。')
      }
      return message
    }

    const scored = pool
      .map((opportunity) => ({ opportunity, score: jobRoleSimilarity(message.role!, opportunity.role) }))
      .filter((item) => item.score >= 0.84)
      .sort((a, b) => b.score - a.score || a.opportunity.id.localeCompare(b.opportunity.id))

    if (scored.length === 0) return message
    if (scored.length === 1) {
      const target = scored[0]!.opportunity
      return {
        ...message,
        company: target.company,
        role: target.role,
      }
    }

    const best = scored[0]!
    const second = scored[1]!
    if (best.score >= 0.94 && best.score - second.score >= 0.12) {
      return {
        ...message,
        company: best.opportunity.company,
        role: best.opportunity.role,
      }
    }

    return appendResolutionNote({ ...message, confidence: 'medium' }, '存在多个高度相似的同公司岗位；Gmail 自动关联已停止，保留为 unresolved。')
  })
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

    const parsed = ingestGmailRunSchema.parse(args) as GmailIngestionRunInput
    const input: GmailIngestionRunInput = {
      ...parsed,
      messages: normalizeGmailMessagesForWorkspace(parsed.messages, workspace.snapshot.data.opportunities),
    }
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
