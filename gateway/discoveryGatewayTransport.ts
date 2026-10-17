import { z } from 'zod/v4'
import type { DiscoveryModelTransport } from './discoveryBatchSpend.js'
import { DISCOVERY_SPEND_TARIFF as T } from './discoverySpendPolicy.js'
import { WorkspaceSourceError } from './workspaceSource.js'

const endpoint = 'https://ai-gateway.vercel.sh/v4/ai/language-model'
const textRequest = z.object({ model: z.literal(T.model), system: z.string(), prompt: z.string(),
  temperature: z.literal(0.1), maxOutputTokens: z.literal(T.modelMaximumOutputTokens), maxRetries: z.literal(0),
}).strict()

/** The installed AI SDK remains responsible for existing Gateway authentication.
 * This adapter adds no key, team, BYOK credential, routing rule or paid tool. A
 * synthetic fetch/key can exercise the real SDK without touching any provider.
 * The call envelope is NOT proof about Gateway's internal billing behavior. */
export function createDiscoveryGatewayTransport(options: { fetchImpl?: typeof fetch; apiKey?: string } = {}): DiscoveryModelTransport {
  const fetchImpl = options.fetchImpl ?? fetch, apiKey = options.apiKey
  return async (value, beforeRequest) => {
    const parsed = textRequest.safeParse(value)
    if (!parsed.success || new TextEncoder().encode(parsed.data.system + parsed.data.prompt).byteLength > T.modelMaximumInputBytes) {
      throw new WorkspaceSourceError('DISCOVERY_MODEL_POLICY_INVALID', 'Only the approved bounded plain-text request is supported.', false)
    }
    const input = Object.freeze(parsed.data)
    const { generateText, createGateway } = await import('ai')
    let dispatched = false, guardRejected = false
    let guardError: unknown
    const gateway = createGateway({ ...(apiKey === undefined ? {} : { apiKey }), fetch: async (url, init) => {
      if (String(url) !== endpoint || init?.method !== 'POST' || dispatched) {
        throw new WorkspaceSourceError('DISCOVERY_MODEL_POLICY_INVALID', 'The SDK attempted an unapproved endpoint or another outbound request.', false)
      }
      // This is reached after the SDK resolves authentication and serializes the
      // request. Consume before the await; failed/unknown dispatch is never retried.
      dispatched = true
      try { await beforeRequest() } catch (caught) { guardRejected = true; guardError = caught; throw caught }
      return fetchImpl(url, { ...init, redirect: 'error' })
    } })
    try {
      const result = await generateText({ model: gateway(T.model), system: input.system, prompt: input.prompt,
        temperature: input.temperature, maxOutputTokens: input.maxOutputTokens, maxRetries: 0,
        toolChoice: 'none', providerOptions: { gateway: { only: [T.modelProvider] } }, abortSignal: AbortSignal.timeout(60_000),
      })
      return { text: result.text }
    } catch (caught) {
      // SDK wrapping must not turn a known final-boundary revocation into an
      // unrelated provider error. The original claim/hold remains retained.
      if (guardRejected) throw guardError
      throw caught
    }
  }
}
