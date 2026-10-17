import { mockCloudGlobalSetup, mockCloudTestUse } from './e2e/support/mockCloudIsolation.mjs'
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  globalSetup: mockCloudGlobalSetup,
  testDir: './e2e', testMatch: 'libraryClipDiagnostic.ui.ts', workers: 1, retries: 0,
  timeout: 90_000, expect: { timeout: 8_000 },
  outputDir: 'test-results/library-clip-diagnostic',
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'library-clip-report' }]],
  // Chromium 153 partial-raster history retained pixels despite identical native
  // paint commands. The bounded experiment and real 1px negative control are
  // recorded in CONSUMER_B3_READ_SCOPE_EVIDENCE.md. Apply only to visual tests,
  // identically to the fixed reference and candidate; keep exact pixel gates.
  use: { ...mockCloudTestUse, launchOptions: { ...mockCloudTestUse.launchOptions, args: ['--disable-partial-raster'] }, baseURL: 'http://127.0.0.1:4173', timezoneId: 'Asia/Shanghai',
    trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'npm run preview -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173/pjsdas/', reuseExistingServer: false, timeout: 60_000 },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
