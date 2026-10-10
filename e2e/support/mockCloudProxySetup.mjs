import http from 'node:http'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, basename } from 'node:path'

export const PROXY_PORT = 18879
export const MOCK_PROXY_ORIGIN = `http://127.0.0.1:${PROXY_PORT}`
export const MOCK_PROXY = { server: MOCK_PROXY_ORIGIN, bypass: '127.0.0.1,localhost,[::1]' }
const PROBE_HOST = 'todayaction-egress-probe.invalid'
// These exact fixtures have no production recipient. Rejected attempts remain
// visible diagnostics; a CONNECT count cannot prove application mock coverage.
export const SYNTHETIC_MOCK_HOSTS = ['todayaction-backend.invalid', 'todayaction-auth.invalid', 'apply.example.test']
// Exact known service destination, not a claim about the request's initiator.
// It is still refused before DNS/upstream I/O; other Mozilla hosts are unknown.
export const KNOWN_REJECTED_SERVICE_HOSTS = ['aus5.mozilla.org']
export function unexpectedMockProxyHosts(counts, backgroundHosts) {
  return [...counts].filter(([host]) => host !== PROBE_HOST && !SYNTHETIC_MOCK_HOSTS.includes(host) && !KNOWN_REJECTED_SERVICE_HOSTS.includes(host) && !backgroundHosts.has(host))
}
export const BROWSER_BACKGROUND_HOSTS = ['clients2.google.com', 'accounts.google.com', 'www.google.com', 'update.googleapis.com', 'android.clients.google.com', 'content-autofill.googleapis.com']
/** Safe success-log evidence: fixed host names and counts only. The complete
 * host accounting remains in the existing artifact, including unknown misses. */
export function mockProxyLogSummary(counts, backgroundHosts) {
  const browserBackground = Object.fromEntries(BROWSER_BACKGROUND_HOSTS.filter(host => backgroundHosts.has(host)).map(host => [host, counts.get(host) ?? 0]))
  const blockedAttempts = [...counts.values()].reduce((sum, count) => sum + count, 0)
  const deliberateProbeAttempts = counts.get(PROBE_HOST) ?? 0
  const rejectedSyntheticTargets = Object.fromEntries(SYNTHETIC_MOCK_HOSTS.filter(host => counts.has(host)).map(host => [host, counts.get(host)]))
  const rejectedKnownServiceTargets = Object.fromEntries(KNOWN_REJECTED_SERVICE_HOSTS.filter(host => counts.has(host)).map(host => [host, counts.get(host)]))
  return { scope: 'rejecting proxy only', forwardedRequests: 0, blockedAttempts, deliberateProbeAttempts,
    browserBackground, rejectedSyntheticTargets, rejectedKnownServiceTargets, otherBlockedAttempts: blockedAttempts - deliberateProbeAttempts
      - Object.values(browserBackground).reduce((sum, count) => sum + count, 0)
      - Object.values(rejectedSyntheticTargets).reduce((sum, count) => sum + count, 0)
      - Object.values(rejectedKnownServiceTargets).reduce((sum, count) => sum + count, 0) }
}
/** Diagnostic classification only. Every request is still rejected with 502.
 * Application traffic to these same hosts is separately rejected and failed
 * by voiceoverMockTest's mandatory context guard before reaching this proxy. */
export function voiceOverBackgroundDiagnostics(config, installed) {
  const projects = config.projects ?? []
  const allowed = basename(config.configFile ?? '') === 'playwright.voiceover.config.mts'
    && projects.length === 1 && projects[0].name === 'chromium-voiceover'
    && projects[0].use.headless === false && projects[0].use.serviceWorkers === 'block'
    && (!projects[0].use.browserName || projects[0].use.browserName === 'chromium')
    && !projects[0].use.channel && !projects[0].use.launchOptions?.channel
    && !projects[0].use.connectOptions && !process.env.PW_TEST_CONNECT_WS_ENDPOINT
    && !projects[0].use.launchOptions?.executablePath
    && installed?.playwright === '1.63.0' && installed?.chromium === '153.0.8010.12'
  return new Set(allowed ? BROWSER_BACKGROUND_HOSTS : [])
}

/** This process-local test proxy never forwards, resolves or connects to a
 * destination. Keep only host/count diagnostics, never paths or headers. */
export function createRejectingMockProxy() {
  const counts = new Map()
  const requestClasses = new Map()
  const socketErrors = new Map()
  const record = (request, transport = 'http') => {
    const target = request.url ?? ''
    const tunnel = transport === 'connect'
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : PROXY_PORT
    const localAuthority = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(request.headers.host ?? '')
    const form = tunnel ? 'authority' : target.startsWith('/') ? 'origin' : /^[a-z]+:\/\//i.test(target) ? 'absolute' : 'other'
    const exactLocalFavicon = localAuthority && request.method === 'GET' && target === '/favicon.ico'
    // Fixed categories only: never retain arbitrary paths, headers or tokens.
    const category = `${transport}:${form}:${localAuthority ? 'loopback' : 'other'}:${exactLocalFavicon ? 'local-favicon' : 'other'}`
    requestClasses.set(category, (requestClasses.get(category) ?? 0) + 1)
    let host = 'invalid-target'
    try { host = new URL(tunnel ? `https://${target}` : target).hostname } catch {}
    counts.set(host, (counts.get(host) ?? 0) + 1)
    if (host === 'todayaction-backend.invalid' || host === 'todayaction-auth.invalid') {
      console.log(`Mock application transport rejected: ${JSON.stringify({ at: new Date().toISOString(), host, transport })}`)
    }
  }
  const server = http.createServer((request, response) => {
    if (request.url === '/__mock_proxy_stats' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(Object.fromEntries(counts))); return
    }
    if (request.url === '/__mock_proxy_page' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><title>Local isolation probe</title><link rel="icon" type="image/png" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=">'); return
    }
    if (request.url === '/__mock_proxy_worker.js' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/javascript', 'service-worker-allowed': '/' })
      response.end(`self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));self.addEventListener('message',event=>{event.waitUntil(fetch('https://${PROBE_HOST}/worker').catch(()=>{}).then(()=>event.source.postMessage('blocked-attempt-complete')))});`); return
    }
    if (request.url === '/__mock_proxy_redirect' && request.method === 'GET') {
      response.writeHead(302, { location: `https://${PROBE_HOST}/redirect` }); response.end(); return
    }
    record(request)
    response.writeHead(502, { 'content-type': 'text/plain', connection: 'close' }); response.end('MOCK_EXTERNAL_REQUEST_BLOCKED')
  })
  const sockets = new Set()
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    // Node removes its HTTP parser's listener when CONNECT/upgrade hands the
    // socket to us. A browser may reset that already-rejected tunnel after 502.
    // Handle only this accepted peer; retain the refusal and error accounting.
    socket.on('error', error => {
      const code = error.code === 'ECONNRESET' || error.code === 'EPIPE' ? error.code : 'other'
      socketErrors.set(code, (socketErrors.get(code) ?? 0) + 1)
      socket.destroy()
    })
  })
  for (const event of ['connect', 'upgrade']) server.on(event, (request, socket) => {
    record(request, event)
    socket.end('HTTP/1.1 502 Mock external request blocked\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  })
  return { server, counts, requestClasses, socketErrors, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) } }
}

export default async function setup(config) {
  if (process.env.TA_MOCK_FIXTURE_TARGET === 'live' || process.env.VITE_PJSDAS_CLOUD_MODE === 'live') throw new Error('Mock cloud isolation cannot use an explicit live target.')
  for (const project of config.projects) {
    const target = new URL(project.use.baseURL ?? 'http://127.0.0.1')
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) throw new Error('Mock cloud isolation requires a loopback application target.')
  }
  let installed
  if (basename(config.configFile ?? '') === 'playwright.voiceover.config.mts') {
    const require = createRequire(import.meta.url)
    const packagePath = require.resolve('playwright-core/package.json')
    const packageInfo = JSON.parse(await readFile(packagePath, 'utf8'))
    const browsers = JSON.parse(await readFile(join(dirname(packagePath), 'browsers.json'), 'utf8'))
    installed = { playwright: packageInfo.version, chromium: browsers.browsers.find(item => item.name === 'chromium')?.browserVersion }
  }
  const backgroundHosts = voiceOverBackgroundDiagnostics(config, installed)
  const proxy = createRejectingMockProxy()
  await new Promise((resolve, reject) => { proxy.server.once('error', reject); proxy.server.listen(PROXY_PORT, '127.0.0.1', resolve) })
  return async () => {
    await proxy.close()
    const directory = config.projects[0]?.outputDir ?? 'test-results'
    await mkdir(directory, { recursive: true })
    await writeFile(`${directory}/mock-cloud-egress.json`, JSON.stringify({ proxyForwardedRequests: 0,
      scope: 'This proxy only. Browser/API transport adoption is established by the separate isolation tests; arbitrary Node HTTP is outside this counter.',
      blockedHosts: Object.fromEntries(proxy.counts),
      rejectedSyntheticTargets: Object.fromEntries([...proxy.counts].filter(([host]) => SYNTHETIC_MOCK_HOSTS.includes(host))),
      rejectedKnownServiceTargets: Object.fromEntries([...proxy.counts].filter(([host]) => KNOWN_REJECTED_SERVICE_HOSTS.includes(host))),
      knownServiceClassification: 'Exact destination only; does not establish a browser-background initiator. All such attempts remain rejected.',
      coverageLimit: 'Blocked transport counts do not establish that every business request was mocked. Original business assertions and guard-first refusal tests remain required.',
      rejectedBrowserBackground: Object.fromEntries([...proxy.counts].filter(([host]) => backgroundHosts.has(host))),
      backgroundClassification: backgroundHosts.size ? { ...installed, applicationGuard: 'voiceoverMockTest: context fallback, WebSocket rejection, ServiceWorkers blocked; see per-test application request evidence' } : null,
      requestClasses: Object.fromEntries(proxy.requestClasses), peerSocketErrors: Object.fromEntries(proxy.socketErrors) }, null, 2))
    console.log(`Mock cloud transport evidence: ${JSON.stringify({ ...mockProxyLogSummary(proxy.counts, backgroundHosts), peerSocketErrors: Object.fromEntries(proxy.socketErrors) })}`)
    const unexpected = unexpectedMockProxyHosts(proxy.counts, backgroundHosts)
    if (unexpected.length) throw new Error(`Unmatched external requests were blocked by mock CI: ${unexpected.map(([host, count]) => `${host} (${count})`).join(', ')}; request classes: ${JSON.stringify(Object.fromEntries(proxy.requestClasses))}`)
    if (proxy.socketErrors.has('other')) throw new Error('Unexpected accepted-socket error in mock proxy.')
  }
}
