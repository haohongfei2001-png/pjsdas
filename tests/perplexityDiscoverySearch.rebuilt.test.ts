import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPerplexityDiscoverySearchProvider } from '../gateway/perplexityDiscoverySearch.js'

const request = { requestId: 'offline-request', query: { query: 'Explicit role and location', coverage: 'general_web' as const }, maxResults: 20 }
afterEach(() => vi.useRealTimers())
describe('rebuilt raw search adapter (synthetic credential and intercepted HTTP only)', () => {
  it.each([['web', 0.005], ['fast', 0.001]] as const)('uses explicit %s pricing ceiling and one exact official POST', async (searchType, ceiling) => {
    const fetchImpl = vi.fn(async () => Response.json({ id: 'provider-owned-response', results: [{ url: 'https://example.test/job', title: 'T'.repeat(800), snippet: 'S'.repeat(3000) }] }))
    const provider = createPerplexityDiscoverySearchProvider({ apiKey: 'synthetic-not-a-real-key', searchType, fetchImpl })
    expect(provider.maximumRequestCostUsd).toBe(ceiling); expect(provider.maximumResults).toBe(20)
    const result = await provider.search(request)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.perplexity.ai/search'); expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(JSON.parse(String(init.body))).toEqual({ query: request.query.query, search_type: searchType, max_results: 20, max_tokens: 4096, max_tokens_per_page: 512 })
    expect(result.providerRequestId).toBe('provider-owned-response'); expect(result.providerRequestId).not.toBe(request.requestId)
    expect(result.results[0].title).toHaveLength(500); expect(result.results[0].snippet).toHaveLength(2000)
  })
  it.each([[401, 'DISCOVERY_SEARCH_UNAUTHORIZED'], [403, 'DISCOVERY_SEARCH_UNAUTHORIZED'], [429, 'DISCOVERY_SEARCH_RATE_LIMITED'], [500, 'DISCOVERY_SEARCH_UNAVAILABLE']] as const)('never retries HTTP %s', async (status, code) => {
    const fetchImpl = vi.fn(async () => new Response('Synthetic error body', { status }))
    await expect(createPerplexityDiscoverySearchProvider({ apiKey: 'synthetic', fetchImpl }).search(request)).rejects.toMatchObject({ code })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it.each(['missing ID', '21 results', 'HTML', 'oversized declared body', 'oversized streamed body', 'redirect failure'])('rejects %s as evidence, with one request', async mode => {
    const fetchImpl = vi.fn(async () => {
      if (mode === 'redirect failure') throw new TypeError('Synthetic redirect refused')
      if (mode === 'HTML') return new Response('<html>not search</html>', { headers: { 'content-type': 'text/html' } })
      if (mode === 'oversized declared body') return new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '1000001' } })
      if (mode === 'oversized streamed body') return new Response(' '.repeat(1000001), { headers: { 'content-type': 'application/json' } })
      return Response.json(mode === 'missing ID' ? { results: [] } : { id: 'synthetic', results: Array.from({ length: 21 }, () => ({ url: 'https://example.test/1', title: 'Synthetic' })) })
    })
    await expect(createPerplexityDiscoverySearchProvider({ apiKey: 'synthetic', fetchImpl }).search(request)).rejects.toMatchObject({ code: 'DISCOVERY_SEARCH_INVALID_RESPONSE' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('aborts a stalled body at the fixed timeout without retry', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn(), fetchImpl = vi.fn(async () => new Response(new ReadableStream({ start() {}, cancel }), { headers: { 'content-type': 'application/json' } }))
    const result = createPerplexityDiscoverySearchProvider({ apiKey: 'synthetic', fetchImpl }).search(request)
    const rejected = expect(result).rejects.toMatchObject({ code: 'DISCOVERY_SEARCH_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(15000); await rejected
    expect(cancel).toHaveBeenCalledTimes(1); expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it.each(['', 'line\nbreak', 'line\rbreak'])('rejects an absent/invalid credential before HTTP', key => {
    const fetchImpl = vi.fn()
    expect(() => createPerplexityDiscoverySearchProvider({ apiKey: key, fetchImpl })).toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it('rejects unpriced search modes and out-of-bound result limits before HTTP', async () => {
    const fetchImpl = vi.fn()
    expect(() => createPerplexityDiscoverySearchProvider({ apiKey: 'synthetic', searchType: 'new-mode' as 'web', fetchImpl })).toThrow()
    const provider = createPerplexityDiscoverySearchProvider({ apiKey: 'synthetic', fetchImpl })
    for (const maxResults of [0, 21, 1.5]) await expect(provider.search({ ...request, maxResults })).rejects.toMatchObject({ code: 'DISCOVERY_SEARCH_INVALID_REQUEST' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
