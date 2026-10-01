import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e', testMatch: 'secondarySurfaces.ui.ts', workers: 1, retries: 0,
  timeout: 90_000, expect: { timeout: 8_000 },
  outputDir: 'test-results/secondary-ui-checks',
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'secondary-ui-report' }]],
  use: { baseURL: 'http://127.0.0.1:4173', timezoneId: 'Asia/Shanghai',
    trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'npm run preview -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173/pjsdas/', reuseExistingServer: false, timeout: 60_000 },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
