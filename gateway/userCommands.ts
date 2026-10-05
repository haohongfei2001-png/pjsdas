import { invalidateLegacyProcessEvent } from '../src/legacyProcessCorrection.js'
import { dismissSemanticDecision } from '../src/decisionDismissal.js'
import { applyOpportunityMerge, opportunityMergeSchema } from '../src/opportunityMerge.js'
import type { CallToolResult } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { applyUserDomainCommand, type UserDomainCommand } from '../src/domainCommands.js'
import { hashMutationPayload } from './mutationKernel.js'
import { requireWritableWorkspaceSource, WorkspaceSourceError, type WorkspaceSource } from './workspaceSource.js'

const isoString = z.string().trim().min(1).max(80).refine((value) => !Number.isNaN(new Date(value).getTime()), 'Expected a valid date/time string.')
const commandId = z.string().trim().min(8).max(160)
const opportunityId = z.string().trim().min(1).max(240)
const actionId = z.string().trim().min(1).max(240)
const precision = z.enum(['date', 'datetime'])
const roleType = z.enum(['core', 'backup', 'reach', 'lottery', 'practice'])
const actionStatus = z.enum(['todo', 'doing', 'done', 'skipped'])
const processEventType = z.enum(['assessment_invite', 'written_test_invite', 'interview_invite', 'offer', 'rejection', 'status_update', 'other'])
const timingMode = z.enum(['deadline', 'fixed'])
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const scheduleTemporal = z.object({
  shape: z.enum(['fixed_range', 'deadline', 'availability_window', 'date_only', 'estimated_date']),
  precision,
  timezone: z.string().trim().min(1).max(120),
  startAt: isoString.optional(),
  endAt: isoString.optional(),
  deadlineAt: isoString.optional(),
  date: dateOnly.optional(),
  rawExpression: z.string().trim().max(500).optional(),
  resolutionBasis: z.enum(['source_explicit', 'user_explicit', 'legacy_projection', 'system_estimate']),
  legacyProjectionAt: z.string().trim().max(100).optional(),
}).strict()

const repairRevision = z.string().regex(/^txn:\d+$/)
const evidenceRefs = z.array(z.string().trim().min(1).max(1000)).min(1).max(20)
export const applyUserCommandSchema = z.discriminatedUnion('kind', [
  z.object({ commandId, kind: z.literal('invalidate_legacy_process_event'), expectedWorkspaceVersion: repairRevision,
    eventId: z.string().trim().min(1).max(240), expectedEventFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    sourceRefs: evidenceRefs, reason: z.string().trim().min(1).max(800), evidenceRefs }).strict(),
  z.object({ commandId, kind: z.literal('dismiss_semantic_decision'), expectedWorkspaceVersion: repairRevision,
    requestId: z.string().trim().min(1).max(240), expectedRequestUpdatedAt: isoString, expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    reason: z.string().trim().min(1).max(800), evidenceRefs }).strict(),
  z.object({ ...opportunityMergeSchema.shape, commandId, kind: z.literal('merge_opportunities'), expectedWorkspaceVersion: repairRevision }).strict(),
  z.object({ commandId, kind: z.literal('record_application_submission'), opportunityId, occurredAt: isoString.optional() }).strict(),
  z.object({
    commandId,
    kind: z.literal('record_process_event'),
    opportunityId,
    eventType: processEventType,
    occurredAt: isoString.optional(),
    dueAt: isoString.optional(),
    duePrecision: precision.optional(),
    timingMode: timingMode.optional(),
    estimatedMinutes: z.number().int().min(5).max(720).optional(),
    notes: z.string().trim().max(800).optional(),
  }).strict(),
  z.object({ commandId, kind: z.literal('invalidate_process_event'), opportunityId, eventId: z.string().min(1).max(240), receiptId: z.string().min(1).max(240), expectedEventUpdatedAt: isoString, reason: z.string().trim().min(1).max(800), evidenceRefs: z.array(z.string().trim().min(1).max(1000)).min(1).max(20) }).strict(),
  z.object({ commandId, kind: z.literal('correct_application_deadline'), opportunityId, expectedDeadlineFingerprint: z.string().min(1).max(64_000), correction: z.object({
    state: z.enum(['confirmed', 'unknown']), deadline: isoString.optional(), precision: precision.optional(), sourceUrl: z.string().url().max(2000), sourceAuthority: z.enum(['official_role', 'official_campaign', 'university_repost', 'aggregator', 'user']), evidence: z.string().trim().min(1).max(1600), checkedAt: isoString, postingStatus: z.enum(['open', 'closed', 'unknown']),
  }).strict() }).strict(),
  z.object({ commandId, kind: z.literal('set_deadline'), opportunityId, deadline: isoString, precision }).strict(),
  z.object({ commandId, kind: z.literal('complete_occurrence'), occurrenceId: z.string().trim().min(1).max(320), occurredAt: isoString.optional() }).strict(),
  z.object({ commandId, kind: z.literal('cancel_occurrence'), occurrenceId: z.string().trim().min(1).max(320), occurredAt: isoString.optional() }).strict(),
  z.object({
    commandId,
    kind: z.literal('reschedule_occurrence'),
    occurrenceId: z.string().trim().min(1).max(320),
    temporal: scheduleTemporal,
    evidenceRefs: z.array(z.string().trim().min(1).max(1000)).max(20).optional(),
    sourceVersionRefs: z.array(z.string().trim().min(1).max(1000)).max(20).optional(),
  }).strict(),
  z.object({ commandId, kind: z.literal('set_action_status'), actionId, status: actionStatus }).strict(),
  z.object({ commandId, kind: z.literal('abandon_opportunity'), opportunityId, occurredAt: isoString.optional() }).strict(),
  z.object({
    commandId,
    kind: z.literal('correct_opportunity_fact'),
    opportunityId,
    field: z.enum(['location', 'compensationText', 'applicationUrl']),
    value: z.string().trim().min(1).max(2000),
  }).strict(),
  z.object({ commandId, kind: z.literal('set_opportunity_preference'), opportunityId, roleType }).strict(),
  z.object({ commandId, kind: z.literal('set_daily_capacity'), minutes: z.number().int().min(0).max(1440) }).strict(),
  z.object({ commandId, kind: z.literal('set_date_capacity'), date: dateOnly, minutes: z.number().int().min(0).max(1440) }).strict(),
  z.object({ commandId, kind: z.literal('set_work_windows'), windows: z.array(z.object({
    weekday: z.number().int().min(0).max(6), startMinute: z.number().int().min(0).max(1439), endMinute: z.number().int().min(1).max(1440),
  }).strict()).max(21) }).strict(),
  z.object({
    commandId,
    kind: z.literal('add_manual_action'),
    title: z.string().trim().min(1).max(300),
    dueAt: isoString.optional(),
    duePrecision: precision.optional(),
    estimatedMinutes: z.number().int().min(5).max(720).optional(),
  }).strict(),
])

function result(body: Record<string, unknown>, isError = false): CallToolResult {
  return {
    isError,
    content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
    structuredContent: body,
  }
}

function errorResult(caught: unknown): CallToolResult {
  if (caught instanceof WorkspaceSourceError) {
    return result({ code: caught.code, message: caught.message, retryable: caught.retryable }, true)
  }
  if (caught instanceof z.ZodError) {
    return result({ code: 'INVALID_ARGUMENT', message: caught.issues[0]?.message ?? 'Invalid user command.', retryable: false }, true)
  }
  return result({
    code: 'USER_COMMAND_FAILED',
    message: caught instanceof Error ? caught.message : 'TodayAction user command failed.',
    retryable: false,
  }, true)
}

export async function invokeApplyUserCommand(source: WorkspaceSource, rawArgs: unknown): Promise<CallToolResult> {
  try {
    const command = applyUserCommandSchema.parse(rawArgs)
    const workspace = await source.read()
    const now = workspace.context.now ?? new Date()
    const applied = command.kind === 'invalidate_legacy_process_event'
      ? await invalidateLegacyProcessEvent(workspace.snapshot, command, now)
      : command.kind === 'dismiss_semantic_decision'
        ? await dismissSemanticDecision(workspace.snapshot, command, now)
        : command.kind === 'merge_opportunities'
          ? await applyOpportunityMerge(workspace.snapshot, (({ commandId: _id, kind: _kind, expectedWorkspaceVersion: _version, ...input }) => input)(command), command.commandId, now)
          : applyUserDomainCommand(workspace.snapshot, command as UserDomainCommand, now)

    if (applied.status === 'NEEDS_CONFIRMATION') {
      return result({
        applied: false,
        reviewRequired: false,
        needsConfirmation: true,
        reason: applied.reason,
        message: applied.summary,
        workspaceVersion: workspace.context.workspaceVersion,
      })
    }

    if (applied.status === 'ALREADY_APPLIED') {
      return result({
        applied: true,
        alreadyApplied: true,
        reviewRequired: false,
        message: applied.summary,
        workspaceVersion: workspace.context.workspaceVersion,
      })
    }

    if ('expectedWorkspaceVersion' in command && workspace.context.workspaceVersion !== command.expectedWorkspaceVersion) {
      throw new WorkspaceSourceError('CONFLICT', 'Workspace revision changed since repair review; read it again before applying.', false)
    }
    const writable = requireWritableWorkspaceSource(source)
    const payloadHash = await hashMutationPayload(command.kind, command)
    const written = await writable.write({
      snapshot: applied.snapshot,
      expectedWorkspaceVersion: workspace.context.workspaceVersion ?? workspace.snapshot.exportedAt,
      updatedByDevice: 'mcp-explicit-user-command',
      command: {
        commandId: command.commandId,
        operation: command.kind,
        payload: command,
        payloadHash,
        compensation: 'compensation' in applied ? applied.compensation as unknown as Record<string, unknown> : undefined,
        provenance: { channel: 'mcp-explicit-user-command' },
        effectiveTime: 'occurredAt' in command && command.occurredAt ? command.occurredAt : undefined,
      },
    })

    return result({
      applied: true,
      alreadyApplied: false,
      reviewRequired: false,
      message: applied.summary,
      workspaceVersion: written.context.workspaceVersion,
      commandId: command.commandId,
      operation: command.kind,
    })
  } catch (caught) {
    return errorResult(caught)
  }
}
