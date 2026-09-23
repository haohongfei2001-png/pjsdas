import { screenReaderConfig } from '@guidepup/playwright'
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  ...screenReaderConfig,
  testDir: './e2e',
  testMatch: '**/*.voiceover.ts',
  timeout: 180_000,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'webkit-voiceover', use: { ...devices['Desktop Safari'], headless: false } }],
  webServer: {
    command: 'VITE_PJSDAS_CONNECTED_AUTHORITY=transactional npm run dev -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
