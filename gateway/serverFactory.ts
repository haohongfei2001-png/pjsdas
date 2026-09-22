import { McpServer } from '@modelcontextprotocol/server'
import {
  explainPrioritySchema,
  getApplicationPortfolioSchema,
  getOpportunityAssessmentSchema,
  getOpportunityDetailSchema,
  getPipelineSchema,
  getPrepGraphSchema,
  getRecentTimelineSchema,
  getDiscoveryContextSchema,
  getTodayBriefSchema,
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
import { applyUserCommandSchema, invokeApplyUserCommand } from './userCommands.js'
import {
  invokePaiaIntake,
  invokeResolveSemanticDecision,
  invokeSemanticIntake,
  invokeSemanticUndo,
  paiaIntakeSchema,
  resolveSemanticDecisionSchema,
  semanticIntakeSchema,
  undoSemanticCommandSchema,
} from './semanticIntake.js'
import { invokeProposeChanges, proposeChangesSchema } from './proposeChanges.js'
import {
  capabilityStateMap,
  defaultExternalCapabilityProbes,
  getExternalCapabilitiesSchema,
  invokeExternalCapabilities,
  invokeListReminderIntents,
  listReminderIntentsSchema,
} from './reminderTools.js'
import type { ExternalCapabilityProbe } from '../src/reminders.js'
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
  dataMode?: 'workspace' | 'demo' | 'google-drive-readonly' | 'google-drive' | 'transactional'
  proposalMode?: 'disabled' | 'review-link'
  proposalSigningKey?: string
  trustedIngestionMode?: 'disabled' | 'enabled'
  trustedIngestionCapabilities?: { discovery: boolean; gmail: boolean }
  trustedIngestionAuthorizer?: (name: 'ingest_discovery_run' | 'ingest_gmail_run', sourceId: string) => Promise<void>
  explicitUserWriteMode?: 'disabled' | 'enabled'
  explicitUserCommandMode?: 'disabled' | 'enabled'
  semanticIntakeMode?: 'disabled' | 'enabled'
  semanticIntakeAuthorizer?: (source: import('../src/model.js').SemanticIntakeSourceRef) => Promise<void>
  externalCapabilities?: ExternalCapabilityProbe[]
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
  const explicitUserCommandMode = options.explicitUserCommandMode ?? 'disabled'
  const semanticIntakeMode = options.semanticIntakeMode ?? 'disabled'
  const externalCapabilities = options.externalCapabilities ?? defaultExternalCapabilityProbes()
  const externalCapabilityStates = capabilityStateMap(externalCapabilities)
  const instructions = [
    'PJSDAS is a personal job-search decision and action system.',
    'Use its explicit decision rules and deterministic explanations instead of inventing hidden ranking rules.',
    'Read tools never change PJSDAS state.',
    'Use get_today_brief as the canonical daily read contract for Web/MCP/iPhone-equivalent planning. It is revision-bound and already combines next action, sparse next actions, recruiting agenda, DecisionRequests, and material coverage warnings. get_today_plan remains a compatibility read for older clients.',
    'For job discovery, first call get_discovery_context. Treat its Discovery Profile as the durable user-controlled search preference source; do not silently invent or rewrite durable preferences from chat history.',
    'When get_discovery_context returns continuousDiscovery, use incrementalSince as the normal lower bound for new or materially updated postings, and treat refreshQueue as separate source-verification work. Do not repeat a full historical search without a reason.',
    'For refreshQueue work, preserve ownerKind, ownerId, postingId and canonicalSourceUrl exactly. A newly found canonical URL is a new/re-posted source and must go through normal discovery instead of overwriting an existing posting.',
    'A public posting becoming closed does not by itself close the PJSDAS Opportunity or recruitment Process. Posting lifecycle and recruiting lifecycle are separate facts.',
    'Interactive MCP tools do not perform arbitrary job-web discovery. If the user asks for current jobs in ChatGPT, use ChatGPT web search/browsing and preserve public source URLs. Separately, PJSDAS background Discovery may discover candidates and independently fetch their source URLs before any source fact is trusted.',
    'When a public source explicitly supports them, submit bounded structured job facts. Do not convert model inference into source facts.',
    'For new web-discovered jobs, prefer bounded component assessments over opaque aggregate ratings. PJSDAS derives Fit and Opportunity Value totals from explicit components and user-controlled weights.',
    'Use get_opportunity_detail as the canonical opportunity decision read: conclusion, material reasons/risks, current process state, next operation, and nearest ScheduleNode. Use get_opportunity_assessment only when the user explicitly asks why a stored Fit or Opportunity Value score exists.',
    'Use get_application_portfolio when the user asks which roles to choose inside an explicit Application Group. Capacity is a maximum, not a target.',
    'Use get_prep_graph when the user asks what preparation has the highest leverage or which current gaps are uncovered.',
    'Use get_coverage_status when the user asks whether automated sources missed anything. A green result means every currently enabled Source Registry entry is fresh, balanced, and has no unresolved input; it does not claim that the public internet contains no other jobs.',
    'Use get_workspace_integrity when the user asks whether the PJSDAS workspace itself is structurally healthy. This audit is read-only and never repairs or deletes data.',
    'Use get_external_capabilities before assuming an external Task or Calendar delivery channel exists. Host-side ChatGPT features are not callable merely because they exist in the host product.',
    'Use list_reminder_intents to inspect PJSDAS reminder policy. ScheduleNode is business-time truth; ReminderIntent is notification policy; external task/calendar objects are delivery mappings only.',
  ]

  server.registerTool('get_external_capabilities', {
    title: 'Get PJSDAS external delivery capabilities',
    description: 'Read the truthful runtime capability state for external reminder delivery adapters such as ChatGPT Tasks or Google Calendar. Availability is never inferred from host-product features.',
    inputSchema: getExternalCapabilitiesSchema, annotations: readOnlyAnnotations,
  }, async (args) => invokeExternalCapabilities(args, externalCapabilities))

  server.registerTool('list_reminder_intents', {
    title: 'List PJSDAS reminder intents',
    description: 'Read bounded ReminderIntent policy and delivery/outbox state. ScheduleNode remains recruiting-time truth and external objects remain delivery mappings only.',
    inputSchema: listReminderIntentsSchema, annotations: readOnlyAnnotations,
  }, async (args) => invokeListReminderIntents(source, args))

  if (explicitUserWriteMode === 'enabled') {
    instructions.push(
      'When the user explicitly asks in the current conversation to add, save, record, or write specific source-backed job opportunities into PJSDAS, use add_opportunities and execute the write immediately. Do not route that explicit instruction through propose_changes and do not require a second Apply click.',
      'Use add_opportunities only for additive Opportunity creation. It is duplicate-safe and cannot change Decision Rules, delete history, close processes, or make other policy decisions.',
      'Do not use add_opportunities when the user is only asking for recommendations, evaluation, discovery, or whether a job should be added. Those requests do not constitute write authorization.',
      'If Fit or Opportunity Value is not already grounded, omit those optional scores rather than inventing precision; PJSDAS will mark the opportunity unassessed even if internal ranking needs fallback values.',
    )
  }

  if (explicitUserCommandMode === 'enabled') {
    instructions.push(
      'For an explicit current-user progress command on an existing unique target, use apply_user_command. Read the relevant opportunity/action first and pass its exact stable id. Do not guess an id or use a fuzzy company-only target.',
      'P1 examples include: record an application submission; record a recruiting event; set an explicit deadline; complete/start/skip/restore an Action; abandon one Opportunity without closing the recruiting process; correct a bounded user-asserted fact; change one Opportunity roleType; add one manual Action.',
      'If the user intent is explicit but the target or a required parameter is ambiguous, ask only for that missing detail in the current conversation. Do not route ordinary P2 ambiguity through propose_changes.',
      'Never use apply_user_command for bulk operations, identity merge/rename, Decision Rules, workspace conflict override, restore/migration, authorization changes, or external consequences such as applying, withdrawing, sending mail, or accepting an Offer.',
    )
  }

  if (semanticIntakeMode === 'enabled') {
    instructions.push(
      'Use semantic_intake as the primary write path for current factual statements and current user intents. Supply a source-neutral structured candidate; PJSDAS resolves stable Opportunity/occurrence identity and enforces write policy on the server.',
      'Do not treat questions, quotes, examples, hypotheticals, or rewrite requests as facts. Mark statementMode truthfully; non-assertive modes produce NO_WRITE.',
      'Do not guess among same-company roles or multiple interview/test occurrences. Semantic Intake creates a durable DecisionRequest with bounded choices when identity or occurrence is ambiguous.',
      'High-confidence, uniquely resolved, compensatable internal facts may commit without a second confirmation. Explicit internal abandonment follows the owner policy but shared application-group governance still requires a DecisionRequest.',
      'Semantic Intake never authorizes external applications, withdrawals, recruiting email, or Offer acceptance/rejection. External-consequence requests fail closed into a human decision.',
      'Use resolve_semantic_decision only for an open DecisionRequest and one of its exact choice ids. Use undo_semantic_command only for a latest-revision Semantic Intake command whose receipt says Undo is available.',
      'apply_user_command remains a lower-level compatibility tool for exact-id bounded commands; new source adapters must target Semantic Intake instead of inventing parallel domain transitions.',
      'For the current ChatGPT conversation, semantic_intake is the canonical source-neutral write contract. Use source.kind=mcp and a stable current-chat source identity; do not route current statements through a PAIA-only adapter.',
      'Use ingest_paia_input only for an authenticated PAIA owner-input source. PAIA may supply bounded context but cannot bypass source-scoped authorization or Semantic Intake policy, and raw owner text is not persisted in the command ledger.',
      'Reminder requests are Semantic Intake candidates. One ScheduleNode/version/purpose has one ReminderIntent delivery owner. Never interpret task/calendar delivery lifecycle as recruiting completion.',
      'When an external reminder owner is requested, trust only get_external_capabilities/runtime capability state. Unsupported external delivery is recorded truthfully; do not silently pretend an external task or calendar object exists.',
    )
  }

  if (trustedDiscoveryEnabled || trustedGmailEnabled) {
    instructions.push(
      'Trusted factual ingestion is autonomous and does not require a review click. It is deliberately narrower than generic mutation.',
      'Use ingest_discovery_run only for a bounded completed GPT/ChatGPT monitoring run with public source URLs. PJSDAS independently fetches and verifies submitted source URLs before any Discovery fact may create or refresh an Opportunity; unverified candidates remain explicit unresolved records.',
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
  } else if (!trustedDiscoveryEnabled && !trustedGmailEnabled && explicitUserWriteMode !== 'enabled' && explicitUserCommandMode !== 'enabled' && semanticIntakeMode !== 'enabled') {
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
  if (dataMode === 'transactional') {
    instructions.push('Connected-mode reads and writes use the server-authoritative transactional PJSDAS workspace. Every write is revision-checked, command-ledgered, and fail-closed on conflict.')
  }

  const server = new McpServer(
    { name: 'pjsdas', version: options.version ?? '1.9.0-alpha.1' },
    { instructions: instructions.join(' ') },
  )

  server.registerTool('get_today_brief', {
    title: 'Get PJSDAS Today brief',
    description: 'Read the canonical revision-bound daily decision contract: one next action, sparse next actions, recruiting agenda, relevant DecisionRequests, material coverage warnings, executability and latest-start protection.',
    inputSchema: getTodayBriefSchema, annotations: readOnlyAnnotations,
  }, async (args) => invokeReadTool(source, 'get_today_brief', args))

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

  server.registerTool('get_opportunity_detail', {
    title: 'Get PJSDAS opportunity detail decision',
    description: 'Read one platform-neutral conclusion-first Opportunity decision: conclusion, material reasons/risks, process state, next operation, nearest ScheduleNode, and progressive-detail references.',
    inputSchema: getOpportunityDetailSchema, annotations: readOnlyAnnotations,
  }, async (args) => invokeReadTool(source, 'get_opportunity_detail', args))

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

  if (explicitUserCommandMode === 'enabled') {
    server.registerTool('apply_user_command', {
      title: 'Apply one explicit PJSDAS user command',
      description: 'Directly commit one bounded, explicit, low-risk user command against an exact PJSDAS target. Ambiguous targets must be clarified in the AI conversation before calling this tool; governed/high-impact changes remain review-only.',
      inputSchema: applyUserCommandSchema, annotations: directWriteAnnotations,
    }, async (args) => invokeApplyUserCommand(source, args))
  }

  if (semanticIntakeMode === 'enabled') {
    server.registerTool('semantic_intake', {
      title: 'Apply PJSDAS Semantic Intake',
      description: 'Normalize one current source observation into bounded internal PJSDAS facts/intents. Unique high-confidence compensatable facts may commit atomically; ambiguity creates DecisionRequest; non-assertive text produces NO_WRITE; external consequences are never executed.',
      inputSchema: semanticIntakeSchema, annotations: directWriteAnnotations,
    }, async (args) => invokeSemanticIntake(source, args, {
      authorize: options.semanticIntakeAuthorizer,
      externalCapabilities: externalCapabilityStates,
    }))

    server.registerTool('ingest_paia_input', {
      title: 'Ingest one authorized PAIA owner input',
      description: 'Adapt one authenticated PAIA owner-input record into the shared Semantic Intake contract. It never creates a parallel mutation path and requires normal source-scoped semantic_intake authorization.',
      inputSchema: paiaIntakeSchema, annotations: directWriteAnnotations,
    }, async (args) => invokePaiaIntake(source, args, {
      authorize: options.semanticIntakeAuthorizer,
      externalCapabilities: externalCapabilityStates,
    }))

    server.registerTool('resolve_semantic_decision', {
      title: 'Resolve one PJSDAS DecisionRequest',
      description: 'Answer one open Semantic Intake DecisionRequest using an exact offered choice id. The shared domain/write policy is re-run against current state before commit.',
      inputSchema: resolveSemanticDecisionSchema, annotations: directWriteAnnotations,
    }, async (args) => invokeResolveSemanticDecision(source, args))

    server.registerTool('undo_semantic_command', {
      title: 'Undo latest PJSDAS Semantic Intake command',
      description: 'Apply a field/object-level compensation for a latest-revision Semantic Intake command. It never restores a whole stale snapshot and refuses automatic Undo after dependent revisions.',
      inputSchema: undoSemanticCommandSchema, annotations: directWriteAnnotations,
    }, async (args) => invokeSemanticUndo(source, args))
  }

  if (trustedDiscoveryEnabled) {
    server.registerTool('ingest_discovery_run', {
      title: 'Autonomously ingest a trusted job-monitor run',
      description: 'Auto-apply or dry-run one completed trusted monitoring batch. Each submitted source record is accounted for; identity ambiguity fails closed; workspace conflicts fail closed.',
      inputSchema: ingestDiscoveryRunSchema, annotations: trustedIngestionAnnotations,
    }, async (args) => invokeTrustedIngestion(source, 'ingest_discovery_run', args, { authorize: options.trustedIngestionAuthorizer }))
  }

  if (trustedGmailEnabled) {
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
