import { mockCloudGlobalSetup, mockCloudTestUse } from './e2e/support/mockCloudIsolation.mjs'
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  globalSetup: mockCloudGlobalSetup,
  testDir: './e2e', testMatch: 'nativePaintDiagnostic.ui.ts', workers: 1, retries: 0,
  timeout: 90_000, expect: { timeout: 8_000 },
  outputDir: 'test-results/native-paint-diagnostic',
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'native-paint-report' }]],
  use: { ...mockCloudTestUse, baseURL: 'http://127.0.0.1:4173', timezoneId: 'Asia/Shanghai',
    trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'npm run preview -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173/pjsdas/', reuseExistingServer: false, timeout: 60_000 },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
