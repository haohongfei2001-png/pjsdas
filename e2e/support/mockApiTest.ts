import { test as base, expect } from '@playwright/test'
import { createMockApiRequest } from './mockApiRequest.js'

/** Limited to the two existing mock suites that make Node-side API requests.
 * Unlike browser networking, a request initially bypassing the proxy may keep
 * its direct agent across redirects. Never automatically follow them here. */
export const test = base.extend({
  request: async ({ baseURL, request: upstream, extraHTTPHeaders, ignoreHTTPSErrors }, use) => {
    if (process.env.TA_MOCK_FIXTURE_TARGET === 'live') { await use(upstream); return }
    const isolated = await createMockApiRequest({ baseURL, extraHTTPHeaders, ignoreHTTPSErrors })
    try { await use(isolated) } finally { await isolated.dispose() }
  },
})
export { expect }
