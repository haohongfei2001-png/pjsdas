// Newly rebuilt offline regressions after workspace recovery, not recovered test evidence.
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { IncomingMessage, RequestOptions } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchPinnedPublicDiscoverySource, isPublicDiscoveryAddress, pinnedDiscoveryLookup, resolvePublicDiscoveryAddresses } from '../gateway/discoveryNetwork.js'

type Address = { address: string; family: number }
const publicAddresses = [{ address: '93.184.216.34', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }]
type Transport = NonNullable<Parameters<typeof fetchPinnedPublicDiscoverySource>[2]>['request']
function fakeTransport(body = 'independent source', headers: IncomingMessage['headers'] = { 'content-type': 'text/plain' }, statusCode = 200) {
  const calls: Array<{ url: URL; options: RequestOptions; request: EventEmitter; payload: unknown; response?: Readable }> = []
  const request: Transport = (url, options, callback) => {
    const req = new EventEmitter()
    const call = { url: new URL(url), options, request: req, payload: undefined as unknown, response: undefined as Readable | undefined }
    calls.push(call)
    Object.assign(req, { end(payload: unknown) {
      call.payload = payload
      const stream = Readable.from([Buffer.from(body)])
      Object.assign(stream, { headers, statusCode })
      call.response = stream
      queueMicrotask(() => callback(stream as IncomingMessage))
    } })
    return req as ReturnType<NonNullable<Transport>>
  }
  return { calls, request }
}
function lookup(implementation: ReturnType<typeof pinnedDiscoveryLookup>, hostname: string, options: { family?: number; all?: boolean } = {}) {
  return new Promise<unknown>((resolve, reject) => implementation(hostname, options, ((error: Error | null, address: unknown, family: number) => {
    if (error) reject(error)
    else resolve(options.all ? address : { address, family })
  }) as never))
}
afterEach(() => vi.useRealTimers())

describe('rebuilt public address security', () => {
  it.each(['8.8.8.8', '93.184.216.34', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888'])('accepts public unicast %s', value => {
    expect(isPublicDiscoveryAddress(value)).toBe(true)
  })
  it.each(['0.0.0.0', '10.2.3.4', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.1.1', '172.31.255.255',
    '192.0.0.8', '192.0.2.1', '192.88.99.1', '192.168.1.1', '198.18.0.1', '198.19.255.254', '198.51.100.2', '203.0.113.5',
    '224.0.0.1', '240.0.0.1', '255.255.255.255', '168.63.129.16', '::', '::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8',
    '64:ff9b::a00:1', '100::1', 'fc00::1', 'fd12::1', 'fe80::1', 'fe80::1%eth0', 'ff02::1', '2001::1', '2001:db8::1',
    '2002:7f00:1::', '3ffe::1', '3fff::1', 'not-an-ip', '127.1', '2130706433'])('rejects private, mapped, local or special address %s', value => {
    expect(isPublicDiscoveryAddress(value)).toBe(false)
  })
  it.each([
    ['mixed public A and private A', [...publicAddresses, { address: '10.0.0.1', family: 4 }]],
    ['public A and mapped AAAA', [publicAddresses[0], { address: '::ffff:127.0.0.1', family: 6 }]],
    ['public AAAA and link-local A', [publicAddresses[1], { address: '169.254.169.254', family: 4 }]],
    ['wrong DNS family', [{ address: '8.8.8.8', family: 6 }]],
    ['empty response', []], ['unbounded response', Array.from({ length: 33 }, () => publicAddresses[0])],
    ['invalid family', [{ address: '8.8.8.8', family: 0 }]], ['missing address', [{ family: 4 }]],
  ])('rejects the complete DNS set: %s', async (_label, addresses) => {
    await expect(resolvePublicDiscoveryAddresses('jobs.example.test', new AbortController().signal,
      async () => addresses as Address[])).rejects.toMatchObject({ code: 'DISCOVERY_SOURCE_NON_PUBLIC' })
  })
  it('resolves every A/AAAA result once and freezes a copy against DNS result mutation', async () => {
    const answers = structuredClone(publicAddresses), resolve = vi.fn(async () => answers)
    const result = await resolvePublicDiscoveryAddresses('jobs.example.test', new AbortController().signal, resolve)
    answers[0]!.address = '127.0.0.1'
    expect(resolve).toHaveBeenCalledExactlyOnceWith('jobs.example.test')
    expect(result).toEqual(publicAddresses)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result[0])).toBe(true)
  })
  it('checks address literals without consulting DNS, including bracketed IPv6', async () => {
    const resolve = vi.fn(async () => publicAddresses)
    await expect(resolvePublicDiscoveryAddresses('[2606:4700:4700::1111]', new AbortController().signal, resolve)).resolves.toEqual([publicAddresses[1]])
    await expect(resolvePublicDiscoveryAddresses('127.0.0.1', new AbortController().signal, resolve)).rejects.toMatchObject({ code: 'DISCOVERY_SOURCE_NON_PUBLIC' })
    expect(resolve).not.toHaveBeenCalled()
  })
  it('bounds a stalled DNS resolution using the caller abort signal', async () => {
    const controller = new AbortController(), resolve = vi.fn(() => new Promise<Address[]>(() => {}))
    const result = resolvePublicDiscoveryAddresses('jobs.example.test', controller.signal, resolve)
    const assertion = expect(result).rejects.toMatchObject({ code: 'DISCOVERY_SOURCE_UNAVAILABLE', retryable: true })
    controller.abort()
    await assertion
    const alreadyAborted = vi.fn(async () => publicAddresses)
    await expect(resolvePublicDiscoveryAddresses('jobs.example.test', controller.signal, alreadyAborted)).rejects.toMatchObject({ code: 'DISCOVERY_SOURCE_UNAVAILABLE' })
    expect(alreadyAborted).not.toHaveBeenCalled()
  })
})

describe('rebuilt socket pinning and TLS identity', () => {
  it('pins all address families and rejects lookups for another host or unavailable family', async () => {
    const original = structuredClone(publicAddresses), pinned = pinnedDiscoveryLookup('jobs.example.test', original)
    original[0]!.address = '127.0.0.1'
    expect(await lookup(pinned, 'JOBS.EXAMPLE.TEST', { all: true })).toEqual(publicAddresses)
    expect(await lookup(pinned, 'jobs.example.test', { family: 6 })).toEqual(publicAddresses[1])
    const first = await lookup(pinned, 'jobs.example.test', { all: true }) as Address[]
    first[0]!.address = '127.0.0.1'
    expect(await lookup(pinned, 'jobs.example.test')).toEqual(publicAddresses[0])
    await expect(lookup(pinned, 'attacker.example.test')).rejects.toMatchObject({ code: 'ENOTFOUND' })
    await expect(lookup(pinnedDiscoveryLookup('jobs.example.test', [publicAddresses[0]!]), 'jobs.example.test', { family: 6 })).rejects.toMatchObject({ code: 'ENOTFOUND' })
  })
  it('keeps the public URL as Host/TLS identity, disables pooling, limits headers and pins the connection', async () => {
    const fake = fakeTransport('public posting', { 'content-type': 'text/html', 'set-cookie': ['session=do-not-forward'], 'x-source': 'literal' })
    const resolve = vi.fn(async () => publicAddresses), controller = new AbortController()
    const response = await fetchPinnedPublicDiscoverySource(new URL('https://jobs.example.test/posting/42'),
      { signal: controller.signal, headers: { accept: 'text/html', 'user-agent': 'offline-test' } }, { resolve, request: fake.request })
    const call = fake.calls[0]!
    expect(call.url.href).toBe('https://jobs.example.test/posting/42')
    expect(call.options).toMatchObject({ agent: false, method: 'GET', servername: 'jobs.example.test', maxHeaderSize: 16_384, signal: controller.signal })
    expect(call.options.headers).toEqual({ accept: 'text/html', 'user-agent': 'offline-test' })
    expect(call.options).not.toHaveProperty('rejectUnauthorized', false)
    expect(call.options).not.toHaveProperty('checkServerIdentity')
    expect(await lookup(call.options.lookup!, 'jobs.example.test', { all: true })).toEqual(publicAddresses)
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(await response.text()).toBe('public posting')
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('x-source')).toBe('literal')
  })
  it('cannot change the target after the caller URL was validated', async () => {
    const url = new URL('https://jobs.example.test/42'), fake = fakeTransport()
    let release!: (addresses: Address[]) => void
    const pending = fetchPinnedPublicDiscoverySource(url, {}, { resolve: () => new Promise(resolve => { release = resolve }), request: fake.request })
    url.hostname = '127.0.0.1'; url.pathname = '/secret'
    release(publicAddresses)
    await pending
    expect(fake.calls[0]!.url.href).toBe('https://jobs.example.test/42')
  })
  it.each(['authorization', 'cookie', 'host', 'x-forwarded-host', 'x-api-key', 'proxy-authorization'])('blocks credential/custom header %s before DNS or sockets', async name => {
    const resolve = vi.fn(async () => publicAddresses), fake = fakeTransport()
    await expect(fetchPinnedPublicDiscoverySource(new URL('https://jobs.example.test/42'), { headers: { [name]: 'sensitive' } }, { resolve, request: fake.request }))
      .rejects.toMatchObject({ code: 'DISCOVERY_SOURCE_INVALID' })
    expect(resolve).not.toHaveBeenCalled(); expect(fake.calls).toHaveLength(0)
  })
  it.each(['file:///etc/passwd', 'ftp://jobs.example.test/42', 'https://user:password@jobs.example.test/42', 'https://jobs.example.test:8443/42', `https://jobs.example.test/${'a'.repeat(4096)}`])('rejects unsupported transport target %s', async raw => {
    const fake = fakeTransport(), resolve = vi.fn(async () => publicAddresses)
    await expect(fetchPinnedPublicDiscoverySource(new URL(raw), {}, { resolve, request: fake.request })).rejects.toMatchObject({ code: 'DISCOVERY_SOURCE_INVALID' })
    expect(resolve).not.toHaveBeenCalled(); expect(fake.calls).toHaveLength(0)
  })
  it.each([{ method: 'PUT' }, { method: 'DELETE' }, { method: 'POST', body: 'opaque-unreviewed-body' }])('rejects unsupported request method/body %j', async init => {
    const fake = fakeTransport()
    await expect(fetchPinnedPublicDiscoverySource(new URL('https://jobs.example.test/42'), init, { resolve: async () => publicAddresses, request: fake.request }))
      .rejects.toMatchObject({ code: 'DISCOVERY_SOURCE_INVALID' })
    expect(fake.calls).toHaveLength(0)
  })
  it('encodes only explicit URLSearchParams POST bodies', async () => {
    const fake = fakeTransport()
    await fetchPinnedPublicDiscoverySource(new URL('https://jobs.example.test/search'), { method: 'POST', body: new URLSearchParams({ term: 'AI 产品' }) }, { resolve: async () => publicAddresses, request: fake.request })
    expect(fake.calls[0]!.options.method).toBe('POST')
    expect(fake.calls[0]!.payload).toBe('term=AI+%E4%BA%A7%E5%93%81')
  })
  it('does not start a socket for mixed DNS or an aborted resolution', async () => {
    const fake = fakeTransport()
    await expect(fetchPinnedPublicDiscoverySource(new URL('https://jobs.example.test/42'), {}, { resolve: async () => [...publicAddresses, { address: '::ffff:127.0.0.1', family: 6 }], request: fake.request }))
      .rejects.toMatchObject({ code: 'DISCOVERY_SOURCE_NON_PUBLIC' })
    expect(fake.calls).toHaveLength(0)
  })
  it.each(['CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'HPE_HEADER_OVERFLOW', 'ECONNRESET'])('propagates socket/TLS/header failure %s without accepting a source', async code => {
    const request: Transport = () => {
      const req = new EventEmitter()
      Object.assign(req, { end: () => queueMicrotask(() => req.emit('error', Object.assign(new Error(code), { code }))) })
      return req as ReturnType<NonNullable<Transport>>
    }
    await expect(fetchPinnedPublicDiscoverySource(new URL('https://jobs.example.test/42'), {}, { resolve: async () => publicAddresses, request }))
      .rejects.toMatchObject({ code })
  })
  it('destroys an attempted upgraded socket and rejects the source', async () => {
    const destroy = vi.fn(), request: Transport = () => {
      const req = new EventEmitter()
      Object.assign(req, { end: () => queueMicrotask(() => req.emit('upgrade', {}, { destroy })) })
      return req as ReturnType<NonNullable<Transport>>
    }
    await expect(fetchPinnedPublicDiscoverySource(new URL('https://jobs.example.test/42'), {}, { resolve: async () => publicAddresses, request })).rejects.toMatchObject({ code: 'DISCOVERY_SOURCE_INVALID' })
    expect(destroy).toHaveBeenCalledOnce()
  })
  it.each([204, 205, 304])('discards a forbidden body for status %s', async status => {
    const fake = fakeTransport('must not appear', {}, status)
    const response = await fetchPinnedPublicDiscoverySource(new URL('https://jobs.example.test/42'), {}, { resolve: async () => publicAddresses, request: fake.request })
    expect(response.status).toBe(status); expect(response.body).toBeNull(); expect(fake.calls[0]!.response!.destroyed).toBe(true)
  })
})
