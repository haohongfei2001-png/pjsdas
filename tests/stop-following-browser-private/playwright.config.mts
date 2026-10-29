import { defineConfig, devices } from '@playwright/test'
import { resolve } from 'node:path'
import { mockCloudGlobalSetup, mockCloudTestUse } from '../../e2e/support/mockCloudIsolation.mjs'
const output = resolve(import.meta.dirname, '../../stop-following-browser-results')
export default defineConfig({
  globalSetup: mockCloudGlobalSetup,
  testDir: '.', testMatch: 'stopFollowing.browser.ts', fullyParallel: false, workers: 1,
  retries: 0, timeout: 45_000, expect: { timeout: 10_000 },
  reporter: [['list'], ['json', { outputFile: resolve(output, 'results.json') }]],
  outputDir: resolve(output, 'artifacts'),
  use: { ...mockCloudTestUse, baseURL: 'http://127.0.0.1:4187', viewport: { width: 1500, height: 1000 }, serviceWorkers: 'block', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1500, height: 1000 } } }],
  webServer: { cwd: resolve(import.meta.dirname, '../..'), command: 'VITE_PJSDAS_CLOUD_MODE=mock VITE_PJSDAS_CONNECTED_AUTHORITY=transactional npm run dev -- --host 127.0.0.1 --port 4187', url: 'http://127.0.0.1:4187/pjsdas/tests/stop-following-browser-private/index.html', reuseExistingServer: false },
})
