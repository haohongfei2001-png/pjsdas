import base from './playwright.config.mts'
export default {
  ...base,
  testMatch: 'mockCloudIsolation.e2e.ts', testIgnore: [],
  outputDir: 'test-results/cloud-guard',
  reporter: [['list']],
}
