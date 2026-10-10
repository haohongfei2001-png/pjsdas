import { z } from 'zod/v4'
import { discoveryWebQuerySchema } from '../src/discoverySearchEvidence.js'
import type { DiscoveryWebQuery } from '../src/discoveryQueryPlan.js'
import type { DiscoveryGenerateText, DiscoveryGenerateTextInput } from './discoveryAutomationWorker.js'
import type { DiscoverySpendRequest, ReserveDiscoverySpend } from './discoveryBudgetGuard.js'
import type { DiscoverySearchProvider, DiscoverySearchReservationRequest, ReserveDiscoverySearch } from './discoverySearchExecution.js'
import { hashMutationPayload } from './mutationKernel.js'
import { WorkspaceSourceError } from './workspaceSource.js'
import { assertDiscoverySpendWindow, discoveryBatchPlanningEnvelope, discoverySpendPolicySchema, DISCOVERY_SPEND_TARIFF, type DiscoveryBatchSpendHold } from './discoverySpendPolicy.js'

const boundedCount = z.number().int().min(1).max(48)
const holdSchema = z.object({
  version: z.literal(1), policy: discoverySpendPolicySchema,
  policyFingerprint: z.string().regex(/^[a-f0-9]{64}$/), sourceId: z.string().min(1).max(180),
  claimAttemptId: z.string().uuid(), searchRequestLimit: boundedCount,
  modelRequestLimit: z.literal(1), reservedMicroUsd: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict()
const admissionSchema = z.object({
  version: z.literal(1), hold: holdSchema, admitted: z.boolean(),
  retainedMicroUsd: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict()

function denied(message: string): never {
  throw new WorkspaceSourceError('DISCOVERY_BUDGET_RESERVATION_INVALID', message, false)
}

/** This metadata must come from the original ledger receipt, after the normal
 * receipt identity/revision check. A proposal or a successful CAS by itself
 * does not establish that the shared monetary cap admitted the hold. */
export async function verifyDiscoveryBudgetAdmission(receipt: Record<string, unknown>, expected: DiscoveryBatchSpendHold) {
  const parsed = admissionSchema.safeParse(receipt.discoveryBudget)
  const expectedCopy = holdSchema.parse(expected)
  if (!parsed.success) return denied('The original claim has no valid atomic budget admission.')
  const admission = parsed.data
  if (expectedCopy.reservedMicroUsd !== discoveryBatchPlanningEnvelope(expectedCopy.searchRequestLimit)
    || expectedCopy.reservedMicroUsd > expectedCopy.policy.maximumMicroUsd
    || expectedCopy.policyFingerprint !== await hashMutationPayload('discovery_spend_policy', expectedCopy.policy)) {
    return denied('The proposed hold does not cover its complete fixed-tariff batch.')
  }
  if (await hashMutationPayload('discovery_budget_hold', admission.hold)
    !== await hashMutationPayload('discovery_budget_hold', expectedCopy)
    || admission.retainedMicroUsd !== (admission.admitted ? expectedCopy.reservedMicroUsd : 0)) {
    return denied('Budget admission differs from the exact proposed account, scope or batch hold.')
  }
  return Object.freeze({ ...admission, hold: Object.freeze({ ...admission.hold, policy: Object.freeze(admission.hold.policy) }) })
}

const searchReservationSchema = z.object({
  requestId: z.string().uuid(), application: z.literal('todayaction'),
  provider: z.literal(DISCOVERY_SPEND_TARIFF.searchProvider), accountId: z.string().uuid(),
  sourceId: z.string().min(1).max(180), requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  maxHttpRequests: z.literal(1), maximumCostUsd: z.literal(DISCOVERY_SPEND_TARIFF.searchRequestMicroUsd / 1_000_000),
}).strict()
const modelReservationSchema = z.object({
  requestId: z.string().uuid(), application: z.literal('todayaction'), provider: z.literal('vercel-ai-gateway'),
  accountId: z.string().uuid(), sourceId: z.string().min(1).max(180), model: z.literal(DISCOVERY_SPEND_TARIFF.model),
  inputBytes: z.number().int().nonnegative().max(DISCOVERY_SPEND_TARIFF.modelMaximumInputBytes),
  maxOutputTokens: z.literal(DISCOVERY_SPEND_TARIFF.modelMaximumOutputTokens), maxSdkAttempts: z.literal(1),
}).strict()
const textInputSchema = z.object({ model: z.literal(DISCOVERY_SPEND_TARIFF.model), system: z.string(), prompt: z.string(),
  temperature: z.literal(0.1), maxOutputTokens: z.literal(DISCOVERY_SPEND_TARIFF.modelMaximumOutputTokens), maxRetries: z.literal(0),
}).strict()

/** The concrete Gateway transport rechecks authority immediately before its
 * HTTP dispatch, after SDK preparation/credential resolution has completed. */
export type DiscoveryModelTransport = (input: DiscoveryGenerateTextInput, beforeRequest: () => Promise<void>) => Promise<{ text: string }>

export async function createDiscoveryBatchSpendAdapters(input: {
  hold: DiscoveryBatchSpendHold
  claim: { firstCommit: boolean; receipt: Record<string, unknown> }
  queries: DiscoveryWebQuery[]
  searchProvider: DiscoverySearchProvider
  modelTransport: DiscoveryModelTransport
  authorize: () => Promise<void>
  clock: () => Date
}) {
  // Snapshot every caller-controlled field before validation yields. No other
  // invocation, including a replay with the same claim, inherits these slots.
  const hold = holdSchema.parse(input.hold), receipt = structuredClone(input.claim.receipt)
  const firstCommit = input.claim.firstCommit, queries = z.array(discoveryWebQuerySchema).parse(input.queries)
  const provider = Object.freeze({ id: input.searchProvider.id, maximumRequestCostUsd: input.searchProvider.maximumRequestCostUsd,
    maximumResults: input.searchProvider.maximumResults, search: input.searchProvider.search })
  const transport = input.modelTransport, authorize = input.authorize, clock = input.clock
  if (firstCommit !== true || receipt.status !== 'COMMITTED' || receipt.operation !== 'checkpoint_discovery_search'
    || typeof receipt.commandId !== 'string' || !/^discovery-search-claimed:[a-f0-9]{64}$/.test(receipt.commandId)
    || !Number.isSafeInteger(receipt.revision) || Number(receipt.revision) < 1
    || receipt.receiptId !== `command-receipt:${receipt.commandId}`) {
    return denied('Only this invocation\'s first verified claim can dispatch external work.')
  }
  const admission = await verifyDiscoveryBudgetAdmission(receipt, hold)
  if (!admission.admitted) throw new WorkspaceSourceError('DISCOVERY_BUDGET_EXHAUSTED', 'The atomic claim declined this batch; no search or model request was sent.', false)
  if (queries.length !== hold.searchRequestLimit
    || provider.id !== DISCOVERY_SPEND_TARIFF.searchProvider
    || provider.maximumRequestCostUsd !== DISCOVERY_SPEND_TARIFF.searchRequestMicroUsd / 1_000_000
    || provider.maximumResults !== DISCOVERY_SPEND_TARIFF.searchMaximumResults) return denied('The provider or complete query batch differs from its original budget hold.')
  const allowedQueries = new Set(queries.map(query => JSON.stringify(query)))
  if (allowedQueries.size !== queries.length) return denied('A batch cannot pay twice for duplicate planned queries.')
  const searchReservations = new Map<string, { request: DiscoverySearchReservationRequest; started: boolean }>()
  const startedQueries = new Set<string>()
  let modelReservation: DiscoverySpendRequest | undefined, modelStarted = false
  const assertCurrent = async () => {
    await authorize()
    assertDiscoverySpendWindow(hold.policy, clock())
  }
  await assertCurrent()
  const reserveSearch: ReserveDiscoverySearch = async value => {
    const result = searchReservationSchema.safeParse(value)
    if (!result.success) return denied('The search reservation violates the fixed request policy.')
    const request = Object.freeze(result.data)
    if (request.accountId !== hold.policy.accountId || request.sourceId !== hold.sourceId
      || searchReservations.has(request.requestId) || searchReservations.size >= hold.searchRequestLimit) return denied('This claim has no matching unused search slot.')
    // Reserve synchronously before the authorization await, preventing two
    // concurrent callers from both claiming the final slot.
    searchReservations.set(request.requestId, { request, started: false })
    await assertCurrent()
    return Object.freeze({ ...request, reservationId: `${receipt.commandId}:search:${request.requestId}`,
      reservedUsd: DISCOVERY_SPEND_TARIFF.searchRequestMicroUsd / 1_000_000, expiresAt: hold.policy.expiresAt })
  }
  const searchProvider: DiscoverySearchProvider = {
    id: provider.id, maximumRequestCostUsd: provider.maximumRequestCostUsd, maximumResults: provider.maximumResults,
    async search(value) {
      const request = Object.freeze({ requestId: value.requestId, query: discoveryWebQuerySchema.parse(value.query), maxResults: value.maxResults })
      const reservation = searchReservations.get(request.requestId), queryKey = JSON.stringify(request.query)
      if (!reservation || reservation.started || !allowedQueries.has(queryKey) || startedQueries.has(queryKey)
        || request.maxResults !== DISCOVERY_SPEND_TARIFF.searchMaximumResults) return denied('The outbound search has no exact unused reserved query.')
      // Consumption precedes all awaits. A timeout or unknown response cannot
      // be retried by calling this adapter again with another request ID.
      reservation.started = true
      startedQueries.add(queryKey)
      if (await hashMutationPayload('discovery_search', request) !== reservation.request.requestFingerprint) return denied('The outbound search changed after reservation.')
      await assertCurrent()
      return provider.search(request)
    },
  }
  const reserveSpend: ReserveDiscoverySpend = async value => {
    const result = modelReservationSchema.safeParse(value)
    if (!result.success) return denied('The model reservation violates the fixed text policy.')
    const request = Object.freeze(result.data)
    if (modelReservation || request.accountId !== hold.policy.accountId || request.sourceId !== hold.sourceId) return denied('This claim has no matching unused model slot.')
    modelReservation = request
    await assertCurrent()
    return Object.freeze({ ...request, reservationId: `${receipt.commandId}:model:${request.requestId}`,
      reservedUsd: DISCOVERY_SPEND_TARIFF.modelInferenceMicroUsd / 1_000_000, expiresAt: hold.policy.expiresAt })
  }
  const generateTextImpl: DiscoveryGenerateText = async value => {
    const result = textInputSchema.safeParse(value)
    if (!result.success || !modelReservation || modelStarted) return denied('The outbound model request has no unused fixed-policy reservation.')
    const request = Object.freeze(result.data)
    if (new TextEncoder().encode(request.system + request.prompt).byteLength !== modelReservation.inputBytes) return denied('The model input changed after reservation.')
    modelStarted = true
    await assertCurrent()
    return transport(request, assertCurrent)
  }
  return { reserveSearch, searchProvider, reserveSpend, generateTextImpl }
}
