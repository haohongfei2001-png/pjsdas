import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(new URL('../.github/workflows/deploy-pages.yml', import.meta.url), 'utf8')
const health = readFileSync(new URL('../api/health.ts', import.meta.url), 'utf8')

describe('v1.9 backend-first release gate', () => {
  it('refuses to publish GitHub Pages until one configured backend advertises the exact matching hardened build', () => {
    expect(workflow).toContain('Wait for exact matching hardened v1.9 production backend')
    expect(workflow).toContain('PJSDAS_BACKEND_ORIGINS')
    expect(workflow).toContain('${origin}/api/health')
    expect(workflow).toContain('health.version === "1.9.0-alpha.1"')
    expect(workflow).toContain('health.mode === "google-drive-trusted-ingestion"')
    expect(workflow).toContain('health.release?.commitSha === process.env.GITHUB_SHA')
    for (const capability of [
      'trustedMonitorIngestion', 'trustedGmailIngestion', 'dynamicSourceRegistry', 'coverageFreshnessSla',
      'workspaceIntegrityAudit', 'ingestionDryRunReplay', 'sourceHealthHistory', 'productionSelfTest', 'deploymentPortability',
      'releaseIdentityBinding',
    ]) {
      expect(workflow).toContain(`capabilities.${capability} === true`)
    }
    expect(workflow).toContain('No configured PJSDAS backend matched commit ${GITHUB_SHA}')
  })

  it('keeps the public health contract aligned with the hardened release gate', () => {
    expect(health).toContain("autonomousIngestion: 'v1.9'")
    expect(health).toContain('ingestionReconciliationLedger: true')
    expect(health).toContain('coverageStatusRead: true')
    expect(health).toContain('trustedMonitorIngestion: true')
    expect(health).toContain('trustedGmailIngestion: true')
    expect(health).toContain("stableAccountSession: 'v1.8.1'")
    expect(health).toContain('releaseIdentityBinding: true')
    expect(health).toContain('commitSha: backendReleaseCommit(releaseEnvironment) ?? null')
    for (const capability of [
      'dynamicSourceRegistry', 'coverageFreshnessSla', 'workspaceIntegrityAudit', 'ingestionDryRunReplay', 'sourceHealthHistory', 'productionSelfTest', 'deploymentPortability',
    ]) {
      expect(health).toContain(`${capability}: true`)
    }
  })
})
