import { defineConfig, devices } from '@playwright/test'
const base = process.env.TA_BRAND_BASE ?? '/pjsdas/'
export default defineConfig({
  testDir: './e2e', testMatch: 'brand.e2e.ts', workers: 1, retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure' },
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173' + base, reuseExistingServer: false, timeout: 60_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
