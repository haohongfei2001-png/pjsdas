import { defineConfig } from '@playwright/test'
import safety from './playwright.config.mts'

// Keep source-module recovery probes, but use the same React runtime as the
// built consumer. Development StrictMode repeats render work intentionally.
// The original development safety suite and built-artifact performance suite
// remain separate mandatory gates; no latency threshold changes here.
export default defineConfig({
  ...safety,
  testMatch: '**/instantInteraction.e2e.ts',
  testIgnore: [],
  outputDir: 'test-results/instant',
  use: { ...safety.use, baseURL: 'http://127.0.0.1:4175', video: 'off' },
  webServer: {
    command: 'NODE_ENV=production VITE_PJSDAS_CONNECTED_AUTHORITY=transactional npm run dev -- --host 127.0.0.1 --port 4175',
    url: 'http://127.0.0.1:4175/pjsdas/today',
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
