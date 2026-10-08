import { mockCloudGlobalSetup, mockCloudTestUse } from './e2e/support/mockCloudIsolation.mjs'
import { screenReaderConfig } from '@guidepup/playwright'
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  ...screenReaderConfig,
  globalSetup: [...(Array.isArray(screenReaderConfig.globalSetup) ? screenReaderConfig.globalSetup : screenReaderConfig.globalSetup ? [screenReaderConfig.globalSetup] : []), mockCloudGlobalSetup],
  testDir: './e2e',
  testMatch: '**/*.voiceover.ts',
  timeout: 180_000,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: { ...mockCloudTestUse,
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium-voiceover', use: { ...devices['Desktop Chrome'], headless: false } }],
  webServer: {
    command: 'VITE_PJSDAS_CONNECTED_AUTHORITY=transactional npm run dev -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
