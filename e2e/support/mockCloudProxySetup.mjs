import http from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'

export const PROXY_PORT = 18879
export const MOCK_PROXY_ORIGIN = `http://127.0.0.1:${PROXY_PORT}`
export const MOCK_PROXY = { server: MOCK_PROXY_ORIGIN, bypass: '127.0.0.1,localhost,[::1]' }
const PROBE_HOST = 'todayaction-egress-probe.invalid'
/** This process-local test proxy never forwards, resolves or connects to a
 * destination. Keep only host/count diagnostics, never paths or headers. */
export function createRejectingMockProxy() {
  const counts = new Map()
  const record = (target, tunnel = false) => {
    let host = 'invalid-target'
    try { host = new URL(tunnel ? `https://${target}` : target).hostname } catch {}
    counts.set(host, (counts.get(host) ?? 0) + 1)
  }
  const server = http.createServer((request, response) => {
    if (request.url === '/__mock_proxy_stats' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(Object.fromEntries(counts))); return
    }
    if (request.url === '/__mock_proxy_page' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><title>Local isolation probe</title>'); return
    }
    if (request.url === '/__mock_proxy_worker.js' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/javascript', 'service-worker-allowed': '/' })
      response.end(`self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));self.addEventListener('message',event=>{event.waitUntil(fetch('https://${PROBE_HOST}/worker').catch(()=>{}).then(()=>event.source.postMessage('blocked-attempt-complete')))});`); return
    }
    if (request.url === '/__mock_proxy_redirect' && request.method === 'GET') {
      response.writeHead(302, { location: `https://${PROBE_HOST}/redirect` }); response.end(); return
    }
    record(request.url ?? '')
    response.writeHead(502, { 'content-type': 'text/plain', connection: 'close' }); response.end('MOCK_EXTERNAL_REQUEST_BLOCKED')
  })
  const sockets = new Set()
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  for (const event of ['connect', 'upgrade']) server.on(event, (request, socket) => {
    record(request.url ?? '', event === 'connect')
    socket.end('HTTP/1.1 502 Mock external request blocked\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  })
  return { server, counts, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) } }
}

export default async function setup(config) {
  if (process.env.TA_MOCK_FIXTURE_TARGET === 'live' || process.env.VITE_PJSDAS_CLOUD_MODE === 'live') throw new Error('Mock cloud isolation cannot use an explicit live target.')
  for (const project of config.projects) {
    const target = new URL(project.use.baseURL ?? 'http://127.0.0.1')
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) throw new Error('Mock cloud isolation requires a loopback application target.')
  }
  const proxy = createRejectingMockProxy()
  await new Promise((resolve, reject) => { proxy.server.once('error', reject); proxy.server.listen(PROXY_PORT, '127.0.0.1', resolve) })
  return async () => {
    await proxy.close()
    const directory = config.projects[0]?.outputDir ?? 'test-results'
    await mkdir(directory, { recursive: true })
    await writeFile(`${directory}/mock-cloud-egress.json`, JSON.stringify({ proxyForwardedRequests: 0,
      scope: 'This proxy only. Browser/API transport adoption is established by the separate isolation tests; arbitrary Node HTTP is outside this counter.',
      blockedHosts: Object.fromEntries(proxy.counts) }, null, 2))
    const unexpected = [...proxy.counts].filter(([host]) => host !== PROBE_HOST)
    if (unexpected.length) throw new Error(`Unmatched external requests were blocked by mock CI: ${unexpected.map(([host, count]) => `${host} (${count})`).join(', ')}`)
  }
}
