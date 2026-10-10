import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import net from 'node:net'
import { createRequire } from 'node:module'
import { createDiscoveryGatewayTransport } from '../gateway/discoveryGatewayTransport.js'
import { createDiscoveryBatchSpendAdapters } from '../gateway/discoveryBatchSpend.js'
import { createDiscoveryBatchSpendHold, DISCOVERY_SPEND_TARIFF as T } from '../gateway/discoverySpendPolicy.js'
import type { DiscoveryGenerateTextInput } from '../gateway/discoveryAutomationWorker.js'
import { WorkspaceSourceError } from '../gateway/workspaceSource.js'

// Instrument only entry points and an existing async auth-header resolver.
// All request generation, routing, serialization, retry and error handling below
// still run the installed real AI SDK/Gateway. No synthetic key ever leaves fakeFetch.
const sdk = vi.hoisted(() => ({ generate: [] as any[], gateway: [] as any[], events: [] as string[],
  preparation: undefined as undefined | (() => Promise<void>), resolvedHeaders: [] as any[] }))
vi.mock('ai', async importOriginal => {
  const real = await importOriginal<typeof import('ai')>()
  return { ...real,
    generateText: (options: any) => { sdk.generate.push(options); return real.generateText(options) },
    createGateway: (options: any) => {
      sdk.gateway.push(options)
      const gateway = real.createGateway(options)
      return new Proxy(gateway, { apply(target, receiver, args) {
        const model = Reflect.apply(target, receiver, args) as any
        const original = model.config.headers
        model.config.headers = async () => {
          sdk.events.push('auth-start')
          await sdk.preparation?.()
          const headers = await original()
          sdk.resolvedHeaders.push(headers)
          sdk.events.push('auth-ready')
          return headers
        }
        return model
      } })
    },
  }
})

const KEY = 'synthetic-test-key-never-a-real-credential'
const URL = 'https://ai-gateway.vercel.sh/v4/ai/language-model'
const ACCOUNT = 'a84a823c-591e-4c86-a87b-65d8102b393b'
const SOURCE = 'synthetic:gateway-dispatch'
const START = '2026-10-08T10:00:00.000Z'
const END = '2026-10-09T10:00:00.000Z'
const scope = 'a'.repeat(64)
const INVALID = 'DISCOVERY_MODEL_POLICY_INVALID'
function request(): DiscoveryGenerateTextInput { return { model: T.model, system: 'Extract only public facts.', prompt: '职位 🌍', temperature: 0.1,
  maxOutputTokens: T.modelMaximumOutputTokens, maxRetries: 0 } }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
function successfulResponse(text = '[]') { return Response.json({ content: [{ type: 'text', text }],
  finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 2, text: 2, reasoning: 0 } }, warnings: [] }) }
function fake() { return vi.fn<typeof fetch>(async () => { sdk.events.push('fetch'); return successfulResponse() }) }
function transport(fetchImpl = fake()) { return { fetchImpl, call: createDiscoveryGatewayTransport({ fetchImpl, apiKey: KEY }) } }
function causeCodes(error: any): string[] {
  const codes: string[] = []
  const seen = new Set()
  while (error && !seen.has(error)) { seen.add(error); if (error.code) codes.push(error.code); error = error.cause }
  return codes
}
function captured(fetchImpl: ReturnType<typeof fake>) {
  const [url, init] = fetchImpl.mock.calls[0]
  return { url: String(url), init: init!, body: JSON.parse(init!.body as string), headers: new Headers(init!.headers) }
}
async function adapterFixture(fetchImpl: ReturnType<typeof fake>) {
  const state = { account: ACCOUNT, scope, now: new Date(START) }
  const policy = { version: 1 as const, application: 'todayaction' as const, approvalId: 'approval:synthetic-gateway',
    accountId: ACCOUNT, scopeFingerprint: scope, currency: 'USD' as const, maximumMicroUsd: 1_000_000,
    validFrom: START, expiresAt: END, tariffVersion: T.version }
  const hold = await createDiscoveryBatchSpendHold({ policy, accountId: ACCOUNT, scopeFingerprint: scope, sourceId: SOURCE,
    claimAttemptId: '77154231-e507-42fd-ae06-8a3fe092059b', queryCount: 1, now: state.now })
  const commandId = `discovery-search-claimed:${'b'.repeat(64)}`
  const authorize = vi.fn(async () => {
    sdk.events.push('authorize')
    if (state.account !== ACCOUNT) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Synthetic account revoked.', false)
    if (state.scope !== scope) throw new WorkspaceSourceError('DISCOVERY_SCOPE_CHANGED', 'Synthetic scope changed.', false)
  })
  const search = vi.fn(async () => { throw new Error('Search must never run in gateway tests.') })
  const adapters = await createDiscoveryBatchSpendAdapters({ hold, claim: { firstCommit: true, receipt: {
    status: 'COMMITTED', operation: 'checkpoint_discovery_search', commandId, receiptId: `command-receipt:${commandId}`, revision: 1,
    discoveryBudget: { version: 1, hold, admitted: true, retainedMicroUsd: hold.reservedMicroUsd } } },
    queries: [{ query: 'synthetic jobs', coverage: 'general_web' }], searchProvider: { id: T.searchProvider,
      maximumRequestCostUsd: T.searchRequestMicroUsd / 1_000_000, maximumResults: T.searchMaximumResults, search },
    modelTransport: createDiscoveryGatewayTransport({ fetchImpl, apiKey: KEY }), authorize, clock: () => state.now })
  const input = request()
  await adapters.reserveSpend({ requestId: crypto.randomUUID(), application: 'todayaction', provider: 'vercel-ai-gateway',
    accountId: ACCOUNT, sourceId: SOURCE, model: T.model, inputBytes: new TextEncoder().encode(input.system + input.prompt).length,
    maxOutputTokens: T.modelMaximumOutputTokens, maxSdkAttempts: 1 })
  sdk.events.length = 0
  return { adapters, input, state, authorize, search }
}

describe('real ai 7.0.99 Gateway dispatch with synthetic authentication and intercepted HTTP only', () => {
  let globalFetch: ReturnType<typeof vi.fn>, socketConnect: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    sdk.generate.length = 0; sdk.gateway.length = 0; sdk.events.length = 0; sdk.resolvedHeaders.length = 0; sdk.preparation = undefined
    globalFetch = vi.fn(() => { throw new Error('NETWORK FORBIDDEN: only explicitly injected fake fetch may run.') })
    vi.stubGlobal('fetch', globalFetch)
    socketConnect = vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(() => { throw new Error('NETWORK FORBIDDEN: socket connect.') })
    // Run command uses env -i. This extra guard also supports safe future reruns.
    for (const name of ['AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN', 'VERCEL_DEPLOYMENT_ID', 'VERCEL_PROJECT_ID', 'VERCEL_ENV', 'VERCEL_REGION']) vi.stubEnv(name, undefined)
  })
  afterEach(() => {
    try { expect(globalFetch).not.toHaveBeenCalled(); expect(socketConnect).not.toHaveBeenCalled() }
    finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs() }
  })

  it('runs the installed pinned SDK and dispatches exactly one fixed plain-text POST', async () => {
    const require = createRequire(import.meta.url)
    expect(require('ai/package.json').version).toBe('7.0.99')
    const { call, fetchImpl } = transport()
    const before = vi.fn(async () => { sdk.events.push('guard') })
    await expect(call(request(), before)).resolves.toEqual({ text: '[]' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(before).toHaveBeenCalledTimes(1)
    expect(sdk.events).toEqual(['auth-start', 'auth-ready', 'guard', 'fetch'])
    expect(sdk.generate).toHaveLength(1)
    const args = sdk.generate[0]
    expect(Object.keys(args).sort()).toEqual(['abortSignal', 'maxOutputTokens', 'maxRetries', 'model', 'prompt', 'providerOptions', 'system', 'temperature', 'toolChoice'].sort())
    expect(args).toMatchObject({ maxRetries: 0, maxOutputTokens: 5000, temperature: 0.1, toolChoice: 'none', providerOptions: { gateway: { only: ['openai'] } } })
    expect(args.model.modelId).toBe('openai/gpt-4.1-mini')
    expect(args.abortSignal).toBeInstanceOf(AbortSignal)
    expect(Object.keys(sdk.gateway[0]).sort()).toEqual(['apiKey', 'fetch'])
    expect(sdk.gateway[0].apiKey).toBe(KEY)
    const { url, init, body, headers } = captured(fetchImpl)
    expect(url).toBe(URL); expect(init.method).toBe('POST'); expect(init.redirect).toBe('error')
    expect(headers.get('authorization')).toBe(`Bearer ${KEY}`)
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('ai-language-model-id')).toBe('openai/gpt-4.1-mini')
    expect(headers.get('ai-language-model-specification-version')).toBe('4')
    expect(headers.get('ai-language-model-streaming')).toBe('false')
    expect(headers.get('ai-gateway-auth-method')).toBe('api-key')
    expect([...headers.keys()].filter(key => /byok|team|tags|tier|fallback|o11y/.test(key))).toEqual([])
    expect(body.maxOutputTokens).toBe(5000); expect(body.temperature).toBe(0.1)
    expect(body.providerOptions).toEqual({ gateway: { only: ['openai'] } })
    expect(body.prompt).toEqual([{ role: 'system', content: request().system }, { role: 'user', content: [{ type: 'text', text: request().prompt }] }])
    expect(body).not.toHaveProperty('tools')
    for (const key of ['serviceTier', 'tags', 'byok', 'models', 'fallbacks', 'maxRetries']) expect(body).not.toHaveProperty(key)
    expect(body.toolChoice).toEqual({ type: 'none' })
    expect(body.headers).toEqual({ 'user-agent': 'ai/7.0.99' })
    expect(Object.keys(body).sort()).toEqual(['maxOutputTokens', 'prompt', 'providerOptions', 'temperature', 'toolChoice', 'headers'].sort())
  })

  it.each([
    ['wrong model', { model: 'openai/gpt-4.1' }], ['non-OpenAI model', { model: 'anthropic/claude-sonnet-4' }],
    ['max retries', { maxRetries: 1 }], ['lower token limit', { maxOutputTokens: 4999 }], ['higher token limit', { maxOutputTokens: 5001 }],
    ['temperature', { temperature: 0.2 }], ['tools', { tools: {} }], ['tool choice', { toolChoice: 'auto' }],
    ['provider fallback', { providerOptions: { gateway: { models: ['openai/gpt-4.1'] } } }],
    ['BYOK', { providerOptions: { gateway: { byok: { openai: [{ apiKey: 'synthetic-other' }] } } } }],
    ['service tier', { serviceTier: 'priority' }], ['tags', { tags: ['paid-addon'] }], ['headers', { headers: { 'x-test': 'x' } }],
    ['messages', { messages: [] }], ['structured output', { output: {} }], ['stop sequence', { stopSequences: ['x'] }],
    ['numeric prompt', { prompt: 5 }], ['missing system', { system: undefined }], ['missing prompt', { prompt: undefined }],
  ])('rejects %s before SDK preparation, guard or outbound fetch', async (_label, change) => {
    const { call, fetchImpl } = transport(), before = vi.fn(async () => {})
    await expect(call({ ...request(), ...change } as any, before)).rejects.toMatchObject({ code: INVALID })
    expect(before).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled(); expect(sdk.generate).toHaveLength(0); expect(sdk.gateway).toHaveLength(0)
  })

  it.each([null, undefined, [], 'string', 12].map(value => ({ value })))('rejects malformed request $value without SDK or HTTP', async ({ value }) => {
    const { call, fetchImpl } = transport(), before = vi.fn(async () => {})
    await expect(call(value as any, before)).rejects.toMatchObject({ code: INVALID })
    expect(before).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled(); expect(sdk.generate).toHaveLength(0)
  })

  it.each(['ascii', 'utf8', 'combined'])('rejects input bytes over limit (%s), with zero fetch', async kind => {
    const { call, fetchImpl } = transport(), before = vi.fn(async () => {})
    const input = { ...request(), system: '', prompt: 'x'.repeat(T.modelMaximumInputBytes + 1) }
    if (kind === 'utf8') input.prompt = '🌍'.repeat(T.modelMaximumInputBytes / 4) + 'x'
    if (kind === 'combined') { input.system = 'x'.repeat(T.modelMaximumInputBytes / 2); input.prompt = 'x'.repeat(T.modelMaximumInputBytes / 2 + 1) }
    await expect(call(input, before)).rejects.toMatchObject({ code: INVALID })
    expect(fetchImpl).not.toHaveBeenCalled(); expect(before).not.toHaveBeenCalled(); expect(sdk.generate).toHaveLength(0)
  })

  it('allows exactly the UTF-8 byte limit and preserves the text', async () => {
    const { call, fetchImpl } = transport(), input = { ...request(), system: '', prompt: '🌍'.repeat(T.modelMaximumInputBytes / 4) }
    await call(input, async () => {})
    const body = captured(fetchImpl).body
    expect(body.prompt.find((message: any) => message.role === 'user').content[0].text).toBe(input.prompt)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('snapshots request primitives before auth preparation yields', async () => {
    const entered = deferred(), release = deferred()
    sdk.preparation = async () => { entered.resolve(); await release.promise }
    const { call, fetchImpl } = transport(), input = request(), original = structuredClone(input)
    const pending = call(input, async () => {})
    await entered.promise
    Object.assign(input, { model: 'foreign/model', system: 'replaced', prompt: 'changed', maxRetries: 99, maxOutputTokens: 999999 })
    release.resolve(); await pending
    const { body, headers } = captured(fetchImpl)
    expect(headers.get('ai-language-model-id')).toBe(original.model)
    expect(body.prompt[0].content).toBe(original.system); expect(body.prompt[1].content[0].text).toBe(original.prompt)
    expect(body.maxOutputTokens).toBe(5000); expect(sdk.generate[0].maxRetries).toBe(0)
  })

  it.each(['account', 'scope', 'expiry'])('rechecks %s after delayed real SDK auth preparation and burns the adapter slot', async kind => {
    const entered = deferred(), release = deferred(), fetchImpl = fake(), f = await adapterFixture(fetchImpl)
    sdk.preparation = async () => { entered.resolve(); await release.promise }
    const pending = f.adapters.generateTextImpl(f.input)
    const outcome = pending.then(value => ({ value }), error => ({ error }))
    await entered.promise
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(sdk.resolvedHeaders).toHaveLength(0)
    if (kind === 'account') f.state.account = 'revoked-account'
    if (kind === 'scope') f.state.scope = 'c'.repeat(64)
    if (kind === 'expiry') f.state.now = new Date(END)
    release.resolve()
    const result = await outcome
    expect(result).toHaveProperty('error')
    const code = kind === 'account' ? 'AUTH_FORBIDDEN' : kind === 'scope' ? 'DISCOVERY_SCOPE_CHANGED' : 'DISCOVERY_BUDGET_WINDOW_CLOSED'
    expect(causeCodes((result as any).error)).toContain(code)
    expect(sdk.events).toEqual(['authorize', 'auth-start', 'auth-ready', 'authorize'])
    expect(sdk.resolvedHeaders).toHaveLength(1)
    expect(fetchImpl).not.toHaveBeenCalled(); expect(f.search).not.toHaveBeenCalled()
    f.state.account = ACCOUNT; f.state.scope = scope; f.state.now = new Date(START)
    await expect(f.adapters.generateTextImpl(f.input)).rejects.toMatchObject({ code: 'DISCOVERY_BUDGET_RESERVATION_INVALID' })
    expect(fetchImpl).not.toHaveBeenCalled(); expect(sdk.generate).toHaveLength(1)
  })

  it('awaits the final guard and does not fetch when it rejects asynchronously', async () => {
    const entered = deferred(), release = deferred(), { call, fetchImpl } = transport()
    const before = vi.fn(async () => { sdk.events.push('guard-start'); entered.resolve(); await release.promise; throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Synthetic final denial.', false) })
    const pending = call(request(), before).then(value => ({ value }), error => ({ error }))
    await entered.promise
    expect(sdk.events).toEqual(['auth-start', 'auth-ready', 'guard-start']); expect(fetchImpl).not.toHaveBeenCalled()
    release.resolve()
    expect(causeCodes((await pending as any).error)).toContain('AUTH_FORBIDDEN')
    expect(before).toHaveBeenCalledTimes(1); expect(fetchImpl).not.toHaveBeenCalled(); expect(sdk.generate).toHaveLength(1)
  })

  it.each(['403', '429', '500', 'lost-response', 'malformed-response'])('sends one application HTTP at most after %s and refuses reuse of the admitted model slot', async kind => {
    const fetchImpl = fake(), f = await adapterFixture(fetchImpl)
    fetchImpl.mockImplementation(async () => {
      sdk.events.push('fetch')
      if (kind === 'lost-response') throw new TypeError('Synthetic response lost after request accepted.')
      if (kind === 'malformed-response') return new Response('{invalid-json', { status: 200, headers: { 'content-type': 'application/json' } })
      return Response.json({ error: { message: `Synthetic HTTP ${kind}`, type: 'synthetic_error' } }, { status: Number(kind) })
    })
    await expect(f.adapters.generateTextImpl(f.input)).rejects.toBeInstanceOf(Error)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(sdk.events).toEqual(['authorize', 'auth-start', 'auth-ready', 'authorize', 'fetch'])
    await expect(f.adapters.generateTextImpl(f.input)).rejects.toMatchObject({ code: 'DISCOVERY_BUDGET_RESERVATION_INVALID' })
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(sdk.generate).toHaveLength(1); expect(f.search).not.toHaveBeenCalled()
  })

  it.each(['wrong-host', 'wrong-path', 'GET', 'missing-method'])('blocks SDK fetch wrapper %s before authority or injected HTTP', async mode => {
    const entered = deferred(), release = deferred(), { call, fetchImpl } = transport(), before = vi.fn(async () => {})
    sdk.preparation = async () => { entered.resolve(); await release.promise }
    const pending = call(request(), before)
    await entered.promise
    const url = mode === 'wrong-host' ? 'https://other.invalid/v4/ai/language-model' : mode === 'wrong-path' ? 'https://ai-gateway.vercel.sh/v4/ai/models' : URL
    const init = mode === 'missing-method' ? {} : { method: mode === 'GET' ? 'GET' : 'POST' }
    await expect(sdk.gateway[0].fetch(url, init)).rejects.toMatchObject({ code: INVALID })
    expect(before).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled()
    release.resolve(); await pending
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('consumes the concrete HTTP slot before a pending final guard and rejects a second SDK dispatch', async () => {
    const entered = deferred(), release = deferred(), { call, fetchImpl } = transport()
    const before = vi.fn(async () => { entered.resolve(); await release.promise })
    const pending = call(request(), before)
    await entered.promise
    await expect(sdk.gateway[0].fetch(URL, { method: 'POST' })).rejects.toMatchObject({ code: INVALID })
    expect(fetchImpl).not.toHaveBeenCalled(); expect(before).toHaveBeenCalledTimes(1)
    release.resolve(); await pending
    await expect(sdk.gateway[0].fetch(URL, { method: 'POST' })).rejects.toMatchObject({ code: INVALID })
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(before).toHaveBeenCalledTimes(1)
  })

  it('does not dispatch or release the model slot after asynchronous auth preparation fails', async () => {
    const fetchImpl = fake(), f = await adapterFixture(fetchImpl)
    sdk.preparation = async () => { await Promise.resolve(); throw new Error('Synthetic authentication preparation failed.') }
    await expect(f.adapters.generateTextImpl(f.input)).rejects.toThrow('Synthetic authentication preparation failed.')
    expect(sdk.events).toEqual(['authorize', 'auth-start'])
    expect(fetchImpl).not.toHaveBeenCalled(); expect(sdk.resolvedHeaders).toHaveLength(0)
    sdk.preparation = undefined
    await expect(f.adapters.generateTextImpl(f.input)).rejects.toMatchObject({ code: 'DISCOVERY_BUDGET_RESERVATION_INVALID' })
    expect(fetchImpl).not.toHaveBeenCalled(); expect(sdk.generate).toHaveLength(1)
  })

  it('does not start a second inference when the synthetic upstream returns a tool call', async () => {
    const fetchImpl = fake(), { call } = transport(fetchImpl)
    fetchImpl.mockResolvedValue(Response.json({ content: [{ type: 'tool-call', toolCallId: 'synthetic-call', toolName: 'unconfigured-paid-tool', input: '{}' }],
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } }, warnings: [] }))
    await call(request(), async () => {}).catch(() => {})
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(sdk.generate).toHaveLength(1)
    expect(captured(fetchImpl).body).not.toHaveProperty('tools')
    expect(captured(fetchImpl).body.toolChoice).toEqual({ type: 'none' })
  })
})
