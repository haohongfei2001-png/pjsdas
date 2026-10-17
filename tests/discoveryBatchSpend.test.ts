import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDiscoveryBatchSpendAdapters, verifyDiscoveryBudgetAdmission,
  type DiscoveryModelTransport,
} from '../gateway/discoveryBatchSpend.js'
import { createDiscoveryBatchSpendHold, DISCOVERY_SPEND_TARIFF as T, type DiscoverySpendPolicy } from '../gateway/discoverySpendPolicy.js'
import { hashMutationPayload } from '../gateway/mutationKernel.js'
import { WorkspaceSourceError } from '../gateway/workspaceSource.js'
import type { DiscoveryGenerateTextInput } from '../gateway/discoveryAutomationWorker.js'
import type { DiscoverySpendRequest } from '../gateway/discoveryBudgetGuard.js'
import type { DiscoverySearchProvider, DiscoverySearchRequest, DiscoverySearchReservationRequest } from '../gateway/discoverySearchExecution.js'
import type { DiscoveryWebQuery } from '../src/discoveryQueryPlan.js'

// Synthetic adapter contract tests: no provider, SDK, SQL or funding boundary is
// exercised. Real schemas and SHA-256 run; only dispatch and authority are fakes.
const ACCOUNT = 'a84a823c-591e-4c86-a87b-65d8102b393b'
const OTHER_ACCOUNT = '0c5101d9-5cf2-42b5-944e-6b756a327a58'
const CLAIM = '77154231-e507-42fd-ae06-8a3fe092059b'
const OTHER_CLAIM = '8f9d8b07-434d-4d46-8837-641a96c5e172'
const SOURCE = 'monitor:synthetic-campus'
const START = '2026-10-08T10:00:00.000Z'
const END = '2026-10-09T10:00:00.000Z'
const INVALID = 'DISCOVERY_BUDGET_RESERVATION_INVALID'
type AdapterInput = Parameters<typeof createDiscoveryBatchSpendAdapters>[0]
type Admission = { version: 1; hold: AdapterInput['hold']; admitted: boolean; retainedMicroUsd: number }

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

// Pause a genuine digest, rather than mocking hashes or guessing microtask order.
function pauseNextDigest() {
  const entered = deferred(), released = deferred()
  const original = crypto.subtle.digest.bind(crypto.subtle)
  vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, data) => {
    entered.resolve()
    await released.promise
    return original(algorithm, data)
  })
  return { entered: entered.promise, release: released.resolve }
}

function plannedQueries(count: number): DiscoveryWebQuery[] {
  return Array.from({ length: count }, (_, index) => index % 2
    ? { query: `graduate role ${index}`, coverage: 'employer_sites', domains: ['example.com'] }
    : { query: `graduate role ${index}`, coverage: 'general_web' })
}

async function fixture(count = 2) {
  const queries = plannedQueries(count)
  const scopeFingerprint = await hashMutationPayload('discovery_scope', { accountId: ACCOUNT, sourceId: SOURCE })
  const policy: DiscoverySpendPolicy = {
    version: 1, application: 'todayaction', approvalId: 'approval:synthetic-20261008', accountId: ACCOUNT,
    scopeFingerprint, currency: 'USD', maximumMicroUsd: 1_000_000, validFrom: START, expiresAt: END,
    tariffVersion: T.version,
  }
  const hold = structuredClone(await createDiscoveryBatchSpendHold({ policy, accountId: ACCOUNT, scopeFingerprint,
    sourceId: SOURCE, claimAttemptId: CLAIM, queryCount: count, now: new Date(START) }))
  const batchRequest = { contractVersion: 2, sourceId: SOURCE, scopeFingerprint,
    planFingerprint: await hashMutationPayload('discovery_scope_plan', queries),
    cycleId: await hashMutationPayload('discovery_scope_cycle', { date: START }),
    index: 0, count: 1, queryStart: 0, queryCount: count, totalQueryCount: count, queries }
  const commandId = `discovery-search-claimed:${await hashMutationPayload('discovery_scope_checkpoint', batchRequest)}`
  const receipt: Record<string, unknown> = { status: 'COMMITTED', operation: 'checkpoint_discovery_search',
    commandId, receiptId: `command-receipt:${commandId}`, revision: 7,
    discoveryBudget: { version: 1, hold: structuredClone(hold), admitted: true, retainedMicroUsd: hold.reservedMicroUsd } }
  const search = vi.fn<DiscoverySearchProvider['search']>().mockResolvedValue({ providerRequestId: 'synthetic-search', results: [] })
  const modelDispatch = vi.fn<(value: DiscoveryGenerateTextInput) => Promise<{ text: string }>>().mockResolvedValue({ text: '[]' })
  // A fake credential/preparation phase must call the supplied guard at its fake
  // outbound boundary. This does not prove a concrete SDK transport does so.
  const modelTransport = vi.fn<DiscoveryModelTransport>(async (value, beforeRequest) => {
    await beforeRequest()
    return modelDispatch(value)
  })
  const state = { now: new Date(START), accountId: ACCOUNT, scopeFingerprint }
  const authorize = vi.fn(async () => {
    if (state.accountId !== ACCOUNT) throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Synthetic account revoked.', false)
    if (state.scopeFingerprint !== scopeFingerprint) throw new WorkspaceSourceError('DISCOVERY_SCOPE_CHANGED', 'Synthetic scope revoked.', false)
  })
  const provider: DiscoverySearchProvider = { id: T.searchProvider, maximumRequestCostUsd: T.searchRequestMicroUsd / 1_000_000,
    maximumResults: T.searchMaximumResults, search }
  const input: AdapterInput = { hold, claim: { firstCommit: true, receipt }, queries, searchProvider: provider,
    modelTransport, authorize, clock: () => state.now }
  return { input, hold, receipt, state, provider, search, modelTransport, modelDispatch, authorize,
    admission: receipt.discoveryBudget as Admission }
}

async function searchPair(query: DiscoveryWebQuery, requestId = crypto.randomUUID()) {
  const request: DiscoverySearchRequest = { requestId, query: structuredClone(query), maxResults: T.searchMaximumResults }
  const reservation: DiscoverySearchReservationRequest = { requestId, application: 'todayaction', provider: T.searchProvider,
    accountId: ACCOUNT, sourceId: SOURCE, requestFingerprint: await hashMutationPayload('discovery_search', request),
    maxHttpRequests: 1, maximumCostUsd: T.searchRequestMicroUsd / 1_000_000 }
  return { request, reservation }
}

function modelPair() {
  const request: DiscoveryGenerateTextInput = { model: T.model, system: 'Extract facts. ', prompt: '职位 🌍', temperature: 0.1,
    maxOutputTokens: T.modelMaximumOutputTokens, maxRetries: 0 }
  const reservation: DiscoverySpendRequest = { requestId: crypto.randomUUID(), application: 'todayaction', provider: 'vercel-ai-gateway',
    accountId: ACCOUNT, sourceId: SOURCE, model: T.model, inputBytes: new TextEncoder().encode(request.system + request.prompt).byteLength,
    maxOutputTokens: T.modelMaximumOutputTokens, maxSdkAttempts: 1 }
  return { request, reservation }
}

function noDispatch(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.search).not.toHaveBeenCalled()
  expect(f.modelTransport).not.toHaveBeenCalled()
  expect(f.modelDispatch).not.toHaveBeenCalled()
}

describe('per-claim discovery budget adapters, synthetic boundaries only', () => {
  let fetchTrap: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchTrap = vi.fn(() => { throw new Error('Synthetic adapter tests must never access the network.') })
    vi.stubGlobal('fetch', fetchTrap)
  })
  afterEach(() => {
    try { expect(fetchTrap).not.toHaveBeenCalled() }
    finally { vi.restoreAllMocks(); vi.unstubAllGlobals() }
  })

  it('verifies an exact original admitted hold and returns immutable admission metadata', async () => {
    const f = await fixture()
    const admission = await verifyDiscoveryBudgetAdmission(f.receipt, f.hold)
    expect(admission).toEqual(f.admission)
    expect(Object.isFrozen(admission)).toBe(true)
    expect(Object.isFrozen(admission.hold)).toBe(true)
    expect(Object.isFrozen(admission.hold.policy)).toBe(true)
    noDispatch(f)
  })

  it.each(['missing', 'null', 'empty', 'unknown-field', 'missing-hold', 'wrong-version', 'under-retained', 'over-retained'])('rejects %s admission evidence', async mode => {
    const f = await fixture()
    if (mode === 'missing') delete f.receipt.discoveryBudget
    else if (mode === 'null') f.receipt.discoveryBudget = null
    else if (mode === 'empty') f.receipt.discoveryBudget = {}
    else if (mode === 'unknown-field') Object.assign(f.admission, { proposed: true })
    else if (mode === 'missing-hold') delete (f.admission as Partial<Admission>).hold
    else if (mode === 'wrong-version') Object.assign(f.admission, { version: 2 })
    else f.admission.retainedMicroUsd += mode === 'under-retained' ? -1 : 1
    await expect(createDiscoveryBatchSpendAdapters(f.input)).rejects.toMatchObject({ code: INVALID })
    noDispatch(f)
  })

  it.each(['account', 'scope', 'source', 'claim-nonce', 'limit', 'policy-hash'])('rejects a receipt hold with a mismatched %s', async mode => {
    const f = await fixture(), recorded = f.admission.hold
    if (mode === 'account') recorded.policy.accountId = OTHER_ACCOUNT
    if (mode === 'scope') recorded.policy.scopeFingerprint = await hashMutationPayload('scope', { other: true })
    if (mode === 'source') recorded.sourceId = 'monitor:other'
    if (mode === 'claim-nonce') recorded.claimAttemptId = OTHER_CLAIM
    if (mode === 'limit') recorded.searchRequestLimit += 1
    if (mode === 'policy-hash') recorded.policyFingerprint = 'f'.repeat(64)
    await expect(createDiscoveryBatchSpendAdapters(f.input)).rejects.toMatchObject({ code: INVALID })
    noDispatch(f)
  })

  it.each(['underpriced', 'overpriced', 'over-cap', 'wrong-policy-hash'])('rejects internally matching but %s proposed and recorded holds', async mode => {
    const f = await fixture()
    if (mode === 'underpriced') f.hold.reservedMicroUsd -= 1
    if (mode === 'overpriced') f.hold.reservedMicroUsd += 1
    if (mode === 'over-cap') {
      f.hold.policy.maximumMicroUsd = f.hold.reservedMicroUsd - 1
      f.hold.policyFingerprint = await hashMutationPayload('discovery_spend_policy', f.hold.policy)
    }
    if (mode === 'wrong-policy-hash') f.hold.policyFingerprint = 'f'.repeat(64)
    f.admission.hold = structuredClone(f.hold)
    f.admission.retainedMicroUsd = f.hold.reservedMicroUsd
    await expect(createDiscoveryBatchSpendAdapters(f.input)).rejects.toMatchObject({ code: INVALID })
    noDispatch(f)
  })

  it('accepts a declined zero-retention receipt as evidence but never constructs dispatch adapters', async () => {
    const f = await fixture()
    f.admission.admitted = false
    f.admission.retainedMicroUsd = 0
    await expect(verifyDiscoveryBudgetAdmission(f.receipt, f.hold)).resolves.toMatchObject({ admitted: false, retainedMicroUsd: 0 })
    await expect(createDiscoveryBatchSpendAdapters(f.input)).rejects.toMatchObject({ code: 'DISCOVERY_BUDGET_EXHAUSTED' })
    noDispatch(f)
  })

  it('rejects a declined receipt that incorrectly retains an admitted amount', async () => {
    const f = await fixture()
    f.admission.admitted = false
    await expect(createDiscoveryBatchSpendAdapters(f.input)).rejects.toMatchObject({ code: INVALID })
    noDispatch(f)
  })

  it.each(['replay', 'not-committed', 'wrong-operation', 'wrong-command-prefix', 'bad-digest', 'receipt-id', 'zero-revision', 'fractional-revision', 'string-revision'])('rejects %s original claim identity before dispatch', async mode => {
    const f = await fixture()
    if (mode === 'replay') f.input.claim.firstCommit = false
    if (mode === 'not-committed') f.receipt.status = 'ALREADY_APPLIED'
    if (mode === 'wrong-operation') f.receipt.operation = 'ingest_verified_discovery'
    if (mode === 'wrong-command-prefix') f.receipt.commandId = `discovery-search-settled:${'a'.repeat(64)}`
    if (mode === 'bad-digest') f.receipt.commandId = 'discovery-search-claimed:not-a-hash'
    if (mode === 'receipt-id') f.receipt.receiptId = 'command-receipt:foreign'
    if (mode === 'zero-revision') f.receipt.revision = 0
    if (mode === 'fractional-revision') f.receipt.revision = 1.5
    if (mode === 'string-revision') f.receipt.revision = '7'
    await expect(createDiscoveryBatchSpendAdapters(f.input)).rejects.toMatchObject({ code: INVALID })
    noDispatch(f)
  })

  it.each(['missing-query', 'extra-query', 'duplicate-query', 'wrong-provider', 'lower-price', 'higher-price', 'missing-result-limit', 'larger-result-limit'])('requires the complete batch and exact tariff: %s', async mode => {
    const f = await fixture()
    if (mode === 'missing-query') f.input.queries.pop()
    if (mode === 'extra-query') f.input.queries.push(plannedQueries(3)[2])
    if (mode === 'duplicate-query') f.input.queries[1] = structuredClone(f.input.queries[0])
    if (mode === 'wrong-provider') f.provider.id = 'perplexity-search-fast'
    if (mode === 'lower-price') f.provider.maximumRequestCostUsd /= 2
    if (mode === 'higher-price') f.provider.maximumRequestCostUsd *= 2
    if (mode === 'missing-result-limit') delete f.provider.maximumResults
    if (mode === 'larger-result-limit') f.provider.maximumResults = 25
    await expect(createDiscoveryBatchSpendAdapters(f.input)).rejects.toMatchObject({ code: INVALID })
    noDispatch(f)
  })

  it('dispatches every planned query exactly once with exact reservation amounts and one model call', async () => {
    const f = await fixture(3), adapter = await createDiscoveryBatchSpendAdapters(f.input)
    for (const query of f.input.queries) {
      const pair = await searchPair(query)
      expect(await adapter.reserveSearch(pair.reservation)).toEqual({ ...pair.reservation,
        reservationId: `${f.receipt.commandId}:search:${pair.request.requestId}`, reservedUsd: T.searchRequestMicroUsd / 1_000_000, expiresAt: END })
      await adapter.searchProvider.search(pair.request)
    }
    expect(f.search.mock.calls.map(([request]) => request.query)).toEqual(f.input.queries)
    expect(f.search.mock.calls.every(([request]) => request.maxResults === 20)).toBe(true)
    const model = modelPair()
    expect(await adapter.reserveSpend(model.reservation)).toEqual({ ...model.reservation,
      reservationId: `${f.receipt.commandId}:model:${model.reservation.requestId}`, reservedUsd: T.modelInferenceMicroUsd / 1_000_000, expiresAt: END })
    await expect(adapter.generateTextImpl(model.request)).resolves.toEqual({ text: '[]' })
    expect(f.modelDispatch).toHaveBeenCalledExactlyOnceWith(model.request)
    expect(f.authorize).toHaveBeenCalledTimes(10)
  })

  it('requires reservations before either outbound path', async () => {
    const f = await fixture(), adapter = await createDiscoveryBatchSpendAdapters(f.input)
    await expect(adapter.searchProvider.search((await searchPair(f.input.queries[0])).request)).rejects.toMatchObject({ code: INVALID })
    await expect(adapter.generateTextImpl(modelPair().request)).rejects.toMatchObject({ code: INVALID })
    noDispatch(f)
  })

  it.each(['account', 'scope', 'before-window', 'expired'])('rejects initial %s authority before creating usable adapters', async kind => {
    const f = await fixture()
    if (kind === 'account') f.state.accountId = OTHER_ACCOUNT
    if (kind === 'scope') f.state.scopeFingerprint = 'f'.repeat(64)
    if (kind === 'before-window') f.state.now = new Date(Date.parse(START) - 1)
    if (kind === 'expired') f.state.now = new Date(END)
    await expect(createDiscoveryBatchSpendAdapters(f.input)).rejects.toMatchObject({ code: kind === 'account'
      ? 'AUTH_FORBIDDEN' : kind === 'scope' ? 'DISCOVERY_SCOPE_CHANGED' : 'DISCOVERY_BUDGET_WINDOW_CLOSED' })
    noDispatch(f)
  })

  it.each([
    { provider: 'perplexity-search-fast' }, { accountId: OTHER_ACCOUNT }, { sourceId: 'monitor:other' },
    { maxHttpRequests: 2 }, { maximumCostUsd: 0.001 }, { requestFingerprint: 'x' }, { requestId: 'not-a-uuid' },
    { application: 'another-app' }, { retries: 1 },
  ])('rejects invalid search reservation %j without consuming a valid slot', async change => {
    const f = await fixture(1), adapter = await createDiscoveryBatchSpendAdapters(f.input), pair = await searchPair(f.input.queries[0])
    await expect(adapter.reserveSearch({ ...pair.reservation, ...change } as DiscoverySearchReservationRequest)).rejects.toMatchObject({ code: INVALID })
    noDispatch(f)
    await adapter.reserveSearch(pair.reservation)
    await adapter.searchProvider.search(pair.request)
    expect(f.search).toHaveBeenCalledTimes(1)
  })

  it('consumes search slots synchronously while concurrent authorization is pending', async () => {
    const f = await fixture(1), adapter = await createDiscoveryBatchSpendAdapters(f.input)
    const first = await searchPair(f.input.queries[0]), second = await searchPair(f.input.queries[0])
    const entered = deferred(), release = deferred()
    f.authorize.mockImplementationOnce(async () => { entered.resolve(); await release.promise })
    const pending = adapter.reserveSearch(first.reservation)
    await entered.promise
    await expect(adapter.reserveSearch(second.reservation)).rejects.toMatchObject({ code: INVALID })
    await expect(adapter.reserveSearch(first.reservation)).rejects.toMatchObject({ code: INVALID })
    noDispatch(f)
    release.resolve()
    await pending
    await adapter.searchProvider.search(first.request)
    expect(f.search).toHaveBeenCalledTimes(1)
  })

  it('never refunds a search slot after ambiguous authorization failure', async () => {
    const f = await fixture(1), adapter = await createDiscoveryBatchSpendAdapters(f.input), pair = await searchPair(f.input.queries[0])
    f.authorize.mockRejectedValueOnce(new Error('Authority read response lost.'))
    await expect(adapter.reserveSearch(pair.reservation)).rejects.toThrow('Authority read response lost.')
    await expect(adapter.reserveSearch(pair.reservation)).rejects.toMatchObject({ code: INVALID })
    await expect(adapter.reserveSearch((await searchPair(f.input.queries[0])).reservation)).rejects.toMatchObject({ code: INVALID })
    noDispatch(f)
  })

  it.each(['wrong-fingerprint', 'unplanned-query', 'wrong-result-count'])('blocks outbound search with %s', async mode => {
    const f = await fixture(), adapter = await createDiscoveryBatchSpendAdapters(f.input), pair = await searchPair(f.input.queries[0])
    if (mode === 'wrong-fingerprint') pair.reservation.requestFingerprint = await hashMutationPayload('wrong-operation', pair.request)
    if (mode === 'unplanned-query') pair.request.query.query = 'not in the committed plan'
    if (mode === 'wrong-result-count') pair.request.maxResults = 25
    await adapter.reserveSearch(pair.reservation)
    await expect(adapter.searchProvider.search(pair.request)).rejects.toMatchObject({ code: INVALID })
    noDispatch(f)
  })

  it('consumes a failed fingerprint comparison so corrected retries cannot dispatch', async () => {
    const f = await fixture(), adapter = await createDiscoveryBatchSpendAdapters(f.input), pair = await searchPair(f.input.queries[0])
    pair.reservation.requestFingerprint = await hashMutationPayload('wrong-operation', pair.request)
    await adapter.reserveSearch(pair.reservation)
    await expect(adapter.searchProvider.search(pair.request)).rejects.toMatchObject({ code: INVALID })
    await expect(adapter.searchProvider.search(pair.request)).rejects.toMatchObject({ code: INVALID })
    const another = await searchPair(f.input.queries[0])
    await adapter.reserveSearch(another.reservation)
    await expect(adapter.searchProvider.search(another.request)).rejects.toMatchObject({ code: INVALID })
    noDispatch(f)
  })

  it.each(['resolved', 'unknown-failure'])('never dispatches a query twice after %s, even with a new request ID', async mode => {
    const f = await fixture(), adapter = await createDiscoveryBatchSpendAdapters(f.input), pair = await searchPair(f.input.queries[0])
    await adapter.reserveSearch(pair.reservation)
    const entered = deferred(), release = deferred()
    f.search.mockImplementationOnce(async () => {
      entered.resolve(); await release.promise
      if (mode === 'unknown-failure') throw new Error('Provider accepted request but response was lost.')
      return { providerRequestId: 'synthetic-search', results: [] }
    })
    const pending = adapter.searchProvider.search(pair.request)
    const outcome = pending.then(value => ({ value }), error => ({ error }))
    await entered.promise
    await expect(adapter.searchProvider.search(pair.request)).rejects.toMatchObject({ code: INVALID })
    const another = await searchPair(pair.request.query)
    await adapter.reserveSearch(another.reservation)
    await expect(adapter.searchProvider.search(another.request)).rejects.toMatchObject({ code: INVALID })
    release.resolve()
    if (mode === 'unknown-failure') expect(await outcome).toMatchObject({ error: expect.any(Error) })
    else expect(await outcome).toHaveProperty('value')
    await expect(adapter.searchProvider.search(pair.request)).rejects.toMatchObject({ code: INVALID })
    expect(f.search).toHaveBeenCalledTimes(1)
    expect(f.modelTransport).not.toHaveBeenCalled()
  })

  it.each(['account', 'scope'])('blocks search if %s authority is revoked during asynchronous hashing', async kind => {
    const f = await fixture(), adapter = await createDiscoveryBatchSpendAdapters(f.input), pair = await searchPair(f.input.queries[0])
    await adapter.reserveSearch(pair.reservation)
    const pause = pauseNextDigest(), pending = adapter.searchProvider.search(pair.request)
    await pause.entered
    if (kind === 'account') f.state.accountId = OTHER_ACCOUNT
    else f.state.scopeFingerprint = 'f'.repeat(64)
    pause.release()
    await expect(pending).rejects.toMatchObject({ code: kind === 'account' ? 'AUTH_FORBIDDEN' : 'DISCOVERY_SCOPE_CHANGED' })
    f.state.accountId = ACCOUNT
    f.state.scopeFingerprint = f.hold.policy.scopeFingerprint
    await expect(adapter.searchProvider.search(pair.request)).rejects.toMatchObject({ code: INVALID })
    const another = await searchPair(f.input.queries[0])
    await adapter.reserveSearch(another.reservation)
    await expect(adapter.searchProvider.search(another.request)).rejects.toMatchObject({ code: INVALID })
    noDispatch(f)
  })

  it('checks expiry after authority awaits and immediately before search dispatch', async () => {
    const f = await fixture(), adapter = await createDiscoveryBatchSpendAdapters(f.input), pair = await searchPair(f.input.queries[0])
    await adapter.reserveSearch(pair.reservation)
    const entered = deferred(), release = deferred()
    f.authorize.mockImplementationOnce(async () => { entered.resolve(); await release.promise })
    const pending = adapter.searchProvider.search(pair.request)
    await entered.promise
    f.state.now = new Date(END)
    release.resolve()
    await expect(pending).rejects.toMatchObject({ code: 'DISCOVERY_BUDGET_WINDOW_CLOSED' })
    await expect(adapter.searchProvider.search(pair.request)).rejects.toMatchObject({ code: INVALID })
    noDispatch(f)
  })

  it.each([
    { accountId: OTHER_ACCOUNT }, { sourceId: 'monitor:other' }, { provider: 'direct-openai' }, { model: 'openai/gpt-4.1' },
    { maxOutputTokens: 5001 }, { maxSdkAttempts: 2 }, { inputBytes: T.modelMaximumInputBytes + 1 }, { inputBytes: -1 },
    { requestId: 'not-a-uuid' }, { application: 'another-app' }, { tools: {} },
  ])('rejects invalid model reservation %j without dispatch', async change => {
    const f = await fixture(), adapter = await createDiscoveryBatchSpendAdapters(f.input), pair = modelPair()
    await expect(adapter.reserveSpend({ ...pair.reservation, ...change } as DiscoverySpendRequest)).rejects.toMatchObject({ code: INVALID })
    noDispatch(f)
    await adapter.reserveSpend(pair.reservation)
  })

  it('allows only one model reservation while concurrent authorization is pending', async () => {
    const f = await fixture(), adapter = await createDiscoveryBatchSpendAdapters(f.input), pair = modelPair()
    const entered = deferred(), release = deferred()
    f.authorize.mockImplementationOnce(async () => { entered.resolve(); await release.promise })
    const pending = adapter.reserveSpend(pair.reservation)
    await entered.promise
    await expect(adapter.reserveSpend(modelPair().reservation)).rejects.toMatchObject({ code: INVALID })
    release.resolve()
    await pending
    await expect(adapter.reserveSpend(pair.reservation)).rejects.toMatchObject({ code: INVALID })
    noDispatch(f)
  })

  it.each(['account', 'scope', 'expiry'])('blocks model dispatch when %s changes after reservation and before transport', async kind => {
    const f = await fixture(), adapter = await createDiscoveryBatchSpendAdapters(f.input), pair = modelPair()
    await adapter.reserveSpend(pair.reservation)
    if (kind === 'account') f.state.accountId = OTHER_ACCOUNT
    if (kind === 'scope') f.state.scopeFingerprint = 'f'.repeat(64)
    if (kind === 'expiry') f.state.now = new Date(END)
    await expect(adapter.generateTextImpl(pair.request)).rejects.toMatchObject({ code: kind === 'account'
      ? 'AUTH_FORBIDDEN' : kind === 'scope' ? 'DISCOVERY_SCOPE_CHANGED' : 'DISCOVERY_BUDGET_WINDOW_CLOSED' })
    f.state.accountId = ACCOUNT
    f.state.scopeFingerprint = f.hold.policy.scopeFingerprint
    f.state.now = new Date(START)
    await expect(adapter.generateTextImpl(pair.request)).rejects.toMatchObject({ code: INVALID })
    noDispatch(f)
  })

  it.each([
    { model: 'openai/gpt-4.1' }, { maxOutputTokens: 4999 }, { maxRetries: 1 }, { temperature: 0.2 },
    { tools: {} }, { toolChoice: 'auto' }, { providerOptions: { gateway: { models: ['other'] } } },
    { prompt: 'Different number of UTF-8 bytes.' },
  ])('rejects changed model bytes or unfixed/tool-enabled arguments %j', async change => {
    const f = await fixture(), adapter = await createDiscoveryBatchSpendAdapters(f.input), pair = modelPair()
    await adapter.reserveSpend(pair.reservation)
    await expect(adapter.generateTextImpl({ ...pair.request, ...change } as DiscoveryGenerateTextInput)).rejects.toMatchObject({ code: INVALID })
    noDispatch(f)
  })

  it('compares UTF-8 bytes rather than JavaScript string length', async () => {
    const f = await fixture(), adapter = await createDiscoveryBatchSpendAdapters(f.input), pair = modelPair()
    expect(pair.reservation.inputBytes).toBeGreaterThan((pair.request.system + pair.request.prompt).length)
    pair.reservation.inputBytes = (pair.request.system + pair.request.prompt).length
    await adapter.reserveSpend(pair.reservation)
    await expect(adapter.generateTextImpl(pair.request)).rejects.toMatchObject({ code: INVALID })
    noDispatch(f)
  })

  it.each(['resolved', 'unknown-failure'])('consumes the model slot before transport awaits after %s', async mode => {
    const f = await fixture(), adapter = await createDiscoveryBatchSpendAdapters(f.input), pair = modelPair()
    await adapter.reserveSpend(pair.reservation)
    const entered = deferred(), release = deferred()
    f.modelDispatch.mockImplementationOnce(async () => {
      entered.resolve(); await release.promise
      if (mode === 'unknown-failure') throw new Error('Inference response lost.')
      return { text: '[]' }
    })
    const pending = adapter.generateTextImpl(pair.request)
    const outcome = pending.then(value => ({ value }), error => ({ error }))
    await entered.promise
    await expect(adapter.generateTextImpl(pair.request)).rejects.toMatchObject({ code: INVALID })
    await expect(adapter.reserveSpend(modelPair().reservation)).rejects.toMatchObject({ code: INVALID })
    release.resolve()
    if (mode === 'unknown-failure') expect(await outcome).toMatchObject({ error: expect.any(Error) })
    else expect(await outcome).toHaveProperty('value')
    await expect(adapter.generateTextImpl(pair.request)).rejects.toMatchObject({ code: INVALID })
    expect(f.modelDispatch).toHaveBeenCalledTimes(1)
    expect(f.modelTransport).toHaveBeenCalledTimes(1)
    expect(f.search).not.toHaveBeenCalled()
  })

  it.each(['account', 'scope', 'expiry'])('blocks model outbound when %s changes during fake transport preparation', async kind => {
    const f = await fixture(), entered = deferred(), release = deferred()
    f.modelTransport.mockImplementationOnce(async (value, beforeRequest) => {
      entered.resolve(); await release.promise
      await beforeRequest()
      return f.modelDispatch(value)
    })
    const adapter = await createDiscoveryBatchSpendAdapters(f.input), pair = modelPair()
    await adapter.reserveSpend(pair.reservation)
    const pending = adapter.generateTextImpl(pair.request)
    await entered.promise
    if (kind === 'account') f.state.accountId = OTHER_ACCOUNT
    if (kind === 'scope') f.state.scopeFingerprint = 'f'.repeat(64)
    if (kind === 'expiry') f.state.now = new Date(END)
    release.resolve()
    await expect(pending).rejects.toMatchObject({ code: kind === 'account' ? 'AUTH_FORBIDDEN' : kind === 'scope' ? 'DISCOVERY_SCOPE_CHANGED' : 'DISCOVERY_BUDGET_WINDOW_CLOSED' })
    expect(f.modelTransport).toHaveBeenCalledTimes(1)
    expect(f.modelDispatch).not.toHaveBeenCalled()
    expect(f.search).not.toHaveBeenCalled()
    await expect(adapter.generateTextImpl(pair.request)).rejects.toMatchObject({ code: INVALID })
  })

  it('snapshots hold, receipt, queries, provider fields and callbacks before admission hashing yields', async () => {
    const f = await fixture(), originalQueries = structuredClone(f.input.queries)
    const evilSearch = vi.fn<DiscoverySearchProvider['search']>().mockRejectedValue(new Error('Replaced provider invoked.'))
    const evilModel = vi.fn<DiscoveryModelTransport>().mockRejectedValue(new Error('Replaced model invoked.'))
    const pause = pauseNextDigest(), pending = createDiscoveryBatchSpendAdapters(f.input)
    await pause.entered
    f.hold.policy.accountId = OTHER_ACCOUNT
    f.hold.searchRequestLimit = 48
    f.receipt.status = 'ALREADY_APPLIED'
    f.admission.admitted = false
    f.admission.hold.claimAttemptId = OTHER_CLAIM
    f.input.claim.firstCommit = false
    f.input.queries[0].query = 'Injected replacement query'
    f.input.queries[1].domains![0] = 'evil.example'
    f.provider.id = 'foreign-provider'
    f.provider.maximumRequestCostUsd = 100
    f.provider.maximumResults = 25
    f.provider.search = evilSearch
    f.input.modelTransport = evilModel
    f.input.authorize = async () => { throw new Error('Replaced authority invoked.') }
    f.input.clock = () => new Date(END)
    pause.release()
    const adapter = await pending
    expect(adapter.searchProvider).toMatchObject({ id: T.searchProvider, maximumRequestCostUsd: 0.005, maximumResults: 20 })
    for (const query of originalQueries) {
      const pair = await searchPair(query)
      await adapter.reserveSearch(pair.reservation)
      await adapter.searchProvider.search(pair.request)
    }
    const injected = await searchPair(f.input.queries[0])
    await expect(adapter.reserveSearch(injected.reservation)).rejects.toMatchObject({ code: INVALID })
    const model = modelPair()
    await adapter.reserveSpend(model.reservation)
    await adapter.generateTextImpl(model.request)
    expect(f.search.mock.calls.map(([request]) => request.query)).toEqual(originalQueries)
    expect(f.modelDispatch).toHaveBeenCalledExactlyOnceWith(model.request)
    expect(evilSearch).not.toHaveBeenCalled()
    expect(evilModel).not.toHaveBeenCalled()
  })

  it('snapshots caller search input, including nested query domains, before fingerprint hashing yields', async () => {
    const f = await fixture(), adapter = await createDiscoveryBatchSpendAdapters(f.input), pair = await searchPair(f.input.queries[1])
    const original = structuredClone(pair.request)
    await adapter.reserveSearch(pair.reservation)
    const pause = pauseNextDigest(), pending = adapter.searchProvider.search(pair.request)
    await pause.entered
    pair.request.requestId = crypto.randomUUID()
    pair.request.maxResults = 25
    pair.request.query.query = 'mutated'
    pair.request.query.domains!.push('evil.example')
    pause.release()
    await pending
    expect(f.search).toHaveBeenCalledExactlyOnceWith(original)
  })

  it('snapshots the search reservation before asynchronous authorization', async () => {
    const f = await fixture(), adapter = await createDiscoveryBatchSpendAdapters(f.input), pair = await searchPair(f.input.queries[0])
    const original = structuredClone(pair.reservation), entered = deferred(), release = deferred()
    f.authorize.mockImplementationOnce(async () => { entered.resolve(); await release.promise })
    const pending = adapter.reserveSearch(pair.reservation)
    await entered.promise
    pair.reservation.requestId = crypto.randomUUID()
    pair.reservation.accountId = OTHER_ACCOUNT
    pair.reservation.requestFingerprint = 'f'.repeat(64)
    release.resolve()
    await expect(pending).resolves.toMatchObject(original)
    await adapter.searchProvider.search(pair.request)
    expect(f.search).toHaveBeenCalledExactlyOnceWith(pair.request)
  })

  it('does not expose a mutable provider receiver after its fixed tariff was validated', async () => {
    const f = await fixture(), observedReceiver = vi.fn()
    f.provider.search = async function (request) {
      observedReceiver({ id: this.id, maximumRequestCostUsd: this.maximumRequestCostUsd, maximumResults: this.maximumResults })
      return f.search(request)
    }
    const pause = pauseNextDigest(), pending = createDiscoveryBatchSpendAdapters(f.input)
    await pause.entered
    f.provider.id = 'mutated-provider'
    f.provider.maximumRequestCostUsd = 100
    f.provider.maximumResults = 25
    pause.release()
    const adapter = await pending, pair = await searchPair(f.input.queries[0])
    await adapter.reserveSearch(pair.reservation)
    await adapter.searchProvider.search(pair.request)
    expect(observedReceiver).toHaveBeenCalledExactlyOnceWith({ id: T.searchProvider,
      maximumRequestCostUsd: T.searchRequestMicroUsd / 1_000_000, maximumResults: T.searchMaximumResults })
  })

  it('snapshots model reservation and text input before authorization awaits', async () => {
    const f = await fixture(), adapter = await createDiscoveryBatchSpendAdapters(f.input), pair = modelPair()
    const reservationBefore = structuredClone(pair.reservation), requestBefore = structuredClone(pair.request)
    const entered = deferred(), release = deferred()
    f.authorize.mockImplementationOnce(async () => { entered.resolve(); await release.promise })
    const reserved = adapter.reserveSpend(pair.reservation)
    await entered.promise
    pair.reservation.accountId = OTHER_ACCOUNT
    pair.reservation.inputBytes = 0
    pair.reservation.model = 'foreign-model'
    release.resolve()
    await expect(reserved).resolves.toMatchObject(reservationBefore)
    const enteredModel = deferred(), releaseModel = deferred()
    f.authorize.mockImplementationOnce(async () => { enteredModel.resolve(); await releaseModel.promise })
    const generated = adapter.generateTextImpl(pair.request)
    await enteredModel.promise
    pair.request.prompt = 'mutated'
    pair.request.maxOutputTokens = 999999
    releaseModel.resolve()
    await generated
    expect(f.modelDispatch).toHaveBeenCalledExactlyOnceWith(requestBefore)
  })
})
