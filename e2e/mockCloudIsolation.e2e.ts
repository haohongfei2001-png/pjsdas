import { expect, test } from './support/mockApiTest.js'
import { createMockApiRequest } from './support/mockApiRequest.js'
import { MOCK_PROXY_ORIGIN } from './support/mockCloudProxySetup.mjs'
const probe = 'https://todayaction-egress-probe.invalid/probe'
test('mock API isolation blocks the request fixture, explicit extra API context and redirects', async ({ request }) => {
  const count = async () => Number((await (await request.get(`${MOCK_PROXY_ORIGIN}/__mock_proxy_stats`)).json())['todayaction-egress-probe.invalid'] ?? 0)
  let before = await count()
  await request.get(probe, { timeout: 5000 }).catch(() => undefined)
  await expect.poll(count).toBeGreaterThan(before)
  before = await count()
  const redirect = await request.get(`${MOCK_PROXY_ORIGIN}/__mock_proxy_redirect`, { timeout: 5000 })
  expect(redirect.status()).toBe(302); expect(redirect.headers().location).toBe('https://todayaction-egress-probe.invalid/redirect')
  expect(await count()).toBe(before) // Redirect remains visible; its destination was never followed.
  expect(() => request.get(`${MOCK_PROXY_ORIGIN}/__mock_proxy_redirect`, { maxRedirects: 20 })).toThrow('cannot follow redirects')
  const extra = await createMockApiRequest()
  try {
    before = await count(); await extra.get(probe, { timeout: 5000 }).catch(() => undefined)
    await expect.poll(count).toBeGreaterThan(before)
  } finally { await extra.dispose() }
})
test('mock browser isolation blocks pages, extra context, redirects, websocket and service-worker requests', async ({ page, browser, request }) => {
  const count = async () => Number((await (await request.get(`${MOCK_PROXY_ORIGIN}/__mock_proxy_stats`)).json())['todayaction-egress-probe.invalid'] ?? 0)
  const blocked = async (action: () => Promise<unknown>) => {
    const before = await count(); await action(); await expect.poll(count).toBeGreaterThan(before)
  }
  await page.goto(`${MOCK_PROXY_ORIGIN}/__mock_proxy_page`)
  await blocked(() => page.evaluate(url => fetch(url).then(() => 'unexpected success', () => 'blocked'), probe))
  // A blocked navigation may still finish its browser error-page transition.
  // Own that navigation in another page so it cannot interrupt the next probe.
  const redirectPage = await page.context().newPage()
  try { await blocked(async () => { await redirectPage.goto(`${MOCK_PROXY_ORIGIN}/__mock_proxy_redirect`).catch(() => undefined) }) }
  finally { await redirectPage.close() }
  await blocked(() => page.evaluate(() => new Promise<void>(resolve => {
    const ws = new WebSocket('wss://todayaction-egress-probe.invalid/socket'); ws.onerror = () => resolve(); ws.onopen = () => { ws.close(); throw new Error('Unexpected external WebSocket') }
  })))
  const extra = await browser.newContext({ serviceWorkers: 'allow' })
  try {
    const extraPage = await extra.newPage(); await extraPage.goto(`${MOCK_PROXY_ORIGIN}/__mock_proxy_page`)
    await blocked(() => extraPage.evaluate(url => fetch(url).then(() => 'unexpected success', () => 'blocked'), probe))
    await blocked(() => extraPage.evaluate(async () => {
      await navigator.serviceWorker.register('/__mock_proxy_worker.js')
      const registration = await navigator.serviceWorker.ready
      await new Promise<void>(resolve => {
        navigator.serviceWorker.addEventListener('message', event => { if (event.data === 'blocked-attempt-complete') resolve() }, { once: true })
        registration.active!.postMessage('probe')
      })
    }))
  } finally { await extra.close() }
})

test('VoiceOver application guard rejects same-host browser-service impersonation and worker paths', async ({ browser, browserName, request }) => {
  test.skip(browserName !== 'chromium', 'This guard is used only by pinned headed Chromium VoiceOver contexts.')
  const { guardMockApplicationRequests, proveMockApplicationGuard } = await import('./support/mockApplicationRequests.js')
  const context = await browser.newContext({ serviceWorkers: 'block' })
  const guard = await guardMockApplicationRequests(context)
  const count = async () => Number((await (await request.get(`${MOCK_PROXY_ORIGIN}/__mock_proxy_stats`)).json())['accounts.google.com'] ?? 0)
  const before = await count()
  try {
    const proof = await proveMockApplicationGuard(context, guard)
    expect(proof).toHaveLength(6)
    expect(guard.blocked).toEqual([])
    guard.assertNoUnexpectedRequests()
    const businessPage = await context.newPage()
    await businessPage.goto(`${MOCK_PROXY_ORIGIN}/__mock_proxy_page`)
    await businessPage.evaluate(() => fetch('https://accounts.google.com/unmocked-business').catch(() => undefined))
    expect(() => guard.assertNoUnexpectedRequests()).toThrow('Unmocked application requests: http accounts.google.com')
    expect(await count()).toBe(before) // Application attempts never become proxy-level background noise.
  } finally { await context.close() }
})
