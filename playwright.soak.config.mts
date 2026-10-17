import { mockCloudGlobalSetup, mockCloudTestUse } from './e2e/support/mockCloudIsolation.mjs'
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  globalSetup: mockCloudGlobalSetup,
  testDir: './e2e',
  testMatch: '**/*.soak.ts',
  workers: 1,
  retries: 0,
  timeout: 125 * 60_000,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { ...mockCloudTestUse,
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'VITE_PJSDAS_CONNECTED_AUTHORITY=transactional npm run dev -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
