import {defineConfig,devices} from '@playwright/test'
export default defineConfig({
  testDir:'./e2e',testMatch:'todayactionProduction.live.ts',workers:1,retries:0,
  reporter:[['list'],['html',{open:'never'}]],
  use:{trace:'retain-on-failure'},
  projects:[{name:'chromium',use:{...devices['Desktop Chrome']}}],
})
