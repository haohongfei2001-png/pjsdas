import type { CallToolResult } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import {
  assertChangeSetValid,
  createActionStatusChangeSet,
  createProgressChangeSet,
  createRulesChangeSet,
  type ChangeSetOperation,
  type ChangeSetRecord,
} from '../src/changeSet.js'
import {
  decisionRulesForSnapshot,
  validateDecisionRules,
  type DecisionRules,
  type DecisionWeights,
} from '../src/decisionRules.js'
import { buildMcpProposalReviewUrl } from '../src/ai/mcpProposal.js'
import { parseProgressUpdate } from '../src/progressUpdate.js'
import type { ActionStatus } from '../src/model.js'
import { WorkspaceSourceError, type WorkspaceSource } from './workspaceSource.js'

const weightPatchSchema = z.object({
  opportunity: z.number().min(0).max(100).optional(),
  fit: z.number().min(0).max(100).optional(),
  urgency: z.number().min(0).max(100).optional(),
  stage: z.number().min(0).max(100).optional(),
  leverage: z.number().min(0).max(100).optional(),
  delayCost: z.number().min(0).max(100).optional(),
  timeEfficiency: z.number().min(0).max(100).optional(),
}).strict()

const rulesPatchSchema = z.object({
  hardDeadlineHorizonHours: z.number().int().min(1).max(336).optional(),
  fixedEventHorizonHours: z.number().int().min(1).max(336).optional(),
  nearDeadlineStretchMinutes: z.number().int().min(0).max(180).optional(),
  followUpDailyCap: z.number().int().min(0).max(10).optional(),
  prepDailyCap: z.number().int().min(0).max(10).optional(),
  upcomingHorizonDays: z.number().int().min(1).max(30).optional(),
  upcomingNodeLimit: z.number().int().min(1).max(50).optional(),
  riskCriticalHours: z.number().int().min(1).max(168).optional(),
  riskHighHours: z.number().int().min(1).max(336).optional(),
  riskNearHours: z.number().int().min(1).max(504).optional(),
  riskWatchHours: z.number().int().min(1).max(720).optional(),
  weights: weightPatchSchema.optional(),
}).strict()

const actionStatusChangeSchema = z.object({
  actionId: z.string().trim().min(1),
  status: z.enum(['todo', 'doing', 'done', 'skipped']),
}).strict()

export const proposeChangesSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  progressText: z.string().trim().min(1).max(4000).optional(),
  actionStatusChanges: z.array(actionStatusChangeSchema).max(20).optional(),
  decisionRulesPatch: rulesPatchSchema.optional(),
}).refine(
  (value) => Boolean(
    value.progressText ||
    value.actionStatusChanges?.length ||
    value.decisionRulesPatch,
  ),
  { message: 'At least one proposed change is required.' },
)

export type ProposeChangesInput = z.infer<typeof proposeChangesSchema>

function proposalId(now: Date) {
  const compact = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, '0')
  return `CS-MCP-${compact}-${suffix}`
}

function failure(code: string, message: string, retryable = false): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ code, message, retryable }, null, 2) }],
  }
}

function success(output: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
    structuredContent: output,
  }
}

function applyRulesPatch(current: DecisionRules, patch: NonNullable<ProposeChangesInput['decisionRulesPatch']>) {
  const weights: DecisionWeights = {
    ...current.weights,
    ...(patch.weights ?? {}),
  }
  const next: DecisionRules = {
    ...current,
    ...patch,
    weights,
  }
  const errors = validateDecisionRules(next)
  if (errors.length) {
    throw new WorkspaceSourceError('INVALID_ARGUMENT', `Decision Rules proposal is invalid: ${errors[0]}`, false)
  }
  return next
}

function uniqueOperations(operations: ChangeSetOperation[]) {
  const byId = new Map<string, ChangeSetOperation>()
  for (const operation of operations) byId.set(operation.id, operation)
  return [...byId.values()]
}

function makeMcpChangeSet(title: string, operations: ChangeSetOperation[], now: Date): ChangeSetRecord {
  const timestamp = now.toISOString()
  const changeSet: ChangeSetRecord = {
    id: proposalId(now),
    version: 1,
    source: 'mcp',
    status: 'pending',
    title,
    createdAt: timestamp,
    updatedAt: timestamp,
    operations,
  }
  assertChangeSetValid(changeSet)
  return changeSet
}

export async function invokeProposeChanges(
  source: WorkspaceSource,
  rawInput: unknown,
): Promise<CallToolResult> {
  try {
    const input = proposeChangesSchema.parse(rawInput)
    const { snapshot, context } = await source.read()
    const now = context.now ? new Date(context.now) : new Date()
    const operations: ChangeSetOperation[] = []

    if (input.progressText) {
      const parsed = parseProgressUpdate(input.progressText, snapshot.data.opportunities, now)
      if (parsed.unresolved.length > 0) {
        const reasons = parsed.unresolved.slice(0, 3).map((item) => item.reason).join('；')
        throw new WorkspaceSourceError(
          'PROPOSAL_NEEDS_CLARIFICATION',
          `PJSDAS could not safely normalize every requested update. Ask the user to clarify before proposing changes. ${reasons}`,
          false,
        )
      }
      if (parsed.executable.length > 0) {
        operations.push(...createProgressChangeSet(parsed.executable, now).operations)
      }
    }

    for (const requested of input.actionStatusChanges ?? []) {
      const action = snapshot.data.actions.find((item) => item.id === requested.actionId)
      if (!action) {
        throw new WorkspaceSourceError(
          'NOT_FOUND',
          `Action ${requested.actionId} does not exist in the current PJSDAS workspace. Read the current plan or pipeline again before proposing this change.`,
          false,
        )
      }
      const proposed = createActionStatusChangeSet(action, requested.status as ActionStatus, now)
      if (proposed) operations.push(...proposed.operations)
    }

    if (input.decisionRulesPatch) {
      const current = decisionRulesForSnapshot(snapshot.data.decisionRules)
      const next = applyRulesPatch(current, input.decisionRulesPatch)
      const proposed = createRulesChangeSet(current, next, 'save', now)
      if (proposed) operations.push(...proposed.operations)
    }

    const normalized = uniqueOperations(operations)
    if (normalized.length === 0) {
      return failure('NO_CHANGES', 'The requested state already matches PJSDAS, so there is nothing to propose.', false)
    }
    if (normalized.length > 24) {
      return failure('PROPOSAL_TOO_LARGE', 'Split this request into smaller PJSDAS proposals of at most 24 normalized operations.', false)
    }

    const title = input.title ?? `ChatGPT 提议 · ${normalized.length} 项`
    const changeSet = makeMcpChangeSet(title, normalized, now)
    const reviewUrl = buildMcpProposalReviewUrl(changeSet, context.workspaceVersion)

    return success({
      status: 'proposal_created',
      applied: false,
      workspaceVersion: context.workspaceVersion,
      changeSetId: changeSet.id,
      title: changeSet.title,
      operationCount: changeSet.operations.length,
      operations: changeSet.operations.map((item) => ({ id: item.id, kind: item.kind, summary: item.summary })),
      reviewUrl,
      instruction: 'No PJSDAS workspace data has changed. Ask the user to open reviewUrl and explicitly Apply or Discard the pending ChangeSet in PJSDAS.',
    })
  } catch (caught) {
    if (caught instanceof WorkspaceSourceError) return failure(caught.code, caught.message, caught.retryable)
    if (caught instanceof z.ZodError) return failure('INVALID_ARGUMENT', caught.issues[0]?.message ?? 'Invalid proposal arguments.', false)
    return failure(
      'PROPOSAL_FAILED',
      caught instanceof Error ? caught.message : 'PJSDAS could not create a review proposal.',
      false,
    )
  }
}
