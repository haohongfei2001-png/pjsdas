import { mockCloudGlobalSetup, mockCloudTestUse } from './e2e/support/mockCloudIsolation.mjs'
import { defineConfig, devices } from '@playwright/test'
export default defineConfig({ globalSetup: mockCloudGlobalSetup, testDir: './e2e', testMatch: 'aiCapture.ui.ts', workers: 1, retries: 0,
  timeout: 40_000, expect: { timeout: 8_000 }, reporter: [['list']], outputDir: 'test-results/ai-capture',
  use: { ...mockCloudTestUse, baseURL: 'http://127.0.0.1:4278', timezoneId: 'Asia/Shanghai', trace: 'retain-on-failure' },
  webServer: { command: 'VITE_PJSDAS_AI_CAPTURE=enabled VITE_PJSDAS_CONNECTED_AUTHORITY=transactional npm run dev -- --host 127.0.0.1 --port 4278',
    url: 'http://127.0.0.1:4278/pjsdas/', reuseExistingServer: false, timeout: 60_000 },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
