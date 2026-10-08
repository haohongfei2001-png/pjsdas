import { z } from 'zod/v4'
import { hashMutationPayload } from './mutationKernel.js'
import { WorkspaceSourceError } from './workspaceSource.js'

// Price evidence checked against the public provider catalogs on 2026-10-08.
// Search is a per-successful-request price, including an empty response.
// The model value is deliberately a STANDARD SINGLE-INFERENCE envelope. It is
// not a claim that undocumented Gateway failure handling or account add-ons
// are covered. Live activation additionally requires an operator-verified
// funding boundary; a configured amount alone cannot supply that assurance.
// https://docs.perplexity.ai/docs/getting-started/pricing
// https://ai-gateway.vercel.sh/v1/models/openai/gpt-4.1-mini/endpoints
export const DISCOVERY_SPEND_TARIFF = Object.freeze({
  version: 'todayaction-standard-search-text-2026-10-08',
  searchProvider: 'perplexity-search-web',
  searchRequestMicroUsd: 5_000,
  searchMaximumResults: 20,
  model: 'openai/gpt-4.1-mini',
  modelProvider: 'openai',
  modelContextTokens: 1_047_576,
  modelMaximumOutputTokens: 5_000,
  modelMaximumInputBytes: 262_144,
  modelInferenceMicroUsd: Math.ceil((1_047_576 * 4 + 5_000 * 16) / 10),
})

const timestamp = z.string().datetime({ offset: true })
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,119}$/)
const micros = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)

/** Server-owned terms of one explicitly approved account/scope budget.
 * These terms live in original command receipts, never in editable timeline
 * entries or in the recruiting-facts snapshot. All amounts are integer USD
 * millionths; accepting this schema does not enable an external request. */
export const discoverySpendPolicySchema = z.object({
  version: z.literal(1),
  application: z.literal('todayaction'),
  approvalId: identifier,
  accountId: z.string().uuid(),
  scopeFingerprint: digest,
  currency: z.literal('USD'),
  maximumMicroUsd: micros,
  validFrom: timestamp,
  expiresAt: timestamp,
  tariffVersion: z.literal(DISCOVERY_SPEND_TARIFF.version),
}).strict().superRefine((policy, context) => {
  if (Date.parse(policy.expiresAt) <= Date.parse(policy.validFrom)) {
    context.addIssue({ code: 'custom', message: 'The approved budget window must have a positive duration.' })
  }
})
export type DiscoverySpendPolicy = z.infer<typeof discoverySpendPolicySchema>

export interface DiscoveryBatchSpendHold {
  version: 1
  policy: DiscoverySpendPolicy
  policyFingerprint: string
  sourceId: string
  claimAttemptId: string
  searchRequestLimit: number
  modelRequestLimit: 1
  reservedMicroUsd: number
}

export function parseDiscoverySpendPolicy(value: unknown): DiscoverySpendPolicy {
  const result = discoverySpendPolicySchema.safeParse(value)
  if (!result.success) {
    throw new WorkspaceSourceError('DISCOVERY_BUDGET_POLICY_INVALID', 'The approved TodayAction budget terms are missing or invalid.', false)
  }
  return Object.freeze(result.data)
}

export function assertDiscoverySpendWindow(policy: DiscoverySpendPolicy, now: Date) {
  const time = now.getTime()
  if (!Number.isFinite(time) || time < Date.parse(policy.validFrom) || time >= Date.parse(policy.expiresAt)) {
    throw new WorkspaceSourceError('DISCOVERY_BUDGET_WINDOW_CLOSED', 'This TodayAction budget is outside its approved window; no request was sent.', false)
  }
}

export function discoveryBatchPlanningEnvelope(queryCount: number) {
  if (!Number.isInteger(queryCount) || queryCount < 1 || queryCount > 48) {
    throw new WorkspaceSourceError('DISCOVERY_BUDGET_POLICY_INVALID', 'A budget hold must cover one exact bounded search batch.', false)
  }
  return queryCount * DISCOVERY_SPEND_TARIFF.searchRequestMicroUsd + DISCOVERY_SPEND_TARIFF.modelInferenceMicroUsd
}

/** Describe the complete pre-dispatch hold. The existing atomic claim RPC,
 * rather than this pure calculation, must admit it against the shared cap. */
async function describeHold(input: {
  policy: DiscoverySpendPolicy
  accountId: string
  scopeFingerprint: string
  sourceId: string
  claimAttemptId: string
  queryCount: number
  now?: Date
}): Promise<DiscoveryBatchSpendHold> {
  // Capture the validated primitives before asynchronous hashing. A caller's
  // mutable options must not widen the returned slots after pricing them.
  const { accountId, scopeFingerprint, sourceId, claimAttemptId, queryCount } = input
  const policy = parseDiscoverySpendPolicy(input.policy)
  if (accountId !== policy.accountId || scopeFingerprint !== policy.scopeFingerprint
    || !sourceId.trim() || sourceId.length > 180 || !z.string().uuid().safeParse(claimAttemptId).success) {
    throw new WorkspaceSourceError('DISCOVERY_BUDGET_POLICY_MISMATCH', 'The budget does not authorize this account, scope or claim.', false)
  }
  if (input.now) assertDiscoverySpendWindow(policy, input.now)
  const reservedMicroUsd = discoveryBatchPlanningEnvelope(queryCount)
  if (reservedMicroUsd > policy.maximumMicroUsd) {
    throw new WorkspaceSourceError('DISCOVERY_BUDGET_EXHAUSTED', 'The approved budget cannot cover this complete batch; remaining scope was not searched.', false)
  }
  return Object.freeze({ version: 1, policy, policyFingerprint: await hashMutationPayload('discovery_spend_policy', policy),
    sourceId, claimAttemptId, searchRequestLimit: queryCount,
    modelRequestLimit: 1, reservedMicroUsd })
}

/** Describe an immutable historical claim without treating present time as a
 * new spending permit. The caller must still verify its original receipt. */
export function describeDiscoveryBatchSpendHold(input: Omit<Parameters<typeof describeHold>[0], 'now'>) {
  return describeHold({ ...input, now: undefined })
}

export function createDiscoveryBatchSpendHold(input: Parameters<typeof describeHold>[0] & { now: Date }) {
  if (!(input.now instanceof Date)) throw new WorkspaceSourceError('DISCOVERY_BUDGET_WINDOW_CLOSED', 'A current clock is required before proposing new spending.', false)
  return describeHold(input)
}
