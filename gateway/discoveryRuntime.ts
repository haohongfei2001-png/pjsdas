import { z } from 'zod/v4'
import { createDiscoveryAutomationHandler, type DiscoveryAutomationHandlerConfig } from './discoveryAutomationHandler.js'
import { createDiscoveryGatewayTransport } from './discoveryGatewayTransport.js'
import { createPerplexityDiscoverySearchProvider } from './perplexityDiscoverySearch.js'
import { assertDiscoverySpendWindow, discoverySpendPolicySchema, DISCOVERY_SPEND_TARIFF as T } from './discoverySpendPolicy.js'
import { hashMutationPayload } from './mutationKernel.js'
import { WorkspaceSourceError } from './workspaceSource.js'

const reference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/)
const approvalSchema = z.object({
  version: z.literal(1), policy: discoverySpendPolicySchema,
  fundingReview: z.object({
    reference, policyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    reviewedAt: z.string().datetime({ offset: true }), expiresAt: z.string().datetime({ offset: true }),
    // These identify separate operator-held evidence. They are not a checkbox
    // that turns a soft Gateway budget into a vendor spending guarantee.
    billingBoundaryReference: reference, routeAndAddonsReference: reference,
  }).strict(),
}).strict()

function unavailable(code: string, message: string) {
  return new Response(JSON.stringify({ code, message, retryable: false }), {
    status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

/** Configuration injection only. Default-off returns before the handler reads
 * any binding, provider credential or cloud workspace. Production operators
 * must verify the referenced funding/routing evidence before configuring it;
 * syntax and fingerprints cannot establish provider billing behavior. */
export function createDiscoveryRuntime(input: {
  base: Omit<DiscoveryAutomationHandlerConfig, 'aiGatewayModel' | 'budgetPolicyVersion' | 'batchSpend' | 'generateTextImpl' | 'reserveSpend' | 'searchProvider' | 'reserveSearch'>
  environment: Readonly<Record<string, string | undefined>>
  providerFetch?: typeof fetch
}) {
  if (input.environment.PJSDAS_DISCOVERY_RUNTIME_ENABLED !== 'true') {
    return async (_request: Request) => unavailable('DISCOVERY_RUNTIME_DISABLED', 'Automatic search is disabled until its complete scope, deployment and funding boundary are approved.')
  }
  const rawApproval = input.environment.PJSDAS_DISCOVERY_RUNTIME_APPROVAL_JSON
  const searchKey = input.environment.PJSDAS_DISCOVERY_PERPLEXITY_API_KEY
  const base = { ...input.base }, now = base.now ?? (() => new Date()), providerFetch = input.providerFetch
  const initialize = async () => {
    let value: unknown
    try { value = JSON.parse(rawApproval ?? '') } catch { throw new WorkspaceSourceError('DISCOVERY_RUNTIME_APPROVAL_REQUIRED', 'The approved runtime configuration is unavailable.', false) }
    const result = approvalSchema.safeParse(value)
    if (!result.success) throw new WorkspaceSourceError('DISCOVERY_RUNTIME_APPROVAL_REQUIRED', 'The approved runtime configuration is invalid.', false)
    const approval = result.data, policy = Object.freeze(approval.policy), review = Object.freeze(approval.fundingReview)
    if (await hashMutationPayload('discovery_spend_policy', policy) !== review.policyFingerprint) throw new WorkspaceSourceError('DISCOVERY_RUNTIME_APPROVAL_REQUIRED', 'Funding review does not match the complete approved policy.', false)
    const checkCurrent = () => {
      const clock = now(), time = clock.getTime()
      assertDiscoverySpendWindow(policy, clock)
      if (!Number.isFinite(time) || Date.parse(review.reviewedAt) > time || Date.parse(review.expiresAt) <= time
        || Date.parse(review.expiresAt) <= Date.parse(review.reviewedAt)) throw new WorkspaceSourceError('DISCOVERY_FUNDING_REVIEW_EXPIRED', 'The separately verified funding and routing evidence must still be current.', false)
    }
    checkCurrent()
    const searchProvider = createPerplexityDiscoverySearchProvider({ apiKey: searchKey ?? '', searchType: 'web', fetchImpl: providerFetch })
    const handler = createDiscoveryAutomationHandler({ ...base, assertRuntimeCurrent: checkCurrent, aiGatewayModel: T.model, budgetPolicyVersion: T.version,
      searchProvider, batchSpend: { policy, modelTransport: createDiscoveryGatewayTransport({ fetchImpl: providerFetch }) } })
    return { handler, checkCurrent, accountId: policy.accountId }
  }
  // Initialization is lazy and contains no external request. Cache one outcome
  // so concurrent ticks cannot create inconsistent interpretations of config.
  let ready: ReturnType<typeof initialize> | undefined
  return async (request: Request) => {
    try {
      const runtime = await (ready ??= initialize())
      runtime.checkCurrent()
      const url = new URL(request.url)
      if (url.searchParams.get('probe') === '1') return unavailable('DISCOVERY_UNRESERVED_PROBE_DISABLED', 'A model call requires its original budgeted search claim.')
      const requestedAccount = url.searchParams.get('userId')
      if (requestedAccount && requestedAccount !== runtime.accountId) return unavailable('DISCOVERY_BUDGET_POLICY_MISMATCH', 'This runtime is approved for one exact account and scope.')
      return runtime.handler(request)
    } catch (caught) {
      return unavailable(caught instanceof WorkspaceSourceError ? caught.code : 'DISCOVERY_RUNTIME_UNAVAILABLE',
        caught instanceof WorkspaceSourceError ? caught.message : 'Automatic search configuration could not be verified.')
    }
  }
}
