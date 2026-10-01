import base from './playwright.secondary-ui.config.mts'
export default { ...base, testMatch: 'settingsHierarchy.ui.ts', outputDir: 'test-results/settings-hierarchy', reporter: [['list'], ['html', { open: 'never', outputFolder: 'settings-hierarchy-report' }]] }
