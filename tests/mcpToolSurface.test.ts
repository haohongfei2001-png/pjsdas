import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  AUTHENTICATED_MCP_RELEASE_REQUIRED_TOOLS,
  AUTHENTICATED_MCP_TOOL_SURFACE_VERSION,
} from '../gateway/mcpToolSurface.js'

const serverFactory = readFileSync(new URL('../gateway/serverFactory.ts', import.meta.url), 'utf8')
const authenticatedRuntime = readFileSync(new URL('../gateway/authenticatedRemoteHttp.ts', import.meta.url), 'utf8')

describe('authenticated MCP release tool surface', () => {
  it('uses a stable versioned contract and registers every release-required tool in the real server factory', () => {
    expect(AUTHENTICATED_MCP_TOOL_SURFACE_VERSION).toBe('v2')
    expect(AUTHENTICATED_MCP_RELEASE_REQUIRED_TOOLS).toEqual([
      'get_coverage_status',
      'get_workspace_integrity',
      'add_opportunities',
      'ingest_discovery_run',
      'ingest_gmail_run',
    ])
    for (const tool of AUTHENTICATED_MCP_RELEASE_REQUIRED_TOOLS) {
      expect(serverFactory).toContain(`server.registerTool('${tool}'`)
    }
  })

  it('enables the narrow explicit-user write for every authenticated session while keeping trusted ingestion OAuth-gated', () => {
    expect(authenticatedRuntime).toContain('const trustedIngestionEnabled = Boolean(identity.oauthClientId)')
    expect(authenticatedRuntime).toContain("dataMode: 'google-drive'")
    expect(authenticatedRuntime).toContain("explicitUserWriteMode: 'enabled'")
    expect(authenticatedRuntime).toContain("trustedIngestionMode: trustedIngestionEnabled ? 'enabled' : 'disabled'")
    expect(authenticatedRuntime).not.toContain("trustedIngestionMode: 'enabled'")
  })
})
