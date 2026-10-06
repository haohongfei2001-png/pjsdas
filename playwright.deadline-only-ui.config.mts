import base from './playwright.config.mts'

export default {
  ...base,
  testMatch: ['decisionRulesSaveFailure.e2e.ts', 'rulesProductTruth.e2e.ts', 'deadlineOnlySurfaces.ui.ts', 'deadlineArchiveCompatibility.e2e.ts'],
  outputDir: 'test-results/deadline-only-ui',
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'artifacts/deadline-only-ui/report' }]],
  use: { ...base.use, timezoneId: 'Asia/Shanghai' },
  projects: base.projects.filter((project) => project.name === 'chromium'),
}
