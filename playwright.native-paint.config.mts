import { mockCloudGlobalSetup, mockCloudTestUse } from './e2e/support/mockCloudIsolation.mjs'
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  globalSetup: mockCloudGlobalSetup,
  testDir: './e2e', testMatch: 'nativePaintDiagnostic.ui.ts', workers: 1, retries: 0,
  timeout: 90_000, expect: { timeout: 8_000 },
  outputDir: 'test-results/native-paint-diagnostic',
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'native-paint-report' }]],
  // DIAGNOSTIC_ONLY: one compositor variable, identical for both revisions.
  // Chromium 153 reads this switch into LayerTreeSettings.use_partial_raster:
  // https://github.com/chromium/chromium/blob/153.0.8010.12/third_party/blink/renderer/platform/widget/compositing/layer_tree_settings.cc#L297
  use: { ...mockCloudTestUse, launchOptions: { ...mockCloudTestUse.launchOptions, args: ['--disable-partial-raster'] }, baseURL: 'http://127.0.0.1:4173', timezoneId: 'Asia/Shanghai',
    trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'npm run preview -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173/pjsdas/', reuseExistingServer: false, timeout: 60_000 },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
