import http from 'node:http'
import net from 'node:net'
import { expect, it, vi } from 'vitest'
import { createRejectingMockProxy, mockProxyLogSummary, unexpectedMockProxyHosts } from '../e2e/support/mockCloudProxySetup.mjs'

it('survives a real peer reset after rejecting CONNECT and retains the blocked attempt', async () => {
  const proxy = createRejectingMockProxy()
  await new Promise<void>(resolve => proxy.server.listen(0, '127.0.0.1', resolve))
  const tunnel = new Promise<net.Socket>(resolve => proxy.server.once('connect', (_request, socket) => resolve(socket)))
  const client = net.createConnection(proxy.server.address().port, '127.0.0.1')
  client.on('error', () => {})
  try {
    const response = new Promise<Buffer>(resolve => client.once('data', resolve))
    client.write('CONNECT todayaction-egress-probe.invalid:443 HTTP/1.1\r\nHost: todayaction-egress-probe.invalid:443\r\n\r\n')
    const socket = await tunnel
    const closed = new Promise<void>(resolve => socket.once('close', resolve))
    expect((await response).toString()).toContain('502 Mock external request blocked')
    client.resetAndDestroy()
    await closed
    expect(proxy.counts.get('todayaction-egress-probe.invalid')).toBe(1)
    expect(proxy.socketErrors.get('ECONNRESET')).toBe(1)
    expect(mockProxyLogSummary(proxy.counts, new Set()).forwardedRequests).toBe(0)
  } finally { client.destroy(); await proxy.close() }
})

it('success-log evidence counts every attempt while only naming fixed browser hosts', () => {
  const counts = new Map([['accounts.google.com', 3], ['todayaction-egress-probe.invalid', 2], ['synthetic-private-query.invalid', 4]])
  const result = mockProxyLogSummary(counts, new Set(['accounts.google.com', 'synthetic-private-query.invalid']))
  expect(result).toEqual({ scope: 'rejecting proxy only', forwardedRequests: 0, blockedAttempts: 9, deliberateProbeAttempts: 2,
    browserBackground: { 'accounts.google.com': 3 }, rejectedSyntheticTargets: {}, otherBlockedAttempts: 4 })
  expect(JSON.stringify(result)).not.toContain('synthetic-private-query')
  expect(mockProxyLogSummary(counts, new Set())).toMatchObject({ blockedAttempts: 9, browserBackground: {}, otherBlockedAttempts: 7 })
})

it('keeps all unknown requests rejected while distinguishing exact local favicon diagnostics without paths or headers', async () => {
  const proxy = createRejectingMockProxy()
  await new Promise<void>(resolve => proxy.server.listen(0, '127.0.0.1', resolve))
  const port = proxy.server.address().port
  const get = (path: string, authority = `127.0.0.1:${port}`) => new Promise<number>((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path, headers: { host: authority, authorization: 'synthetic-do-not-record' } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode!))
    }).on('error', reject)
  })
  try {
    expect(await get('/favicon.ico')).toBe(502)
    expect(await get('/private-path?private-value')).toBe(502)
    expect(await get('/favicon.ico', 'synthetic-external.invalid')).toBe(502)
    expect(proxy.counts.get('invalid-target')).toBe(3)
    expect(Object.fromEntries(proxy.requestClasses)).toEqual({
      'http:origin:loopback:local-favicon': 1,
      'http:origin:loopback:other': 1,
      'http:origin:other:other': 1,
    })
    const diagnostic = JSON.stringify([...proxy.counts, ...proxy.requestClasses])
    expect(diagnostic).not.toMatch(/private-path|private-value|synthetic-do-not-record|synthetic-external/)
  } finally { await proxy.close() }
})

import { voiceOverBackgroundDiagnostics } from '../e2e/support/mockCloudProxySetup.mjs'
it('classifies only the pinned headed VoiceOver context and never business or unknown hosts', () => {
  const config = { configFile: '/synthetic/playwright.voiceover.config.mts', projects: [{ name: 'chromium-voiceover', use: { headless: false, serviceWorkers: 'block', launchOptions: {} } }] }
  const installed = { playwright: '1.63.0', chromium: '153.0.8010.12' }
  expect([...voiceOverBackgroundDiagnostics(config, installed)]).toEqual(['clients2.google.com', 'accounts.google.com', 'www.google.com', 'update.googleapis.com', 'android.clients.google.com', 'content-autofill.googleapis.com'])
  for (const host of ['google.com', 'evil.google.com', 'todayaction-auth.invalid', 'todayaction-backend.invalid', 'pjsdas-remote-alpha.vercel.app', 'yyrzwpoxlxpafdlbkdtg.supabase.co', 'unknown.invalid']) expect(voiceOverBackgroundDiagnostics(config, installed).has(host)).toBe(false)
  for (const change of [
    { configFile: '/synthetic/playwright.config.mts' },
    { projects: [{ name: 'chromium', use: { headless: false, serviceWorkers: 'block' } }] },
    { projects: [{ name: 'chromium-voiceover', use: { headless: true, serviceWorkers: 'block' } }] },
    { projects: [{ name: 'chromium-voiceover', use: { headless: false, serviceWorkers: 'allow' } }] },
    { projects: [{ name: 'chromium-voiceover', use: { headless: false, serviceWorkers: 'block', channel: 'chrome' } }] },
    { projects: [{ name: 'chromium-voiceover', use: { headless: false, serviceWorkers: 'block', browserName: 'firefox' } }] },
    { projects: [{ name: 'chromium-voiceover', use: { headless: false, serviceWorkers: 'block', connectOptions: { wsEndpoint: 'ws://synthetic.invalid' } } }] },
    { projects: [{ name: 'chromium-voiceover', use: { headless: false, serviceWorkers: 'block', launchOptions: { channel: 'chrome' } } }] },
    { projects: [{ name: 'chromium-voiceover', use: { headless: false, serviceWorkers: 'block', launchOptions: { executablePath: '/other/chrome' } } }] },
  ]) expect(voiceOverBackgroundDiagnostics({ ...config, ...change }, installed).size).toBe(0)
  expect(voiceOverBackgroundDiagnostics(config, { ...installed, playwright: 'other' }).size).toBe(0)
  expect(voiceOverBackgroundDiagnostics(config, { ...installed, chromium: '154.0.0.0' }).size).toBe(0)
  vi.stubEnv('PW_TEST_CONNECT_WS_ENDPOINT', 'ws://synthetic.invalid')
  try { expect(voiceOverBackgroundDiagnostics(config, installed).size).toBe(0) } finally { vi.unstubAllEnvs() }
})


it('keeps exact synthetic targets refused and counted without treating their transport attempts as proof of mock coverage', async () => {
  const proxy = createRejectingMockProxy()
  await new Promise<void>(resolve => proxy.server.listen(0, '127.0.0.1', resolve))
  const port = proxy.server.address().port
  const blocked = (host: string) => new Promise<number>((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: `https://${host}/synthetic-request` }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode!))
    }).on('error', reject)
  })
  const synthetic = ['todayaction-backend.invalid', 'todayaction-auth.invalid', 'apply.example.test']
  const unexpected = ['unknown.invalid', 'other.example.test', 'todayaction-backend.invalid.evil.test', 'pjsdas-remote-alpha.vercel.app', 'yyrzwpoxlxpafdlbkdtg.supabase.co']
  try {
    for (const host of [...synthetic, ...unexpected]) expect(await blocked(host)).toBe(502)
    expect([...proxy.counts.keys()]).toEqual([...synthetic, ...unexpected])
    expect(unexpectedMockProxyHosts(proxy.counts, new Set())).toEqual(unexpected.map(host => [host, 1]))
    expect(mockProxyLogSummary(proxy.counts, new Set())).toMatchObject({ forwardedRequests: 0, blockedAttempts: 8,
      rejectedSyntheticTargets: Object.fromEntries(synthetic.map(host => [host, 1])), otherBlockedAttempts: 5 })
  } finally { await proxy.close() }
})
