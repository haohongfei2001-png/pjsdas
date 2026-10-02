import { applyPlanningManagement, planningManagementSchema, planningManagementObjectRefs, planningManagementFingerprint, restorePlanningManagement, type PlanningManagementCompensation } from '../src/planningManagement.js'
import { assertPlanningManagementGrant, type PlanningManagementGrant } from './planningManagementAccess.js'
import { applyOpportunityManagement, opportunityManagementSchema, opportunityManagementObjectRefs, opportunityManagementFingerprint, restoreOpportunityManagement, type OpportunityManagementCompensation } from '../src/opportunityManagement.js'
import { assertOpportunityManagementGrant, type OpportunityManagementGrant } from './opportunityManagementAccess.js'
import { applyBusinessManagement, businessManagementSchema, businessManagementObjectRefs, restoreBusinessManagement, type BusinessManagementCompensation } from '../src/businessManagement.js'
import { assertBusinessManagementGrant, type BusinessManagementGrant } from './businessManagementAccess.js'
import { diffWorkspaceDelta } from '../src/workspaceDelta.js'
import { INSTANT_COMMAND_KINDS } from '../src/instantCommandKinds.js'
import { restoreActionStatusUndo, type ActionStatusUndo } from '../src/actionStatusUndo.js'
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
import { upgradeSnapshotToLatest, validateSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'
import { decisionRulesForSnapshot, validateDecisionRules, type DecisionRules } from '../src/decisionRules.js'
import type { SemanticIntakeObservation } from '../src/model.js'
import { applyDiscoveryStatusCommand } from '../src/discoveryStatusCommand.js'
import { applyDiscoveryProfileCommand } from '../src/discoveryProfileCommand.js'
import { applyDiscoveryPromotionCommand } from '../src/discoveryPromotionCommand.js'
import { applyMcpInboxSaveCommand } from '../src/mcpInboxCommand.js'
import { applyMcpDiscoveryCommand } from '../src/mcpDiscoveryApplyCommand.js'
import { applyMcpActionStatusCommand } from '../src/mcpActionStatusCommand.js'
import { applyMcpRulesCommand } from '../src/mcpRulesCommand.js'
import { applyMcpSourceRefreshCommand } from '../src/mcpSourceRefreshCommand.js'
import { applyMcpDiscardCommand } from '../src/mcpDiscardCommand.js'
import { applyMcpProgressCommand } from '../src/mcpProgressCommand.js'
import { applyMcpMixedCommand } from '../src/mcpMixedCommand.js'
import { applyProcessEventDeleteCommand } from '../src/processEventDeleteCommand.js'
import { discoveryInboxIdentity, discoveryInboxItemsFromChangeSet } from '../src/discoveryInbox.js'
import type { McpProposalEnvelope } from '../src/ai/mcpProposal.js'
import { fingerprintWorkspace } from '../src/cloud/workspaceFingerprint.js'
import { verifySignedProposalToken } from './proposalToken.js'
import { findSimilarOpportunity } from '../src/discoveryQuality.js'
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
  commandConflictScopes,
  diffCommandFields,
  diffCommandObjects,
  domainIntentObjects,
  intentFieldScopes,
  overlappingCommandObjects,
  readModelInvalidation,
  receiptConflictScopes,
  receiptAffectedObjects,
  type CommandFieldRef,
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
    z.object({ type: z.literal('business_management'), value: businessManagementSchema }).strict(),
    z.object({ type: z.literal('opportunity_management'), value: opportunityManagementSchema }).strict(),
    z.object({ type: z.literal('planning_management'), value: planningManagementSchema }).strict(),
    z.object({ type: z.literal('semantic_intake'), value: semanticIntakeSchema }).strict(),
    z.object({ type: z.literal('resolve_semantic_decision'), value: resolveSemanticDecisionSchema }).strict(),
    z.object({ type: z.literal('discovery_profile'), value: discoveryProfileSchema }).strict(),
    z.object({ type: z.literal('discovery_promotion'), value: z.object({ inboxItemId: z.string().trim().min(1).max(240) }).strict() }).strict(),
    z.object({ type: z.literal('process_event_delete'), value: z.object({ eventId: z.string().trim().min(1).max(240) }).strict() }).strict(),
    z.object({ type: z.literal('mcp_save_inbox'), value: z.object({ token: z.string().min(1).max(32_000) }).strict() }).strict(),
    z.object({ type: z.literal('mcp_apply_actions'), value: z.object({ token: z.string().min(1).max(32_000) }).strict() }).strict(),
    z.object({ type: z.literal('mcp_apply_rules'), value: z.object({ token: z.string().min(1).max(32_000) }).strict() }).strict(),
    z.object({ type: z.literal('mcp_apply_source_refresh'), value: z.object({ token: z.string().min(1).max(32_000) }).strict() }).strict(),
    z.object({ type: z.literal('mcp_apply_progress'), value: z.object({ token: z.string().min(1).max(32_000) }).strict() }).strict(),
    z.object({ type: z.literal('mcp_apply_mixed'), value: z.object({ token: z.string().min(1).max(32_000) }).strict() }).strict(),
    z.object({ type: z.literal('mcp_discard'), value: z.object({
      token: z.string().min(1).max(32_000),
      rejectionSelections: z.record(z.string().min(1).max(240), z.object({
        code: z.enum(['location','compensation','role_direction','company_value','requirements','already_have_better','not_interested','other']),
        note: z.string().max(1000).optional(),
      }).strict()),
    }).strict() }).strict(),
    z.object({ type: z.literal('mcp_apply_discovery'), value: z.object({
      token: z.string().min(1).max(32_000),
      selectedOperationIds: z.array(z.string().min(1).max(240)).min(1).max(24),
      rejectionSelections: z.record(z.string().min(1).max(240), z.object({
        code: z.enum(['location','compensation','role_direction','company_value','requirements','already_have_better','not_interested','other']),
        note: z.string().max(1000).optional(),
      }).strict()),
    }).strict() }).strict(),
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
  expectedCompensationFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
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
  if (command.type === 'planning_management') return { type: command.type, status: evaluated.status, summary: evaluated.summary, objects: evaluated.objects, compensationFingerprint: evaluated.compensationFingerprint }
  if (command.type === 'opportunity_management') return { type: command.type, status: evaluated.status, summary: evaluated.summary, objects: evaluated.objects, compensationFingerprint: evaluated.compensationFingerprint, archivedOpportunityIds: evaluated.archivedOpportunityIds }
  if (command.type === 'business_management') return { type: command.type, status: evaluated.status, summary: evaluated.summary, objects: evaluated.objects }
  if (command.type === 'domain' || command.type === 'discovery_status' || command.type === 'discovery_profile' || command.type === 'discovery_promotion' || command.type === 'process_event_delete' || command.type === 'mcp_save_inbox' || command.type === 'mcp_apply_discovery' || command.type === 'mcp_apply_actions' || command.type === 'mcp_apply_rules' || command.type === 'mcp_apply_source_refresh' || command.type === 'mcp_apply_progress' || command.type === 'mcp_apply_mixed' || command.type === 'mcp_discard') {
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

function typedFactAlreadyCurrent(command: AuthoritativeBusinessCommand['command'], snapshot: PJSDASSnapshot) {
  if (command.type !== 'domain') return false
  const value = command.value
  if (value.kind !== 'correct_opportunity_fact' && value.kind !== 'set_opportunity_preference') return false
  const target = snapshot.data.opportunities.find(item => item.id === value.opportunityId)
  if (!target) return false
  return value.kind === 'correct_opportunity_fact'
    ? target.detail?.userFacts?.[value.field] === value.value.trim()
    : target.roleType === value.roleType
}

function intentObjects(command: AuthoritativeBusinessCommand['command'], snapshot: PJSDASSnapshot, proposal?: McpProposalEnvelope, commandId = '') {
  if (command.type === 'planning_management') return planningManagementObjectRefs(command.value)
  if (command.type === 'opportunity_management') return opportunityManagementObjectRefs(snapshot, command.value)
  if (command.type === 'business_management') return businessManagementObjectRefs(command.value, commandId)
  if (command.type === 'domain') return domainIntentObjects(command.value as UserDomainCommand, snapshot)
  if (command.type === 'mcp_save_inbox') {
    if (!proposal) throw new Error('Verified MCP proposal is required.')
    const incoming = discoveryInboxItemsFromChangeSet(proposal.changeSet)
    return [
      { type: 'change_set', id: proposal.changeSet.id },
      ...incoming.map((item) => {
        const previous = (snapshot.data.discoveryInbox ?? []).find((saved) =>
          discoveryInboxIdentity(saved.company, saved.role) === discoveryInboxIdentity(item.company, item.role))
        return { type: 'discovery_inbox', id: previous?.id ?? item.id }
      }),
    ]
  }
  if (command.type === 'mcp_apply_discovery') {
    if (!proposal) throw new Error('Verified MCP proposal is required.')
    return [
      { type: 'change_set', id: proposal.changeSet.id },
      ...proposal.changeSet.operations.filter((item) => command.value.selectedOperationIds.includes(item.id) && item.kind === 'add_discovered_opportunity')
        .flatMap((item) => item.kind === 'add_discovered_opportunity' ? [
          { type: 'opportunity', id: item.opportunity.id }, { type: 'action', id: `apply:${item.opportunity.id}` },
        ] : []),
    ]
  }
  if (command.type === 'mcp_apply_actions') {
    if (!proposal) throw new Error('Verified MCP proposal is required.')
    return [
      { type: 'change_set', id: proposal.changeSet.id },
      ...proposal.changeSet.operations.filter((item) => item.kind === 'set_action_status')
        .map((item) => ({ type: 'action', id: item.actionId })),
    ]
  }
  if (command.type === 'mcp_apply_rules') {
    if (!proposal) throw new Error('Verified MCP proposal is required.')
    return [{ type: 'change_set', id: proposal.changeSet.id }, { type: 'decision_rules', id: 'current' }]
  }
  if (command.type === 'mcp_apply_source_refresh') {
    if (!proposal) throw new Error('Verified MCP proposal is required.')
    return [
      { type: 'change_set', id: proposal.changeSet.id },
      ...proposal.changeSet.operations.filter((item) => item.kind === 'refresh_job_posting')
        .map((item) => ({ type: item.ownerKind === 'opportunity' ? 'opportunity' : 'discovery_inbox', id: item.ownerId })),
    ]
  }
  if (command.type === 'mcp_apply_progress' || command.type === 'mcp_apply_mixed') {
    if (!proposal) throw new Error('Verified MCP proposal is required.')
    return [
      { type: 'change_set', id: proposal.changeSet.id },
      ...proposal.changeSet.operations.filter((item) => item.kind === 'progress_update').flatMap((item) => {
        if (item.kind !== 'progress_update') return []
        const operation = item.operation
        if (operation.kind === 'manual_action') return [{ type: 'action', id: `progress-action:${operation.id}` }]
        const refs = [{ type: 'opportunity', id: operation.opportunityId }]
        if (operation.kind === 'process_event') refs.push({ type: 'process_event', id: `progress-event:${operation.id}` })
        return refs
      }),
      ...(command.type === 'mcp_apply_mixed' ? proposal.changeSet.operations.flatMap((item) =>
        item.kind === 'set_action_status' ? [{ type: 'action', id: item.actionId }]
          : item.kind === 'replace_decision_rules' ? [{ type: 'decision_rules', id: 'current' }] : []) : []),
    ]
  }
  if (command.type === 'mcp_discard') {
    if (!proposal) throw new Error('Verified MCP proposal is required.')
    return [{ type: 'change_set', id: proposal.changeSet.id }]
  }
  if (command.type === 'discovery_status') return [{ type: 'discovery_inbox', id: command.value.inboxItemId }]
  if (command.type === 'discovery_profile') return [{ type: 'discovery_profile', id: 'current' }]
  if (command.type === 'process_event_delete') {
    const event = snapshot.data.processEvents.find((item) => item.id === command.value.eventId)
    return [
      { type: 'process_event', id: command.value.eventId },
      ...(event ? [{ type: 'opportunity', id: event.opportunityId }, { type: 'action', id: `event-action:${event.id}` }] : []),
      ...(snapshot.data.scheduleNodes ?? []).filter((node) => node.processEventId === command.value.eventId)
        .map((node) => ({ type: 'schedule_occurrence', id: node.occurrenceId })),
    ]
  }
  if (command.type === 'discovery_promotion') {
    const item = (snapshot.data.discoveryInbox ?? []).find((candidate) => candidate.id === command.value.inboxItemId)
    const existing = item && (snapshot.data.opportunities.find((row) => row.id === item.candidateOpportunityId)
      ?? findSimilarOpportunity({ company: item.company, role: item.role }, snapshot.data.opportunities))
    return [
      { type: 'discovery_inbox', id: command.value.inboxItemId },
      ...(item ? [{ type: 'opportunity', id: item.candidateOpportunityId }, { type: 'action', id: `apply:${item.candidateOpportunityId}` }] : []),
      ...(existing && existing.id !== item?.candidateOpportunityId ? [{ type: 'opportunity', id: existing.id }] : []),
    ]
  }
  if (command.type === 'semantic_intake') return semanticIntentObjects(command.value as SemanticIntakeObservation, snapshot)
  return decisionIntentObjects(command.value.requestId, snapshot)
}

function receiptObjects(record: ConnectedCommandRecord, snapshot: PJSDASSnapshot) {
  return receiptAffectedObjects(record.receipt, snapshot)
}

function conflictFromIntervening(
  intent: CommandObjectRef[],
  intentFields: CommandFieldRef[],
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
    const changedFields = receiptConflictScopes(record.receipt)
    const incompatible = shared.filter(ref => {
      const requested = intentFields.filter(field => field.type === ref.type && field.id === ref.id)
      const changed = changedFields?.filter(field => field.type === ref.type && field.id === ref.id)
      if (!requested.length || !changed?.length) return true
      return requested.some(left => changed.some(right => left.field === '*' || right.field === '*'
        || left.field === right.field || left.field.startsWith(`${right.field}.`)
        || right.field.startsWith(`${left.field}.`)))
    })
    if (incompatible.length) {
      conflictingCommands.push(record.commandId)
      for (const ref of incompatible) overlaps.set(`${ref.type}:${ref.id}`, ref)
    }
  }
  if (!overlaps.size) return undefined
  return {
    kind: 'OBJECT_CONFLICT',
    message: 'The same business object changed after this command was prepared. TodayAction kept the newer authoritative state and did not guess which fact should win.',
    objects: [...overlaps.values()],
    interveningCommandIds: conflictingCommands,
  }
}

function semanticCompensation(value: Record<string, unknown>): SemanticBatchCompensation | undefined {
  if (value.operation !== 'semantic_batch' || !value.payload || typeof value.payload !== 'object') return undefined
  return value as unknown as SemanticBatchCompensation
}

function applyCompensation(snapshot: PJSDASSnapshot, compensation: Record<string, unknown>, now: Date) {
  if (compensation.operation === 'planning_management_restore') return restorePlanningManagement(snapshot, compensation as unknown as PlanningManagementCompensation, now)
  if (compensation.operation === 'opportunity_management_restore') return restoreOpportunityManagement(snapshot, compensation as unknown as OpportunityManagementCompensation, now)
  if (compensation.operation === 'business_management_restore') return restoreBusinessManagement(snapshot, compensation as unknown as BusinessManagementCompensation, now)
  if (compensation.operation === 'mcp_restore_decision_rules') {
    const before = (compensation.payload as { before?: DecisionRules } | undefined)?.before
    if (!before || validateDecisionRules(before).length) throw new Error('MCP Rules compensation is invalid.')
    const next = upgradeSnapshotToLatest(snapshot)
    next.data.decisionRules = { ...decisionRulesForSnapshot(before), updatedAt: now.toISOString() }
    next.exportedAt = now.toISOString()
    validateSnapshot(next)
    return next
  }
  if (compensation.operation === 'mcp_action_status_batch') {
    const undo = (compensation.payload as { undo?: ActionStatusUndo } | undefined)?.undo
    if (undo) {
      const next = upgradeSnapshotToLatest(snapshot)
      restoreActionStatusUndo(next.data, undo)
      next.exportedAt = now.toISOString()
      validateSnapshot(next)
      return next
    }
    const previous = (compensation.payload as { previous?: Array<{ actionId: string; status: string }> } | undefined)?.previous
    if (!Array.isArray(previous) || !previous.length) throw new Error('MCP Action compensation is invalid.')
    return [...previous].reverse().reduce((current, item) => applyDomainCompensation(current, {
      operation: 'set_action_status', payload: item,
    } as DomainCompensation, now), snapshot)
  }
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

export interface AuthoritativeCommandExecutorOptions extends TransactionalWorkspaceStoreOptions {
  // Server-owned grant resolver; omission deliberately disables the new capability.
  resolveBusinessManagementGrant?: (principal: MutationPrincipal) => Promise<BusinessManagementGrant | undefined>
  resolveOpportunityManagementGrant?: (principal: MutationPrincipal) => Promise<OpportunityManagementGrant | undefined>
  resolvePlanningManagementGrant?: (principal: MutationPrincipal) => Promise<PlanningManagementGrant | undefined>
}

export function createAuthoritativeCommandExecutor(options: AuthoritativeCommandExecutorOptions) {
  const store = createTransactionalWorkspaceStore(options)
  async function authorizeManagement(principal: MutationPrincipal, admitted?: Pick<BusinessManagementGrant, 'id' | 'revision'>, operation = 'business_management') {
    let grant: BusinessManagementGrant | OpportunityManagementGrant | PlanningManagementGrant
    if (operation === 'planning_management') {
      const resolved = await options.resolvePlanningManagementGrant?.(principal)
      assertPlanningManagementGrant(principal, resolved)
      grant = resolved
    } else if (operation === 'opportunity_management') {
      const resolved = await options.resolveOpportunityManagementGrant?.(principal)
      assertOpportunityManagementGrant(principal, resolved)
      grant = resolved
    } else {
      const resolved = await options.resolveBusinessManagementGrant?.(principal)
      assertBusinessManagementGrant(principal, resolved)
      grant = resolved
    }
    if (admitted && (grant.id !== admitted.id || grant.revision !== admitted.revision)) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Management grant changed during this request. A new explicit request is required.', false)
    // Copy proof so a resolver that reuses objects cannot mutate admission state.
    return Object.freeze({ ...grant })
  }

  async function lookup(principal: MutationPrincipal, targetCommandId: string, compact = false) {
    if (compact) {
      const record = await store.readCommandForUser(principal.userId, targetCommandId)
      return { found: Boolean(record), revision: record?.resultingRevision ?? 0,
        receipt: record?.receipt, commandId: record?.commandId, operation: record?.operation,
        resultingRevision: record?.resultingRevision, snapshot: undefined }
    }
    const current = await store.readForUser(principal.userId)
    if (!current) throw new WorkspaceSourceError('WORKSPACE_NOT_FOUND', 'TodayAction connected workspace has not been migrated yet.', false)
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
    const isManagement = parsed.command.type === 'business_management' || parsed.command.type === 'opportunity_management' || parsed.command.type === 'planning_management'
    const admittedManagementGrant = isManagement ? await authorizeManagement(principal, undefined, parsed.command.type) : undefined
    if (parsed.command.type === 'domain' && parsed.command.value.commandId !== parsed.commandId) {
      throw new WorkspaceSourceError('INVALID_ARGUMENT', 'Outer commandId and domain commandId must match.', false)
    }
    if (principal.kind === 'first_party_web' && parsed.command.type === 'semantic_intake' && parsed.command.value.source.kind !== 'web') {
      throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'First-party Web Semantic Intake may write only web-origin observations.', false)
    }
    if (['discovery_status','discovery_profile','discovery_promotion','process_event_delete','mcp_save_inbox','mcp_apply_discovery','mcp_apply_actions','mcp_apply_rules','mcp_apply_source_refresh','mcp_apply_progress','mcp_apply_mixed','mcp_discard'].includes(parsed.command.type) && principal.kind !== 'first_party_web') {
      throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Discovery review commands are restricted to the first-party Web client.', false)
    }

    let proposal: McpProposalEnvelope | undefined
    if (parsed.command.type === 'mcp_save_inbox' || parsed.command.type === 'mcp_apply_discovery' || parsed.command.type === 'mcp_apply_actions' || parsed.command.type === 'mcp_apply_rules' || parsed.command.type === 'mcp_apply_source_refresh' || parsed.command.type === 'mcp_apply_progress' || parsed.command.type === 'mcp_apply_mixed' || parsed.command.type === 'mcp_discard') {
      const signingKey = process.env.PJSDAS_TOKEN_ENCRYPTION_KEY?.trim() ?? ''
      if (!signingKey) throw new WorkspaceSourceError('PROPOSAL_VERIFY_UNAVAILABLE', 'Signed proposal verification is unavailable.', false)
      proposal = await verifySignedProposalToken(parsed.command.value.token, signingKey)
      if (!proposal.workspaceOwnerUserId || proposal.workspaceOwnerUserId !== principal.userId || !/^txn:\d+$/.test(proposal.workspaceVersion ?? '')) {
        throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'The signed proposal belongs to another account or workspace authority.', false)
      }
    }

    const operation = operationFor(parsed.command)
    const payloadHash = await hashMutationPayload(operation, parsed.command)
    const startedAt = new Date().toISOString()

    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (attempt > 0 && isManagement) await authorizeManagement(principal, admittedManagementGrant, parsed.command.type)
      const current = await store.readForUser(principal.userId, { preserveRawData: parsed.command.type === 'planning_management' })
      if (!current) throw new WorkspaceSourceError('WORKSPACE_NOT_FOUND', 'TodayAction connected workspace has not been migrated yet.', false)

      const existing = await store.readCommandForUser(principal.userId, parsed.commandId)
      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          throw new WorkspaceSourceError('COMMAND_ID_REUSED', 'TodayAction command id was reused with a different payload.', false)
        }
        if (isManagement) await authorizeManagement(principal, admittedManagementGrant, parsed.command.type)
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

      if (proposal) {
        if (proposal.workspaceVersion !== `txn:${current.revision}` || proposal.changeSet.expectedWorkspaceVersion !== proposal.workspaceVersion ||
          proposal.changeSet.expectedWorkspaceFingerprint !== await fingerprintWorkspace(current.snapshot)) {
          throw new WorkspaceSourceError('WORKSPACE_CONFLICT', 'The signed proposal is stale. Refresh and request a new proposal.', false)
        }
      }
      if (typedFactAlreadyCurrent(parsed.command, current.snapshot)) {
        return { outcome: 'ALREADY_APPLIED', revision: current.revision, snapshot: current.snapshot,
          result: { type: parsed.command.type, status: 'ALREADY_APPLIED', summary: 'The requested fact is already current.' } }
      }
      const intent = intentObjects(parsed.command, current.snapshot, proposal, parsed.commandId)
      const intentFields = parsed.command.type === 'domain'
        ? intentFieldScopes(parsed.command.value as UserDomainCommand, intent)
        : intent.map(ref => ({ ...ref, field: '*' }))
      if (parsed.baseRevision < current.revision) {
        const intervening = await store.readCommandsAfterRevision(principal.userId, parsed.baseRevision)
        const conflict = conflictFromIntervening(intent, intentFields, current.snapshot, intervening)
        if (conflict) {
          if (isManagement) await authorizeManagement(principal, admittedManagementGrant, parsed.command.type)
          return { outcome: 'CONFLICT', revision: current.revision, snapshot: current.snapshot, conflict }
        }
      }

      const now = new Date()
      let evaluated: any
      if (parsed.command.type === 'planning_management') {
        evaluated = await applyPlanningManagement(current.snapshot, parsed.command.value, parsed.commandId, now)
        if (evaluated.compensation && !evaluated.compensationFingerprint) evaluated.compensationFingerprint = await planningManagementFingerprint(evaluated.compensation)
      } else if (parsed.command.type === 'opportunity_management') {
        evaluated = await applyOpportunityManagement(current.snapshot, parsed.command.value, parsed.commandId, now)
      } else if (parsed.command.type === 'business_management') {
        evaluated = applyBusinessManagement(current.snapshot, parsed.command.value, parsed.commandId, now)
      } else if (parsed.command.type === 'domain') {
        evaluated = applyUserDomainCommand(current.snapshot, parsed.command.value as UserDomainCommand, now)
      } else if (parsed.command.type === 'discovery_status') {
        evaluated = applyDiscoveryStatusCommand(current.snapshot, parsed.command.value, now)
      } else if (parsed.command.type === 'discovery_profile') {
        evaluated = applyDiscoveryProfileCommand(current.snapshot, parsed.command.value, now)
      } else if (parsed.command.type === 'discovery_promotion') {
        evaluated = applyDiscoveryPromotionCommand(current.snapshot, parsed.command.value, now)
      } else if (parsed.command.type === 'process_event_delete') {
        evaluated = applyProcessEventDeleteCommand(current.snapshot, parsed.command.value.eventId, now)
      } else if (parsed.command.type === 'mcp_save_inbox') {
        evaluated = applyMcpInboxSaveCommand(current.snapshot, proposal!, now)
      } else if (parsed.command.type === 'mcp_apply_discovery') {
        evaluated = applyMcpDiscoveryCommand(current.snapshot, proposal!, parsed.command.value.selectedOperationIds, parsed.command.value.rejectionSelections, now)
      } else if (parsed.command.type === 'mcp_apply_actions') {
        evaluated = applyMcpActionStatusCommand(current.snapshot, proposal!, now)
      } else if (parsed.command.type === 'mcp_apply_rules') {
        evaluated = applyMcpRulesCommand(current.snapshot, proposal!, now)
      } else if (parsed.command.type === 'mcp_apply_source_refresh') {
        evaluated = applyMcpSourceRefreshCommand(current.snapshot, proposal!, now)
      } else if (parsed.command.type === 'mcp_apply_progress') {
        evaluated = applyMcpProgressCommand(current.snapshot, proposal!, now)
      } else if (parsed.command.type === 'mcp_apply_mixed') {
        evaluated = applyMcpMixedCommand(current.snapshot, proposal!, now)
      } else if (parsed.command.type === 'mcp_discard') {
        evaluated = applyMcpDiscardCommand(current.snapshot, proposal!, parsed.command.value.rejectionSelections, now)
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
        if (isManagement) await authorizeManagement(principal, admittedManagementGrant, parsed.command.type)
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

      // Receipts must describe the normalized facts actually submitted to
      // storage, including derived schedule nodes and temporal precision.
      if (parsed.command.type !== 'planning_management') evaluated.snapshot = upgradeSnapshotToLatest(evaluated.snapshot)
      const affectedObjects = diffCommandObjects(current.snapshot, evaluated.snapshot)
      const affectedFields = diffCommandFields(current.snapshot, evaluated.snapshot, affectedObjects)
      const conflictScopes = commandConflictScopes(affectedObjects, intentFields)
      const result = resultPayload(parsed.command, evaluated)
      const receiptContext = {
        contractVersion: 5,
        projectionDelta: diffWorkspaceDelta(current.snapshot, evaluated.snapshot, current.revision),
        schemaVersion: evaluated.snapshot.version,
        commandType: parsed.command.type,
        affectedObjects,
        affectedFields,
        conflictScopes,
        undoDependencyObjects: affectedObjects,
        readModelInvalidation: readModelInvalidation(affectedObjects),
        lifecycle: lifecycle(startedAt, parsed.baseRevision, current.revision),
        result,
        ...(parsed.command.type === 'domain' && INSTANT_COMMAND_KINDS.has(parsed.command.value.kind)
          ? { undoCompensation: evaluated.compensation } : {}),
      }
      const compensation = evaluated.compensation as Record<string, unknown> | undefined
      // Carry the freshly read identity/revision into the transaction-locked RPC.
      const managementGrant = isManagement ? await authorizeManagement(principal, admittedManagementGrant, parsed.command.type) : undefined
      const committed = await store.commitAuthoritativeForUser({
        managementAuthorization: managementGrant ? { grantId: managementGrant.id, grantRevision: managementGrant.revision, ...(managementGrant.consentVersion === 4 ? { consentVersion: 4 as const } : managementGrant.consentVersion === 3 ? { consentVersion: 3 as const } : {}) } : undefined,
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
      if (committed.outcome !== 'COMMITTED' && managementGrant) await authorizeManagement(principal, admittedManagementGrant, managementGrant.consentVersion === 4 ? 'planning_management' : managementGrant.consentVersion === 3 ? 'opportunity_management' : 'business_management')
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
    const payload = { targetCommandId: parsed.targetCommandId, ...(parsed.expectedCompensationFingerprint ? { expectedCompensationFingerprint: parsed.expectedCompensationFingerprint } : {}) }
    let admittedManagementGrant: BusinessManagementGrant | OpportunityManagementGrant | PlanningManagementGrant | undefined
    const payloadHash = await hashMutationPayload(operation, payload)
    const startedAt = new Date().toISOString()

    for (let attempt = 0; attempt < 5; attempt += 1) {
      let current = await store.readForUser(principal.userId)
      if (!current) throw new WorkspaceSourceError('WORKSPACE_NOT_FOUND', 'TodayAction connected workspace has not been migrated yet.', false)

      const target = await store.readCommandForUser(principal.userId, parsed.targetCommandId)
      if (target?.operation === 'planning_management') {
        current = await store.readForUser(principal.userId, { preserveRawData: true })
        if (!current) throw new WorkspaceSourceError('WORKSPACE_NOT_FOUND', 'TodayAction workspace is unavailable.', false)
      }
      if (target?.operation === 'business_management' || target?.operation === 'opportunity_management' || target?.operation === 'planning_management') admittedManagementGrant = await authorizeManagement(principal, admittedManagementGrant, target.operation)
      if (target?.operation === 'planning_management' && (!target.compensation || !parsed.expectedCompensationFingerprint || parsed.expectedCompensationFingerprint !== await planningManagementFingerprint(target.compensation))) throw new WorkspaceSourceError('INVALID_ARGUMENT', 'Planning restore requires the exact owner-ledger compensation fingerprint.', false)
      if (target?.operation === 'opportunity_management' && (!target.compensation || !parsed.expectedCompensationFingerprint || parsed.expectedCompensationFingerprint !== await opportunityManagementFingerprint(target.compensation))) throw new WorkspaceSourceError('INVALID_ARGUMENT', 'Opportunity restore requires the exact owner-ledger compensation fingerprint.', false)
      const existingUndo = await store.readCommandForUser(principal.userId, parsed.commandId)
      if (existingUndo) {
        if (existingUndo.payloadHash !== payloadHash) {
          throw new WorkspaceSourceError('COMMAND_ID_REUSED', 'TodayAction undo command id was reused with a different target.', false)
        }
        if (admittedManagementGrant) await authorizeManagement(principal, admittedManagementGrant, target!.operation)
        return {
          outcome: 'ALREADY_APPLIED',
          revision: current.revision,
          snapshot: current.snapshot,
          receipt: existingUndo.receipt,
        }
      }

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
      if (target.operation === 'process_event_delete' && principal.kind !== 'first_party_web') {
        throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Only the first-party Web client can restore a deleted process event.', false)
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
      const restored = applyCompensation(current.snapshot, target.compensation, now)
      const next = target.operation === 'planning_management' ? restored : upgradeSnapshotToLatest(restored)
      const affectedObjects = diffCommandObjects(current.snapshot, next)
      const managementGrant = target.operation === 'business_management' || target.operation === 'opportunity_management' || target.operation === 'planning_management' ? await authorizeManagement(principal, admittedManagementGrant, target.operation) : undefined
      const committed = await store.commitAuthoritativeForUser({
        managementAuthorization: managementGrant ? { grantId: managementGrant.id, grantRevision: managementGrant.revision, ...(managementGrant.consentVersion === 4 ? { consentVersion: 4 as const } : managementGrant.consentVersion === 3 ? { consentVersion: 3 as const } : {}) } : undefined,
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
          contractVersion: 5,
          projectionDelta: diffWorkspaceDelta(current.snapshot, next, current.revision),
          schemaVersion: next.version,
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
      if (committed.outcome !== 'COMMITTED' && managementGrant) await authorizeManagement(principal, admittedManagementGrant, managementGrant.consentVersion === 4 ? 'planning_management' : managementGrant.consentVersion === 3 ? 'opportunity_management' : 'business_management')
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
