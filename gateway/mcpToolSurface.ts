export const MCP_TOOL_NAMES = {
  todayPlan: 'get_today_plan',
  opportunities: 'list_opportunities',
  opportunityAssessment: 'get_opportunity_assessment',
  applicationPortfolio: 'get_application_portfolio',
  prepGraph: 'get_prep_graph',
  pipeline: 'get_pipeline',
  decisionRules: 'get_decision_rules',
  discoveryContext: 'get_discovery_context',
  coverageStatus: 'get_coverage_status',
  workspaceIntegrity: 'get_workspace_integrity',
  explainPriority: 'explain_priority',
  recentTimeline: 'get_recent_timeline',
  explicitOpportunityWrite: 'add_opportunities',
  discoveryIngestion: 'ingest_discovery_run',
  gmailIngestion: 'ingest_gmail_run',
  proposeChanges: 'propose_changes',
} as const

export const AUTHENTICATED_MCP_RELEASE_REQUIRED_TOOLS = [
  MCP_TOOL_NAMES.coverageStatus,
  MCP_TOOL_NAMES.workspaceIntegrity,
  MCP_TOOL_NAMES.explicitOpportunityWrite,
  MCP_TOOL_NAMES.discoveryIngestion,
  MCP_TOOL_NAMES.gmailIngestion,
] as const

export const AUTHENTICATED_MCP_TOOL_SURFACE_VERSION = 'v2' as const
