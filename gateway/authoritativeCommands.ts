import * as z from 'zod/v4'
import {
  applyDomainCompensation,
  applyUserDomainCommand,
  type DomainCompensation,
  type UserDomainCommand,
} from '../src/domainCommands.js'
import {
  applySemanticCompensation,
  applySemanticIntake,
  resolveSemanticDecision,
  type SemanticBatchCompensation,
} from '../src/semanticIntake.js'
import type { PJSDASSnapshot } from '../src/snapshot.js'
import type { SemanticIntakeObservation } from '../src/model.js'
import { applyDiscoveryStatusCommand } from '../src/discoveryStatusCommand.js'
import { applyDiscoveryProfileCommand } from '../src/discoveryProfileCommand.js'
import { applyUserCommandSchema } from './userCommands.js'
import { semanticIntakeSchema, resolveSemanticDecisionSchema } from './semanticIntake.js'
import { hashMutationPayload, type MutationPrincipal } from './mutationKernel.js'
import {
  createTransactionalWorkspaceStore,
  type ConnectedCommandRecord,
  type TransactionalWorkspaceStoreOptions,
} from './transactionalWorkspaceStore.js'
import { WorkspaceSourceError } from './workspaceSource.js'
import {
  decisionIntentObjects,
  diffCommandObjects,
  domainIntentObjects,
  overlappingCommandObjects,
  readModelInvalidation,
  receiptAffectedObjects,
  semanticIntentObjects,
  type CommandObjectRef,
} from './commandObjects.js'

const commandId = z.string().trim().min(8).max(300)
const baseRevision = z.number().int().min(0)
const profileList = z.array(z.string().trim().min(1).max(160)).max(30)
const discoveryProfileSchema = z.object({
  key: z.literal('current'), version: z.literal(1),
  targetRoleQueries: profileList, preferredLocations: profileList,
  locationNotes: z.string().max(1200),
  minimumAnnualCompensationWan: z.number().min(0).max(1000).optional(),
  preferredRoleTypes: z.array(z.enum(['core','backup','reach','lottery','practice'])).max(5).optional(),
  locationPolicy: z.enum(['prefer','strict']).optional(),
  minimumFitScore: z.number().min(0).max(100).optional(),
  minimumOpportunityValue: z.number().min(0).max(100).optional(),
  maxReviewCandidates: z.number().int().min(1).max(12).optional(),
  mustHave: profileList, mustNotHave: profileList, strengths: profileList,
  notes: z.string().max(2400), updatedAt: z.string().max(40),
}).strict()

export const authoritativeBusinessCommandSchema = z.object({
  commandId,
  baseRevision,
  command: z.discriminatedUnion('type', [
    z.object({ type: z.literal('domain'), value: applyUserCommandSchema }).strict(),
    z.object({ type: z.literal('semantic_intake'), value: semanticIntakeSchema }).strict(),
    z.object({ type: z.literal('resolve_semantic_decision'), value: resolveSemanticDecisionSchema }).strict(),
    z.object({ type: z.literal('discovery_profile'), value: discoveryProfileSchema }).strict(),
    z.object({ type: z.literal('discovery_status'), value: z.object({
      inboxItemId: z.string().trim().min(1).max(240),
      status: z.enum(['new', 'seen', 'later', 'dismissed']),
      rejectionReason: z.enum(['location', 'compensation', 'role_direction', 'company_value', 'requirements', 'already_have_better', 'not_interested', 'other']).optional(),
    }).strict() }).strict(),
  ]),
}).strict()

export const authoritativeUndoSchema = z.object({
  commandId,
  targetCommandId: commandId,
}).strict()

export type AuthoritativeBusinessCommand = z.infer<typeof authoritativeBusinessCommandSchema>

export interface AuthoritativeConflict {
  kind: 'OBJECT_CONFLICT' | 'OPAQUE_INTERVENING_WRITE' | 'BUSINESS_CONFIRMATION_REQUIRED'
  message: string
  objects: CommandObjectRef[]
  interveningCommandIds?: string[]
  reason?: string
}

export interface AuthoritativeCommandExecution {
  outcome: 'COMMITTED' | 'ALREADY_APPLIED' | 'NO_WRITE' | 'CONFLICT'
  revision: number
  snapshot: PJSDASSnapshot
  receipt?: Record<string, unknown>
  conflict?: AuthoritativeConflict
  result?: Record<string, unknown>
}

function resultPayload(command: AuthoritativeBusinessCommand['command'], evaluated: any) {
  if (command.type === 'domain' || command.type === 'discovery_status' || command.type === 'discovery_profile') {
    return {
      type: command.type,
      status: evaluated.status,
      summary: evaluated.summary,
    }
  }
  if (command.type === 'semantic_intake') {
    return {
      type: command.type,
      status: evaluated.status,
      summary: evaluated.summary,
      decisionRequestIds: evaluated.decisionRequests.map((item: { id: string }) => item.id),
      semanticReceiptId: evaluated.receipt?.id,
    }
  }
  return {
    type: command.type,
    status: evaluated.status,
    summary: evaluated.summary,
    semanticReceiptId: evaluated.receipt?.id,
  }
}

function operationFor(command: AuthoritativeBusinessCommand['command']) {
  if (command.type === 'domain') return `domain:${command.value.kind}`
  return command.type
}

function intentObjects(command: AuthoritativeBusinessCommand['command'], snapshot: PJSDASSnapshot) {
  if (command.type === 'domain') return domainIntentObjects(command.value as UserDomainCommand, snapshot)
  if (command.type === 'discovery_status') return [{ type: 'discovery_inbox', id: command.value.inboxItemId }]
  if (command.type === 'discovery_profile') return [{ type: 'discovery_profile', id: 'current' }]
  if (command.type === 'semantic_intake') return semanticIntentObjects(command.value as SemanticIntakeObservation, snapshot)
  return decisionIntentObjects(command.value.requestId, snapshot)
}

function receiptObjects(record: ConnectedCommandRecord, snapshot: PJSDASSnapshot) {
  return receiptAffectedObjects(record.receipt, snapshot)
}

function conflictFromIntervening(
  intent: CommandObjectRef[],
  current: PJSDASSnapshot,
  intervening: ConnectedCommandRecord[],
): AuthoritativeConflict | undefined {
  const overlaps = new Map<string, CommandObjectRef>()
  const conflictingCommands: string[] = []
  for (const record of intervening) {
    const affected = receiptObjects(record, current)
    if (!affected) {
      return {
        kind: 'OPAQUE_INTERVENING_WRITE',
        message: 'A legacy or compatibility write changed the workspace after this command was prepared. Refresh before retrying so newer authoritative fields cannot be overwritten.',
        objects: intent,
        interveningCommandIds: [record.commandId],
      }
    }
    const shared = overlappingCommandObjects(intent, affected)
    if (shared.length) {
      conflictingCommands.push(record.commandId)
      for (const ref of shared) overlaps.set(`${ref.type}:${ref.id}`, ref)
    }
  }
  if (!overlaps.size) return undefined
  return {
    kind: 'OBJECT_CONFLICT',
    message: 'The same business object changed after this command was prepared. PJSDAS kept the newer authoritative state and did not guess which fact should win.',
    objects: [...overlaps.values()],
    interveningCommandIds: conflictingCommands,
  }
}

function semanticCompensation(value: Record<string, unknown>): SemanticBatchCompensation | undefined {
  if (value.operation !== 'semantic_batch' || !value.payload || typeof value.payload !== 'object') return undefined
  return value as unknown as SemanticBatchCompensation
}

function applyCompensation(snapshot: PJSDASSnapshot, compensation: Record<string, unknown>, now: Date) {
  const semantic = semanticCompensation(compensation)
  if (semantic) return applySemanticCompensation(snapshot, semantic, now)
  return applyDomainCompensation(snapshot, compensation as unknown as DomainCompensation, now)
}

function lifecycle(now: string, baseRevision: number, currentRevision: number) {
  return {
    receivedAt: now,
    validatedAt: now,
    baseRevision,
    authoritativeRevisionBeforeCommit: currentRevision,
    rebased: baseRevision !== currentRevision,
  }
}

export function createAuthoritativeCommandExecutor(options: TransactionalWorkspaceStoreOptions) {
  const store = createTransactionalWorkspaceStore(options)

  async function lookup(principal: MutationPrincipal, targetCommandId: string) {
    const current = await store.readForUser(principal.userId)
    if (!current) throw new WorkspaceSourceError('WORKSPACE_NOT_FOUND', 'PJSDAS connected workspace has not been migrated yet.', false)
    const record = await store.readCommandForUser(principal.userId, targetCommandId)
    return {
      found: Boolean(record),
      revision: current.revision,
      snapshot: current.snapshot,
      receipt: record?.receipt,
      commandId: record?.commandId,
      operation: record?.operation,
      resultingRevision: record?.resultingRevision,
    }
  }

  async function execute(principal: MutationPrincipal, raw: unknown): Promise<AuthoritativeCommandExecution> {
    const parsed = authoritativeBusinessCommandSchema.parse(raw) as AuthoritativeBusinessCommand
    if (parsed.command.type === 'domain' && parsed.command.value.commandId !== parsed.commandId) {
      throw new WorkspaceSourceError('INVALID_ARGUMENT', 'Outer commandId and domain commandId must match.', false)
    }
    if (principal.kind === 'first_party_web' && parsed.command.type === 'semantic_intake' && parsed.command.value.source.kind !== 'web') {
      throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'First-party Web Semantic Intake may write only web-origin observations.', false)
    }
    if (['discovery_status','discovery_profile'].includes(parsed.command.type) && principal.kind !== 'first_party_web') {
      throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Discovery Inbox status commands are restricted to the first-party Web client.', false)
    }

    const operation = operationFor(parsed.command)
    const payloadHash = await hashMutationPayload(operation, parsed.command)
    const startedAt = new Date().toISOString()

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await store.readForUser(principal.userId)
      if (!current) throw new WorkspaceSourceError('WORKSPACE_NOT_FOUND', 'PJSDAS connected workspace has not been migrated yet.', false)

      const existing = await store.readCommandForUser(principal.userId, parsed.commandId)
      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          throw new WorkspaceSourceError('COMMAND_ID_REUSED', 'PJSDAS command id was reused with a different payload.', false)
        }
        return {
          outcome: 'ALREADY_APPLIED',
          revision: current.revision,
          snapshot: current.snapshot,
          receipt: existing.receipt,
          result: typeof existing.receipt.result === 'object' && existing.receipt.result !== null
            ? existing.receipt.result as Record<string, unknown>
            : undefined,
        }
      }

      if (parsed.baseRevision > current.revision) {
        throw new WorkspaceSourceError('INVALID_ARGUMENT', 'Command base revision is newer than the authoritative workspace.', false)
      }

      const intent = intentObjects(parsed.command, current.snapshot)
      if (parsed.baseRevision < current.revision) {
        const intervening = await store.readCommandsAfterRevision(principal.userId, parsed.baseRevision)
        const conflict = conflictFromIntervening(intent, current.snapshot, intervening)
        if (conflict) {
          return { outcome: 'CONFLICT', revision: current.revision, snapshot: current.snapshot, conflict }
        }
      }

      const now = new Date()
      let evaluated: any
      if (parsed.command.type === 'domain') {
        evaluated = applyUserDomainCommand(current.snapshot, parsed.command.value as UserDomainCommand, now)
      } else if (parsed.command.type === 'discovery_status') {
        evaluated = applyDiscoveryStatusCommand(current.snapshot, parsed.command.value, now)
      } else if (parsed.command.type === 'discovery_profile') {
        evaluated = applyDiscoveryProfileCommand(current.snapshot, parsed.command.value, now)
      } else if (parsed.command.type === 'semantic_intake') {
        evaluated = applySemanticIntake(current.snapshot, parsed.command.value as SemanticIntakeObservation, {
          authorized: true,
          workspaceRevision: `txn:${current.revision}`,
          now,
        })
      } else {
        evaluated = resolveSemanticDecision(
          current.snapshot,
          parsed.command.value.requestId,
          parsed.command.value.choiceId,
          now,
        )
      }

      if (evaluated.status === 'NEEDS_CONFIRMATION') {
        return {
          outcome: 'CONFLICT',
          revision: current.revision,
          snapshot: current.snapshot,
          conflict: {
            kind: 'BUSINESS_CONFIRMATION_REQUIRED',
            message: evaluated.summary,
            objects: intent,
            reason: evaluated.reason,
          },
          result: resultPayload(parsed.command, evaluated),
        }
      }

      if (!evaluated.changed && parsed.command.type !== 'domain') {
        return {
          outcome: evaluated.status === 'ALREADY_APPLIED' || evaluated.status === 'ALREADY_RESOLVED'
            ? 'ALREADY_APPLIED'
            : 'NO_WRITE',
          revision: current.revision,
          snapshot: current.snapshot,
          result: resultPayload(parsed.command, evaluated),
          receipt: evaluated.receipt,
        }
      }
      if (parsed.command.type === 'domain' && evaluated.status === 'ALREADY_APPLIED') {
        return {
          outcome: 'ALREADY_APPLIED',
          revision: current.revision,
          snapshot: current.snapshot,
          result: resultPayload(parsed.command, evaluated),
        }
      }

      const affectedObjects = diffCommandObjects(current.snapshot, evaluated.snapshot)
      const result = resultPayload(parsed.command, evaluated)
      const receiptContext = {
        contractVersion: 2,
        commandType: parsed.command.type,
        affectedObjects,
        undoDependencyObjects: affectedObjects,
        readModelInvalidation: readModelInvalidation(affectedObjects),
        lifecycle: lifecycle(startedAt, parsed.baseRevision, current.revision),
        result,
      }
      const compensation = evaluated.compensation as Record<string, unknown> | undefined
      const committed = await store.commitAuthoritativeForUser({
        userId: principal.userId,
        commandId: parsed.commandId,
        operation,
        payloadHash,
        expectedRevision: current.revision,
        snapshot: evaluated.snapshot,
        schemaVersion: current.schemaVersion,
        principalKind: principal.kind,
        clientId: principal.clientId,
        provenance: {
          channel: 'authoritative-command-v2',
          ...(principal.sourceId ? { sourceId: principal.sourceId } : {}),
          baseRevision: parsed.baseRevision,
        },
        compensation,
        effectiveTime: parsed.command.type === 'semantic_intake'
          ? parsed.command.value.source.assertedAt ?? parsed.command.value.source.observedAt
          : undefined,
        receiptContext,
      })
      if (committed.outcome === 'CONFLICT') continue
      return {
        outcome: committed.outcome,
        revision: committed.revision,
        snapshot: committed.snapshot,
        receipt: committed.receipt,
        result,
      }
    }

    throw new WorkspaceSourceError('WORKSPACE_CONFLICT', 'The authoritative workspace kept changing while the command was committing. Retry with the same command identity.', true)
  }

  async function undo(principal: MutationPrincipal, raw: unknown): Promise<AuthoritativeCommandExecution> {
    const parsed = authoritativeUndoSchema.parse(raw)
    const operation = 'undo_command'
    const payload = { targetCommandId: parsed.targetCommandId }
    const payloadHash = await hashMutationPayload(operation, payload)
    const startedAt = new Date().toISOString()

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await store.readForUser(principal.userId)
      if (!current) throw new WorkspaceSourceError('WORKSPACE_NOT_FOUND', 'PJSDAS connected workspace has not been migrated yet.', false)

      const existingUndo = await store.readCommandForUser(principal.userId, parsed.commandId)
      if (existingUndo) {
        if (existingUndo.payloadHash !== payloadHash) {
          throw new WorkspaceSourceError('COMMAND_ID_REUSED', 'PJSDAS undo command id was reused with a different target.', false)
        }
        return {
          outcome: 'ALREADY_APPLIED',
          revision: current.revision,
          snapshot: current.snapshot,
          receipt: existingUndo.receipt,
        }
      }

      const target = await store.readCommandForUser(principal.userId, parsed.targetCommandId)
      if (!target) {
        return {
          outcome: 'CONFLICT',
          revision: current.revision,
          snapshot: current.snapshot,
          conflict: {
            kind: 'BUSINESS_CONFIRMATION_REQUIRED',
            message: 'The command to undo was not found in the authoritative ledger.',
            objects: [],
            reason: 'COMMAND_NOT_FOUND',
          },
        }
      }
      if (!target.compensation) {
        return {
          outcome: 'CONFLICT',
          revision: current.revision,
          snapshot: current.snapshot,
          conflict: {
            kind: 'BUSINESS_CONFIRMATION_REQUIRED',
            message: 'The target command has no safe compensating operation.',
            objects: receiptObjects(target, current.snapshot) ?? [],
            reason: 'NO_COMPENSATION',
          },
        }
      }

      const dependencies = receiptObjects(target, current.snapshot)
      const later = await store.readCommandsAfterRevision(principal.userId, target.resultingRevision)
      if (!dependencies && later.length) {
        return {
          outcome: 'CONFLICT',
          revision: current.revision,
          snapshot: current.snapshot,
          conflict: {
            kind: 'OPAQUE_INTERVENING_WRITE',
            message: 'This older command predates object-level dependency receipts and later changes exist, so automatic Undo fails closed.',
            objects: [],
            interveningCommandIds: later.map((item) => item.commandId),
          },
        }
      }
      const blocking = new Map<string, CommandObjectRef>()
      const blockingCommands: string[] = []
      for (const record of later) {
        const affected = receiptObjects(record, current.snapshot)
        if (!affected) {
          return {
            outcome: 'CONFLICT',
            revision: current.revision,
            snapshot: current.snapshot,
            conflict: {
              kind: 'OPAQUE_INTERVENING_WRITE',
              message: 'A later compatibility write lacks object dependency metadata, so automatic Undo cannot prove that compensation is safe.',
              objects: dependencies ?? [],
              interveningCommandIds: [record.commandId],
            },
          }
        }
        const shared = overlappingCommandObjects(dependencies ?? [], affected)
        if (shared.length) {
          blockingCommands.push(record.commandId)
          for (const ref of shared) blocking.set(`${ref.type}:${ref.id}`, ref)
        }
      }
      if (blocking.size) {
        return {
          outcome: 'CONFLICT',
          revision: current.revision,
          snapshot: current.snapshot,
          conflict: {
            kind: 'OBJECT_CONFLICT',
            message: 'A later update depends on the same business object, so automatic Undo was refused rather than erasing newer facts.',
            objects: [...blocking.values()],
            interveningCommandIds: blockingCommands,
          },
        }
      }

      const now = new Date()
      const next = applyCompensation(current.snapshot, target.compensation, now)
      const affectedObjects = diffCommandObjects(current.snapshot, next)
      const committed = await store.commitAuthoritativeForUser({
        userId: principal.userId,
        commandId: parsed.commandId,
        operation,
        payloadHash,
        expectedRevision: current.revision,
        snapshot: next,
        schemaVersion: current.schemaVersion,
        principalKind: principal.kind,
        clientId: principal.clientId,
        provenance: { channel: 'authoritative-command-v2', undoOf: parsed.targetCommandId },
        receiptContext: {
          contractVersion: 2,
          commandType: 'undo',
          undoOf: parsed.targetCommandId,
          affectedObjects,
          undoDependencyObjects: affectedObjects,
          readModelInvalidation: readModelInvalidation(affectedObjects),
          lifecycle: lifecycle(startedAt, current.revision, current.revision),
          result: { type: 'undo', targetCommandId: parsed.targetCommandId, status: 'APPLIED' },
        },
      })
      if (committed.outcome === 'CONFLICT') continue
      return {
        outcome: committed.outcome,
        revision: committed.revision,
        snapshot: committed.snapshot,
        receipt: committed.receipt,
        result: { type: 'undo', targetCommandId: parsed.targetCommandId, status: 'APPLIED' },
      }
    }

    throw new WorkspaceSourceError('WORKSPACE_CONFLICT', 'The authoritative workspace kept changing while Undo was committing. Retry with the same undo command identity.', true)
  }

  return { execute, lookup, undo }
}
