import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(new URL('../.github/workflows/deploy-pages.yml', import.meta.url), 'utf8')
const health = readFileSync(new URL('../api/health.ts', import.meta.url), 'utf8')

describe('backend-first release gate', () => {
  it('refuses to publish until the exact backend build and required MCP tool surface are advertised', () => {
    expect(workflow).toContain('Wait for exact matching production backend')
    expect(workflow).toContain('PJSDAS_BACKEND_ORIGINS')
    expect(workflow).toContain('${origin}/api/health')
    expect(workflow).toContain('health.version === "1.9.0-alpha.1"')
    expect(workflow).toContain('health.mode === "google-drive-trusted-ingestion"')
    expect(workflow).toContain('health.release?.commitSha === process.env.GITHUB_SHA')
    expect(workflow).toContain('capabilities.authenticatedMcpToolSurface === true')
    expect(workflow).toContain('authenticatedMcp.toolSurfaceVersion === "v1"')
    for (const tool of ['get_coverage_status', 'get_workspace_integrity', 'ingest_discovery_run', 'ingest_gmail_run']) {
      expect(workflow).toContain(`"${tool}"`)
    }
    expect(workflow).toContain('Verify production contract before Pages publication')
    expect(workflow).not.toContain('PJSDAS_SELF_TEST_EMAIL')
    expect(workflow).not.toContain('PJSDAS_SELF_TEST_PASSWORD')
    expect(workflow).not.toContain('PJSDAS_REQUIRE_AUTHENTICATED_SELF_TEST')
    expect(workflow.indexOf('Verify production contract before Pages publication'))
      .toBeLessThan(workflow.indexOf('uses: actions/upload-pages-artifact@v3'))
  })

  it('keeps the public health contract aligned with the release gate', () => {
    expect(health).toContain("autonomousIngestion: 'v1.9'")
    expect(health).toContain('ingestionReconciliationLedger: true')
    expect(health).toContain('coverageStatusRead: true')
    expect(health).toContain('trustedMonitorIngestion: true')
    expect(health).toContain('trustedGmailIngestion: true')
    expect(health).toContain("stableAccountSession: 'v1.8.1'")
    expect(health).toContain('releaseIdentityBinding: true')
    expect(health).toContain('authenticatedMcpToolSurface: true')
    expect(health).toContain('toolSurfaceVersion: AUTHENTICATED_MCP_TOOL_SURFACE_VERSION')
    expect(health).toContain('releaseRequiredTools: AUTHENTICATED_MCP_RELEASE_REQUIRED_TOOLS')
    expect(health).toContain('commitSha: backendReleaseCommit(releaseEnvironment) ?? null')
  })
})
