import { McpServer } from '@modelcontextprotocol/server'
import {
  explainPrioritySchema,
  getPipelineSchema,
  getRecentTimelineSchema,
  getTodayPlanSchema,
  invokeReadTool,
  listOpportunitiesSchema,
} from './readTools'
import type { WorkspaceSource } from './workspaceSource'

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
} as const

export function createPjsdasMcpServer(source: WorkspaceSource) {
  const server = new McpServer(
    { name: 'pjsdas', version: '1.1.0-alpha.1' },
    {
      instructions: [
        'PJSDAS is a read-only personal job-search decision system in this alpha.',
        'Use its explicit decision rules and deterministic explanations instead of inventing hidden ranking rules.',
        'Never claim that a tool call changed PJSDAS state; this server exposes no mutation tools.',
      ].join(' '),
    },
  )

  server.registerTool(
    'get_today_plan',
    {
      title: 'Get PJSDAS today plan',
      description: 'Read the deterministic PJSDAS action plan for a day and optional available-time budget.',
      inputSchema: getTodayPlanSchema,
      annotations: readOnlyAnnotations,
    },
    async (args) => invokeReadTool(source, 'get_today_plan', args),
  )

  server.registerTool(
    'list_opportunities',
    {
      title: 'List PJSDAS opportunities',
      description: 'Query the PJSDAS opportunity pool with bounded filters such as stage, company, role type, query text, or deadline.',
      inputSchema: listOpportunitiesSchema,
      annotations: readOnlyAnnotations,
    },
    async (args) => invokeReadTool(source, 'list_opportunities', args),
  )

  server.registerTool(
    'get_pipeline',
    {
      title: 'Get PJSDAS pipeline',
      description: 'Read effective recruiting-process state, upcoming process events, and items needing attention.',
      inputSchema: getPipelineSchema,
      annotations: readOnlyAnnotations,
    },
    async (args) => invokeReadTool(source, 'get_pipeline', args),
  )

  server.registerTool(
    'get_decision_rules',
    {
      title: 'Get PJSDAS decision rules',
      description: 'Read the explicit user-controlled rules that govern PJSDAS planning, risk thresholds, and ranking weights.',
      annotations: readOnlyAnnotations,
    },
    async () => invokeReadTool(source, 'get_decision_rules', {}),
  )

  server.registerTool(
    'explain_priority',
    {
      title: 'Explain PJSDAS priority',
      description: 'Explain an action or opportunity using PJSDAS deterministic scoring components and active guardrails.',
      inputSchema: explainPrioritySchema,
      annotations: readOnlyAnnotations,
    },
    async (args) => invokeReadTool(source, 'explain_priority', args),
  )

  server.registerTool(
    'get_recent_timeline',
    {
      title: 'Get PJSDAS recent timeline',
      description: 'Read bounded factual PJSDAS history, optionally filtered by time, category, company, or opportunity.',
      inputSchema: getRecentTimelineSchema,
      annotations: readOnlyAnnotations,
    },
    async (args) => invokeReadTool(source, 'get_recent_timeline', args),
  )

  return server
}
