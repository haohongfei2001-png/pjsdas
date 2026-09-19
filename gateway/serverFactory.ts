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
import { getCoverageStatusSchema, invokeCoverageStatus } from './coverageTool.js'
import { getWorkspaceIntegritySchema, invokeWorkspaceIntegrity } from './workspaceIntegrityTool.js'
import {
  ingestDiscoveryRunSchema,
  ingestGmailRunSchema,
  invokeTrustedIngestion,
} from './ingestSources.js'
import { addOpportunitiesSchema, invokeAddOpportunities } from './addOpportunities.js'
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

const directWriteAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
} as const

const trustedIngestionAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
} as const

export interface PjsdasMcpServerOptions {
  version?: string
  dataMode?: 'workspace' | 'demo' | 'google-drive-readonly' | 'google-drive'
  proposalMode?: 'disabled' | 'review-link'
  proposalSigningKey?: string
  trustedIngestionMode?: 'disabled' | 'enabled'
  trustedIngestionCapabilities?: { discovery: boolean; gmail: boolean }
  trustedIngestionAuthorizer?: (name: 'ingest_discovery_run' | 'ingest_gmail_run', sourceId: string) => Promise<void>
  explicitUserWriteMode?: 'disabled' | 'enabled'
}

export function createPjsdasMcpServer(
  source: WorkspaceSource,
  options: PjsdasMcpServerOptions = {},
) {
  const dataMode = options.dataMode ?? 'workspace'
  const proposalMode = options.proposalMode ?? 'disabled'
  const trustedIngestionMode = options.trustedIngestionMode ?? 'disabled'
  const trustedDiscoveryEnabled = trustedIngestionMode === 'enabled' && (options.trustedIngestionCapabilities?.discovery ?? true)
  const trustedGmailEnabled = trustedIngestionMode === 'enabled' && (options.trustedIngestionCapabilities?.gmail ?? true)
  const explicitUserWriteMode = options.explicitUserWriteMode ?? 'disabled'
  const instructions = [
    'PJSDAS is a personal job-search decision and action system.',
    'Use its explicit decision rules and deterministic explanations instead of inventing hidden ranking rules.',
    'Read tools never change PJSDAS state.',
    'For job discovery, first call get_discovery_context. Treat its Discovery Profile as the durable user-controlled search preference source; do not silently invent or rewrite durable preferences from chat history.',
    'When get_discovery_context returns continuousDiscovery, use incrementalSince as the normal lower bound for new or materially updated postings, and treat refreshQueue as separate source-verification work. Do not repeat a full historical search without a reason.',
    'For refreshQueue work, preserve ownerKind, ownerId, postingId and canonicalSourceUrl exactly. A newly found canonical URL is a new/re-posted source and must go through normal discovery instead of overwriting an existing posting.',
    'A public posting becoming closed does not by itself close the PJSDAS Opportunity or recruitment Process. Posting lifecycle and recruiting lifecycle are separate facts.',
    'PJSDAS itself does not crawl the web. If the user asks for current job opportunities, use ChatGPT web search/browsing outside PJSDAS, preserve public source URLs, and keep unknown job facts unknown rather than fabricating them.',
    'When a public source explicitly supports them, submit bounded structured job facts. Do not convert model inference into source facts.',
    'For new web-discovered jobs, prefer bounded component assessments over opaque aggregate ratings. PJSDAS derives Fit and Opportunity Value totals from explicit components and user-controlled weights.',
    'Use get_opportunity_assessment when the user asks why a stored Fit or Opportunity Value score exists.',
    'Use get_application_portfolio when the user asks which roles to choose inside an explicit Application Group. Capacity is a maximum, not a target.',
    'Use get_prep_graph when the user asks what preparation has the highest leverage or which current gaps are uncovered.',
    'Use get_coverage_status when the user asks whether automated sources missed anything. A green result means every currently enabled Source Registry entry is fresh, balanced, and has no unresolved input; it does not claim that the public internet contains no other jobs.',
    'Use get_workspace_integrity when the user asks whether the PJSDAS workspace itself is structurally healthy. This audit is read-only and never repairs or deletes data.',
  ]

  if (explicitUserWriteMode === 'enabled') {
    instructions.push(
      'When the user explicitly asks in the current conversation to add, save, record, or write specific source-backed job opportunities into PJSDAS, use add_opportunities and execute the write immediately. Do not route that explicit instruction through propose_changes and do not require a second Apply click.',
      'Use add_opportunities only for additive Opportunity creation. It is duplicate-safe and cannot change Decision Rules, delete history, close processes, or make other policy decisions.',
      'Do not use add_opportunities when the user is only asking for recommendations, evaluation, discovery, or whether a job should be added. Those requests do not constitute write authorization.',
      'If Fit or Opportunity Value is not already grounded, omit those optional scores rather than inventing precision; PJSDAS will create the opportunity with a neutral pending-assessment placeholder.',
    )
  }

  if (trustedDiscoveryEnabled || trustedGmailEnabled) {
    instructions.push(
      'Trusted factual ingestion is autonomous and does not require a review click. It is deliberately narrower than generic mutation.',
      'Use ingest_discovery_run only for a bounded completed GPT/ChatGPT monitoring run with stable sourceRecordId values and source-backed public URLs. The tool performs identity resolution, quality gates, duplicate merging, accounting, and fail-closed workspace-version checks itself.',
      'Use ingest_gmail_run only after Gmail messages have been classified and reduced to bounded structured facts. Never submit raw mailbox contents as notes. Low-confidence or ambiguous messages must be submitted with low/medium confidence so PJSDAS records them as unresolved instead of guessing.',
      'Every submitted source record must be accounted for as created, merged, updated, duplicate, filtered, ignored, or unresolved. Never silently omit an inconvenient result from the ingestion batch.',
      'Trusted ingestion may add or merge factual opportunities and process events, but it must not silently change Decision Rules, durable user preferences, rejection decisions, or delete data.',
      'Use dryRun=true on either ingestion tool to simulate outcomes without writing. replayOfRunId is permitted only with dryRun=true and compares a fresh simulation with the historical run while preserving the workspace.',
      'A new trusted source that is not in the bootstrap registry must provide sourcePolicy with enabled state, cadence, and freshness SLA. Existing sources persist their current policy on every run.',
    )
  }

  if (proposalMode === 'review-link') {
    instructions.push(
      'The propose_changes tool remains review-only for ambiguous, destructive, preference, policy, user-decision mutations, and AI-initiated ad-hoc discoveries that the user did not explicitly command PJSDAS to store. It creates a pending ChangeSet and signed review link but never applies it.',
      'Never tell the user that a proposed change was applied. State clearly that Apply or Discard is still required for review-only changes.',
      'For action status changes, read current actions first and use exact action IDs. For ambiguous updates, ask the user to clarify rather than guessing.',
      'For ad-hoc web-discovered jobs that are not part of a trusted monitoring run and are not covered by an explicit current user write instruction, submit only source-backed candidates through discoveredOpportunities.',
      'When a discovery pass produces zero eligible jobs, PJSDAS can return a review-only record_discovery_run proposal.',
      'For refreshQueue verification, use postingRefreshes as a separate review batch.',
      'Rich Opportunity facts are evidence fields, not ratings. Component assessment is the preferred rating path.',
    )
  } else if (!trustedDiscoveryEnabled && !trustedGmailEnabled && explicitUserWriteMode !== 'enabled') {
    instructions.push('This server exposes no mutation or proposal tools.')
  }

  if (dataMode === 'demo') {
    instructions.push('This endpoint contains synthetic demo data only. Never present demo companies, roles, events, or priorities as the user\'s real job-search state.')
  }
  if (dataMode === 'google-drive-readonly') {
    instructions.push('Read operations use the authenticated user\'s validated PJSDAS workspace from Google Drive appDataFolder. This endpoint is read-only.')
  }
  if (dataMode === 'google-drive') {
    instructions.push('The authenticated user\'s validated PJSDAS workspace lives in Google Drive appDataFolder. Reads are private; writes are permitted only through registered bounded mutation tools and use optimistic workspace-version conflict checks.')
  }

  const server = new McpServer(
    { name: 'pjsdas', version: options.version ?? '1.9.0-alpha.1' },
    { instructions: instructions.join(' ') },
  )

  server.registerTool('get_today_plan', {
    title: 'Get PJSDAS today plan',
    description: 'Read the deterministic PJSDAS action plan for a day and optional available-time budget. Existing Prep Actions may receive runtime leverage/urgency boosts without rewriting stored records.',
    inputSchema: getTodayPlanSchema, annotations: readOnlyAnnotations,
  }, async (args) => invokeReadTool(source, 'get_today_plan', args))

  server.registerTool('list_opportunities', {
    title: 'List PJSDAS opportunities',
    description: 'Query the PJSDAS opportunity pool with bounded filters such as stage, company, role type, query text, or deadline. Rich facts are optional and bounded.',
    inputSchema: listOpportunitiesSchema, annotations: readOnlyAnnotations,
  }, async (args) => invokeReadTool(source, 'list_opportunities', args))

  server.registerTool('get_opportunity_assessment', {
    title: 'Get PJSDAS opportunity assessment',
    description: 'Read a single Opportunity component assessment, stored aggregate scores, and current-rules projection without rewriting history.',
    inputSchema: getOpportunityAssessmentSchema, annotations: readOnlyAnnotations,
  }, async (args) => invokeReadTool(source, 'get_opportunity_assessment', args))

  server.registerTool('get_application_portfolio', {
    title: 'Get PJSDAS application portfolio decision',
    description: 'Read deterministic portfolio recommendations for explicit Application Groups with shared application quotas. Capacity is treated as a maximum.',
    inputSchema: getApplicationPortfolioSchema, annotations: readOnlyAnnotations,
  }, async (args) => invokeReadTool(source, 'get_application_portfolio', args))

  server.registerTool('get_prep_graph', {
    title: 'Get PJSDAS Prep Graph',
    description: 'Read deterministic links from Prep to current opportunities, structured requirements/gaps, and process-prep needs.',
    inputSchema: getPrepGraphSchema, annotations: readOnlyAnnotations,
  }, async (args) => invokeReadTool(source, 'get_prep_graph', args))

  server.registerTool('get_pipeline', {
    title: 'Get PJSDAS pipeline',
    description: 'Read effective recruiting-process state, upcoming process events, and items needing attention.',
    inputSchema: getPipelineSchema, annotations: readOnlyAnnotations,
  }, async (args) => invokeReadTool(source, 'get_pipeline', args))

  server.registerTool('get_decision_rules', {
    title: 'Get PJSDAS decision rules',
    description: 'Read the explicit user-controlled rules that govern planning, risk thresholds, ranking weights, component-assessment weights, and portfolio policy.',
    annotations: readOnlyAnnotations,
  }, async () => invokeReadTool(source, 'get_decision_rules', {}))

  server.registerTool('get_discovery_context', {
    title: 'Get PJSDAS continuous job-discovery context',
    description: 'Read the Discovery Profile, active weights, existing/inbox identities, Discovery Run history, incremental baseline, source coverage, and posting-refresh queue.',
    inputSchema: getDiscoveryContextSchema, annotations: readOnlyAnnotations,
  }, async (args) => invokeReadTool(source, 'get_discovery_context', args))

  server.registerTool('get_coverage_status', {
    title: 'Get PJSDAS autonomous-ingestion coverage',
    description: 'Read dynamic Source Registry coverage, reconciliation status, freshness SLA, source health, and recent run history for trusted ingestion.',
    inputSchema: getCoverageStatusSchema, annotations: readOnlyAnnotations,
  }, async () => invokeCoverageStatus(source))

  server.registerTool('get_workspace_integrity', {
    title: 'Audit PJSDAS workspace integrity',
    description: 'Read-only structural audit for duplicate opportunities/postings, orphan events/actions, missing process actions, closed-process active tasks, and expired not-applied opportunities. Never repairs data.',
    inputSchema: getWorkspaceIntegritySchema, annotations: readOnlyAnnotations,
  }, async () => invokeWorkspaceIntegrity(source))

  server.registerTool('explain_priority', {
    title: 'Explain PJSDAS priority',
    description: 'Explain an action or opportunity using deterministic Today-ranking components and active guardrails.',
    inputSchema: explainPrioritySchema, annotations: readOnlyAnnotations,
  }, async (args) => invokeReadTool(source, 'explain_priority', args))

  server.registerTool('get_recent_timeline', {
    title: 'Get PJSDAS recent timeline',
    description: 'Read bounded factual PJSDAS history, optionally filtered by time, category, company, or opportunity.',
    inputSchema: getRecentTimelineSchema, annotations: readOnlyAnnotations,
  }, async (args) => invokeReadTool(source, 'get_recent_timeline', args))

  if (explicitUserWriteMode === 'enabled') {
    server.registerTool('add_opportunities', {
      title: 'Add explicitly user-authorized PJSDAS opportunities',
      description: 'Directly add source-backed opportunities to the canonical PJSDAS workspace only when the current user message explicitly asks to add, save, record, or write those specific jobs. This is an immediate duplicate-safe additive write with no review click; never use it for mere recommendations or autonomous discovery.',
      inputSchema: addOpportunitiesSchema, annotations: directWriteAnnotations,
    }, async (args) => invokeAddOpportunities(source, args))
  }

  if (trustedDiscoveryEnabled) {
    server.registerTool('ingest_discovery_run', {
      title: 'Autonomously ingest a trusted job-monitor run',
      description: 'Auto-apply or dry-run one completed trusted monitoring batch. Each submitted source record is accounted for; identity ambiguity fails closed; workspace conflicts fail closed.',
      inputSchema: ingestDiscoveryRunSchema, annotations: trustedIngestionAnnotations,
    }, async (args) => invokeTrustedIngestion(source, 'ingest_discovery_run', args, { authorize: options.trustedIngestionAuthorizer }))

    server.registerTool('ingest_gmail_run', {
      title: 'Autonomously ingest structured Gmail recruitment facts',
      description: 'Auto-apply or dry-run one bounded Gmail ingestion batch after classification/extraction. High-confidence facts may create/update opportunities and logical process events; ambiguous facts remain unresolved.',
      inputSchema: ingestGmailRunSchema, annotations: trustedIngestionAnnotations,
    }, async (args) => invokeTrustedIngestion(source, 'ingest_gmail_run', args, { authorize: options.trustedIngestionAuthorizer }))
  }

  if (proposalMode === 'review-link') {
    if (!options.proposalSigningKey?.trim()) throw new Error('PJSDAS proposal signing key is not configured.')
    server.registerTool('propose_changes', {
      title: 'Propose PJSDAS changes for review',
      description: 'Create a signed, review-only PJSDAS ChangeSet for ambiguous, destructive, preference/policy, or AI-initiated changes outside the direct explicit-user Opportunity-add boundary. Nothing changes until explicit Apply in PJSDAS.',
      inputSchema: proposeChangesSchema, annotations: proposalAnnotations,
    }, async (args) => invokeProposeChanges(source, args, { signingKey: options.proposalSigningKey! }))
  }

  return server
}
