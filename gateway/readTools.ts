import type { CallToolResult } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { getOpportunityAssessment } from '../src/ai/assessmentRead.js'
import {
  BridgeReadError,
  explainPriority,
  getDecisionRules,
  getDiscoveryContext,
  getPipeline,
  getRecentTimeline,
  getTodayPlan,
  listOpportunities,
} from '../src/ai/readLayer.js'
import { enrichOpportunityListWithFacts } from '../src/ai/richOpportunityRead.js'
import { decisionRulesForSnapshot } from '../src/decisionRules.js'
import { WorkspaceSourceError, type WorkspaceSource } from './workspaceSource.js'

export const READ_TOOL_NAMES = [
  'get_today_plan',
  'list_opportunities',
  'get_opportunity_assessment',
  'get_pipeline',
  'get_decision_rules',
  'get_discovery_context',
  'explain_priority',
  'get_recent_timeline',
] as const

export type ReadToolName = typeof READ_TOOL_NAMES[number]

export const processStageSchema = z.enum([
  'not_applied',
  'screening',
  'assessment',
  'written_test',
  'interview',
  'offer',
  'waiting_release',
  'closed',
])

export const opportunityRoleSchema = z.enum(['core', 'backup', 'reach', 'lottery', 'practice'])
export const timelineCategorySchema = z.enum(['opportunity', 'process', 'action', 'rules', 'change', 'data', 'note'])

export const getTodayPlanSchema = z.object({
  date: z.string().optional(),
  availableMinutes: z.number().optional(),
})

export const listOpportunitiesSchema = z.object({
  query: z.string().optional(),
  stage: processStageSchema.optional(),
  company: z.string().optional(),
  roleType: opportunityRoleSchema.optional(),
  deadlineBefore: z.string().optional(),
  limit: z.number().int().optional(),
  includeFacts: z.boolean().optional(),
}).superRefine((value, context) => {
  if (value.includeFacts && value.limit !== undefined && value.limit > 20) {
    context.addIssue({ code: 'custom', message: 'limit must be at most 20 when includeFacts is true.' })
  }
})

export const getOpportunityAssessmentSchema = z.object({
  opportunityId: z.string().trim().min(1),
})

export const getPipelineSchema = z.object({
  stage: processStageSchema.optional(),
  attentionOnly: z.boolean().optional(),
  company: z.string().optional(),
  limit: z.number().int().optional(),
})

export const getDecisionRulesSchema = z.object({})
export const getDiscoveryContextSchema = z.object({})

export const explainPrioritySchema = z.object({
  actionId: z.string().optional(),
  opportunityId: z.string().optional(),
  compareWithOpportunityId: z.string().optional(),
})

export const getRecentTimelineSchema = z.object({
  since: z.string().optional(),
  until: z.string().optional(),
  categories: z.array(timelineCategorySchema).optional(),
  company: z.string().optional(),
  opportunityId: z.string().optional(),
  limit: z.number().int().optional(),
})

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
  if (caught instanceof BridgeReadError || caught instanceof WorkspaceSourceError) {
    return toolError(caught.code, caught.message, caught.retryable)
  }
  if (caught instanceof z.ZodError) {
    return toolError('INVALID_ARGUMENT', caught.issues[0]?.message ?? 'Invalid MCP tool arguments.', false)
  }
  return toolError(
    'TEMPORARILY_UNAVAILABLE',
    caught instanceof Error ? caught.message : 'PJSDAS MCP gateway failed to read the workspace.',
    true,
  )
}

function readMeta(context: { now?: Date; timezone?: string; workspaceVersion?: string }) {
  const now = context.now ?? new Date()
  return {
    workspaceVersion: context.workspaceVersion,
    generatedAt: now.toISOString(),
    timezone: context.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
    source: 'pjsdas' as const,
  }
}

export async function invokeReadTool(
  source: WorkspaceSource,
  name: ReadToolName,
  args: unknown = {},
): Promise<CallToolResult> {
  try {
    const { snapshot, context } = await source.read()

    switch (name) {
      case 'get_today_plan':
        return success(getTodayPlan(snapshot, getTodayPlanSchema.parse(args), context))
      case 'list_opportunities': {
        const parsed = listOpportunitiesSchema.parse(args)
        const readInput = {
          query: parsed.query,
          stage: parsed.stage,
          company: parsed.company,
          roleType: parsed.roleType,
          deadlineBefore: parsed.deadlineBefore,
          limit: parsed.includeFacts ? (parsed.limit ?? 20) : parsed.limit,
        }
        return success(enrichOpportunityListWithFacts(
          snapshot,
          listOpportunities(snapshot, readInput, context),
          Boolean(parsed.includeFacts),
        ))
      }
      case 'get_opportunity_assessment': {
        const parsed = getOpportunityAssessmentSchema.parse(args)
        if (!snapshot.data.opportunities.some((item) => item.id === parsed.opportunityId)) {
          return toolError('NOT_FOUND', `Opportunity ${parsed.opportunityId} was not found.`, false)
        }
        return success({ meta: readMeta(context), ...getOpportunityAssessment(snapshot, parsed) })
      }
      case 'get_pipeline':
        return success(getPipeline(snapshot, getPipelineSchema.parse(args), context))
      case 'get_decision_rules': {
        getDecisionRulesSchema.parse(args)
        const output = getDecisionRules(snapshot, context)
        const rules = decisionRulesForSnapshot(snapshot.data.decisionRules)
        return success({
          ...output,
          fitComponentWeights: { ...rules.fitComponentWeights! },
          opportunityValueComponentWeights: { ...rules.opportunityValueComponentWeights! },
        })
      }
      case 'get_discovery_context':
        getDiscoveryContextSchema.parse(args)
        return success(getDiscoveryContext(snapshot, context))
      case 'explain_priority':
        return success(explainPriority(snapshot, explainPrioritySchema.parse(args), context))
      case 'get_recent_timeline':
        return success(getRecentTimeline(snapshot, getRecentTimelineSchema.parse(args), context))
    }
  } catch (caught) {
    return failure(caught)
  }
}
