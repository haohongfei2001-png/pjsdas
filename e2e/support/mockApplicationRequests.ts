import { expect, type BrowserContext, type Request } from '@playwright/test'
import { MOCK_PROXY_ORIGIN, BROWSER_BACKGROUND_HOSTS } from './mockCloudProxySetup.mjs'

export type BlockedApplicationRequest = { kind: 'http' | 'websocket' | 'serviceworker'; host: string }
const local = (address: string) => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(address).hostname)
/** A context fallback: page-level explicit fixtures still fulfill first. Every
 * remaining application request is classified before it can reach the proxy.
 * VoiceOver additionally blocks ServiceWorkers through Playwright's supported
 * context option, because their fetches can bypass context routing. */
export async function guardMockApplicationRequests(context: BrowserContext) {
  const blocked: BlockedApplicationRequest[] = []
  const record = (kind: BlockedApplicationRequest['kind'], address: string) => {
    let host = 'invalid-address'
    try { host = new URL(address).hostname } catch {}
    blocked.push({ kind, host })
  }
  const backgroundHosts = new Set(BROWSER_BACKGROUND_HOSTS)
  const seenRequests = new WeakSet<Request>()
  const recordHttp = (request: Request) => {
    if (seenRequests.has(request)) return
    seenRequests.add(request); record('http', request.url())
  }
  // These browser-service hosts are never application targets in this suite.
  // Observe them independently of route priority: even a page mock that
  // continues or fulfills such a URL cannot disguise it as browser activity.
  context.on('request', request => { if (backgroundHosts.has(new URL(request.url()).hostname)) recordHttp(request) })
  context.on('serviceworker', worker => record('serviceworker', worker.url()))
  for (const worker of context.serviceWorkers()) record('serviceworker', worker.url())
  await context.route('**/*', route => {
    if (local(route.request().url())) return route.continue()
    recordHttp(route.request())
    return route.abort('blockedbyclient')
  })
  await context.routeWebSocket('**/*', async route => {
    if (local(route.url())) { route.connectToServer(); return }
    record('websocket', route.url())
    await route.close({ code: 1008, reason: 'Unmocked application WebSocket' })
  })
  return { blocked, assertNoUnexpectedRequests() {
    if (blocked.length) throw new Error(`Unmocked application requests: ${blocked.map(item => `${item.kind} ${item.host}`).join(', ')}`)
  } }
}

/** Run before any application page in every VoiceOver context, in its actual
 * headed browser. Only these explicit probes are reset; their complete attempt
 * records are returned as evidence. Application records are never reset. */
export async function proveMockApplicationGuard(context: BrowserContext, guard: Awaited<ReturnType<typeof guardMockApplicationRequests>>) {
  expect(guard.blocked).toEqual([])
  const page = await context.newPage()
  try {
    await page.setExtraHTTPHeaders({ origin: 'chrome://newtab/', 'x-browser-background': 'synthetic-impersonation' })
    await page.goto(`${MOCK_PROXY_ORIGIN}/__mock_proxy_page`)
    await page.evaluate(() => fetch('https://accounts.google.com/fetch').catch(() => undefined))
    await expect.poll(() => guard.blocked.filter(item => item.kind === 'http').length).toBe(1)
    await page.route('https://accounts.google.com/mock-looking', route => route.fulfill({ status: 200, body: 'synthetic page fixture' }))
    await page.evaluate(() => fetch('https://accounts.google.com/mock-looking').catch(() => undefined))
    await expect.poll(() => guard.blocked.filter(item => item.kind === 'http').length).toBe(2)
    await page.evaluate(() => { const frame = document.createElement('iframe'); frame.src = 'https://accounts.google.com/frame'; document.body.append(frame) })
    await expect.poll(() => guard.blocked.filter(item => item.kind === 'http').length).toBe(3)
    const popupPromise = page.waitForEvent('popup')
    await page.evaluate(() => { window.open('about:blank') })
    const popup = await popupPromise
    try { await popup.goto('https://accounts.google.com/popup').catch(() => undefined) } finally { await popup.close() }
    await expect.poll(() => guard.blocked.filter(item => item.kind === 'http').length).toBe(4)
    await page.evaluate(async () => {
      const url = URL.createObjectURL(new Blob(["fetch('https://accounts.google.com/worker').catch(()=>{}).then(()=>postMessage('done'))"], { type: 'application/javascript' }))
      const worker = new Worker(url)
      try { await new Promise<void>(resolve => { worker.onmessage = () => resolve() }) } finally { worker.terminate(); URL.revokeObjectURL(url) }
    })
    await expect.poll(() => guard.blocked.filter(item => item.kind === 'http').length).toBe(5)
    await page.evaluate(() => new Promise<void>(resolve => {
      const socket = new WebSocket('wss://accounts.google.com/socket')
      socket.onclose = () => resolve(); socket.onerror = () => resolve()
    }))
    await expect.poll(() => guard.blocked.filter(item => item.kind === 'websocket').length).toBe(1)
    await page.evaluate(async () => { await navigator.serviceWorker.register('/__mock_proxy_worker.js').catch(() => undefined) })
    expect(await page.evaluate(() => navigator.serviceWorker.getRegistrations().then(items => items.length))).toBe(0)
    expect(context.serviceWorkers()).toEqual([])
    expect(guard.blocked.every(item => item.host === 'accounts.google.com')).toBe(true)
  } finally { await page.close() }
  expect(guard.blocked).toHaveLength(6)
  expect(guard.blocked.every(item => item.host === 'accounts.google.com')).toBe(true)
  return guard.blocked.splice(0)
}
