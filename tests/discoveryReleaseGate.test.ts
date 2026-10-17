import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

let direct: (request: Request) => Response | Promise<Response>
let standby: (request: Request) => Response | Promise<Response>

beforeAll(async () => {
  vi.resetModules()
  // A previously configured deployment must still be unable to activate this release.
  vi.stubEnv('PJSDAS_DISCOVERY_RUNTIME_ENABLED', 'true')
  vi.stubEnv('PJSDAS_DISCOVERY_RUNTIME_APPROVAL_JSON', 'synthetic-untrusted-configuration')
  vi.stubEnv('PJSDAS_DISCOVERY_PERPLEXITY_API_KEY', 'synthetic-search-only')
  vi.stubEnv('AI_GATEWAY_API_KEY', 'synthetic-gateway-only')
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Release gate must not access any external service') }))
  direct = (await import('../api/automation-discovery.js')).default.fetch
  standby = (await import('../cloudflare/worker.js')).routeCloudflareRequest
})
afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules() })

describe('source-enforced paid-OFF Discovery release', () => {
  it.each(['vercel', 'cloudflare'] as const)('blocks scheduler, manual, probe and forced calls through %s', async platform => {
    const call = platform === 'vercel' ? direct : standby
    for (const method of ['GET', 'POST']) for (const query of ['', '?force=1', '?probe=1', '?force=1&probe=1&userId=synthetic-owner']) {
      for (const authorization of [undefined, 'Bearer synthetic-worker-only']) {
        const response = await call(new Request(`https://synthetic.invalid/api/automation-discovery${query}`, {
          method, ...(authorization ? { headers: { authorization } } : {}),
        }))
        expect(response.status).toBe(503)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(await response.json()).toMatchObject({ code: 'DISCOVERY_RUNTIME_DISABLED', retryable: false })
        expect(fetch).not.toHaveBeenCalled()
      }
    }
  })
})
