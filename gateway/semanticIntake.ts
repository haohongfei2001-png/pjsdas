import type { CallToolResult } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import {
  applySemanticCompensation,
  applySemanticIntake,
  resolveSemanticDecision,
  type SemanticBatchCompensation,
} from '../src/semanticIntake.js'
import type { SemanticIntakeObservation, SemanticIntakeSourceRef } from '../src/model.js'
import { requireWritableWorkspaceSource, WorkspaceSourceError, type WorkspaceSource } from './workspaceSource.js'

const isoString = z.string().trim().min(1).max(100).refine(
  (value) => !Number.isNaN(new Date(value).getTime()),
  'Expected a valid date/time string.',
)
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const confidence = z.enum(['high', 'medium', 'low'])
const precision = z.enum(['date', 'datetime'])
const scheduleKind = z.enum(['interview', 'written_test', 'assessment', 'application_deadline', 'follow_up', 'prep_trigger'])
const timingMode = z.enum(['deadline', 'fixed'])
const processEventType = z.enum(['assessment_invite', 'written_test_invite', 'interview_invite', 'offer', 'rejection', 'status_update', 'other'])

const target = z.object({
  opportunityId: z.string().trim().min(1).max(240).optional(),
  company: z.string().trim().min(1).max(240).optional(),
  role: z.string().trim().min(1).max(320).optional(),
  occurrenceId: z.string().trim().min(1).max(320).optional(),
  scheduleNodeId: z.string().trim().min(1).max(320).optional(),
  occurrenceKind: scheduleKind.optional(),
}).strict()

const temporal = z.object({
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

const baseCandidate = {
  id: z.string().trim().min(1).max(180),
  target: target.optional(),
  objectConfidence: confidence,
  eventConfidence: confidence,
  temporalConfidence: confidence.optional(),
  evidenceRefs: z.array(z.string().trim().min(1).max(1000)).max(20).default([]),
  sourceVersionRefs: z.array(z.string().trim().min(1).max(1000)).max(20).default([]),
}

const candidate = z.discriminatedUnion('kind', [
  z.object({ ...baseCandidate, kind: z.literal('application_submitted'), occurredAt: isoString.optional() }).strict(),
  z.object({
    ...baseCandidate,
    kind: z.literal('process_event'),
    temporal: temporal.optional(),
    eventType: processEventType,
    occurredAt: isoString.optional(),
    dueAt: isoString.optional(),
    duePrecision: precision.optional(),
    timingMode: timingMode.optional(),
    estimatedMinutes: z.number().int().min(5).max(720).optional(),
    notes: z.string().trim().max(800).optional(),
    location: z.string().trim().max(200).optional(),
    joinUrl: z.string().trim().max(500).url().refine((value) => new URL(value).protocol === 'https:').optional(),
  }).strict(),
  z.object({
    ...baseCandidate,
    kind: z.literal('opportunity_deadline'),
    deadline: z.string().trim().min(1).max(100),
    precision,
  }).strict(),
  z.object({ ...baseCandidate, kind: z.enum(['occurrence_completed', 'occurrence_cancelled']), occurredAt: isoString.optional() }).strict(),
  z.object({ ...baseCandidate, kind: z.literal('occurrence_rescheduled'), temporal }).strict(),
  z.object({ ...baseCandidate, kind: z.literal('abandon_opportunity'), occurredAt: isoString.optional() }).strict(),
  z.object({
    ...baseCandidate,
    kind: z.literal('manual_action'),
    title: z.string().trim().min(1).max(300),
    dueAt: z.string().trim().min(1).max(100).optional(),
    duePrecision: precision.optional(),
    estimatedMinutes: z.number().int().min(5).max(720).optional(),
  }).strict(),
  z.object({ ...baseCandidate, kind: z.literal('external_withdrawal') }).strict(),
])

const source = z.object({
  kind: z.enum(['web', 'paia', 'gmail', 'mcp', 'iphone']),
  sourceId: z.string().trim().min(1).max(240),
  sourceRecordId: z.string().trim().min(1).max(500),
  sourceVersion: z.string().trim().min(1).max(300).optional(),
  observedAt: isoString,
  assertedAt: isoString.optional(),
  timezone: z.string().trim().min(1).max(120),
  authorizationGrantId: z.string().trim().min(1).max(300).optional(),
}).strict()

export const semanticIntakeSchema = z.object({
  contractVersion: z.literal(1),
  inputId: z.string().trim().min(8).max(240),
  source,
  statementMode: z.enum(['assertion', 'current_intent', 'question', 'quote', 'example', 'hypothetical', 'rewrite_request']),
  originalText: z.string().max(8_000).optional(),
  originalTextFingerprint: z.string().trim().min(1).max(200).optional(),
  contextRefs: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  candidates: z.array(candidate).max(12),
}).strict()

export const resolveSemanticDecisionSchema = z.object({
  requestId: z.string().trim().min(1).max(240),
  choiceId: z.string().trim().min(1).max(240),
}).strict()

export const undoSemanticCommandSchema = z.object({
  targetCommandId: z.string().trim().min(1).max(300),
}).strict()

function success(body: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
    structuredContent: body,
  }
}

function failure(caught: unknown): CallToolResult {
  if (caught instanceof WorkspaceSourceError) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ code: caught.code, message: caught.message, retryable: caught.retryable }) }],
    }
  }
  if (caught instanceof z.ZodError) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ code: 'INVALID_ARGUMENT', message: caught.issues[0]?.message ?? 'Invalid semantic intake.', retryable: false }) }],
    }
  }
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({
      code: 'SEMANTIC_INTAKE_FAILED',
      message: caught instanceof Error ? caught.message : 'Semantic Intake failed.',
      retryable: false,
    }) }],
  }
}

function ledgerObservation(observation: SemanticIntakeObservation) {
  return {
    ...observation,
    originalText: undefined,
    originalTextFingerprint: observation.originalTextFingerprint
      ?? (observation.originalText ? 'present-but-not-persisted' : undefined),
  }
}

export async function invokeSemanticIntake(
  workspaceSource: WorkspaceSource,
  rawArgs: unknown,
  options: {
    authorize?: (source: SemanticIntakeSourceRef) => Promise<void>
  } = {},
): Promise<CallToolResult> {
  try {
    const observation = semanticIntakeSchema.parse(rawArgs) as SemanticIntakeObservation
    await options.authorize?.(observation.source)
    const workspace = await workspaceSource.read()
    const evaluated = applySemanticIntake(workspace.snapshot, observation, {
      authorized: true,
      workspaceRevision: workspace.context.workspaceVersion,
      now: workspace.context.now,
    })

    if (!evaluated.changed) {
      return success({
        applied: evaluated.status === 'ALREADY_APPLIED',
        alreadyApplied: evaluated.status === 'ALREADY_APPLIED',
        noWrite: evaluated.status === 'NO_WRITE',
        decisionRequired: false,
        message: evaluated.summary,
        receipt: evaluated.receipt,
        workspaceVersion: workspace.context.workspaceVersion,
      })
    }

    const writable = requireWritableWorkspaceSource(workspaceSource)
    const commandId = evaluated.receipt?.commandId ?? `semantic-intake:${observation.inputId}`
    const written = await writable.write({
      snapshot: evaluated.snapshot,
      expectedWorkspaceVersion: workspace.context.workspaceVersion,
      updatedByDevice: `semantic-intake:${observation.source.kind}:${observation.source.sourceId}`,
      command: {
        commandId,
        operation: 'semantic_intake',
        payload: ledgerObservation(observation),
        compensation: evaluated.compensation as unknown as Record<string, unknown> | undefined,
        provenance: {
          channel: 'semantic-intake-v1',
          sourceKind: observation.source.kind,
          sourceId: observation.source.sourceId,
          sourceRecordId: observation.source.sourceRecordId,
          sourceVersion: observation.source.sourceVersion,
          authorizationGrantId: observation.source.authorizationGrantId,
        },
        effectiveTime: observation.source.assertedAt ?? observation.source.observedAt,
      },
    })

    return success({
      applied: evaluated.status === 'APPLIED',
      alreadyApplied: false,
      noWrite: false,
      decisionRequired: evaluated.decisionRequests.length > 0,
      message: evaluated.summary,
      receipt: evaluated.receipt,
      decisionRequests: evaluated.decisionRequests,
      workspaceVersion: written.context.workspaceVersion,
      commandId,
    })
  } catch (caught) {
    return failure(caught)
  }
}

export async function invokeResolveSemanticDecision(
  workspaceSource: WorkspaceSource,
  rawArgs: unknown,
): Promise<CallToolResult> {
  try {
    const parsed = resolveSemanticDecisionSchema.parse(rawArgs)
    const workspace = await workspaceSource.read()
    const evaluated = resolveSemanticDecision(
      workspace.snapshot,
      parsed.requestId,
      parsed.choiceId,
      workspace.context.now,
    )
    if (!evaluated.changed) {
      return success({
        applied: false,
        alreadyResolved: true,
        message: evaluated.summary,
        workspaceVersion: workspace.context.workspaceVersion,
      })
    }

    const writable = requireWritableWorkspaceSource(workspaceSource)
    const commandId = evaluated.receipt?.commandId ?? `semantic-decision:${parsed.requestId}:${parsed.choiceId}`
    const written = await writable.write({
      snapshot: evaluated.snapshot,
      expectedWorkspaceVersion: workspace.context.workspaceVersion,
      updatedByDevice: 'semantic-decision-resolution',
      command: {
        commandId,
        operation: 'resolve_semantic_decision',
        payload: parsed,
        compensation: evaluated.compensation as unknown as Record<string, unknown> | undefined,
        provenance: { channel: 'semantic-intake-v1', decisionRequestId: parsed.requestId },
      },
    })
    return success({
      applied: evaluated.status === 'APPLIED',
      dismissed: evaluated.status === 'DISMISSED',
      message: evaluated.summary,
      receipt: evaluated.receipt,
      workspaceVersion: written.context.workspaceVersion,
      commandId,
    })
  } catch (caught) {
    return failure(caught)
  }
}

function semanticCompensation(value: Record<string, unknown>): SemanticBatchCompensation {
  if (value.operation !== 'semantic_batch' || !value.payload || typeof value.payload !== 'object') {
    throw new WorkspaceSourceError(
      'UNDO_REQUIRES_CONFIRMATION',
      'The target command does not contain a Semantic Intake compensation payload.',
      false,
    )
  }
  return value as unknown as SemanticBatchCompensation
}

export async function invokeSemanticUndo(
  workspaceSource: WorkspaceSource,
  rawArgs: unknown,
): Promise<CallToolResult> {
  try {
    const parsed = undoSemanticCommandSchema.parse(rawArgs)
    if (!workspaceSource.prepareUndo) {
      throw new WorkspaceSourceError('UNDO_NOT_SUPPORTED', 'This workspace authority does not support ledger-backed Undo.', false)
    }
    const prepared = await workspaceSource.prepareUndo(parsed.targetCommandId)
    if (prepared.outcome !== 'READY') {
      return success({
        applied: false,
        needsConfirmation: true,
        reason: prepared.reason,
        targetRevision: prepared.targetRevision,
        currentRevision: prepared.currentRevision,
      })
    }
    const compensation = semanticCompensation(prepared.compensation)
    const next = applySemanticCompensation(prepared.snapshot, compensation)
    const writable = requireWritableWorkspaceSource(workspaceSource)
    const commandId = `semantic-undo:${parsed.targetCommandId}:${prepared.expectedWorkspaceVersion}`
    const written = await writable.write({
      snapshot: next,
      expectedWorkspaceVersion: prepared.expectedWorkspaceVersion,
      updatedByDevice: 'semantic-intake-undo',
      command: {
        commandId,
        operation: 'semantic_undo',
        payload: { targetCommandId: parsed.targetCommandId },
        provenance: { channel: 'semantic-intake-v1', undoOf: parsed.targetCommandId },
      },
    })
    return success({
      applied: true,
      targetCommandId: parsed.targetCommandId,
      commandId,
      workspaceVersion: written.context.workspaceVersion,
      message: 'Semantic Intake update was compensated without overwriting unrelated workspace state.',
    })
  } catch (caught) {
    return failure(caught)
  }
}
