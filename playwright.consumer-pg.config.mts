import { defineConfig, devices } from '@playwright/test'
import { mockCloudGlobalSetup, mockCloudTestUse } from './e2e/support/mockCloudIsolation.mjs'

export default defineConfig({
  globalSetup: mockCloudGlobalSetup,
  testDir: './e2e', testMatch: '**/consumerPostgresRecovery.consumer-pg.ts',
  fullyParallel: false, workers: 1, retries: 0, timeout: 120_000,
  expect: { timeout: 15_000 }, reporter: [['list']],
  outputDir: 'test-results/consumer-pg',
  use: { ...mockCloudTestUse, baseURL: 'http://127.0.0.1:4176',
    timezoneId: 'UTC', serviceWorkers: 'block', trace: 'off', video: 'off', screenshot: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'NODE_ENV=production VITE_PJSDAS_CONNECTED_AUTHORITY=transactional npm run dev -- --host 127.0.0.1 --port 4176',
    url: 'http://127.0.0.1:4176/pjsdas/today', reuseExistingServer: false, timeout: 60_000,
  },
})
