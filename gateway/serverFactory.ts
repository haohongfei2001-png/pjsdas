import { McpServer } from '@modelcontextprotocol/server'
import {
  explainPrioritySchema,
  getApplicationPortfolioSchema,
  getOpportunityAssessmentSchema,
  getPipelineSchema,
  getPrepGraphSchema,
  getRecentTimelineSchema,
  getDiscoveryContextSchema,
  getTodayPlanSchema,
  invokeReadTool,
  listOpportunitiesSchema,
} from './readTools.js'
import { invokeProposeChanges, proposeChangesSchema } from './proposeChanges.js'
import type { WorkspaceSource } from './workspaceSource.js'

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
} as const

const proposalAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
} as const

export interface PjsdasMcpServerOptions {
  version?: string
  dataMode?: 'workspace' | 'demo' | 'google-drive-readonly'
  proposalMode?: 'disabled' | 'review-link'
  proposalSigningKey?: string
}

export function createPjsdasMcpServer(
  source: WorkspaceSource,
  options: PjsdasMcpServerOptions = {},
) {
  const dataMode = options.dataMode ?? 'workspace'
  const proposalMode = options.proposalMode ?? 'disabled'
  const instructions = [
    'PJSDAS is a personal job-search decision and action system.',
    'Use its explicit decision rules and deterministic explanations instead of inventing hidden ranking rules.',
    'Read tools never change PJSDAS state.',
    'For job discovery, first call get_discovery_context. Treat its Discovery Profile as the durable user-controlled search preference source; do not silently invent or rewrite durable preferences from chat history.',
    'PJSDAS itself does not crawl the web. If the user asks for current job opportunities, use ChatGPT web search/browsing outside PJSDAS, preserve public source URLs, and keep unknown job facts unknown rather than fabricating them.',
    'When a public source explicitly supports them, submit bounded structured Rich Opportunity facts such as responsibilities, requirements, education, majors, experience, skills, languages, department/business unit, recruitment batch, application method, and compensation evidence. Do not convert model inference into source facts.',
    'For new web-discovered jobs, prefer bounded component assessments over opaque aggregate ratings. PJSDAS derives Fit and Opportunity Value totals from explicit component scores, confidence, rationale, and user-controlled component weights.',
    'Use get_opportunity_assessment when the user asks why a stored Fit or Opportunity Value score exists, or how current component weights would project the saved assessment. Do not claim current-rule projection silently rewrites historical stored scores.',
    'Use get_application_portfolio when the user asks which roles to choose inside an explicit Application Group with shared quota or preference constraints. Capacity is a maximum, not a target: never recommend weak roles merely to fill every available slot.',
    'Use get_prep_graph when the user asks what preparation has the highest leverage, which opportunities a Prep item supports, or which current gaps/process-prep needs are uncovered. Prep Graph edges are explicit or deterministic exact matches only; do not invent fuzzy semantic edges or claim that a waiting Prep task was automatically activated.',
  ]

  if (proposalMode === 'review-link') {
    instructions.push(
      'The propose_changes tool is review-only: it creates a validated pending ChangeSet and a signed PJSDAS review link, but it never mutates the workspace itself.',
      'Never tell the user that a proposed change was applied. State clearly that the user must open the returned reviewUrl and explicitly Apply or Discard it in PJSDAS.',
      'For action status changes, read current actions first and use exact action IDs. For ambiguous updates, ask the user to clarify rather than guessing.',
      'For web-discovered jobs, submit only source-backed candidates through discoveredOpportunities. Do not mix discovery candidates with unrelated updates in the same ChangeSet.',
      'Rich Opportunity facts are evidence fields, not ratings. Component assessment is the preferred rating path; legacy aggregate score fields remain compatibility input only.',
    )
  } else {
    instructions.push('This server exposes no mutation or proposal tools.')
  }

  if (dataMode === 'demo') {
    instructions.push('This endpoint contains synthetic demo data only. Never present demo companies, roles, events, or priorities as the user\'s real job-search state.')
  }
  if (dataMode === 'google-drive-readonly') {
    instructions.push('Read operations use the authenticated user\'s validated PJSDAS workspace from Google Drive appDataFolder. Treat returned records as private user data and expose only what is needed to answer the user\'s request.')
  }

  const server = new McpServer(
    { name: 'pjsdas', version: options.version ?? '1.6.0-alpha.2' },
    { instructions: instructions.join(' ') },
  )

  server.registerTool(
    'get_today_plan',
    {
      title: 'Get PJSDAS today plan',
      description: 'Read the deterministic PJSDAS action plan for a day and optional available-time budget. Existing Prep Actions may receive runtime leverage/urgency boosts from deterministic Prep Graph coverage without rewriting stored Action records.',
      inputSchema: getTodayPlanSchema,
      annotations: readOnlyAnnotations,
    },
    async (args) => invokeReadTool(source, 'get_today_plan', args),
  )

  server.registerTool(
    'list_opportunities',
    {
      title: 'List PJSDAS opportunities',
      description: 'Query the PJSDAS opportunity pool with bounded filters such as stage, company, role type, query text, or deadline. Rich facts are optional and bounded.',
      inputSchema: listOpportunitiesSchema,
      annotations: readOnlyAnnotations,
    },
    async (args) => invokeReadTool(source, 'list_opportunities', args),
  )

  server.registerTool(
    'get_opportunity_assessment',
    {
      title: 'Get PJSDAS opportunity assessment',
      description: 'Read a single Opportunity component assessment, stored aggregate Fit/Opportunity Value scores, and the explicit current-rules projection. This tool never rewrites historical scores.',
      inputSchema: getOpportunityAssessmentSchema,
      annotations: readOnlyAnnotations,
    },
    async (args) => invokeReadTool(source, 'get_opportunity_assessment', args),
  )

  server.registerTool(
    'get_application_portfolio',
    {
      title: 'Get PJSDAS application portfolio decision',
      description: 'Read deterministic portfolio recommendations for explicit Application Groups with shared application quotas. Returns recommended and not-recommended roles, capacity status, component scores, overlap effects, and warnings. Capacity is treated as a maximum; this tool never submits applications or changes priorities.',
      inputSchema: getApplicationPortfolioSchema,
      annotations: readOnlyAnnotations,
    },
    async (args) => invokeReadTool(source, 'get_application_portfolio', args),
  )

  server.registerTool(
    'get_prep_graph',
    {
      title: 'Get PJSDAS Prep Graph',
      description: 'Read deterministic links from Prep to current opportunities, structured requirements/gaps, and process-prep needs. Returns leverage signals, coverage, trigger suggestions, and uncovered needs. It never creates Prep Actions or mutates job-search state.',
      inputSchema: getPrepGraphSchema,
      annotations: readOnlyAnnotations,
    },
    async (args) => invokeReadTool(source, 'get_prep_graph', args),
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
      description: 'Read the explicit user-controlled rules that govern PJSDAS planning, risk thresholds, ranking weights, component-assessment weights, and application-portfolio policy.',
      annotations: readOnlyAnnotations,
    },
    async () => invokeReadTool(source, 'get_decision_rules', {}),
  )

  server.registerTool(
    'get_discovery_context',
    {
      title: 'Get PJSDAS job discovery context',
      description: 'Read the explicit user-controlled Discovery Profile, active decision weights, and bounded existing/closed opportunity identities before searching public job sources. PJSDAS does not search the web or mutate state in this tool.',
      inputSchema: getDiscoveryContextSchema,
      annotations: readOnlyAnnotations,
    },
    async (args) => invokeReadTool(source, 'get_discovery_context', args),
  )

  server.registerTool(
    'explain_priority',
    {
      title: 'Explain PJSDAS priority',
      description: 'Explain an action or opportunity using PJSDAS deterministic Today-ranking components and active guardrails.',
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

  if (proposalMode === 'review-link') {
    if (!options.proposalSigningKey?.trim()) throw new Error('PJSDAS proposal signing key is not configured.')
    server.registerTool(
      'propose_changes',
      {
        title: 'Propose PJSDAS changes for review',
        description: 'Create a signed, review-only PJSDAS ChangeSet. Supports natural-language progress, exact action-status changes, explicit Decision Rules patches, or a separate batch of source-backed discoveredOpportunities. New discovery candidates should use bounded component assessments; legacy aggregate scores remain accepted for compatibility. This does not change the workspace. Return reviewUrl for explicit Apply/Discard in PJSDAS.',
        inputSchema: proposeChangesSchema,
        annotations: proposalAnnotations,
      },
      async (args) => invokeProposeChanges(source, args, { signingKey: options.proposalSigningKey! }),
    )
  }

  return server
}
