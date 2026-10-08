import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DISCOVERY_SPEND_TARIFF,
  assertDiscoverySpendWindow,
  createDiscoveryBatchSpendHold,
  discoveryBatchPlanningEnvelope,
  discoverySpendPolicySchema,
  parseDiscoverySpendPolicy,
  type DiscoverySpendPolicy,
} from '../gateway/discoverySpendPolicy.js'

const ACCOUNT = 'a84a823c-591e-4c86-a87b-65d8102b393b'
const OTHER_ACCOUNT = '0c5101d9-5cf2-42b5-944e-6b756a327a58'
const CLAIM = '77154231-e507-42fd-ae06-8a3fe092059b'
const OTHER_CLAIM = '8f9d8b07-434d-4d46-8837-641a96c5e172'
const SCOPE = 'a'.repeat(64)
const START = '2026-10-08T10:00:00.000Z'
const END = '2026-10-09T10:00:00.000Z'

function terms(change: Partial<DiscoverySpendPolicy> = {}): DiscoverySpendPolicy {
  return {
    version: 1,
    application: 'todayaction',
    approvalId: 'approval:synthetic-20261008',
    accountId: ACCOUNT,
    scopeFingerprint: SCOPE,
    currency: 'USD',
    maximumMicroUsd: 1_000_000,
    validFrom: START,
    expiresAt: END,
    tariffVersion: 'todayaction-standard-search-text-2026-10-08',
    ...change,
  }
}

function request(change: Partial<Parameters<typeof createDiscoveryBatchSpendHold>[0]> = {}) {
  return {
    policy: terms(),
    accountId: ACCOUNT,
    scopeFingerprint: SCOPE,
    sourceId: 'monitor:synthetic-campus',
    claimAttemptId: CLAIM,
    queryCount: 4,
    now: new Date(START),
    ...change,
  }
}

const invalidCounts: unknown[] = [0, -1, 49, 1.1, 47.9, 48.1, NaN, Infinity, -Infinity, '2', null, undefined]

describe('pure TodayAction discovery spend terms and batch descriptions', () => {
  let fetchTrap: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchTrap = vi.fn(() => { throw new Error('These synthetic policy tests must not access the network.') })
    vi.stubGlobal('fetch', fetchTrap)
  })

  afterEach(() => {
    try {
      expect(fetchTrap).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('accepts complete server terms and preserves exact approved amounts and identifiers', () => {
    const approved = terms({ maximumMicroUsd: Number.MAX_SAFE_INTEGER })
    expect(discoverySpendPolicySchema.parse(approved)).toEqual(approved)
    expect(parseDiscoverySpendPolicy(approved)).toEqual(approved)
  })

  it.each(Object.keys(terms()))('requires the %s term', key => {
    const incomplete: Record<string, unknown> = { ...terms() }
    delete incomplete[key]
    expect(discoverySpendPolicySchema.safeParse(incomplete).success).toBe(false)
    expect(() => parseDiscoverySpendPolicy(incomplete)).toThrow(expect.objectContaining({ code: 'DISCOVERY_BUDGET_POLICY_INVALID' }))
  })

  it.each([
    undefined, null, [], 'approved',
    { ...terms(), application: 'other-app' },
    { ...terms(), currency: 'EUR' },
    { ...terms(), currency: 'usd' },
    { ...terms(), tariffVersion: 'foreign-tariff' },
    { ...terms(), version: 2 },
    { ...terms(), accountId: 'owner-a' },
    { ...terms(), accountId: ` ${ACCOUNT}` },
    { ...terms(), scopeFingerprint: 'a'.repeat(63) },
    { ...terms(), scopeFingerprint: 'g'.repeat(64) },
    { ...terms(), scopeFingerprint: SCOPE.toUpperCase() },
    { ...terms(), approvalId: '' },
    { ...terms(), approvalId: 'approval with spaces' },
    { ...terms(), maximumMicroUsd: 0 },
    { ...terms(), maximumMicroUsd: -1 },
    { ...terms(), maximumMicroUsd: 1.5 },
    { ...terms(), maximumMicroUsd: '1000000' },
    { ...terms(), maximumMicroUsd: Number.MAX_SAFE_INTEGER + 1 },
    { ...terms(), maximumMicroUsd: NaN },
    { ...terms(), maximumMicroUsd: Infinity },
    { ...terms(), validFrom: '2026-10-08' },
    { ...terms(), expiresAt: 'not-a-timestamp' },
    { ...terms(), expiresAt: START },
    { ...terms(), expiresAt: '2026-10-08T09:59:59.999Z' },
    { ...terms(), fundingApproved: true },
    { ...terms(), providerRetries: 3 },
  ])('rejects absent, foreign, malformed, or extra policy terms %#', value => {
    expect(discoverySpendPolicySchema.safeParse(value).success).toBe(false)
    expect(() => parseDiscoverySpendPolicy(value)).toThrow(expect.objectContaining({ code: 'DISCOVERY_BUDGET_POLICY_INVALID' }))
  })

  it.each([
    { accountId: OTHER_ACCOUNT },
    { accountId: ACCOUNT.toUpperCase() },
    { accountId: ` ${ACCOUNT}` },
    { accountId: 'owner-a' },
    { scopeFingerprint: 'b'.repeat(64) },
    { scopeFingerprint: SCOPE.toUpperCase() },
    { scopeFingerprint: `${SCOPE} ` },
    { sourceId: '' },
    { sourceId: '   ' },
    { sourceId: 'x'.repeat(181) },
    { claimAttemptId: 'claim-a' },
  ])('does not authorize a mismatched account, scope, source, or claim %#', change => {
    return expect(createDiscoveryBatchSpendHold(request(change))).rejects.toMatchObject({ code: 'DISCOVERY_BUDGET_POLICY_MISMATCH' })
  })

  it('validates the policy again when describing a hold', async () => {
    const invalid = { ...terms(), application: 'another-app' } as unknown as DiscoverySpendPolicy
    await expect(createDiscoveryBatchSpendHold(request({ policy: invalid }))).rejects.toMatchObject({ code: 'DISCOVERY_BUDGET_POLICY_INVALID' })
  })

  it.each([START, '2026-10-09T09:59:59.999Z'])('includes the start and all instants before expiry: %s', async time => {
    expect(() => assertDiscoverySpendWindow(terms(), new Date(time))).not.toThrow()
    await expect(createDiscoveryBatchSpendHold(request({ now: new Date(time) }))).resolves.toMatchObject({ reservedMicroUsd: 447_031 })
  })

  it.each(['2026-10-08T09:59:59.999Z', END, '2026-10-09T10:00:00.001Z', 'invalid'])('rejects before start, at/after expiry, and invalid clocks: %s', async time => {
    const now = new Date(time)
    expect(() => assertDiscoverySpendWindow(terms(), now)).toThrow(expect.objectContaining({ code: 'DISCOVERY_BUDGET_WINDOW_CLOSED' }))
    await expect(createDiscoveryBatchSpendHold(request({ now }))).rejects.toMatchObject({ code: 'DISCOVERY_BUDGET_WINDOW_CLOSED' })
  })

  it('interprets offset timestamps as the approved instants', async () => {
    const policy = terms({ validFrom: '2026-10-08T18:00:00+08:00', expiresAt: '2026-10-09T18:00:00+08:00' })
    await expect(createDiscoveryBatchSpendHold(request({ policy, now: new Date(START) }))).resolves.toMatchObject({ policy })
    await expect(createDiscoveryBatchSpendHold(request({ policy, now: new Date(END) }))).rejects.toMatchObject({ code: 'DISCOVERY_BUDGET_WINDOW_CLOSED' })
  })

  it('uses integer micro-USD for the standard single-inference planning envelope', () => {
    // This is a planning allowance, not proof of a cap on every provider failure path.
    expect(DISCOVERY_SPEND_TARIFF.modelInferenceMicroUsd).toBe(427_031)
    expect(DISCOVERY_SPEND_TARIFF.searchRequestMicroUsd).toBe(5_000)
    expect(discoveryBatchPlanningEnvelope(1)).toBe(432_031)
    expect(discoveryBatchPlanningEnvelope(48)).toBe(667_031)
  })

  it.each(Array.from({ length: 48 }, (_, index) => index + 1))('covers exactly all %i searches plus one model inference', async queryCount => {
    const expected = 427_031 + queryCount * 5_000
    expect(discoveryBatchPlanningEnvelope(queryCount)).toBe(expected)
    expect(Number.isSafeInteger(discoveryBatchPlanningEnvelope(queryCount))).toBe(true)
    const hold = await createDiscoveryBatchSpendHold(request({ queryCount, policy: terms({ maximumMicroUsd: expected }) }))
    expect(hold).toMatchObject({ searchRequestLimit: queryCount, modelRequestLimit: 1, reservedMicroUsd: expected })
  })

  it.each(invalidCounts)('rejects invalid query counts without coercion or truncation: %s', async count => {
    const queryCount = count as number
    expect(() => discoveryBatchPlanningEnvelope(queryCount)).toThrow(expect.objectContaining({ code: 'DISCOVERY_BUDGET_POLICY_INVALID' }))
    await expect(createDiscoveryBatchSpendHold(request({ queryCount }))).rejects.toMatchObject({ code: 'DISCOVERY_BUDGET_POLICY_INVALID' })
  })

  it.each([1, 4, 48])('rejects a cap one micro-USD short of the entire %i-query batch', async queryCount => {
    const maximumMicroUsd = 427_031 + queryCount * 5_000 - 1
    await expect(createDiscoveryBatchSpendHold(request({ queryCount, policy: terms({ maximumMicroUsd }) }))).rejects.toMatchObject({ code: 'DISCOVERY_BUDGET_EXHAUSTED' })
  })

  it('never falls back to a partially affordable search batch', async () => {
    // The cap covers 47 searches, but the requested batch requires all 48.
    await expect(createDiscoveryBatchSpendHold(request({ queryCount: 48, policy: terms({ maximumMicroUsd: 662_031 }) }))).rejects.toMatchObject({ code: 'DISCOVERY_BUDGET_EXHAUSTED' })
  })

  it('copies and freezes parsed approval terms rather than retaining a mutable input', () => {
    const original = terms()
    const parsed = parseDiscoverySpendPolicy(original)
    const expected = { ...parsed }
    original.maximumMicroUsd = 1
    original.accountId = OTHER_ACCOUNT
    original.scopeFingerprint = 'b'.repeat(64)
    expect(parsed).toEqual(expected)
    expect(parsed).not.toBe(original)
    expect(Reflect.set(parsed, 'maximumMicroUsd', 1)).toBe(false)
    expect(parsed.maximumMicroUsd).toBe(1_000_000)
  })

  it('returns immutable hold and policy snapshots despite later input mutations', async () => {
    const input = request()
    const hold = await createDiscoveryBatchSpendHold(input)
    const expected = structuredClone(hold)
    input.policy.maximumMicroUsd = 1
    input.policy.accountId = OTHER_ACCOUNT
    input.policy.expiresAt = START
    input.queryCount = 48
    input.sourceId = 'monitor:replacement'
    input.claimAttemptId = OTHER_CLAIM
    input.now.setTime(0)
    expect(hold).toEqual(expected)
    expect(hold.policy).not.toBe(input.policy)
    expect(Reflect.set(hold, 'reservedMicroUsd', 1)).toBe(false)
    expect(Reflect.set(hold.policy, 'maximumMicroUsd', 1)).toBe(false)
    expect(hold).toEqual(expected)
  })

  it('snapshots the approved policy before asynchronous fingerprint computation', async () => {
    const original = terms()
    const pending = createDiscoveryBatchSpendHold(request({ policy: original }))
    original.maximumMicroUsd = 1
    original.approvalId = 'replaced-approval'
    const hold = await pending
    expect(hold.policy).toEqual(terms())
    expect(hold.policyFingerprint).toBe((await createDiscoveryBatchSpendHold(request())).policyFingerprint)
  })

  it('keeps the validated batch and claim stable while asynchronous hashing is pending', async () => {
    const input = request()
    const pending = createDiscoveryBatchSpendHold(input)
    input.queryCount = 48
    input.sourceId = ''
    input.claimAttemptId = 'invalid-after-validation'
    const hold = await pending
    expect(hold).toMatchObject({
      sourceId: 'monitor:synthetic-campus',
      claimAttemptId: CLAIM,
      searchRequestLimit: 4,
      reservedMicroUsd: 447_031,
    })
  })

  it('fingerprints identical approved terms deterministically regardless of property order or batch identity', async () => {
    const policy = terms()
    const reordered = Object.fromEntries(Object.entries(policy).reverse()) as DiscoverySpendPolicy
    const first = await createDiscoveryBatchSpendHold(request({ policy }))
    const second = await createDiscoveryBatchSpendHold(request({ policy: reordered, claimAttemptId: OTHER_CLAIM, sourceId: 'monitor:another-source', queryCount: 48 }))
    expect(first.policyFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(second.policyFingerprint).toBe(first.policyFingerprint)
  })

  it.each([
    { approvalId: 'approval:another' },
    { maximumMicroUsd: 1_000_001 },
    { validFrom: '2026-10-08T09:59:59.999Z' },
    { expiresAt: '2026-10-09T10:00:00.001Z' },
    { accountId: OTHER_ACCOUNT },
    { scopeFingerprint: 'b'.repeat(64) },
  ])('changes the fingerprint when approved terms change %#', async change => {
    const first = await createDiscoveryBatchSpendHold(request())
    const policy = terms(change)
    const second = await createDiscoveryBatchSpendHold(request({ policy, accountId: policy.accountId, scopeFingerprint: policy.scopeFingerprint }))
    expect(second.policyFingerprint).not.toBe(first.policyFingerprint)
  })

  it('only describes a hold: repeated calls neither admit nor debit a durable shared budget', async () => {
    const policy = terms({ maximumMicroUsd: 447_031 })
    const first = await createDiscoveryBatchSpendHold(request({ policy }))
    const second = await createDiscoveryBatchSpendHold(request({ policy, claimAttemptId: OTHER_CLAIM }))
    expect(first.reservedMicroUsd).toBe(447_031)
    expect(second.reservedMicroUsd).toBe(447_031)
    expect(policy.maximumMicroUsd).toBe(447_031)
    expect(first.policyFingerprint).toBe(second.policyFingerprint)
  })
})
