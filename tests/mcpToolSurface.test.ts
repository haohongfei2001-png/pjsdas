import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  AUTHENTICATED_MCP_BASE_RELEASE_REQUIRED_TOOLS,
  AUTHENTICATED_MCP_TOOL_SURFACE_VERSION,
  AUTHENTICATED_MCP_TRANSACTIONAL_RELEASE_REQUIRED_TOOLS,
  authenticatedMcpReleaseRequiredTools,
} from '../gateway/mcpToolSurface.js'

const serverFactory = readFileSync(new URL('../gateway/serverFactory.ts', import.meta.url), 'utf8')
const authenticatedRuntime = readFileSync(new URL('../gateway/authenticatedRemoteHttp.ts', import.meta.url), 'utf8')

describe('authenticated MCP release tool surface', () => {
  it('uses a stable v7 contract while exposing P1 commands only for transactional authority', () => {
    expect(AUTHENTICATED_MCP_TOOL_SURFACE_VERSION).toBe('v7')
    expect(AUTHENTICATED_MCP_BASE_RELEASE_REQUIRED_TOOLS).toEqual([
      'get_today_brief',
      'get_opportunity_detail',
      'get_coverage_status',
      'get_workspace_integrity',
      'list_reminder_intents',
      'get_external_capabilities',
      'add_opportunities',
      'ingest_discovery_run',
      'ingest_gmail_run',
    ])
    expect(AUTHENTICATED_MCP_TRANSACTIONAL_RELEASE_REQUIRED_TOOLS).toEqual([
      'get_today_brief',
      'get_opportunity_detail',
      'get_coverage_status',
      'get_workspace_integrity',
      'add_opportunities',
      'apply_user_command',
      'semantic_intake',
      'resolve_semantic_decision',
      'undo_semantic_command',
      'list_reminder_intents',
      'get_external_capabilities',
      'ingest_paia_input',
      'ingest_discovery_run',
      'ingest_gmail_run',
    ])
    expect(authenticatedMcpReleaseRequiredTools('google-drive')).not.toContain('apply_user_command')
    expect(authenticatedMcpReleaseRequiredTools('google-drive')).toContain('get_today_brief')
    expect(authenticatedMcpReleaseRequiredTools('google-drive')).toContain('get_opportunity_detail')
    expect(authenticatedMcpReleaseRequiredTools('transactional')).toContain('get_today_brief')
    expect(authenticatedMcpReleaseRequiredTools('transactional')).toContain('get_opportunity_detail')
    expect(authenticatedMcpReleaseRequiredTools('transactional')).toContain('apply_user_command')
    expect(authenticatedMcpReleaseRequiredTools('transactional')).toContain('semantic_intake')
    expect(authenticatedMcpReleaseRequiredTools('transactional')).toContain('resolve_semantic_decision')
    expect(authenticatedMcpReleaseRequiredTools('transactional')).toContain('undo_semantic_command')
    expect(authenticatedMcpReleaseRequiredTools('transactional')).toContain('ingest_paia_input')
    expect(authenticatedMcpReleaseRequiredTools('transactional')).toContain('list_reminder_intents')
    expect(authenticatedMcpReleaseRequiredTools('transactional')).toContain('get_external_capabilities')
    for (const tool of AUTHENTICATED_MCP_TRANSACTIONAL_RELEASE_REQUIRED_TOOLS) {
      expect(serverFactory).toContain(`server.registerTool('${tool}'`)
    }
  })

  it('keeps legacy additive writes available but gates new P1 commands on transactional authority', () => {
    expect(authenticatedRuntime).toContain('createAuthorizationGrantStore')
    expect(authenticatedRuntime).toContain('grantAllows(grants, name, sourceId)')
    expect(authenticatedRuntime).toContain("dataMode: transactionalAuthority ? 'transactional' : 'google-drive'")
    expect(authenticatedRuntime).toContain("explicitUserWriteMode: 'enabled'")
    expect(authenticatedRuntime).toContain("explicitUserCommandMode: transactionalAuthority ? 'enabled' : 'disabled'")
    expect(authenticatedRuntime).toContain("semanticIntakeMode: transactionalAuthority ? 'enabled' : 'disabled'")
    expect(authenticatedRuntime).toContain('authorizeSemanticIntake')
    expect(authenticatedRuntime).toContain('trustedIngestionCapabilities')
    expect(authenticatedRuntime).not.toContain('Boolean(identity.oauthClientId)')
  })
})
