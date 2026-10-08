import http from 'node:http'
import { expect, it } from 'vitest'
import { createRejectingMockProxy } from '../e2e/support/mockCloudProxySetup.mjs'

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
