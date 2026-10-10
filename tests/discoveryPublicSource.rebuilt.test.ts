// Newly rebuilt synthetic-transport tests; these do not reproduce lost historical pass evidence.
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchPinnedPublicDiscoverySource } from '../gateway/discoveryNetwork.js'
import { assertPublicDiscoverySourceUrl, boundedResponseText, fetchPublicDiscoverySource } from '../gateway/discoveryPublicSource.js'

const start = 'https://jobs.example.test/job/42'
const signal = () => new AbortController().signal
const allow = (url: URL) => url.origin === 'https://jobs.example.test'
function pages(values: Record<string, () => Response>) {
  return vi.fn(async (input: URL | RequestInfo) => {
    const url = input instanceof Request ? input.url : String(input)
    const response = values[url]
    if (!response) throw new Error(`No synthetic fixture for ${url}`)
    return response()
  }) as unknown as typeof fetch
}
afterEach(() => vi.useRealTimers())

describe('rebuilt public URL and read bounds', () => {
  it.each(['http://localhost/jobs', 'https://a.localhost/jobs', 'https://intranet/jobs', 'https://jobs.local/42', 'https://jobs.internal/42',
    'https://jobs.lan/42', 'http://127.1/', 'http://2130706433/', 'https://0x7f000001/', 'https://[::ffff:127.0.0.1]/',
    'https://[fe80::1]/', 'https://169.254.169.254/latest', 'https://192.168.1.1/', 'file:///etc/passwd', 'data:text/plain,no',
    'https://user:pass@jobs.example.test/42', 'https://jobs.example.test:8080/42', 'not-a-url', `https://jobs.example.test/${'a'.repeat(4096)}`])('rejects unsafe URL %s', url => {
    expect(() => assertPublicDiscoverySourceUrl(url)).toThrow()
  })
  it.each(['https://jobs.example.test/42', 'http://jobs.example.test/42', 'https://jobs.example.test:443/42', 'https://8.8.8.8/', 'https://[2606:4700:4700::1111]/'])('allows syntactically public URL %s, leaving DNS verification to transport', url => {
    expect(assertPublicDiscoverySourceUrl(url)).toBeInstanceOf(URL)
  })
  it('rejects declared oversized content without reading its body', async () => {
    const reader = vi.fn()
    const response = new Response('small', { headers: { 'content-length': '1000001' } })
    Object.defineProperty(response, 'body', { get: reader })
    await expect(boundedResponseText(response, signal())).rejects.toMatchObject({ code: 'DISCOVERY_SOURCE_TOO_LARGE' })
    expect(reader).not.toHaveBeenCalled()
  })
  it.each([undefined, '1', 'not-a-number'])('counts actual UTF-8 bytes even when content-length is %s', async length => {
    const response = new Response('界'.repeat(333334), { headers: length ? { 'content-length': length } : {} })
    await expect(boundedResponseText(response, signal())).rejects.toMatchObject({ code: 'DISCOVERY_SOURCE_TOO_LARGE' })
  })
  it('accepts the exact million-byte bound and decodes multibyte text across chunk boundaries', async () => {
    expect((await boundedResponseText(new Response('a'.repeat(1_000_000)), signal())).length).toBe(1_000_000)
    const bytes = new TextEncoder().encode('开始 AI 招聘')
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
      controller.close()
    } })
    expect(await boundedResponseText(new Response(stream), signal())).toBe('开始 AI 招聘')
  })
  it('cancels a chunked response as soon as the aggregate body exceeds the bound', async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(600_000)); controller.enqueue(new Uint8Array(400_001)) }, cancel })
    await expect(boundedResponseText(new Response(stream), signal())).rejects.toMatchObject({ code: 'DISCOVERY_SOURCE_TOO_LARGE' })
    expect(cancel).toHaveBeenCalledOnce()
  })
  it('cancels a stalled body read on abort', async () => {
    const controller = new AbortController(), cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}) }, cancel })
    const pending = boundedResponseText(new Response(stream), controller.signal)
    const assertion = expect(pending).rejects.toThrow('timed out')
    controller.abort()
    await assertion
    expect(cancel).toHaveBeenCalledOnce()
  })
})

describe('rebuilt redirect and response boundaries', () => {
  it('rechecks authority and repins public DNS for every redirect connection', async () => {
    const resolved: string[] = [], sockets: Array<{ host: string; address: string; servername?: string }> = [], checks: string[] = []
    const answers = ['93.184.216.34', '8.8.8.8', '1.1.1.1']
    const routes: Record<string, { status: number; location?: string }> = {
      [start]: { status: 302, location: '/job/42/step' },
      [`${start}/step`]: { status: 307, location: 'https://careers.example.test/post/42' },
      'https://careers.example.test/post/42': { status: 200 },
    }
    const request: NonNullable<Parameters<typeof fetchPinnedPublicDiscoverySource>[2]>['request'] = (url, options, callback) => {
      const req = new EventEmitter(), route = routes[url.href]!
      expect(route).toBeDefined()
      Object.assign(req, { end() {
        options.lookup!(url.hostname, {}, ((error: Error | null, address: string) => {
          expect(error).toBeNull()
          sockets.push({ host: url.hostname, address, servername: (options as { servername?: string }).servername })
          const stream = Readable.from([Buffer.from('source')])
          Object.assign(stream, { statusCode: route.status, headers: route.location ? { location: route.location } : { 'content-type': 'text/html' } })
          queueMicrotask(() => callback(stream as IncomingMessage))
        }) as never)
      } })
      return req as ReturnType<NonNullable<typeof request>>
    }
    const fetchImpl = ((input: URL | RequestInfo, init?: RequestInit) => fetchPinnedPublicDiscoverySource(new URL(String(input)), init ?? {}, {
      resolve: async host => { resolved.push(host); return [{ address: answers[resolved.length - 1]!, family: 4 }] }, request,
    })) as typeof fetch
    const result = await fetchPublicDiscoverySource(start, fetchImpl, url => { checks.push(url.href); return ['jobs.example.test', 'careers.example.test'].includes(url.hostname) })
    expect(checks).toEqual(Object.keys(routes))
    expect(resolved).toEqual(['jobs.example.test', 'jobs.example.test', 'careers.example.test'])
    expect(sockets).toEqual([
      { host: 'jobs.example.test', address: answers[0], servername: 'jobs.example.test' },
      { host: 'jobs.example.test', address: answers[1], servername: 'jobs.example.test' },
      { host: 'careers.example.test', address: answers[2], servername: 'careers.example.test' },
    ])
    expect(result).toMatchObject({ raw: 'source' }); expect(result.url.href).toBe('https://careers.example.test/post/42')
  })
  it('stops a DNS-rebinding redirect before creating a second socket', async () => {
    const resolve = vi.fn().mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]).mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }])
    let sockets = 0
    const request: NonNullable<Parameters<typeof fetchPinnedPublicDiscoverySource>[2]>['request'] = (_url, _options, callback) => {
      sockets++
      const req = new EventEmitter()
      Object.assign(req, { end() {
        const stream = Readable.from([])
        Object.assign(stream, { statusCode: 302, headers: { location: '/job/42/next' } })
        queueMicrotask(() => callback(stream as IncomingMessage))
      } })
      return req as ReturnType<NonNullable<typeof request>>
    }
    const fetchImpl = ((input: URL | RequestInfo, init?: RequestInit) => fetchPinnedPublicDiscoverySource(new URL(String(input)), init ?? {}, { resolve, request })) as typeof fetch
    await expect(fetchPublicDiscoverySource(start, fetchImpl, allow)).rejects.toMatchObject({ code: 'DISCOVERY_SOURCE_NON_PUBLIC' })
    expect(resolve).toHaveBeenCalledTimes(2); expect(sockets).toBe(1)
  })
  it.each(['http://127.0.0.1/private', 'https://169.254.169.254/latest', 'https://[::ffff:127.0.0.1]/', 'https://evil.example.test/post/42'])('does not fetch a redirect outside the approved public boundary: %s', location => {
    const fetchImpl = pages({ [start]: () => new Response(null, { status: 302, headers: { location } }) })
    return expect(fetchPublicDiscoverySource(start, fetchImpl, allow)).rejects.toThrow().then(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
  })
  it('inherits an SPA fragment when Location omits it and respects an explicitly replaced fragment', async () => {
    const initial = `${start}#/job/native-42`, next = `${start}/next#/job/native-42`, final = `${start}/final#/job/native-99`
    const fetchImpl = pages({
      [initial]: () => new Response(null, { status: 302, headers: { location: '/job/42/next' } }),
      [next]: () => new Response(null, { status: 302, headers: { location: '/job/42/final#/job/native-99' } }),
      [final]: () => new Response('detail'),
    })
    expect((await fetchPublicDiscoverySource(initial, fetchImpl, allow)).url.href).toBe(final)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })
  it('allows three redirects but rejects a fourth response without fetching its destination', async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input)), n = Number(url.searchParams.get('step') ?? 0)
      return new Response(null, { status: 302, headers: { location: `?step=${n + 1}` } })
    }) as typeof fetch
    await expect(fetchPublicDiscoverySource(start, fetchImpl, allow)).rejects.toMatchObject({ code: 'DISCOVERY_SOURCE_INVALID' })
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })
  it('rejects redirects without a destination', async () => {
    await expect(fetchPublicDiscoverySource(start, pages({ [start]: () => new Response(null, { status: 302 }) }), allow)).rejects.toMatchObject({ code: 'DISCOVERY_SOURCE_INVALID' })
  })
  it('checks the initial approved boundary before making a request', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    await expect(fetchPublicDiscoverySource(start, fetchImpl, () => false)).rejects.toMatchObject({ code: 'DISCOVERY_SOURCE_AUTHORITY_REQUIRED' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it.each([301, 302, 303, 307, 308])('does not redirect or change an explicit public-search POST on HTTP %s', async status => {
    const fetchImpl = pages({ [start]: () => new Response(null, { status, headers: { location: '/next' } }) })
    await expect(fetchPublicDiscoverySource(start, fetchImpl, allow, { method: 'POST', body: new URLSearchParams({ term: 'AI' }) })).rejects.toMatchObject({ code: 'DISCOVERY_SOURCE_INVALID' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('bounds encoded POST input before making a request', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    await expect(fetchPublicDiscoverySource(start, fetchImpl, allow, { method: 'POST', body: new URLSearchParams({ term: '界'.repeat(500) }) })).rejects.toMatchObject({ code: 'DISCOVERY_SOURCE_INVALID' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it.each([[404, false], [401, false], [429, true], [500, true], [503, true]])('reports HTTP %s with the correct retry classification', async (status, retryable) => {
    await expect(fetchPublicDiscoverySource(start, pages({ [start]: () => new Response('error', { status: status as number }) }), allow)).rejects.toMatchObject({ code: 'DISCOVERY_SOURCE_UNAVAILABLE', retryable })
  })
  it.each(['image/png', 'application/pdf', 'application/octet-stream'])('rejects non-text source content %s', async contentType => {
    await expect(fetchPublicDiscoverySource(start, pages({ [start]: () => new Response('not a verified document', { headers: { 'content-type': contentType } }) }), allow)).rejects.toMatchObject({ code: 'DISCOVERY_SOURCE_INVALID' })
  })
  it('aborts a pending transport at the eight-second budget and clears its timer', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn((_input, init) => new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))) as typeof fetch
    const pending = fetchPublicDiscoverySource(start, fetchImpl, allow)
    const assertion = expect(pending).rejects.toMatchObject({ code: 'DISCOVERY_SOURCE_UNAVAILABLE', retryable: true })
    await vi.advanceTimersByTimeAsync(8000)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })
  it('applies the same timeout to a never-ending source body', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn(), fetchImpl = pages({ [start]: () => new Response(new ReadableStream({ pull: () => new Promise(() => {}), cancel })) })
    const assertion = expect(fetchPublicDiscoverySource(start, fetchImpl, allow)).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(8000)
    await assertion
    expect(cancel).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0)
  })
  it('uses credential-free manual requests and aborts/clears completed response timers', async () => {
    vi.useFakeTimers()
    const fetchImpl = pages({ [start]: () => new Response('detail') })
    await fetchPublicDiscoverySource(start, fetchImpl, allow)
    const init = vi.mocked(fetchImpl).mock.calls[0]![1]!
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual' })
    expect(new Headers(init.headers).has('authorization')).toBe(false)
    expect(new Headers(init.headers).has('cookie')).toBe(false)
    expect(init.signal!.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0)
  })
})
