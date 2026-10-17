import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createDiscoveryRuntime } from '../gateway/discoveryRuntime.js'
import { DISCOVERY_SPEND_TARIFF as T } from '../gateway/discoverySpendPolicy.js'
import { hashMutationPayload } from '../gateway/mutationKernel.js'
import { discoveryProfileManagementFingerprint } from '../src/discoveryProfileManagement.js'
import { LedgerHarness, USER, GENERATION, AT, json } from './fixtures/b2Ledger.rebuilt.js'
import { budgetWire } from './fixtures/b2BudgetLedger.js'

const request = (query = '') => new Request(`https://synthetic.invalid/api/automation-discovery${query}`, { headers: { authorization: 'Bearer synthetic-worker-only' } })
const base = { supabaseUrl: 'https://synthetic.invalid', supabasePublishableKey: 'synthetic-public', supabaseServiceRoleKey: 'synthetic-service',
  tokenEncryptionKey: '', googleClientId: '', googleClientSecret: '' }
beforeEach(() => {
  // The ledger clock is fixed; keep the model reservation wall clock in the same fixture window.
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(AT))
  vi.stubEnv('PJSDAS_CONNECTED_AUTHORITY', 'transactional'); vi.stubEnv('PJSDAS_SUPABASE_SERVICE_ROLE_KEY', 'synthetic-service')
  vi.stubEnv('AI_GATEWAY_API_KEY', 'synthetic-gateway-only')
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Uninjected external request forbidden') }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
async function fixture() {
  const db = new LedgerHarness(), wire = budgetWire(db)
  const policy = { version: 1, application: 'todayaction', approvalId: 'synthetic:runtime-approval', accountId: USER,
    scopeFingerprint: await discoveryProfileManagementFingerprint(db.snapshot.data.discoveryProfile!), currency: 'USD', maximumMicroUsd: 10_000_000,
    validFrom: '2026-10-01T00:00:00Z', expiresAt: '2026-10-10T00:00:00Z', tariffVersion: T.version }
  const approval = { version: 1, policy, fundingReview: { reference: 'synthetic:review', policyFingerprint: await hashMutationPayload('discovery_spend_policy', policy),
    reviewedAt: '2026-10-01T00:00:00Z', expiresAt: '2026-10-09T00:00:00Z', billingBoundaryReference: 'synthetic:billing-evidence', routeAndAddonsReference: 'synthetic:route-evidence' } }
  const environment: Record<string, string | undefined> = { PJSDAS_DISCOVERY_RUNTIME_ENABLED: 'true', PJSDAS_DISCOVERY_RUNTIME_APPROVAL_JSON: JSON.stringify(approval), PJSDAS_DISCOVERY_PERPLEXITY_API_KEY: 'synthetic-search-only' }
  const binding = { user_id: USER, google_subject: 'synthetic-subject', refresh_token_ciphertext: 'synthetic-unused', discovery_consent_generation: GENERATION }
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname
    if (path.endsWith('/pjsdas_claim_enabled_discovery_automation_bindings_v2')) return json([binding,
      { ...binding, user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }])
    if (path.endsWith('/pjsdas_update_google_automation_state')) {
      expect(JSON.parse(String(init?.body))).toMatchObject({ target_user_id: USER, expected_ciphertext: binding.refresh_token_ciphertext, state_operation: 'pjsdas_update_discovery_automation_state' })
      return json(true)
    }
    return wire(input, init)
  })
  let searchResponses = 0
  const providerFetch = vi.fn<typeof fetch>(async (input, init): Promise<Response> => {
    const url = String(input)
    if (url === 'https://api.perplexity.ai/search') return json({ id: `synthetic-response-${++searchResponses}`, results: [{ url: 'https://example.test/posting', title: 'Synthetic role' }] })
    if (url === 'https://ai-gateway.vercel.sh/v4/ai/language-model') {
      expect(JSON.parse(String(init?.body))).toMatchObject({ maxOutputTokens: 5000, toolChoice: { type: 'none' }, providerOptions: { gateway: { only: ['openai'] } } })
      return json({ content: [{ type: 'text', text: '{"observations":[]}' }], finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } }, warnings: [] })
    }
    throw new Error('Unexpected provider endpoint')
  })
  const make = () => createDiscoveryRuntime({ base: { ...base, fetchImpl, now: () => db.now }, environment, providerFetch })
  return { db, approval, environment, fetchImpl, providerFetch, binding, make }
}

describe('default-off production endpoint wiring, synthetic SDK and ledger only', () => {
  it.each([undefined, '', 'false', '1', 'TRUE'])('disabled flag %s performs no cloud read or credential access', async flag => {
    const environment = { PJSDAS_DISCOVERY_RUNTIME_ENABLED: flag, get PJSDAS_DISCOVERY_PERPLEXITY_API_KEY(): string { throw new Error('must not read credential') }, get PJSDAS_DISCOVERY_RUNTIME_APPROVAL_JSON(): string { throw new Error('must not read configuration') } }
    const fetchImpl = vi.fn<typeof fetch>()
    const response = await createDiscoveryRuntime({ base: { ...base, fetchImpl }, environment })(request())
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ code: 'DISCOVERY_RUNTIME_DISABLED' })
    expect(fetchImpl).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
  })
  it.each(['missing approval', 'invalid approval', 'extra field', 'wrong fingerprint', 'missing evidence', 'future review', 'expired review', 'expired policy', 'missing key'])('fails closed for %s before any external effect', async failure => {
    const f = await fixture()
    if (failure === 'extra field') Object.assign(f.approval, { bypass: true })
    if (failure === 'wrong fingerprint') f.approval.fundingReview.policyFingerprint = 'f'.repeat(64)
    if (failure === 'missing evidence') f.approval.fundingReview.billingBoundaryReference = ''
    if (failure === 'future review') f.approval.fundingReview.reviewedAt = '2027-01-01T00:00:00Z'
    if (failure === 'expired review') f.approval.fundingReview.expiresAt = f.db.now.toISOString()
    if (failure === 'expired policy') { f.approval.policy.expiresAt = f.db.now.toISOString(); f.approval.fundingReview.policyFingerprint = await hashMutationPayload('discovery_spend_policy', f.approval.policy) }
    f.environment.PJSDAS_DISCOVERY_RUNTIME_APPROVAL_JSON = JSON.stringify(f.approval)
    if (failure === 'missing approval') delete f.environment.PJSDAS_DISCOVERY_RUNTIME_APPROVAL_JSON
    if (failure === 'invalid approval') f.environment.PJSDAS_DISCOVERY_RUNTIME_APPROVAL_JSON = '{bad'
    if (failure === 'missing key') delete f.environment.PJSDAS_DISCOVERY_PERPLEXITY_API_KEY
    expect((await f.make()(request())).status).toBe(503)
    expect(f.fetchImpl).not.toHaveBeenCalled(); expect(f.providerFetch).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
  })
  it.each(['?probe=1', '?userId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'])('refuses unreserved probe or different account %s', async query => {
    const f = await fixture(); expect((await f.make()(request(query))).status).toBe(503)
    expect(f.fetchImpl).not.toHaveBeenCalled(); expect(f.providerFetch).not.toHaveBeenCalled()
  })
  it('requires the original scheduler token even with syntactically valid runtime approval', async () => {
    const f = await fixture(); expect((await f.make()(new Request('https://synthetic.invalid/api/automation-discovery'))).status).toBe(401)
    expect(f.fetchImpl).not.toHaveBeenCalled(); expect(f.providerFetch).not.toHaveBeenCalled()
  })
  it('uses the complete four-query plan and real SDK through admitted original receipts, with no foreign account work', async () => {
    const f = await fixture(), handler = f.make()
    const response = await handler(request())
    const body = await response.json()
    expect(response.status, JSON.stringify(body)).toBe(200)
    expect(body).toMatchObject({ processedUsers: 1 })
    expect(f.providerFetch.mock.calls.filter(call => String(call[0]) === 'https://api.perplexity.ai/search')).toHaveLength(4)
    expect(f.providerFetch.mock.calls.filter(call => String(call[0]).includes('/language-model'))).toHaveLength(4)
    expect(f.db.rows.size).toBe(8)
    expect([...f.db.rows.values()].every(row => row.user_id === USER && row.receipt.discoveryBudget)).toBe(true)
    expect((await handler(request())).status).toBe(200)
    expect(f.providerFetch).toHaveBeenCalledTimes(8)
    expect(fetch).not.toHaveBeenCalled(); expect(f.db.unexpectedUrls).toEqual([])
  })
  it('commits one independently verified synthetic posting across all four sources without fabricating a deadline or action', async () => {
    const f = await fixture()
    const posting = 'https://source-tenant.zhiye.com/social/detail?jobAdId=b7a408f6-9a55-4e08-9f8d-160cfff60e20'
    const sourceFacts = { '@context': 'https://schema.org', '@type': 'JobPosting', url: posting,
      title: 'Product Manager', hiringOrganization: { '@type': 'Organization', name: 'Synthetic Source Company' },
      jobLocation: { address: { addressLocality: 'Shanghai' } } }
    const original = f.fetchImpl.getMockImplementation()!
    f.fetchImpl.mockImplementation(async (url, init) => String(url) === posting
      ? new Response(`<html><head><title>Synthetic posting</title><script type="application/ld+json">${JSON.stringify(sourceFacts)}</script></head><body><main><article><h1>Product Manager</h1><dl><dt>公司名称</dt><dd>Synthetic Source Company</dd></dl></article></main></body></html>`, { headers: { 'content-type': 'text/html' } })
      : original(url, init))
    f.providerFetch.mockImplementation(async (url, init) => {
      if (String(url) === 'https://api.perplexity.ai/search') return json({ id: `synthetic-search-${f.providerFetch.mock.calls.length}`, results: [{ url: posting, title: 'Product Manager' }] })
      expect(String(url)).toBe('https://ai-gateway.vercel.sh/v4/ai/language-model')
      expect(JSON.parse(String(init?.body)).providerOptions).toEqual({ gateway: { only: ['openai'] } })
      return json({ content: [{ type: 'text', text: JSON.stringify({ observations: [{ sourceRecordId: 'candidate-only',
        company: 'Synthetic Source Company', role: 'Product Manager', sourceTitle: 'Candidate title', sourceUrl: posting,
        deadline: '2030-12-31', location: 'Model City' }] }) }], finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 5 }, outputTokens: { total: 5 } }, warnings: [] })
    })
    const handler = f.make(), result = await handler(request()), body = await result.json()
    expect(result.status, JSON.stringify(body)).toBe(200)
    expect(body).toMatchObject({ successfulUsers: 1, failedUsers: 0, results: [{ scopeComplete: true, createdCount: 1, remainingQueryCount: 0 }] })
    expect(f.db.snapshot.data.opportunities).toHaveLength(1)
    expect(f.db.snapshot.data.opportunities[0]).toMatchObject({ company: 'Synthetic Source Company', role: 'Product Manager', detail: { discovery: { location: 'Shanghai', sourceVerification: 'verified', sourceProof: { authority: 'recruiting_platform' } } } })
    expect(f.db.snapshot.data.opportunities[0].deadline).toBeUndefined()
    expect(f.db.snapshot.data.actions).toEqual([]); expect(f.db.snapshot.data.processes).toEqual([]); expect(f.db.snapshot.data.scheduleNodes).toEqual([])
    const saved = structuredClone(f.db.snapshot), calls = f.providerFetch.mock.calls.length
    await handler(request())
    expect(f.providerFetch).toHaveBeenCalledTimes(calls); expect(f.db.snapshot).toEqual(saved)
    expect(fetch).not.toHaveBeenCalled(); expect(f.db.unexpectedUrls).toEqual([])
  })
  it('retains original holds and refuses model dispatch when the reservation wall clock reaches expiry', async () => {
    const f = await fixture()
    vi.mocked(Date.now).mockReturnValue(Date.parse(f.approval.policy.expiresAt))
    const response = await f.make()(request())
    expect(response.status).toBe(207)
    expect(f.providerFetch.mock.calls.filter(call => String(call[0]) === 'https://api.perplexity.ai/search')).toHaveLength(4)
    expect(f.providerFetch.mock.calls.filter(call => String(call[0]) === 'https://ai-gateway.vercel.sh/v4/ai/language-model')).toHaveLength(0)
    expect([...f.db.rows.values()].filter(row => row.provenance.searchPhase === 'claimed')).toHaveLength(4)
    for (const row of f.db.rows.values()) expect(row.receipt.discoveryBudget).toMatchObject({
      admitted: true, retainedMicroUsd: 432031, hold: { reservedMicroUsd: 432031 },
    })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('rechecks funding-review expiry on an already initialized handler', async () => {
    const f = await fixture(), handler = f.make()
    await handler(request()); const calls = f.fetchImpl.mock.calls.length, paid = f.providerFetch.mock.calls.length
    f.db.now = new Date(f.approval.fundingReview.expiresAt)
    expect((await handler(request())).status).toBe(503)
    expect(f.fetchImpl).toHaveBeenCalledTimes(calls); expect(f.providerFetch).toHaveBeenCalledTimes(paid)
  })
  it('stops before dispatch when the review expires during authority readback', async () => {
    const f = await fixture(), original = f.fetchImpl.getMockImplementation()!
    f.fetchImpl.mockImplementation(async (url, init) => {
      const response = await original(url, init)
      if (f.db.rows.size && String(url).endsWith('/pjsdas_claim_enabled_discovery_automation_bindings_v2')) f.db.now = new Date(f.approval.fundingReview.expiresAt)
      return response
    })
    await f.make()(request())
    expect(f.providerFetch).not.toHaveBeenCalled()
    expect([...f.db.rows.values()].some(row => row.provenance.searchPhase === 'claimed' && row.receipt.discoveryBudget)).toBe(true)
  })
})

describe('authority remains current through final scope validation', () => {
  it.each([['review-expiry','search'],['consent-revocation','search'],['review-expiry','model'],['consent-revocation','model']])('does not dispatch after %s during the final %s workspace read', async (failure, kind) => {
    const target = kind === 'search' ? 'https://api.perplexity.ai/search' : 'https://ai-gateway.vercel.sh/v4/ai/language-model'
    const baseline = await fixture()
    let count = 0, beforeFirstSearch = 0
    const originalBase = baseline.fetchImpl.getMockImplementation()!
    baseline.fetchImpl.mockImplementation(async (url, init) => {
      if (new URL(String(url)).pathname === '/rest/v1/pjsdas_workspaces') count++
      return originalBase(url, init)
    })
    const originalPaid = baseline.providerFetch.getMockImplementation()!
    baseline.providerFetch.mockImplementation(async (url, init) => {
      if (!beforeFirstSearch && String(url) === target) beforeFirstSearch = count
      return originalPaid(url, init)
    })
    await baseline.make()(request())
    expect(beforeFirstSearch).toBeGreaterThan(0)
    const f = await fixture(), original = f.fetchImpl.getMockImplementation()!
    let reads = 0, changed = false
    f.fetchImpl.mockImplementation(async (url, init) => {
      const response = await original(url, init)
      if (new URL(String(url)).pathname === '/rest/v1/pjsdas_workspaces' && ++reads === beforeFirstSearch) {
        changed = true
        if (failure === 'review-expiry') f.db.now = new Date(f.approval.fundingReview.expiresAt)
        else f.binding.discovery_consent_generation = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      }
      return response
    })
    await f.make()(request())
    expect(changed).toBe(true)
    expect([...f.db.rows.values()].some(row => row.provenance.searchPhase === 'claimed' && row.receipt.discoveryBudget)).toBe(true)
    expect(f.providerFetch.mock.calls.filter(call => String(call[0]) === target)).toHaveLength(0)
  })
})
