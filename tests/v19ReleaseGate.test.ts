import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(new URL('../.github/workflows/deploy-pages.yml', import.meta.url), 'utf8')
const health = readFileSync(new URL('../api/health.ts', import.meta.url), 'utf8')

describe('v1.9 backend-first release gate', () => {
  it('refuses to publish GitHub Pages until the production backend advertises the matching hardened v1.9 contract', () => {
    expect(workflow).toContain('Wait for matching hardened v1.9 production backend')
    expect(workflow).toContain('https://pjsdas-remote-alpha.vercel.app/api/health')
    expect(workflow).toContain('health.version === "1.9.0-alpha.1"')
    expect(workflow).toContain('health.mode === "google-drive-trusted-ingestion"')
    for (const capability of [
      'trustedMonitorIngestion', 'trustedGmailIngestion', 'dynamicSourceRegistry', 'coverageFreshnessSla',
      'workspaceIntegrityAudit', 'ingestionDryRunReplay', 'sourceHealthHistory', 'productionSelfTest',
    ]) {
      expect(workflow).toContain(`capabilities.${capability} === true`)
    }
    expect(workflow).toContain('refusing to publish a frontend that depends on it')
  })

  it('keeps the public health contract aligned with the hardened release gate', () => {
    expect(health).toContain("autonomousIngestion: 'v1.9'")
    expect(health).toContain('ingestionReconciliationLedger: true')
    expect(health).toContain('coverageStatusRead: true')
    expect(health).toContain('trustedMonitorIngestion: true')
    expect(health).toContain('trustedGmailIngestion: true')
    expect(health).toContain("stableAccountSession: 'v1.8.1'")
    for (const capability of [
      'dynamicSourceRegistry', 'coverageFreshnessSla', 'workspaceIntegrityAudit', 'ingestionDryRunReplay', 'sourceHealthHistory', 'productionSelfTest',
    ]) {
      expect(health).toContain(`${capability}: true`)
    }
  })
})
