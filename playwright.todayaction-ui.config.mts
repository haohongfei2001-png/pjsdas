import { defineConfig,devices } from '@playwright/test'
export default defineConfig({
  testDir:'./e2e',testMatch:'todayactionUI.ui.ts',workers:1,retries:0,
  reporter:[['list'],['html',{open:'never'}]],
  use:{baseURL:'http://127.0.0.1:4173',trace:'retain-on-failure',screenshot:'only-on-failure'},
  webServer:{command:'npm run preview -- --host 127.0.0.1 --port 4173',url:'http://127.0.0.1:4173/pjsdas/',reuseExistingServer:false,timeout:60000},
  projects:[{name:'chromium',use:{...devices['Desktop Chrome']}}],
})
