import { fileURLToPath } from 'node:url'
import { MOCK_PROXY } from './mockCloudProxySetup.mjs'
export { MOCK_PROXY_ORIGIN, MOCK_PROXY } from './mockCloudProxySetup.mjs'

// These options are only imported by local/mock configurations. Production
// smoke configurations remain separate and are never selected by this helper.
if (process.env.VITE_PJSDAS_CLOUD_MODE === 'live') throw new Error('Mock browser tests cannot opt into live cloud services.')
process.env.VITE_PJSDAS_CLOUD_MODE = 'mock'
export const mockCloudTestUse = { proxy: MOCK_PROXY, launchOptions: { proxy: MOCK_PROXY } }
// Only the pinned mock Firefox process reads this policy. Its existing testing
// preference does not cover Firefox 155's separate UpdateServiceStub startup.
// https://playwright.dev/docs/api/class-browsertype#browser-type-launch-option-firefox-user-prefs
export const mockFirefoxLaunchOptions = { proxy: MOCK_PROXY,
  env: { ...process.env, PLAYWRIGHT_FIREFOX_POLICIES_JSON: fileURLToPath(new URL('./firefoxMockPolicies.json', import.meta.url)) } }
export const mockCloudGlobalSetup = fileURLToPath(new URL('./mockCloudProxySetup.mjs', import.meta.url))
