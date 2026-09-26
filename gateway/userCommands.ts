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

export const applyUserCommandSchema = z.discriminatedUnion('kind', [
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
    const command = applyUserCommandSchema.parse(rawArgs) as UserDomainCommand
    const workspace = await source.read()
    const applied = applyUserDomainCommand(workspace.snapshot, command, workspace.context.now ?? new Date())

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
        compensation: applied.compensation,
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
