import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
describe('mock CI and production readback execution boundary', () => {
  it.each(['browser-e2e', 'tsui05-browser-matrix', 'todayaction-ui', 'secondary-surfaces-ui', 'todayaction-brand', 'instant-recovery-draft', 'rc-browser-hardening', 'cgr02-read-only-rollback', 'cgr02-voiceover', 'cgr05-long-session', 'account-signout-diagnosis'])('%s runs a separate isolation gate before every browser job', name => {
    const source = read(`.github/workflows/${name}.yml`)
    const jobs = source.split(/^  [a-z][a-z0-9-]*:\s*$/m).slice(1)
    const browserJobs = jobs.filter(job => job.includes('npx playwright test'))
    expect(browserJobs.length).toBeGreaterThan(0)
    for (const job of browserJobs) {
      const first = job.match(/npx playwright test[^\n]*/)?.[0]
      expect(first).toContain('--config=playwright.cloud-guard.config.mts')
      expect(job).not.toMatch(/continue-on-error:\s*true/)
    }
  })
  it('keeps anonymous production readback after the exact main deployment, never from a PR', () => {
    const workflow = read('.github/workflows/todayaction-production-readback.yml')
    expect(workflow).not.toContain('pull_request')
    expect(workflow).toContain("workflows: ['Deploy PJSDAS to GitHub Pages']")
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.head_branch == 'main'")
    expect(workflow).toContain('TA_EXPECTED_COMMIT: ${{ github.event.workflow_run.head_sha }}')
    expect(workflow).toContain('--config=playwright.todayaction-live.config.mts')
    expect(read('playwright.live.config.mts')).toContain("testIgnore: '**/mockCloudIsolation.e2e.ts'")
  })
  it('retains the fixed visual baseline adapters and explicit mock builds', () => {
    for (const name of ['todayaction-ui', 'secondary-surfaces-ui']) {
      const workflow = read(`.github/workflows/${name}.yml`)
      expect(workflow).toContain('VITE_PJSDAS_CLOUD_MODE: mock')
      expect(workflow).toContain('e2e/support/mockCloudProxySetup.mjs')
      expect(workflow).toContain('e2e/support/mockCloudIsolation.mts')
    }
    expect(read('.github/workflows/todayaction-ui.yml')).toContain('e2e/support/mockCloudTargets.ts')
  })
})

it('requires the narrow VoiceOver application guard and preserves ServiceWorker coverage elsewhere', () => {
  expect(read('e2e/cgr02TodayVoiceOver.voiceover.ts')).toContain("import { test } from './support/voiceoverMockTest.js'")
  expect(read('e2e/cgr02TodayVoiceOver.voiceover.ts')).not.toContain("from '@guidepup/playwright'")
  expect(read('e2e/cgr02TodayVoiceOver.voiceover.ts')).not.toMatch(/browser\.newContext|request\.newContext|routeWebSocket/)
  expect(read('playwright.voiceover.config.mts')).toContain("serviceWorkers: 'block'")
  expect(read('playwright.brand.config.mts')).not.toContain("serviceWorkers: 'block'")
  expect(read('playwright.config.mts')).not.toContain("serviceWorkers: 'block'")
  expect(read('e2e/mockCloudIsolation.e2e.ts')).toContain("serviceWorkers: 'allow'")
  expect(read('e2e/support/voiceoverMockTest.ts')).toContain('guard.assertNoUnexpectedRequests()')
  expect(read('.github/workflows/cgr02-voiceover.yml')).not.toContain('DEBUG: pw:browser')
})

it('limits the Firefox updater policy to the pinned mock project and keeps live settings separate', () => {
  expect(JSON.parse(read('e2e/support/firefoxMockPolicies.json'))).toEqual({ policies: { DisableAppUpdate: true } })
  const config = read('playwright.config.mts')
  expect(config).toContain("...devices['Desktop Firefox'], launchOptions: mockFirefoxLaunchOptions")
  expect(config).not.toMatch(/Desktop Chrome[^\n]*mockFirefoxLaunchOptions/)
  const live = read('playwright.live.config.mts') + read('playwright.todayaction-live.config.mts')
  expect(live).not.toMatch(/mockFirefoxLaunchOptions|from[^\n]*mockCloudIsolation|firefoxMockPolicies/)
  expect(read('e2e/support/mockCloudIsolation.mts')).toContain('env: { ...process.env, PLAYWRIGHT_FIREFOX_POLICIES_JSON:')
})
